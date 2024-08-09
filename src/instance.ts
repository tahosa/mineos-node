import child from 'child_process';
import du from 'du';
import fs from 'fs-extra';
import ini from 'ini';
import memoize from 'memoize';
import path from 'node:path';
import procfs from 'procfs-stats';
import { Tail } from 'tail';
import userid from 'userid';
import which from 'which';

import { DIRS, ServerProperties, ServerConfig, CronConfig, CronTask, SP_DEFAULTS } from './constants.js';
import { Logger } from './logger.js';
import { readIni } from './util.js';
import { usedJavaVersion } from './java.js';

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
    logger.error(`path ${proc} does not exist, skipping`);
  }
}

type MemoKeys = 'server.properties' | 'server.config';
type EnvKeys = 'baseDir' | 'cwd' | 'bwd' | 'awd' | 'pwd' | 'sp' | 'sc' | 'cc';
type Properties =
  | 'owner'
  | 'owner_uid'
  | 'owner_gid'
  | 'exists'
  | '!exists'
  | 'up'
  | '!up'
  | 'java_pid'
  | 'screen_pid'
  | 'server-port'
  | 'server-ip'
  | 'memory'
  | 'ping'
  | 'query'
  | 'server.properties'
  | 'server.config'
  | 'du_awd'
  | 'du_bwd'
  | 'du_cwd'
  | 'broadcast'
  | 'onreboot_start'
  | 'unconventional'
  | 'commit_interval'
  | 'eula'
  | 'server_files'
  | 'autosave'
  | 'FTBInstall.sh'
  | 'java_version_in_use';

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
        logger.warn(`error reading or parsing ${PROC_PATH}/${pids[i]}/cmdline`);
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

        // Could not find a SCREEN process, check for JAVA
        try {
          environ = fs
            .readFileSync(path.join(PROC_PATH, pids[i].toString(), 'environ'))
            .toString('ascii')
            .replace(/\u0000/g, ' ');
        } catch (e) {
          logger.warn(`error reading or parsing ${PROC_PATH}/${pids[i]}/environ`);
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
   * Read a memoized INI file and return its contents
   *
   * @param key Which INI file to read data from
   * @returns Parsed data from the INI file
   */
  private updateIni(key: MemoKeys) {
    const lastWrite = fs.statSync(this.env.sp).mtime.getTime();
    if ((key in this.timestamps && Number(this.timestamps[key]) - lastWrite !== 0) || !this.memoFiles[key]) {
      this.timestamps[key] = lastWrite;
      this.memoFiles[key] = memoize(readIni);
    }

    return this.memoFiles[key](this.env.sp);
  }

  /**
   * Get the server properties
   *
   * @returns Contents of server.properties file for this instance
   */
  sp(): ServerProperties {
    return this.updateIni('server.properties') as ServerProperties;
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
    this.timestamps['server.properties'] = 0; // reset time to force update on next read
    fs.writeFileSync(this.env.sp, ini.stringify(currentProps));
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
    for (const key in Object.getOwnPropertyNames(overlay)) {
      currentProps[key] = overlay[key];
      this.timestamps['server.properties'] = 0; // reset time to force update on next read
      fs.writeFileSync(this.env.sp, ini.stringify(currentProps));
    }
    return currentProps;
  }

  /**
   * Get the server config
   *
   * @returns Contents of server.config file for this instance
   */
  sc(): ServerConfig {
    return this.updateIni('server.config') as ServerConfig;
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
    this.timestamps['server.config'] = 0; // reset time to force update on next read
    fs.writeFileSync(this.env.sc, ini.stringify(currentProps));
    return currentProps;
  }

  /**
   * Get the cron jobs
   * @returns List of cron configurations for this instance
   */
  crons(): CronConfig {
    return readIni(this.env.cc) as CronConfig;
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
    return currentCron;
  }

  ping() {}

  query() {}

  /**
   * Send a command to the Minecraft console
   *
   * @param command Command to send
   */
  async stuff(command: string) {
    const params = {
      cwd: this.env.cwd,
      ...(await this.property('owner')),
    };
    const binary = which.sync('screen');

    if (!this.verify('exists') && this.verify('up')) {
      throw new Error(`instance ${this.name} does not exist or is not running`);
    }

    child.execFileSync(binary, ['-s', `mc-${this.name}`, '-p', '0', '-X', 'eval', `stuff "${command}\x0a"`], params);
  }

  /**
   * Get state information about this instance
   *
   * TODO: refactor this into separate functions
   *
   * @param property Value to inspect
   * @returns Varies by value
   */
  async property(property: Properties): Promise<any> {
    let pids: ReturnType<typeof Instance.listRunningInstancePids>;

    switch (property) {
      case 'owner':
        return await fs.promises.stat(this.env.cwd).then((statData) => ({
          uid: statData.uid,
          gid: statData.gid,
          username: userid.username(statData.uid),
          groupname: userid.groupname(statData.gid),
        }));
      case 'owner_uid':
        return await fs.promises.stat(this.env.cwd).then((statData) => statData.uid);
      case 'owner_gid':
        return await fs.promises.stat(this.env.cwd).then((statData) => statData.gid);
      case 'exists':
        return await fs.promises.stat(this.env.sp).then((statData) => !!statData);
      case '!exists':
        return await fs.promises.stat(this.env.sp).then((statData) => !statData);
      case 'up':
        pids = Instance.listRunningInstancePids();
        return this.name in pids;
      case '!up':
        pids = Instance.listRunningInstancePids();
        return !(this.name in pids);
      case 'java_pid':
        pids = Instance.listRunningInstancePids();
        return pids[this.name].java;
      case 'screen_pid':
        pids = Instance.listRunningInstancePids();
        return pids[this.name].screen;
      case 'server-port':
        return this.sp()['server-port'];
      case 'server-ip':
        return this.sp()['server-ip'];
      case 'memory':
        pids = Instance.listRunningInstancePids();
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
      case 'ping':
        const jarfile = this.sc().java.jarfile;
        if (jarfile && jarfile.slice(-5).toLowerCase() === '.phar') {
          return Promise.reject();
        } else {
          const pids = Instance.listRunningInstancePids();
          if (this.name in pids) {
            return this.ping();
          }

          return Promise.reject();
        }
      case 'query':
        return await this.query();
      case 'server.properties':
        return this.sp();
      case 'server.config':
        return this.sc();
      case 'du_awd':
        return await new Promise((res, rej) => {
          const timer = setTimeout(() => rej, 2 * 1000); // TODO: magic number?

          du(this.env.awd, { disk: true }, (err, size) => {
            clearTimeout(timer);
            res(size);
          });
        });
      case 'du_bwd':
        return await new Promise((res, rej) => {
          const timer = setTimeout(() => rej, 3 * 1000); // TODO: magic number?

          du(this.env.bwd, { disk: true }, (err, size) => {
            clearTimeout(timer);
            res(size);
          });
        });
      case 'du_cwd':
        return await new Promise((res, rej) => {
          const timer = setTimeout(() => rej, 3 * 1000); // TODO: magic number?

          du(this.env.cwd, { disk: true }, (err, size) => {
            clearTimeout(timer);

            if (err) {
              rej(err);
              return;
            }

            res(size);
          });
        });
      case 'broadcast':
        return this.sc().minecraft.broadcast;
      case 'onreboot_start':
        return this.sc().onreboot.start;
      case 'unconventional':
        return this.sc().minecraft.unconventional;
      case 'commit_interval':
        return this.sc().minecraft.commit_interval;
      case 'eula':
        return await fs.promises.readFile(path.join(this.env.cwd, 'eula.txt')).then((data) => {
          const REGEX_EULA_TRUE = /eula\s*=\s*true/i;
          const lines = data.toString().split('\n');
          let matches = false;
          for (const i in lines) {
            if (lines[i].match(REGEX_EULA_TRUE)) matches = true;
          }
          return matches;
        });
      case 'server_files':
        // Get the list of files copied into the server directory
        let serverFiles = (await fs.promises.readdir(this.env.cwd)).reduce((acc, f) => {
          if (f.slice(-4).toLowerCase() == '.jar' || f.slice(-5).toLowerCase() == '.phar' || f === 'Cuberite') {
            acc[f] = true;
          }
          return acc;
        }, {});

        // If a profile is set, also get the the list of files from the profile
        const scProfile = this.sc().minecraft.profile;
        if (scProfile) {
          const profileDir = path.join(this.env.pwd, scProfile);
          serverFiles = {
            ...serverFiles,
            ...(await fs.promises.readdir(profileDir)).reduce((acc, f) => {
              if (
                !serverFiles[f] &&
                (f.slice(-4).toLowerCase() == '.jar' || f.slice(-5).toLowerCase() == '.phar' || f === 'Cuberite')
              ) {
                acc[f] = true;
              }
              return acc;
            }, {}),
          };
        }

        return Object.getOwnPropertyNames(serverFiles);
      case 'autosave':
        return await new Promise((res) => {
          const new_tail = new Tail(path.join(this.env.cwd, 'logs/latest.log'));

          const timeout = setTimeout(() => {
            new_tail.unwatch();
            res(true); //default to true for unsupported server functionality fallback
          }, 2 * 1000); // TODO magic number

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

      case 'FTBInstall.sh':
        return !!(await fs.promises.stat(path.join(this.env.cwd, 'FTBInstall.sh')));
      case 'java_version_in_use':
        return await usedJavaVersion(this.sc());
      default:
        return Promise.reject('unknown property');
    }
  }

  verify(test: Properties): boolean {
    try {
      return !!this.property(test);
    } catch (e) {
      return false;
    }
  }

  create(owner: { uid: number; gid: number }) {
    if (this.verify('!exists') || this.verify('up')) {
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
}
