import type { Request } from 'express';
import type { Server, Namespace, Socket } from 'socket.io';

import { CronJob } from 'cron';
import Fireworm from 'fireworm';
import fs from 'fs-extra';
import introspect from 'introspect';
import { randomUUID } from 'node:crypto';
import { constants as FS_CONST } from 'node:fs';
import path from 'node:path';
import hash from 'object-hash';
import { Tail } from 'tail';

import { Logger } from './lib/logger';

import { testMembership } from './auth-new';
import { Instance, type OwnerData, type Properties } from './instance';
import { usedJavaVersion } from './java';
import { CronTask } from './constants';

const logger = Logger.child({ service: 'server-container' });

const DEFAULT_SKIPS = [
  'world',
  'world_the_end',
  'world_nether',
  'dynmap',
  'plugins',
  'web',
  'region',
  'playerdata',
  'stats',
  'data',
];

const HEARTBEAT_INTERVAL_MS = 5000;
const FILESIZE_LIMIT_THRESHOLD = 256000;
const NOTICES_QUEUE_LENGTH = 10; // 0 < q <= 10

export type ServerContainerConfig = {
  base_directory: string;
  additional_logfiles: string;
};

type IntervalKeys = 'heartbeat' | 'checkWorldCommitInterval' | 'commit';
export type DispatchCommand = { command: keyof Instance; [key: string]: any };

/**
 * Wrapper for managing a single Instance through socket-based interactions
 */
export class ServerContainer {
  private baseDir: string;
  private instance: Instance;
  private nsp: Namespace;

  private tails: { [key: string]: Tail } = {};
  private intervals: { [K in IntervalKeys]?: NodeJS.Timeout } = {};
  private cron: { [key: string]: CronJob<null, CronTask> } = {};
  private notices: DispatchCommand[] = [];

  private commitInterval: number | undefined;
  private logger: typeof Logger;

  /**
   * @param name Instance name to manage
   * @param config Configuration data
   * @param socket Socket parent to use to communicate
   */
  constructor(
    public name: string,
    config: ServerContainerConfig,
    socket: Server
  ) {
    this.logger = logger.child({ instance: name });
    this.baseDir = config.base_directory;
    this.instance = new Instance(name, this.baseDir);
    this.nsp = socket.of(`/${name}`);

    logger.info(`[${name}] Discovered instance`);

    // Try to read the archive and backup folders. Create them and fix ownership if they are not found.
    try {
      fs.accessSync(this.instance.env.bwd, FS_CONST.F_OK);
      fs.accessSync(this.instance.env.awd, FS_CONST.F_OK);
    } catch (e) {
      this.logger.warn('error accessing archive or backup directory', e);
      fs.ensureDirSync(this.instance.env.bwd);
      fs.ensureDirSync(this.instance.env.awd);
      this.instance.fixOwnership().catch((e) => {
        this.logger.warn('error applying permissions to instance:', e);
      });
    }
    this.makeTails(config.additional_logfiles);
    this.createConfigWatchers();

    this.intervals.heartbeat = setInterval(() => { this.heartbeat() }, HEARTBEAT_INTERVAL_MS);
    this.intervals.checkWorldCommitInterval = setInterval(() => { this.checkWorldCommitInterval() }, 1 * 60 * 1000); // check for changes every minute

    this.setupCron();

    this.nsp.on('connect', async (socket) => {
      const req = socket.request as Request & { user: Express.User };
      const ownership = await this.instance.getOwner();

      // If the user who attempted to connect is not in the instance's group, they are not authorized
      if (!(await testMembership(req.user.username, ownership.groupname))) {
        this.logger.info(`user "${req.user.username}" attempted to connect but is not authorized`);
        socket.disconnect();
        return;
      }

      const conn = new ServerContainer.Connection(this, socket);

      socket.on('command', (args) => {
        conn.produceReceipt(args)
      });
      socket.on('get_file_contents', (args) => { conn.getFileContents(args) });
      socket.on('get_available_tails', () => { conn.getAvailableTails() });
      socket.on('page_data', (args) => { conn.getPageData(args) });
      socket.on('archives', () => { conn.getArchives() });
      socket.on('increments', () => { conn.getIncrements() });
      socket.on('increment_sizes', () => { conn.getIncrementSizes() });
      socket.on('cron', (args) => { conn.manageCron(args) });
      socket.on('property', (args) => { conn.getProperty(args) });
      socket.on('server.properties', () => { this.broadcastServerProperties() });
      socket.on('server.config', () => { this.broadcastServerConfig() });
      socket.on('cron.config', () => { this.broadcastCronConfig() });
      socket.on('server-icon.png', () => { this.broadcastIcon() });
      socket.on('config.yml', () => { this.broadcastConfigYaml() });
      socket.on('req_server_activity', () => { this.broadcastNotices() });
    });
  }

