import child from 'child_process';
import chownr from 'chownr';
import du from 'du';
import fs from 'fs-extra';
import ini from 'ini';
import mcquery from 'mcquery';
import { constants } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import procfs from 'procfs-stats';
import { Rsync } from 'rsync2';
import strftime from 'strftime';
import { Tail } from 'tail';
import tmp from 'tmp';
import userid from 'userid';
import which from 'which';

import { Logger } from './lib/logger';
import memoize from './lib/memoize';
import { bufferToAscii, type MinecraftFullStats, readIni, splitBuffer } from './lib/util';

import { existsOnSystem } from './auth-new';
import { DIRS, ServerProperties, ServerConfig, CronConfig, CronTask, SP_DEFAULTS } from './constants';

const logger = Logger.child({ service: 'instance' });

const procPaths = ['/proc', '/usr/compat/linux/proc', '/system/lxproc', '/compat/linux/proc'];
let PROC_PATH: string;

for (const proc in procPaths) {
  logger.debug(`checking ${proc} for process stats`);
  try {
    fs.statSync(path.join(procPaths[proc], 'uptime'));
    PROC_PATH = procPaths[proc];
    procfs['PROC'] = PROC_PATH; //procfs will default to /proc but we want to set it more variably
    break;
  } catch (e) {
    continue;
  }
}

type MemoKeys = 'server.properties' | 'server.config';
type EnvKeys = 'baseDir' | 'cwd' | 'bwd' | 'awd' | 'pwd' | 'sp' | 'sc' | 'cc';
type QueryResponse = {
  protocol?: number;
  serverVersion: string;
  motd: string;
  playersOnline: number;
  playersMax: number;
};
type IncrementListItem = {
  step: string;
  time: string;
  size: string;
  cum: string;
};
type ArchiveListItem = {
  time: Date;
  size: number;
  filename: string;
};

export class Instance {
  name: string = '';
  env: { [key in EnvKeys]: string };
  memoFiles: { [key in MemoKeys]?: ReturnType<typeof memoize> } = {};
  timestamps: { [key in MemoKeys]?: number } = {};

  constructor(name: string, baseDir: string) {
    this.name = name;
    this.env = {
      baseDir,
      cwd: path.join(baseDir, DIRS.servers, name),
      bwd: path.join(baseDir, DIRS.backup, name),
      awd: path.join(baseDir, DIRS.archive, name),
      pwd: path.join(baseDir, DIRS.profiles),
      sp: path.join(baseDir, DIRS.servers, name, 'server.properties'),
      sc: path.join(baseDir, DIRS.servers, name, 'server.config'),
      cc: path.join(baseDir, DIRS.servers, name, 'cron.config'),
    };
  }

  /**
   * Get a list of instance names from a directory
   *
   * @param baseDir Directory to search for instances
   * @returns List of all instance names
   */
  static listInstances(baseDir: string): string[] {
    return fs.readdirSync(path.join(baseDir, DIRS.servers));
  }

  /**
   * Check if a potential instance name is valid
   *
   * @param name Name to inspect
   * @returns True if valid, false otherwise
   */
  static validInstanceName(name: string): boolean {
    return /^(?!\.)[a-zA-Z0-9_.]+$/.test(name);
  }

  /**
   * Get as list of running instances and their process IDs
   *
   * @returns Map of instance names to screen or java PIDs
   */
  static listRunningInstancePids() {
    const SCREEN_REGEX = /screen[^S]+S mc-(\S+)/i;
    const JAVA_REGEX = /\.mc-(\S+)/i;

    type pidTypes = 'screen' | 'java';
    const instances: { [key: string]: { [key in pidTypes]?: number } } = {};

    // Get all running process PIDs from system process directory
    const pids = fs.readdirSync(PROC_PATH).filter((e) => {
      if (/^([0-9]+)$/.test(e)) {
        return e;
      }
    });

    for (let i = 0; i < pids.length; i++) {
      let cmdline: string;

      // Read the command which was executed to be able to match against the args
      try {
        cmdline = fs
          .readFileSync(path.join(PROC_PATH, pids[i].toString(), 'cmdline'))
          .toString('ascii')
          .replace(/\u0000/g, ' ');
      } catch (e) {
        continue;
      }

      // Check if it is runninng SCREEN
      const screenMatch = SCREEN_REGEX.exec(cmdline);
      if (screenMatch) {
        if (screenMatch[1] in instances) {
          // Instance already exists, update PID
          instances[screenMatch[1]]['screen'] = parseInt(pids[i]);
        } else {
          // Add entry for instance
          instances[screenMatch[1]] = { screen: parseInt(pids[i]) };
        }
      } else {
        let environ: string;

        // This is not a SCREEN process, check for JAVA
        // screen starts its child process with an env var STY which has the parent process ID
        // and the string identifier of the screen session which happens to include the server name,
        // e.g. STY=12345.mc-servername
        try {
          environ = fs
            .readFileSync(path.join(PROC_PATH, pids[i].toString(), 'environ'))
            .toString('ascii')
            .replace(/\u0000/g, ' ');
        } catch (e) {
          continue;
        }

        const javaMatch = JAVA_REGEX.exec(environ);
        if (javaMatch) {
          if (javaMatch[1] in instances) {
            // Instance already exists, update PID
            instances[javaMatch[1]]['java'] = parseInt(pids[i]);
          } else {
            // Add entry for instance
            instances[javaMatch[1]] = { java: parseInt(pids[i]) };
          }
        }
      }
    }
    return instances;
  }

