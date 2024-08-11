import child from 'child_process';
import du from 'du';
import fs from 'fs-extra';
import ini from 'ini';
import mcquery from 'mcquery';
import net from 'net';
import path from 'node:path';
import procfs from 'procfs-stats';
import { Tail } from 'tail';
import userid from 'userid';
import which from 'which';

import { Logger } from './lib/logger';
import memoize from './lib/memoize';
import { bufferToAscii, type MinecraftFullStats, readIni, splitBuffer, swapBytes } from './lib/util';

import { DIRS, ServerProperties, ServerConfig, CronConfig, CronTask, SP_DEFAULTS } from './constants';

const logger = Logger('instance');

const proc_paths = ['/proc', '/usr/compat/linux/proc', '/system/lxproc', '/compat/linux/proc'];
let PROC_PATH: string;

for (const proc in proc_paths) {
  logger.debug(`checking ${proc} for process stats`);
  try {
    fs.statSync(path.join(proc_paths[proc], 'uptime'));
    PROC_PATH = proc_paths[proc];
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
      const screen_match = SCREEN_REGEX.exec(cmdline);
      if (screen_match) {
        if (screen_match[1] in instances) {
          // Instance already exists, update PID
          instances[screen_match[1]]['screen'] = parseInt(pids[i]);
        } else {
          // Add entry for instance
          instances[screen_match[1]] = { screen: parseInt(pids[i]) };
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

        const java_match = JAVA_REGEX.exec(environ);
        if (java_match) {
          if (java_match[1] in instances) {
            // Instance already exists, update PID
            instances[java_match[1]]['java'] = parseInt(pids[i]);
          } else {
            // Add entry for instance
            instances[java_match[1]] = { java: parseInt(pids[i]) };
          }
        }
      }
    }
    return instances;
  }

  /**
   * Get the instance name from a longer path string
   *
   * @param path Path to extract instance name from
   * @param baseDir Base directory string (default: 'servers')
   * @returns Instance name, if one is found
   * @throws Error if no match is found
   */
  static extractInstanceName(path: string, baseDir: string = DIRS.servers): string {
    const re = new RegExp(`${baseDir}/([a-zA-Z0-9_.]+)`);
    const matches = re.exec(path);
    if (matches) {
      return matches[1];
    } else {
      throw new Error(`no instance name in ${path}`);
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
    return this.readIni(this.env.sp) as ServerProperties;
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
  overlaySp(overlay: ServerProperties) {
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
    return this.readIni(this.env.sc) as ServerConfig;
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
    return this.readIni(this.env.cc) as CronConfig;
  }

  /**
   * Add a disabled cron job
   *
   * @param identifier Hash of the cron task config to add
   * @param config Cron task config to add with schedule and task
   * @returns Current cron configurations including the one just added
   */
  addCron(identifier: string, config: CronTask) {
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
      return new Promise((res, rej) => {
        const socket = new net.Socket();
        const query = 'modern';
        const QUERIES = {
          modern: '\xfe\x01',
          legacy:
            '\xfe' +
            '\x01' +
            '\xfa' +
            '\x00\x06' +
            '\x00\x6d\x00\x69\x00\x6e\x00\x65\x00\x6f\x00\x73' +
            '\x00\x19' +
            '\x49' +
            '\x00\x09' +
            '\x00\x6c\x00\x6f\x00\x63\x00\x61\x00\x6c\x00\x68' +
            '\x00\x6f\x00\x73\x00\x74' +
            '\x00\x00\x63\xdd',
        };

        socket.setTimeout(2500);

        socket.on('connect', () => {
          const buf = Buffer.alloc(2);

          buf.write(QUERIES[query], 0, QUERIES[query].length, 'binary');
          socket.write(buf);
        });

        socket.on('data', (data) => {
          socket.end();

          const legacy_split = splitBuffer(data, 0x00a7);
          const modern_split = swapBytes(data.subarray(3)).toString('ucs2').split('\u0000').splice(1);

          if (modern_split.length == 5) {
            // modern ping to modern server
            res({
              protocol: parseInt(modern_split[0]),
              serverVersion: modern_split[1],
              motd: modern_split[2],
              playersOnline: parseInt(modern_split[3]),
              playersMax: parseInt(modern_split[4]),
            });
          } else if (legacy_split.length == 3) {
            if (String.fromCharCode(legacy_split[0][-1]) == '\u0000') {
              // modern ping to legacy server
              res({
                serverVersion: '',
                motd: bufferToAscii(legacy_split[0].subarray(3, legacy_split[0].length - 1)),
                playersOnline: parseInt(bufferToAscii(legacy_split[1])),
                playersMax: parseInt(bufferToAscii(legacy_split[2])),
              });
            }
          }
        });

        socket.on('error', (err) => {
          logger.error(`ping: MC Server not available on port ${port}`);
          //logger.debug(err);
          //logger.debug(err.stack);
          rej(err);
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
    } else if (jarfile.slice(-5).toLocaleLowerCase() == '.phar') {
      return Promise.reject('cannot query instances using .phar executables');
    }

    const port = this.sp()['server-port'];

    const query = new mcquery('localhost', port);
    await query.connect();

    return await new Promise((res, rej) => {
      query.full_stat((err, stat) => {
        if (err) {
          rej(err);
        }

        res(stat);
      });
    });
  }

  async create(owner: { uid: number; gid: number }) {
    if ((await this.isCreated()) || (await this.isUp())) {
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

    // Write defaults
    this.overlaySp(SP_DEFAULTS);
    this.modifySc('java', 'java_binary', '');
    this.modifySc('java', 'java_xmx', '256');
    this.modifySc('onreboot', 'start', false);
  }

  /**
   * Send a command to the Minecraft console
   *
   * @param command Command to send
   */
  async stuff(command: string): Promise<string> {
    const params = {
      cwd: this.env.cwd,
      ...(await this.getOwner()),
    };
    const binary = await which('screen');

    if (!(await this.isCreated()) && (await this.isUp())) {
      throw new Error(`instance ${this.name} does not exist or is not running`);
    }

    return child
      .execFileSync(binary, ['-s', `mc-${this.name}`, '-p', '0', '-X', 'eval', `stuff "${command}\x0a"`], params)
      .toString('utf-8');
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
   * Get the status of the current server by checking if server.properties exists
   *
   * @returns True if server.properties exists, false otherwise
   */
  async isCreated(): Promise<boolean> {
    return await fs.promises.stat(this.env.sp).then((statData) => !!statData);
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
      return await new Promise((res, rej) => {
        const ps = procfs(Number(pids[this.name].java));

        ps.status((err, data) => {
          if (err) {
            rej(err);
          }
          res(data);
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
    let path;
    switch (dir) {
      case 'awd':
        path = this.env.awd;
        break;
      case 'bwd':
        path = this.env.bwd;
        break;
      case 'cwd':
        path = this.env.cwd;
        break;
      default:
        return Promise.reject(`invalid directory: ${dir}`);
    }

    const TIMEOUT = 3 * 1000; // Default to 3s timeout
    return await new Promise((res, rej) => {
      const timer = setTimeout(() => {
        rej('timeout getting directory usage');
      }, TIMEOUT);

      du(path, { disk: true }, (err, size) => {
        clearTimeout(timer);

        if (err) {
          rej(err);
        }

        res(Number(size));
      });
    });
  }

  /**
   * Check if this instance has the eula.txt file for the Minecrafte server EULA and it has been accepted
   *
   * @returns Whether or not this instance has accepted the Minecraft server EULA
   */
  async eulaAccepted(): Promise<boolean> {
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
   * Get the list of potentially runnable server files to set in server.config
   *
   * @returns The list of potentially runnable server jar or phar files
   */
  async getRunnableJarFiles(): Promise<string[]> {
    const reducer = (acc: { [key: string]: boolean }, f: string) => {
      if (f.slice(-4).toLowerCase() == '.jar' || f.slice(-5).toLowerCase() == '.phar' || f === 'Cuberite') {
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
    return await new Promise((res) => {
      const new_tail = new Tail(path.join(this.env.cwd, 'logs/latest.log'));

      const timeout = setTimeout(() => {
        new_tail.unwatch();
        res(true); //default to true for unsupported server functionality fallback
      }, 2 * 1000); // TODO magic number?

      new_tail.on('line', async (data) => {
        if (data.match(/INFO]: Saving is already turned on/)) {
          //previously on, return true
          clearTimeout(timeout);
          new_tail.unwatch();
          res(true);
        }
        if (data.match(/INFO]: Turned on world auto-saving/)) {
          //previously off, return false
          clearTimeout(timeout);
          new_tail.unwatch();

          this.stuff('save-off');
          res(false); //return initial state
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