  /**
   * Create the initial set of tail instances to watch log files for changes
   *
   * @param additionalLogs Comma-separated string of additional log files to watch
   */
  makeTails(additionalLogs?: string): void {
    /**
     * Begin watching a file for changes
     *
     * If the file does not exist, create a watcher to monitor for the file to be created and begin
     * tailing the file once it is created.
     *
     * @param filename string path relative to the instance's main working directory to watch
     */
    const makeTail = (filename: string): void => {
      if (filename in this.tails) {
        this.logger.warn(`tail already exists for ${filename}`);
        return;
      }

      const absPath = path.join(this.instance.env.cwd, filename);
      try {
        const tail = new Tail(absPath);
        this.logger.info(`created tail on ${filename}`);

        tail.on('line', (data) => {
          //this.logger.debug(`transmitting tail data for ${filename}`, data);
          this.nsp.emit('tail_data', { filepath: filename, payload: data });
        });

        this.tails[filename] = tail;
      } catch (e) {
        this.logger.warn(`create tail on ${filename} failed`);

        if ((e as NodeJS.ErrnoException).errno != -2) {
          this.logger.error(e);
          return; // exit execution to perhaps curb a runaway process
        }

        const watch = Fireworm(this.instance.env.cwd, {
          skipDirEntryPatterns: DEFAULT_SKIPS,
        });

        watch.add(`**/${filename}`);
        watch.on('add', (target) => {
          if (target === absPath) {
            watch.clear();
            this.logger.info(`${filename} was created. Closing watch`);
            setImmediate(() => makeTail(filename));
          }
        });
      }
    };

    // Create tail instances to watch logs for messages
    const filesToTail = new Set(['logs/latest.log', 'server.log', 'proxy.log.0', 'logs/fml-server-latest.log']);
    if (additionalLogs) {
      additionalLogs.split(',').forEach((s) => {
        s.trim(); // Trim whitespace
        if (!s) {
          // Remove empty elements
          return;
        }

        // normalize path, remove traversal
        filesToTail.add(path.normalize(s).replace(/^(\.\.(\/|\\|$))+/, ''));
      });
    }

    filesToTail.forEach((file) => makeTail(file));
  }