  /**
   * Get the instance name from a longer path string
   *
   * @param filepath Path to extract instance name from
   * @param baseDir Base directory string (default: 'servers')
   * @returns Instance name, if one is found
   * @throws Error if no match is found
   */
  static extractInstanceName(filepath: string, baseDir: string = DIRS.servers): string {
    const re = new RegExp(`${baseDir}/([a-zA-Z0-9_.]+)`);
    const matches = re.exec(filepath);
    if (matches) {
      return matches[1];
    } else {
      throw new Error(`no instance name in ${filepath}`);
    }
  }

  /**
   * Cache of memoized values. Stored so we can clear individual values.
   */
  private _memoCache = new Map();

  /**
   * Read a memoized INI file and return its contents
   *
   * @param key Which INI file to read data from
   * @returns Parsed data from the INI file
   */
  private readIni = memoize(readIni, { cache: this._memoCache });

  /**
   * Get the server properties
   *
   * @returns Contents of server.properties file for this instance
   */
  sp(): ServerProperties {
    return (this.readIni(this.env.sp) || {}) as ServerProperties;
  }

  /**
   * Modify or add a single value in the server properties
   *
   * @param property The single property to update or add
   * @param newValue The value to set for the property
   * @returns The complete updated server.properties values
   */
  modifySp(property: string, newValue: any): ServerProperties {
    const currentProps = this.sp();
    currentProps[property] = newValue;
    fs.writeFileSync(this.env.sp, ini.stringify(currentProps));
    this._memoCache.delete(this.env.sp);
    return currentProps;
  }

  /**
   * Modify or add multiple values in the server properties
   *
   * @param overlay Partial or complete server.properties values to set on this instance
   * @returns The complete updated server.properties values
   */
  overlaySp(overlay: ServerProperties): ServerProperties {
    const currentProps = this.sp();
    for (const key of Object.getOwnPropertyNames(overlay)) {
      currentProps[key] = overlay[key];
    }

    fs.writeFileSync(this.env.sp, ini.stringify(currentProps));
    this._memoCache.delete(this.env.sp);
    return currentProps;
  }

  /**
   * Get the server config
   *
   * @returns Contents of server.config file for this instance
   */
  sc(): ServerConfig {
    return (this.readIni(this.env.sc) || {}) as ServerConfig;
  }

  /**
   * Modify or add a single value in the server config
   *
   * @param property The single property to update or add
   * @param newValue The value to set for the property
   * @returns The complete updated server.config values
   */
  modifySc(
    section: keyof ServerConfig,
    property: keyof ServerConfig['java'] | keyof ServerConfig['onreboot'] | keyof ServerConfig['minecraft'],
    newValue: any
  ): ServerConfig {
    const currentProps = this.sc();
    if (currentProps[section]) {
      currentProps[section][property] = newValue;
    } else {
      currentProps[section] = { [property]: newValue } as any;
    }
    fs.writeFileSync(this.env.sc, ini.stringify(currentProps));
    this._memoCache.delete(this.env.sc);
    return currentProps;
  }

  /**
   * Get the cron jobs
   * @returns List of cron configurations for this instance
   */
  crons(): CronConfig {
    return (this.readIni(this.env.cc) || {}) as CronConfig;
  }

  /**
   * Add a disabled cron job
   *
   * @param identifier Hash of the cron task config to add
   * @param config Cron task config to add with schedule and task
   * @returns Current cron configurations including the one just added
   */
  addCron(identifier: string, config: CronTask): CronConfig {
    const currentCron = this.crons();
    currentCron[identifier] = config;
    currentCron[identifier].enabled = false;
    fs.writeFileSync(this.env.cc, ini.stringify(currentCron));
    this._memoCache.delete(this.env.cc);
    return currentCron;
  }

  /**
   * Delete a cron job
   *
   * @param identifier Hash of the cron task config to delete
   * @returns Current cron configurations without the one just removed
   */
  deleteCron(identifier: string): CronConfig {
    const currentCron = this.crons();
    delete currentCron[identifier];
    fs.writeFileSync(this.env.cc, ini.stringify(currentCron));
    this._memoCache.delete(this.env.cc);
    return currentCron;
  }

  /**
   * Enable or disable a cron job
   *
   * @param identifier Hash of the cron job to set status
   * @param enabled Whether the job should run or not
   * @returns Current cron configurations
   */
  setCron(identifier: string, enabled: boolean): CronConfig {
    const currentCron = this.crons();

    if (!(identifier in currentCron)) {
      logger.warn(`cannot enable cron job ${identifier} because it does not exist for instance ${this.name}`);
      return currentCron;
    }

    currentCron[identifier].enabled = enabled;
    fs.writeFileSync(this.env.cc, ini.stringify(currentCron));
    this._memoCache.delete(this.env.cc);
    return currentCron;
  }

  /**
   * Create the necessary folders and files for this instance if they don't already exist
   *
   * @param owner Owner information to use when creating files and folders
   */
  async create(owner: { uid: number; gid: number }, unconventional: boolean = false): Promise<void> {
    if ((await this.exists()) || (await this.isUp())) {
      throw new Error(`instance ${this.name} already exists or is running`);
    }

    // Create server, backup, and archive dirs
    fs.ensureDirSync(this.env.cwd);
    fs.chownSync(this.env.cwd, owner.uid, owner.gid);
    fs.ensureDirSync(this.env.bwd);
    fs.chownSync(this.env.bwd, owner.uid, owner.gid);
    fs.ensureDirSync(this.env.awd);
    fs.chownSync(this.env.awd, owner.uid, owner.gid);

    // Create config files
    fs.ensureFileSync(this.env.sp);
    fs.chownSync(this.env.sp, owner.uid, owner.gid);
    fs.ensureFileSync(this.env.sc);
    fs.chownSync(this.env.sc, owner.uid, owner.gid);
    fs.ensureFileSync(this.env.cc);
    fs.chownSync(this.env.cc, owner.uid, owner.gid);

    if (!unconventional) {
      // Write defaults
      this.overlaySp(SP_DEFAULTS);
      this.modifySc('java', 'java_binary', '');
      this.modifySc('java', 'java_xmx', '256');
      this.modifySc('onreboot', 'start', false);
    } else {
      this.modifySc('minecraft', 'unconventional', true);
    }
  }