  /**
   * Create a set of watchers for monitoring changes to config files on disk
   */
  createConfigWatchers(): void {
    const skipDirs = new Set([
      ...DEFAULT_SKIPS,
      ...fs.readdirSync(this.instance.env.cwd, { withFileTypes: true }).filter((p) => p.isDirectory()),
    ]);
    this.logger.info('using skipDirEntryPatterns: ', skipDirs);

    const watcher = Fireworm(this.instance.env.cwd, { skipDirEntryPatterns: Array.from(skipDirs.values()) });
    skipDirs.forEach((dir) => watcher.ignore(dir));
    watcher.add('**/server.properties');
    watcher.add('**/server.config');
    watcher.add('**/cron.config');
    watcher.add('**/eula.txt');
    watcher.add('**/server-icon.png');
    watcher.add('**/config.yml');

    // because it is unknown when fireworm triggers on add/change and
    // further because if it catches DURING the write, it will find
    // the file has 0 size, adding arbitrary delay.
    // process.nexttick didnt work.
    const DEBOUNCE = 250;
    const watchHandler = (fp) => {
      const filename = path.basename(fp);
      switch (filename) {
        case 'server.properties':
          setTimeout(() => {
            this.broadcastServerProperties();
          }, DEBOUNCE);
          break;
        case 'server.config':
          setTimeout(() => {
            this.broadcastServerConfig();
          }, DEBOUNCE);
          break;
        case 'cron.config':
          setTimeout(() => {
            this.broadcastCronConfig();
          }, DEBOUNCE);
          break;
        case 'eula.txt':
          setTimeout(() => {
            this.broadcastEula();
          }, DEBOUNCE);
          break;
        case 'server-icon.png':
          setTimeout(() => {
            this.broadcastIcon();
          }, DEBOUNCE);
          break;
        case 'config.yml':
          setTimeout(() => {
            this.broadcastConfigYaml();
          }, DEBOUNCE);
          break;
      }
    };

    watcher.on('add', watchHandler);
    watcher.on('change', watchHandler);
  }

  /**
   * Monitor the instance for health periodically
   */
  async heartbeat(): Promise<void> {
    clearInterval(this.intervals.heartbeat);
    this.intervals.heartbeat = setInterval(() => { this.heartbeat() }, HEARTBEAT_INTERVAL_MS * 3);

    const [up, memory, query, ping] = await Promise.all([
      Promise.resolve(this.instance.isUp()),
      this.instance.getJavaProcessStats(),
      this.instance.sp()['enable-query'] ? this.instance.query() : Promise.resolve({}),
      !this.instance.sc().minecraft?.unconventional ? this.instance.ping() : Promise.resolve({}),
    ]).catch((e) => {
      this.logger.debug('heartbeat error', { error: e });
      return [];
    });

    clearInterval(this.intervals.heartbeat);
    this.intervals.heartbeat = setInterval(() => { this.heartbeat() }, HEARTBEAT_INTERVAL_MS);
    this.nsp.emit('heartbeat', {
      server_name: this.name,
      timestamp: Date.now(),
      payload: { up, memory, query, ping },
    });
  }

  /**
   * Check the instance configuration to see how often to send the save-all command
   */
  checkWorldCommitInterval(): void {
    // TODO: maybe replace with a hook?
    const commitInterval = this.instance.sc().minecraft?.commit_interval;
    if (commitInterval != this.commitInterval) {
      // init or change
      this.commitInterval = commitInterval;
      if (commitInterval && commitInterval > 0) {
        this.logger.info(`committing world to disk every ${commitInterval} minutes`);
        clearInterval(this.intervals.commit);
        this.intervals.commit = setInterval(() => { this.instance.saveall() }, commitInterval * 60 * 1000);
      } else {
        this.logger.info(`not committing world to disk automatically (interval set to ${commitInterval})`);
        clearInterval(this.intervals.commit);
      }
    }
  }

  /**
   * Get the cron configuration from the instance and attempt to start any enabled cron jobs
   */
  setupCron(): void {
    const cronDict = this.instance.crons();
    Object.entries(cronDict).forEach(([id, task]) => {
      if (task.enabled) {
        try {
          this.cron[id] = CronJob.from({
            cronTime: task.source,
            onTick: () => {
              this.dispatch(task);
            },
            start: true,
            context: task,
          });
        } catch (e) {
          this.logger.warn('invalid cron expression', id, task);
          this.instance.setCron(id, false);
        }
      }
    });
  }

  /**
   * Get the information about the server to broadcast to LAN, if configured.
   *
   * @returns The broadcast-to-LAN message and server IP for this instance
   */
  async broadcastToLan(): Promise<[Buffer, string]> {
    if (!(await this.instance.exists()) || !this.instance.isUp()) {
      return Promise.reject('instance does not exist or is not running');
    }

    if (!this.instance.sc().minecraft?.broadcast) {
      return Promise.reject('instance not set to broadcast to LAN');
    }

    const sp = this.instance.sp();
    const msg = Buffer.from(`[MOTD]${sp.motd}[/MOTD][AD]${sp['server-port']}[/AD]`);
    return [msg, `${sp['server-ip']}`];
  }

  /**
   * Check if this instance should start when MineOS starts and if so, launch it
   */
  async onrebootStart(): Promise<void> {
    const shouldStart = this.instance.sc().onreboot.start;
    this.logger.info(`autostart = ${shouldStart}`);
    if (shouldStart) {
      return this.instance.start();
    }

    return Promise.resolve();
  }

  /**
   * Stop all tails watching files, clear all timeouts, and remove all socket listeners
   */
  cleanup(): void {
    for (const t of Object.values(this.tails)) {
      t.unwatch();
    }

    for (const i of Object.values(this.intervals)) {
      clearInterval(i);
    }

    this.nsp.removeAllListeners();
  }

  /**
   * Get the state of the EULA acceptance from the instance and send it to the client
   */
  async broadcastEula(): Promise<void> {
    const accepted = await this.instance.getEulaState();
    this.logger.info(`eula.txt detected: ${accepted ? 'ACCEPTED' : 'NOT YET ACCEPTED'} (eula=${accepted})`);
    this.nsp.emit('eula', accepted);
  }

  /**
   * Read the server icon from disk and send it to the client if it is a PNG
   */
  async broadcastIcon(): Promise<void> {
    const data = await fs.promises
      .readFile(path.join(this.instance.env.cwd, 'server-icon.png'))
      .catch(() => Buffer.from('')); // Swallow errors - icon is not required

    // magic number for PNG
    if (data.toString('hex', 0, 4) === '89504e47') {
      this.nsp.emit('server-icon.png', Buffer.from(data).toString('base64'));
    }
  }

  /**
   * Read the contents of config.yml from disk and send it to the client if it exists
   */
  async broadcastConfigYaml(): Promise<void> {
    const config = await fs.promises
      .readFile(path.join(this.instance.env.cwd, 'config.yml'))
      .catch(() => Buffer.from(''));
    if (config) {
      this.nsp.emit('config.yml', config);
    }
  }

  /**
   * Get the current queue of tasks in this container and send it to the client
   */
  broadcastNotices() {
    this.nsp.emit('notices', this.notices);
  }

  /**
   * Get the instance server.properties file and send it to the client
   */
  broadcastServerProperties() {
    this.logger.debug('broadcasting server.properties');
    this.nsp.emit('server.properties', this.instance.sp());
  }

  /**
   * Get the instance server.config file and send it to the client
   */
  broadcastServerConfig() {
    this.logger.debug('broadcasting server.config');
    this.nsp.emit('server.properties', this.instance.sc());
  }

  /**
   * Get the instance cron.config file and send it to the client
   */
  broadcastCronConfig() {
    this.logger.debug('broadcasting cron.config');
    this.nsp.emit('server.properties', this.instance.crons());
  }

  /**
   * Invoke a function of the instance as the given user. On error, a message is sent to the
   * namespace socket with details.
   *
   * @param user Username to verify has permissions on the instance
   * @param args Arguments to pass to the function, including the function name
   */
  async directDispatch(user: string, args: DispatchCommand): Promise<void> {
    const owner = await this.instance.getOwner();
    if (!(await testMembership(user, owner.groupname))) {
      this.logger.error(`user ${user} does not have permissions on [${this.name}]`);
      return;
    }

    this.dispatch(args);
  }