  /**
   * Create the necessary folders and files for this instance from a tar archive
   *
   * @param owner Owner information to use when creating files and folders
   * @param filepath Archive path to copy from
   */
  async createFromArchive(owner: { uid: number; gid: number }, filepath: string): Promise<void | void[]> {
    let sourceFilepath: string = '';

    if (filepath.startsWith(path.sep)) {
      // if it starts with a '/', treat it as an absolute path
      sourceFilepath = filepath;
    } else {
      // if it doesn't treat it as being from baseDir/import/
      sourceFilepath = path.join(this.env.baseDir, DIRS['import'], filepath);
    }

    const split = sourceFilepath.split('.');
    let extension = split.pop();

    if (extension === 'gz' && split.pop() === 'tar') {
      extension = 'tar.gz';
    }

    switch (extension) {
      case 'tar.gz':
      case 'tgz':
      case 'tar':
        const binary = which.sync('tar');
        const args = ['-xf', sourceFilepath];
        const params = { cwd: this.env.cwd, uid: owner.uid, gid: owner.gid };

        await this.create(owner);
        return new Promise((resolve, reject) => {
          const proc = child.spawn(binary, args, params);
          proc.once('exit', (code) => {
            if (code) {
              reject(code);
            }

            resolve();
          });
        });
      }

      return Promise.reject(`cannot create instance ${this.name} from archive with unsupported file type ${extension}`);
    }

  /**
   * Delete the files for this instance
   */
  async delete(): Promise<void[]> {
    if (!(await this.exists()) || (await this.isUp())) {
      return Promise.reject(`instance ${this.name} does not exist or is running`);
    }

    const rmOptions = { recursive: true, force: true };
    return await Promise.all([
      fs.promises.rm(this.env.cwd, rmOptions),
      fs.promises.rm(this.env.bwd, rmOptions),
      fs.promises.rm(this.env.awd, rmOptions),
    ]);
  }

  /**
   * Copy files from the selected profile to the instance server directory
   *
   * @returns rsync exit status
   */
  async copyProfile(): Promise<number> {
    const rsyncProfile = async (source: string, dest: string, username: string, groupname: string) => {
      const obj = Rsync.build({
        source: source,
        destination: dest,
        flags: 'au',
        shell: 'ssh',
      });

      obj.set('chown', `${username}:${groupname}`);
      obj.set('chmod', 'ug=rwX');

      return (await obj.execute()) as Promise<number>;
    };

    if (!(await this.exists()) || this.isUp()) {
      return Promise.reject(`instance ${this.name} does not exist or is running`);
    }

    const profilePath = this.sc().minecraft?.profile;

    if (!profilePath) {
      return Promise.reject('profile not set for this instance');
    }

    const ownerInfo = await this.getOwner();
    const source = path.join(this.env.pwd, profilePath) + path.sep;
    const dest = this.env.cwd + path.sep;

    return await rsyncProfile(source, dest, ownerInfo.username, ownerInfo.groupname);
  }

  /**
   * Get a list of files that are in the selected profile but not in the instance directory
   *
   * @param profile Profile name to compare
   * @returns List of files this instance is missing from the profile
   */
  async profileDelta(profile: string): Promise<string[]> {
    const stdout: string[] = [];

    const obj = Rsync.build({
      source: path.join(this.env.pwd, profile) + path.sep,
      destination: this.env.cwd + path.sep,
      flags: 'vrun', // verbose, recursive, skip-remote-newer, dry-run
      shell: 'ssh',
      output: [
        (output) => {
          stdout.push(output);
        }
      ],
    });

    const rsyncStatus = await obj.execute();

    if (rsyncStatus) {
      return Promise.reject(rsyncStatus);
    }

    // Clear off the header and trailer from rsync
    stdout.shift();
    stdout.pop();

    // Clean up output to only filenames
    return stdout.reduce<string[]>((acc: string[], file: string) => {
      if (file.match(/sent \d+ bytes/)) {
        // Skip for known pattern on freebsd: 'sent 79 bytes  received 19 bytes  196.00 bytes/sec'
        return acc;
      }

      acc.push(...file.split('\n').filter((f) => !!f));
      return acc;
    }, []);
  }