  /**
   * Invoke a function of the instance On error, a message is sent to the namespace socket with details.
   *
   * @param args Arguments to pass to the function, including the function name
   */
  private async dispatch(args: DispatchCommand) {
    let fn, argNames;
    try {
      fn = this.instance[args.command];
      argNames = introspect(fn);
    } catch (e) {
      args.success = false;
      args.error = e;
      args.time_resolved = Date.now();
      this.nsp.emit('server_fin', args);

      while (this.notices.length > NOTICES_QUEUE_LENGTH) {
        this.notices.shift();
      }
      this.notices.push(args);
      return;
    }

    const fnArgs: any[] = [];
    for (const arg of argNames) {
      if (arg in args) {
        fnArgs.push(args[arg]);
      } else {
        args.success = false;
        args.error = `Provided values missing required argument: ${arg}`;
        this.logger.error(args.error);

        this.nsp.emit('server_fin', args);

        while (this.notices.length > NOTICES_QUEUE_LENGTH) {
          this.notices.shift();
        }

        if (args.command !== 'delete') {
          this.notices.push(args);
        }
        return;
      }
    }

    if (args.command === 'delete') {
      this.cleanup();
    }

    this.logger.info(`dispatching command "${args.command}"`);
    try {
      await fn.apply(this.instance, fnArgs);
    } catch (e) {
      this.logger.error(`error running "${args.command}"`, e);
      args.success = false;
      args.error = e;
      this.nsp.emit('server_fin', args);
    }
  }

  /**
   * Represents the connection to a specific client. Used to return data and control access.
   */
  private static Connection = class {
    private logger: typeof Logger;
    private ip: string;
    private user: Express.User;

    /**
     * @param sup Parent to attach to
     * @param socket Socket from the client connection
     */
    constructor(
      private sup: ServerContainer,
      private socket: Socket
    ) {
      this.ip = socket.conn.remoteAddress;
      this.user = (socket.request as Request & { user: Express.User }).user;
      this.logger = sup.logger.child({ connection: this.ip });
    }

    /**
     * Immediately acknowledge a request and start processing it.
     *
     * @param args Arguments and the command to run to pass to the instance.
     */
    async produceReceipt(args: DispatchCommand): Promise<void> {
      this.logger.info(`received command : "${args.command}"`);
      args.uuid = randomUUID();
      args.time_initiated = Date.now();
      this.sup.nsp.emit('server_ack', args);

      try {
        if (args.command === 'chown') {
          const ownership = await this.sup.instance.getOwner();
          if (ownership.username !== this.user.username) {
            throw new Error('Only the current user owner can reassign instance ownership.');
          } else if (ownership.uid !== args.uid) {
            throw new Error('You may not change the user owner of this instance.');
          }
        }
      } catch (e) {
        args.success = false;
        args.err = e;
        args.time_resolved = Date.now();
        this.logger.error(`command ${args.command} errored out:`, e);
        this.sup.nsp.emit('server_fin', args);
      }

      this.sup.dispatch(args);
    }

    /**
     * Read a file if it is below the size threshold (default 256KB) and send it to the client.
     *
     * @param filename File to retrieve data for
     */
    async getFileContents(filename: string): Promise<void> {
      const absPath = path.join(this.sup.instance.env.cwd, filename);
      const statData = await fs.promises.stat(absPath);
      if (statData.size > FILESIZE_LIMIT_THRESHOLD) {
        const payload = `File is too large (> ${FILESIZE_LIMIT_THRESHOLD / 1000} KB).  Only newly added lines will appear here.`;
        this.sup.nsp.emit('file head', { filename, payload });
        return;
      }

      const contents = await fs.promises.readFile(absPath);
      this.logger.info(`transmitting existing file contents: ${filename} (${statData.size} bytes)`);
      this.sup.nsp.emit('file head', { filename, payload: contents.toString() });
    }

    /**
     * Send the contents of all currently tailed files to the client
     */
    getAvailableTails(): void {
      for (const t of Object.keys(this.sup.tails)) {
        this.getFileContents(t);
      }
    }

    /**
     * Get the list of archive files for this instance and send it to the client
     */
    async getArchives(): Promise<void> {
      this.logger.debug(`${this.user.username} requesting server archives`);
      const archives = await this.sup.instance.listArchives().catch((e) => {
        this.logger.error('error with getArchives', e);
        return {};
      });
      this.sup.nsp.emit('archives', { payload: archives });
    }

    /**
     * Get the list of backup increments for this instance and send it to the client
     */
    async getIncrements(): Promise<void> {
      this.logger.debug(`${this.user.username} requesting backup increments`);
      const archives = await this.sup.instance.listIncrements().catch((e) => {
        this.logger.error('error with listIncrements', e);
        return {};
      });
      this.sup.nsp.emit('increments', { payload: archives });
    }

    /**
     * Get the list of backup increments with their size and cumulative size for this instance and send it to the client
     */
    async getIncrementSizes(): Promise<void> {
      this.logger.debug(`${this.user.username} requesting backup increments with sizes`);
      const archives = await this.sup.instance.listIncrementSizes().catch((e) => {
        this.logger.error('error with listIncrementSizes', e);
        return {};
      });
      this.sup.nsp.emit('increment_sizes', { payload: archives });
    }

    /**
     * Load the data necessary to populate a UI page and send it to the client
     *
     * @param page The name of the page to load data for
     */
    async getPageData(page: string): Promise<void> {
      let payload:
        | {
            du_awd: number;
            du_bwd: number;
            du_cwd: number;
            owner: OwnerData;
            server_files: string[];
            ftb_installer: boolean;
            eula: boolean;
            base_dir: string;
            java_version_in_use: string;
          }
        | undefined;

      if (page === 'glance') {
        const inst = this.sup.instance;
        const promises = await Promise.allSettled([
          inst.du('awd'),
          inst.du('bwd'),
          inst.du('cwd'),
          inst.getOwner(),
          inst.getRunnableJarFiles(),
          inst.isFTBServer(),
          inst.getEulaState(),
          Promise.resolve(this.sup.baseDir),
          usedJavaVersion(inst.sc()),
        ]);

        const errors = promises.filter((p) => p.status === 'rejected');
        if (errors.length > 0) {
          this.logger.error('error with getPageData glance', errors);
        }

        const results = promises.map((p) => (p.status === 'fulfilled' ? p.value : undefined));

        payload = {
          du_awd: results[0] as number,
          du_bwd: results[1] as number,
          du_cwd: results[2] as number,
          owner: results[3] as OwnerData,
          server_files: results[4] as string[],
          ftb_installer: results[5] as boolean,
          eula: results[6] as boolean,
          base_dir: results[7] as string,
          java_version_in_use: results[8] as string,
        };
      }

      this.sup.nsp.emit('page_data', { page, payload });
    }

    /**
     * Get data about a specific property and send it to the client
     *
     * @param property Which property to fetch data about
     */
    async getProperty(property: Properties): Promise<void> {
      let promise: Promise<any>;
      const inst = this.sup.instance;
      switch (property) {
        case 'owner':
          promise = inst.getOwner();
          break;
        case 'owner_uid':
          promise = inst.getOwner().then((o) => o.uid);
          break;
        case 'owner_gid':
          promise = inst.getOwner().then((o) => o.gid);
          break;
        case 'exists':
          promise = inst.exists();
          break;
        case '!exists':
          promise = inst.exists().then((v) => !v);
          break;
        case 'up':
          promise = Promise.resolve(inst.isUp());
          break;
        case '!up':
          promise = Promise.resolve(!inst.isUp());
          break;
        case 'java_pid':
          promise = Promise.resolve(inst.getChildPid('java'));
          break;
        case 'screen_pid':
          promise = Promise.resolve(inst.getChildPid('screen'));
          break;
        case 'server-port':
          promise = Promise.resolve(inst.sp()['server-port']);
          break;
        case 'server-ip':
          promise = Promise.resolve(inst.sp()['server-ip']);
          break;
        case 'memory':
          promise = inst.getJavaProcessStats();
          break;
        case 'ping':
          promise = inst.ping();
          break;
        case 'query':
          promise = inst.query();
          break;
        case 'server.properties':
          promise = Promise.resolve(inst.sp());
          break;
        case 'server.config':
          promise = Promise.resolve(inst.sc());
          break;
        case 'du_awd':
          promise = inst.du('awd');
          break;
        case 'du_bwd':
          promise = inst.du('bwd');
          break;
        case 'du_cwd':
          promise = inst.du('cwd');
          break;
        case 'broadcast':
          promise = Promise.resolve(inst.sc().minecraft?.broadcast);
          break;
        case 'onreboot_start':
          promise = Promise.resolve(inst.sc().onreboot?.start);
          break;
        case 'unconventional':
          promise = Promise.resolve(inst.sc().minecraft?.unconventional);
          break;
        case 'commit_interval':
          promise = Promise.resolve(inst.sc().minecraft?.commit_interval);
          break;
        case 'eula':
          promise = inst.getEulaState();
          break;
        case 'server_files':
          promise = inst.getRunnableJarFiles();
          break;
        case 'autosave':
          promise = inst.getAutosaveState();
          break;
        case 'FTBInstall.sh':
          promise = inst.isFTBServer();
          break;
        case 'java_version_in_use':
          promise = usedJavaVersion(inst.sc());
          break;
      }

      const payload = await promise.catch((e) => {
        this.logger.error(`error retrieving property "${property}"`, e);
        return null;
      });

      this.sup.nsp.emit('server_fin', { server_name: this.sup.name, property, payload });
    }

    /**
     * Manage the cron tasks for this instance by creating, deleting, or modifying the tasks
     *
     * @param opts Cron task definition and management options
     */
    async manageCron(opts: CronTask & { hash?: string; operation?: 'create' | 'delete' | 'start' | 'suspend' }) {
      /**
       * Reload the currently running set of tasks
       */
      const reload = async () => {
        try {
          for (const [id, c] of Object.entries(this.sup.cron)) {
            c.stop();
            delete this.sup.cron[id];
          }
        } catch (e) {
          this.logger.error('error stoping cron job:', e);
        }

        const jobs = this.sup.instance.crons();
        Object.entries(jobs).forEach(([id, c]) => {
          if (c.enabled) {
            try {
              this.sup.cron[id] = CronJob.from({
                cronTime: c.source,
                onTick: () => {
                  this.sup.dispatch(c);
                },
                start: true,
                context: c,
              });
            } catch (e) {
              this.logger.warn('invalid cron expression submitted', id, c.source);
              this.sup.instance.setCron(id, false);
            }
          }
        });
      };

      switch (opts.operation) {
        case 'create':
          delete opts.operation;
          delete opts.hash;

          const id = hash(opts);

          this.logger.info('requests cron creation:', id, opts);

          opts.enabled = false;
          this.sup.instance.addCron(id, opts);
          break;

        case 'delete':
          this.logger.info('requests cron deletion', opts.hash);

          if (opts.hash && opts.hash in this.sup.cron) {
            this.sup.cron[opts.hash].stop();
            delete this.sup.cron[opts.hash];

            await this.sup.instance.deleteCron(opts.hash);
            reload();
          } else {
            this.logger.warn('delete: cron hash not in running tasks');
          }
          break;

        case 'start':
          if (opts.hash) {
            this.logger.info('starting cron:', opts.hash);
            await this.sup.instance.setCron(opts.hash, true);
            reload();
          } else {
            this.logger.warn('start: invalid cron hash', opts.hash);
          }
          break;

        case 'suspend':
          if (opts.hash) {
            this.logger.info('suspending cron:', opts.hash);
            await this.sup.instance.setCron(opts.hash, false);
            reload();
          } else {
            this.logger.warn('suspend: invalid cron hash', opts.hash);
          }
          break;

        default:
          this.logger.warn(`requested invalid cron operation: ${opts.operation}`);
      }
    }
  };
}