  /**
   * Send a query packet to the Minecraft server to get the current stats.
   *
   * @returns Current Minecraft stats
   */
  async ping(): Promise<QueryResponse> {
    const port = Number(this.sp()['server-port']);
    if (!port) {
      return Promise.reject('no server port set for this instance');
    }

    const jarfile = this.sc().java?.jarfile;
    if (jarfile && jarfile.slice(-5).toLowerCase() === '.phar') {
      return Promise.reject('cannot ping instances using .phar executables');
    } else {
      const pids = Instance.listRunningInstancePids();
      if (!(this.name in pids)) {
        return Promise.reject('instance not running');
      }
    }

    /**
     * Send a Minecraft query packet to the given port and wait for a response
     *
     * @param port Port number
     */
    const sendQueryPacket = async (port: number): Promise<QueryResponse> => {
      return await new Promise((resolve, reject) => {
        const socket = new net.Socket();
        const query = '\xfe\x01';

        socket.setTimeout(2500);

        socket.on('connect', () => {
          const buf = Buffer.alloc(2);

          buf.write(query, 0, query.length, 'binary');
          socket.write(buf);
        });

        socket.on('data', (data) => {
          socket.end();

          const legacySplit = splitBuffer(data, 0x00a7);
          const modernSplit = data.subarray(3).swap16().toString('ucs2').split('\x00').splice(1);

          if (modernSplit.length === 5) {
            // modern ping to modern server
            resolve({
              protocol: parseInt(modernSplit[0]),
              serverVersion: modernSplit[1],
              motd: modernSplit[2],
              playersOnline: parseInt(modernSplit[3]),
              playersMax: parseInt(modernSplit[4]),
            });
          } else if (legacySplit.length === 3) {
            if (String.fromCharCode(legacySplit[0][-1]) === '\u0000') {
              // modern ping to legacy server
              resolve({
                serverVersion: '',
                motd: bufferToAscii(legacySplit[0].subarray(3, legacySplit[0].length - 1)),
                playersOnline: parseInt(bufferToAscii(legacySplit[1])),
                playersMax: parseInt(bufferToAscii(legacySplit[2])),
              });
            }
          }
        });

        socket.on('error', (err) => {
          logger.error(`ping: MC Server ${this.name} not available on port ${port}`);
          //logger.debug('error', err);}
          reject(err);
        });

        socket.connect({ port: port });
      });
    };

    return await sendQueryPacket(port);
  }

  /**
   * Query the Minecraft process for the full stats information
   *
   * @returns The fully query stats from the Minecraft server: https://wiki.vg/Query#Full_stat
   */
  async query(): Promise<MinecraftFullStats> {
    const jarfile = this.sc().java?.jarfile;
    if (!jarfile) {
      return Promise.reject('jarfile not set');
    } else if (jarfile.slice(-5).toLocaleLowerCase() === '.phar') {
      return Promise.reject('cannot query instances using .phar executables');
    }

    const port = this.sp()['server-port'];

    const query = new mcquery('localhost', port);
    await query.connect();

    return await new Promise((resolve, reject) => {
      query.full_stat((err, stat) => {
        if (err) {
          reject(err);
        }

        resolve(stat);
      });
    });
  }

  /**
   * Send a command to the Minecraft process
   *
   * @param command Command to send
   */
  async stuff(command: string): Promise<string> {
    const params = {
      cwd: this.env.cwd,
      ...(await this.getOwner()),
    };
    const binary = which.sync('screen');

    if (!(await this.exists()) || !this.isUp()) {
      throw new Error(`instance ${this.name} does not exist or is not running`);
    }

    return child
      .execFileSync(binary, ['-S', `mc-${this.name}`, '-p', '0', '-X', 'eval', `stuff "${command}\x0a"`], params)
      .toString('utf-8');
  }

  /**
   * Start the instance
   */
  async start(): Promise<void> {
    if (!(await this.exists()) || this.isUp()) {
      return Promise.reject(`instance ${this.name} does not exist or is already running`);
    }

    const owner = await this.getOwner();
    const profileStatus = await this.profileDelta(this.sc().minecraft?.profile || '').catch((err) => {
      if (err === 23) {
        // source dir of profile non-existent
        // ignore issue; only server_jar is required to start
        return [];
      }

      throw err;
    });

    if (profileStatus.length > 0) {
      await this.copyProfile();
    }

    const binary = which.sync('screen');
    const params = { cwd: this.env.cwd, uid: owner.uid, gid: owner.gid };

    const proc = child.spawn(binary, this.getStartArgs(), params);
    return await new Promise<void>((resolve, reject) => {
      proc.once('close', (code) => {
        if (code) {
          reject(code);
        }
        resolve();
      });

      // Wait 2 seconds for the server to be considered "up"
      setTimeout(resolve, 2000);
    });
  }

  /**
   * Stop the instance by sending the stop command
   */
  async stop(): Promise<void> {
    const interval = 200;
    let iterations = 0;
    const MAX_ITERATIONS_TO_QUIT = 150;

    if (!(await this.exists())) {
      return Promise.reject(`instance ${this.name} does not exist`);
    }

    if(!this.isUp()) {
      return;
    }

    await this.stuff('stop');
    while (iterations < MAX_ITERATIONS_TO_QUIT) {
      const running = await new Promise((resolve) => {
        setTimeout(() => resolve(this.name in Instance.listRunningInstancePids()), interval);
      });

      if (!running) {
        return;
      }
      iterations++;
    }
    return Promise.reject(
      `instance ${this.name} did not stop after ${((interval * MAX_ITERATIONS_TO_QUIT) / 1000).toFixed(1)} seconds`
    );
  }

  /**
   * Kill the java process for this instance
   */
  async kill(): Promise<void> {
    if (!(await this.exists())) {
      return Promise.reject(`instance ${this.name} does not exist`);
    }

    const pids = Instance.listRunningInstancePids();

    if (!(this.name in pids)) {
      return;
    } else {
      const javaPid = pids[this.name].java;
      if (!javaPid) {
        return Promise.reject(`instance ${this.name} has no java process to kill`);
      }

      process.kill(javaPid, 'SIGKILL');

      const interval = 200;
      const MAX_ITERATIONS_TO_QUIT = 150;
      let iterations = 0;

      while (iterations < MAX_ITERATIONS_TO_QUIT) {
        const running = await new Promise((resolve) => {
          setTimeout(() => resolve(this.name in Instance.listRunningInstancePids()), interval);
        });

        if (!running) {
          return;
        }

        iterations++;
      }
      return Promise.reject(
        `instance ${this.name} did not stop after ${((interval * MAX_ITERATIONS_TO_QUIT) / 1000).toFixed(1)} seconds`
      );
    }
  }

  /**
   * Restart the instance
   */
  async restart(): Promise<void> {
    await this.stop();
    return await this.start();
  }

  /**
   * Stop the instance and run a backup
   */
  async stopAndBackup(): Promise<void> {
    await this.stop();
    return await this.backup();
  }

  /**
   * Send a save command to the Minecraft process
   *
   * @param delay Seconds to wait
   */
  async saveall(delay: number = 5): Promise<void> {
    if (!(await this.exists()) || !this.isUp()) {
      return Promise.reject(`instance ${this.name} does not exist or is not running`);
    }
    await this.stuff('save-all');
    return await new Promise<void>((resolve) => {
      setTimeout(() => resolve(), delay * 1000);
    });
  }

  /**
   * Send a save command to the Minecraft process and watch the server log to make sure it saves
   *
   * @returns True if the server was able to
   */
  async saveallLatestLog(): Promise<void> {
    if (!(await this.exists()) || !this.isUp()) {
      return Promise.reject(`instance ${this.name} does not exist or is not running`);
    }

    const TIMEOUT_LENGTH = 10 * 1000;
    let tail: Tail;

    return await new Promise<void>((resolve, reject) => {
      try {
        tail = new Tail(path.join(this.env.cwd, 'logs/latest.log'));
      } catch (e) {
        reject(`could not create tail on logs/latest.log for instance ${this.name}`);
      }

      tail.on('line', (data) => {
        const match = data.match(/INFO]: Saved the world/);
        if (match) {
          //previously on, return true
          clearTimeout(timeout);
          tail.unwatch();
          resolve();
        }
      });

      this.stuff('save-all');

      const timeout = setTimeout(() => {
        tail.unwatch();
        reject(`timeout waiting for instance ${this.name} to save`);
      }, TIMEOUT_LENGTH);
    });
  }

  /**
   * Create a tar archive of the instance
   *
   * @param forceSave Force the server to save before archiving
   * @returns
   */
  async archive(forceSave: boolean = false): Promise<void> {
    const binary = which.sync('tar');
    const filename = `server-${this.name}_${strftime('%Y-%m-%d_%H-%M-%S')}.tgz`;
    const args = ['czf', path.join(this.env.awd, filename), '.'];

    const owner = await this.getOwner();
    const params = { cwd: this.env.cwd, uid: owner.uid, gid: owner.gid };
    const autosave = await this.getAutosaveState();

    if (forceSave) {
      try {
        await this.stuff('save-off');
        await this.saveallLatestLog();
      } catch (e) {
        // We can still archive if the server isn't running
        logger.warn(`could not force save ${this.name} before archiving:`, e);
      }
    }

    const proc = child.spawn(binary, args, params);
    return await new Promise<void>((resolve, reject) => {
      proc.once('exit', (code) => {
        if (forceSave && autosave) {
          this.stuff('save-on');
        }

        if (code) {
          return reject(code);
        }
        resolve();
      });
    });
  }

  /**
   * Create an rdiff-backup incerement of the instance
   */
  async backup(): Promise<void> {
    const binary = which.sync('rdiff-backup');
    const args = ['--exclude', path.join(this.env.cwd, 'dynmap'), `${this.env.cwd}/`, this.env.bwd];
    const owner = await this.getOwner();
    const params = { cwd: this.env.bwd, uid: owner.uid, gid: owner.gid };

    return await new Promise((resolve, reject) => {
      const proc = child.spawn(binary, args, params);
      proc.once('exit', (code) => {
        if (code) {
          return reject(code);
        }
        resolve();
      });
    });
  }

  /**
   * Restore an rdiff-backup increment of the instance
   *
   * @param step Increment to restore
   */
  async restore(step: number): Promise<void> {
    const binary = which.sync('rdiff-backup');
    const args = ['--restore-as-of', `${step}`, '--force', this.env.bwd, this.env.cwd];
    const params = { cwd: this.env.bwd };

    return await new Promise((resolve, reject) => {
      const proc = child.spawn(binary, args, params);
      proc.once('exit', (code) => {
        if (code) {
          return reject(code);
        }
        resolve();
      });
    });
  }

  /**
   * Get the contents of a a file as it was in a previous backup increment
   *
   * @param filename File to read from the backup
   * @param increment rdiff-backup increment number to get file from
   * @returns
   */
  async previousVersion(filename: string, increment: number): Promise<string> {
    const binary = which.sync('rdiff-backup');
    const absFilepath = path.join(this.env.bwd, filename);

    return await new Promise((resolve, reject) => {
      tmp.file((err, newFilepath) => {
        if (err) {
          return reject(err);
        }

        const args = ['--force', '--restore-as-of', `${increment}`, absFilepath, newFilepath];
        const params = { cwd: this.env.bwd };
        const proc = child.spawn(binary, args, params);

        proc.on('error', (code) => {
          reject(code);
        });

        proc.on('exit', (code) => {
          if (code === 0) {
            fs.readFile(newFilepath, (inErr, data) => {
              if (inErr) {
                reject(inErr);
                return;
              }

              resolve(data.toString());
            });
          } else {
            reject(code);
          }
        });
      });
    });
  }

  /**
   * Get the list of backup increments for this instance
   *
   * @returns List of increments ordered by date desc
   */
  async listIncrements(): Promise<IncrementListItem[]> {
    const binary = which.sync('rdiff-backup');
    const args = ['--list-increments', this.env.bwd];
    const params = { cwd: this.env.bwd };

    // Increment entry looks like:
    // increments.2024-08-12T00:15:00Z.dir   Mon Aug 12 00:15:00 2024
    const regex = /^.+ +(\w{3} \w{3} {1,2}\d{1,2} \d{2}:\d{2}:\d{2} \d{4})/;
    const increments: IncrementListItem[] = [];

    return await new Promise((resolve, reject) => {
      const rdiff = child.spawn(binary, args, params);

      rdiff.stdout.on('data', (data) => {
        const buffer = Buffer.from(data, 'ascii');
        // Force increments into consistent order - date desc
        const lines = buffer.toString('ascii').split('\n').sort().reverse();
        let incrs = 0;

        for (let i = 0; i < lines.length; i++) {
          const match = lines[i].match(regex);
          if (match) {
            increments.push({
              step: `${incrs}B`,
              time: match[1],
              size: '',
              cum: '',
            });
            incrs += 1;
          }
        }
      });

      rdiff.on('error', (code) => {
        if (code) {
          // branch if path does not exist
          reject(code);
        }
      });

      rdiff.on('exit', (code) => {
        if (code === 0) {
          // branch if all is well
          resolve(increments);
        } else {
          // branch if dir exists, not an rdiff-backup dir
          reject(code);
        }
      });
    });
  }

  /**
   * Get the list of backup increments for this instance with their sizes
   *
   * @returns List of increments with size information ordered by date desc
   */
  async listIncrementSizes(): Promise<IncrementListItem[]> {
    const binary = which.sync('rdiff-backup');
    const args = ['--list-increment-sizes', this.env.bwd];
    const params = { cwd: this.env.bwd };

    // Increment entry looks like:
    // Mon Aug 12 16:15:00 2024         1.81 GB           1.81 GB   (current mirror)
    const regex = /^(\w.*?) {3,}(.*?) {2,}([^ ]+ \w*)/;
    const increments: IncrementListItem[] = [];

    return await new Promise((resolve, reject) => {
      const rdiff = child.spawn(binary, args, params);

      rdiff.stdout.on('data', (data) => {
        const buffer = Buffer.from(data, 'ascii');
        const lines = buffer
          .toString('ascii')
          .split('\n')
          .reduce<RegExpMatchArray[]>((acc, line) => {
            const match = line.match(regex);
            if (!match) {
              return [];
            }

            acc.push(match);
            return acc;
          }, [])
          // Force increments into consistent order - date desc
          .sort((a, b) => Date.parse(b[1]) - Date.parse(a[1]));
        let incrs = 0;

        for (let i = 0; i < lines.length; i++) {
          const match = lines[i];
          if (match) {
            increments.push({
              step: `${incrs}B`,
              time: match[1],
              size: match[2],
              cum: match[3],
            });
            incrs += 1;
          }
        }
      });

      rdiff.on('error', (code) => {
        if (code) {
          // branch if path does not exist
          reject(code);
        }
      });

      rdiff.on('exit', (code) => {
        if (code === 0) {
          // branch if all is well
          resolve(increments);
        } else {
          // branch if dir exists, not an rdiff-backup dir
          reject(code);
        }
      });
    });
  }

  /**
   * Get all archive files for this instance
   *
   * @returns List of archive files sorted by date desc
   */
  async listArchives(): Promise<ArchiveListItem[]> {
    const awd = this.env['awd'];
    const archiveFiles: ArchiveListItem[] = [];

    const files = await fs.promises.readdir(awd);
    await Promise.all(
      files.map(async (file) => {
        const statInfo = await fs.promises.stat(path.join(awd, file));
        archiveFiles.push({
          time: statInfo.mtime,
          size: statInfo.size,
          filename: file,
        });
      })
    );

    return archiveFiles.sort((a, b) => b.time.getTime() - a.time.getTime());
  }

  /**
   * Delete backup increments older than a given increment
   *
   * @param step Increment number to prune backups older than
   */
  async prune(step: number): Promise<void> {
    const binary = which.sync('rdiff-backup');
    const args = ['--force', '--remove-older-than', `${step}`, this.env.bwd];
    const params = { cwd: this.env.bwd };

    return await new Promise((resolve, reject) => {
      const proc = child.spawn(binary, args, params);

      proc.on('error', (code) => {
        if (code) {
          // branch if path does not exist
          reject(code);
        }
      });

      proc.on('exit', (code) => {
        if (code === 0) {
          // branch if all is well
          resolve();
        } else {
          // branch if dir exists, not an rdiff-backup dir
          reject(code);
        }
      });
    });
  }

  /**
   * Delete an archive copy of this isntance
   *
   * @param filename Archive file to delete
   */
  async deleteArchive(filename: string): Promise<void> {
    const archiveFiles = path.join(this.env['awd'], filename);

    return await new Promise((resolve, reject) => {
      fs.remove(archiveFiles, (err) => {
        if (err) {
          reject(err);
        }
        resolve();
      });
    });
  }

  /**
   * Get the user and group of the instance root directory
   *
   * @returns Owner and group information for this instance
   */
  async getOwner(): Promise<{ uid: number; gid: number; username: string; groupname: string }> {
    return await fs.promises.stat(this.env.cwd).then((statData) => ({
      uid: statData.uid,
      gid: statData.gid,
      username: userid.username(statData.uid),
      groupname: userid.groupname(statData.gid),
    }));
  }

    /**
   * Get the startup arguments for this instance
   *
   * @returns Arguments to pass to screen to start the server
   */
    getStartArgs(): string[] {
      const jar = (unconventional: boolean = false): string[] => {
        const systemJava = which.sync('java');
        const javaConfig = this.sc().java;
        const javaArgs = {
          binary: javaConfig?.java_binary || systemJava,
          xmx: parseInt(javaConfig?.java_xmx) || 0,
          xms: parseInt(javaConfig?.java_xms) || 0,
          jarfile: javaConfig?.jarfile,
          jar_args: javaConfig?.jar_args || '',
          java_tweaks: javaConfig?.java_tweaks || null,
        };

        if (!javaArgs.binary) {
          throw new Error('no java binary assigned for instance');
        }

        if (javaArgs.xmx <= 0) {
          throw new Error('Xmx heapsize must be positive integer >= 0');
        }

        if (javaArgs.xmx < javaArgs.xms || javaArgs.xms <= 0) {
          throw new Error('Xms heapsize must be positive integer where Xmx >= Xms >= 0');
        }

        if (!javaArgs.jarfile) {
          throw new Error('instance not assigned a runnable jar');
        }

        const screenArgs = ['-dmS', `mc-${this.name}`, javaArgs.binary, '-server'];

        if (javaArgs.xmx) {
          screenArgs.push(`-Xmx${javaArgs.xmx}M`);
        }
        if (javaArgs.xms) {
          screenArgs.push(`-Xms${javaArgs.xms}M`);
        }

        if (javaArgs.java_tweaks) {
          screenArgs.push(...javaArgs.java_tweaks.split(' '));
        }

        screenArgs.push('-jar', javaArgs.jarfile);

        screenArgs.push(...javaArgs.jar_args.split(' '));

        if (!unconventional && javaArgs.jarfile.match(/forge.*installer.jar$/)) {
          screenArgs.push('--installServer');
        }

        return screenArgs;
      };

      const phar = (): string[] => {
        let binary: string;

        try {
          const php7 = path.join(this.env.cwd, '/bin/php7/bin/php');
          fs.accessSync(php7, constants.F_OK);
          binary = './bin/php7/bin/php';
        } catch (e) {
          binary = './bin/php5/bin/php';
        }

        const pharFile = this.sc().java?.jarfile;
        if (!pharFile) {
          throw new Error('instance not assigned a runnable phar');
        }

        return ['-dmS', `mc-${this.name}`, binary, pharFile];
      };

      const cuberite = (): string[] => {
        return ['-dmS', `mc-${this.name}`, './Cuberite'];
      };

      const sc = this.sc();
      const jarfile = sc.java?.jarfile;
      const unconventional = sc.minecraft?.unconventional;

      if (!jarfile) {
        throw new Error('Cannot start instance without a designated jar/phar');
      } else if (jarfile.slice(-4).toLowerCase() === '.jar') {
        return jar(unconventional);
      } else if (jarfile.slice(-5).toLowerCase() === '.phar') {
        return phar();
      } else if (jarfile === 'Cuberite') {
        return cuberite();
      }

      throw new Error(`unknown jar type ${jarfile}`);
    }

  /**
   *
   * @param uid
   * @param gid
   * @returns
   */
  async chown(uid: number, gid: number): Promise<void[]> {
    if (!(await existsOnSystem(uid, gid)).every((t) => t)) {
      return Promise.reject(`uid ${uid} or gid ${gid} does not exist`);
    } else if (!(await this.exists())) {
      return Promise.reject(`instance ${this.name} does not exist`);
    }

    return await Promise.all(
      [this.env.cwd, this.env.bwd, this.env.awd].map(
        (path) =>
          new Promise<void>((resolve, reject) => {
            chownr(path, uid, gid, (err) => {
              if (err) {
                reject(err);
                return;
              }
              resolve();
            });
          })
      )
    );
  }

  /**
   * Recursively set the ownership of the archive, backup, and instance folders to the
   * owner and group of the instance folder.
   *
   * Duplicates functionality of chown because it does not assume sp existence
   */
  async fixOwnership(): Promise<void[]> {
    const { uid, gid } = await fs.promises.stat(this.env.cwd);
    await Promise.all([this.env.bwd, this.env.awd].map((path) => fs.ensureDir(path)));
    return await Promise.all(
      [this.env.cwd, this.env.bwd, this.env.awd].map(
        (path) =>
          new Promise<void>((resolve, reject) => {
            chownr(path, uid, gid, (err) => {
              if (err) {
                reject(err);
                return;
              }
              resolve();
            });
          })
      )
    );
  }

  /**
   * Run the FTB Installer script
   */
  async runInstaller(): Promise<void> {
    if (!(await this.exists()) || !this.isUp()) {
      return Promise.reject(`instance ${this.name} does not exist or is not running`);
    }

    const args = ['FTBInstall.sh'];
    const owner = await this.getOwner();
    const params = { cwd: this.env.cwd, uid: owner.uid, gid: owner.gid };
    const binary = await which('sh');

    return await new Promise((resolve, reject) => {
      const proc = child.spawn(binary, args, params);
      proc.once('close', (code) => {
        if (code) {
          reject(code);
          return;
        }

        resolve();
      });
    });
  }

  /**
   * Set the process priority to a new relative value
   *
   * @param priority Process priority
   */
  async renice(priority: string): Promise<void> {
    const javaPid = this.getChildPid('java');
    if (!(await this.exists()) || !this.isUp() || !javaPid) {
      return Promise.reject(`instance ${this.name} does not exist or is not running`);
    }

    const owner = await this.getOwner();
    const params = { cwd: this.env.cwd, uid: owner.uid, gid: owner.gid };
    const binary = which.sync('renice');
    return await new Promise((resolve, reject) => {
      const proc = child.spawn(binary, ['-n', priority, '-p', `${javaPid}`], params);
      proc.once('close', (err) => {
        if (err) {
          return reject(err);
        }
        resolve();
      });
    });
  }

  /**
   * Get the status of the current server by checking if server.properties exists
   *
   * @returns True if server.properties exists, false otherwise
   */
  async exists(): Promise<boolean> {
    return await fs.promises.stat(this.env.sp).then((statData) => !!statData).catch(() => false);
  }

  /**
   * Check if this instance is currently running by inspecing the running process list
   *
   * @returns If the current instance exists in the list of running instance PIDs
   */
  isUp(): boolean {
    return this.name in Instance.listRunningInstancePids();
  }

  /**
   * Get the process ID for one this instances' child processes (screen or java)
   *
   * @param process Which child process to look for
   * @returns The PID for the requested process if it is running. undefined if no matching process is found
   */
  getChildPid(process: 'java' | 'screen'): number | undefined {
    const pids = Instance.listRunningInstancePids();
    switch (process) {
      case 'java':
        return pids[this.name]?.java;
      case 'screen':
        return pids[this.name]?.screen;
    }
  }

  /**
   * Get the process statistics including memory usage for the java child process of this instance
   *
   * @returns Process stats for the java child process of this instance
   */
  async getJavaProcessStats(): Promise<procfs.Status> {
    const pids = Instance.listRunningInstancePids();
    if (this.name in pids) {
      return await new Promise((resolve, reject) => {
        const ps = procfs(Number(pids[this.name].java));

        ps.status((err, data) => {
          if (err) {
            reject(err);
          }
          resolve(data);
        });
      });
    } else {
      return Promise.reject();
    }
  }

  /**
   * Get the disk usage of one of this instances' folders.
   *
   * @param dir Which directory to check the usage of: archive, backup, or working
   * @returns Size in
   */
  async du(dir: 'awd' | 'bwd' | 'cwd'): Promise<number> {
    let filepath;
    switch (dir) {
      case 'awd':
        filepath = this.env.awd;
        break;
      case 'bwd':
        filepath = this.env.bwd;
        break;
      case 'cwd':
        filepath = this.env.cwd;
        break;
      default:
        return Promise.reject(`invalid directory: ${dir}`);
    }

    const TIMEOUT = 3 * 1000; // Default to 3s timeout
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject('timeout getting directory usage');
      }, TIMEOUT);

      du(filepath, { disk: true }, (err, size) => {
        clearTimeout(timer);

        if (err) {
          reject(err);
        }

        resolve(Number(size));
      });
    });
  }

  /**
   * Check if this instance has the eula.txt file for the Minecrafte server EULA and it has been accepted
   *
   * @returns Whether or not this instance has accepted the Minecraft server EULA
   */
  async eulaStatus(): Promise<boolean> {
    return await fs.promises.readFile(path.join(this.env.cwd, 'eula.txt')).then((data) => {
      const REGEX_EULA_TRUE = /eula\s*=\s*true/i;
      const lines = data.toString().split('\n');
      let matches = false;
      for (const i in lines) {
        if (lines[i].match(REGEX_EULA_TRUE)) matches = true;
      }
      return matches;
    });
  }

  /**
   * Accept the Minecraft server EULA by creating eula.txt with the contents 'eula=true'
   */
  async acceptEula() {
    const EULA_PATH = path.join(this.env.cwd, 'eula.txt');
    await fs.outputFile(EULA_PATH, 'eula=true');

    const dirStat = await fs.promises.stat(this.env.cwd);
    return await fs.promises.chown(EULA_PATH, dirStat.uid, dirStat.gid);
  }

  /**
   * Get the list of potentially runnable server files to set in server.config
   *
   * @returns The list of potentially runnable server jar or phar files
   */
  async getRunnableJarFiles(): Promise<string[]> {
    const reducer = (acc: { [key: string]: boolean }, f: string) => {
      if (f.slice(-4).toLowerCase() === '.jar' || f.slice(-5).toLowerCase() === '.phar' || f === 'Cuberite') {
        acc[f] = true;
      }
      return acc;
    };

    // Get the list of files copied into the server directory
    let serverFiles = (await fs.promises.readdir(this.env.cwd)).reduce(reducer, {});

    // If a profile is set, also get the the list of files from the profile
    const scProfile = this.sc().minecraft.profile;
    if (scProfile) {
      const profileDir = path.join(this.env.pwd, scProfile);
      serverFiles = {
        ...serverFiles,
        ...(await fs.promises.readdir(profileDir)).reduce(reducer, {}),
      };
    }

    return Object.getOwnPropertyNames(serverFiles);
  }

  /**
   * Get the autosave state of the current instance by attempting to enable it and inspecting the log
   *
   * @returns True if autosave is enabled or not supported by this instance, false otherwise
   */
  async getAutosaveState(): Promise<boolean> {
    return await new Promise((resolve) => {
      const newTail = new Tail(path.join(this.env.cwd, 'logs/latest.log'));

      const timeout = setTimeout(() => {
        newTail.unwatch();
        resolve(true); //default to true for unsupported server functionality fallback
      }, 2 * 1000); // TODO magic number?

      newTail.on('line', async (data) => {
        if (data.match(/INFO]: Saving is already turned on/)) {
          //previously on, return true
          clearTimeout(timeout);
          newTail.unwatch();
          resolve(true);
        }
        if (data.match(/INFO]: Turned on world auto-saving/)) {
          //previously off, return false
          clearTimeout(timeout);
          newTail.unwatch();

          this.stuff('save-off');
          resolve(false); //return initial state
        }
      });

      this.stuff('save-on');
    });
  }

  /**
   * Indicate whether or not this instance is an FTB server based on the presense of FTBInstall.sh
   *
   * @returns True if FTBInstall.sh exists which indicates this is an FTB server, false otherwise
   */
  async isFTBServer(): Promise<boolean> {
    return !!(await fs.promises.stat(path.join(this.env.cwd, 'FTBInstall.sh')));
  }
}
