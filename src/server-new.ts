import type { Request } from 'express';
import type socket from 'socket.io';

import type Profile from './profiles.d/template';
import { type Collection } from './profiles.d/template';

import admzip from 'adm-zip';
import { check } from 'diskusage';
import passwd from 'etc-passwd';
import { Fireworm } from 'fireworm';
import fs from 'fs-extra';
import child from 'node:child_process';
import dgram from 'node:dgram';
import path from 'node:path';
import os from 'node:os';
import { meminfo } from 'procfs-stats';
import { Rsync } from 'rsync2';
import unzip from 'unzipper';
import userid from 'userid';
import which from 'which';

import { Logger } from './lib/logger';
import { PromisePool } from './lib/util';

import { DIRS, type ServerProperties } from './constants';
import { PROFILES } from './profiles';
import { ServerContainer, type ServerContainerConfig } from './server-container';
import axios from 'axios';
import { Instance } from './instance';

const logger = Logger.child({ service: 'server' });

const HOST_DU_HEARTBEAT_DELAY_MS = 10000; // statvfs might be heavy, every 10s should be reasonable
const HOST_HEARTBEAT_DELAY_MS = 1000;
const MS_TO_PAUSE = 10000;

type Config = ServerContainerConfig & {
  webui_locale: string;
  optional_columns: string[];
  creators: string;
};

type DispatchCommand = {
  command:
    | 'create'
    | 'create_unconventional_server'
    | 'download'
    | 'build_jar'
    | 'delete_build'
    | 'copy_to_server'
    | 'refresh_server_list'
    | 'refresh_profile_list'
    | 'create_from_archive';
  profile?: Profile;
  server_name?: string;
  new_server_name?: string;
  properties?: ServerProperties;
  builder?: {
    group: string;
    id: string;
    filename: string;
  };
  version?: string;
  filename?: string;
  awd_dir?: string;
  [key: string]: any;
};

type DispatchResult = {
  command: string;
  success: boolean;
  help_text: string;
};

/**
 * Core server management for MineOS. Creates a ServerContainer for each Minecraft or other server to host and manage.
 */
export default class Server {
  instances: { [key: string]: ServerContainer } = {};
  profiles: Profile[] = [];
  private commit: string;
  private logger: typeof Logger;

  constructor(
    public baseDir: string,
    private socket: socket.Server,
    private config: Config
  ) {
    this.logger = logger.child({ baseDir });
    this.logger.debug(`creating server at ${baseDir}`);

    this.instances = {};
    this.profiles = [];
    this.socket = socket;

    // Set file permission mask for interacting with this server
    process.umask(0o002);

    // Check for required folders and create them if needed
    fs.ensureDirSync(baseDir);
    fs.ensureDirSync(path.join(baseDir, DIRS['servers']));
    fs.ensureDirSync(path.join(baseDir, DIRS['backup']));
    fs.ensureDirSync(path.join(baseDir, DIRS['archive']));
    fs.ensureDirSync(path.join(baseDir, DIRS['import']));
    fs.ensureDirSync(path.join(baseDir, DIRS['profiles']));

    fs.chmod(path.join(baseDir, DIRS['import']), 0o777);

    const gitPath = which.sync('git');
    this.commit = child.execFileSync(gitPath, ['show', '--oneline', '-s'], {
      cwd: __dirname,
      encoding: 'utf8',
    });
    logger.info(`starting server using commit: ${this.commit}`);

    this.startBroadcasts();

    setInterval(this.getHostDiskspace, HOST_DU_HEARTBEAT_DELAY_MS);
    setInterval(this.getHostHeartbeat, HOST_HEARTBEAT_DELAY_MS);

    this.startTracking(config);
    this.startImportWatch();

    setTimeout(this.startServers, 5000);

    this.socket.on('connect', (conn) => {
      const connection = new this.Connection(this, conn);

      socket.emit('commit_msg', this.commit);
      socket.emit('change_locale', config.webui_locale);
      socket.emit('optional_columns', config.optional_columns);

      for (const name in this.instances) {
        socket.emit('track_server', name);
      }

      socket.on('command', connection.dispatch);

      connection.sendUserList();
      this.sendProfileList(true);
      this.sendSpigotList();
      this.sendImportableList();
      this.sendLocaleList();
    });
  }

  /**
   * For each Minecraft instance, check if it is configured to broadcast to LAN.
   * If so, set up a socket to broadcast the necessary packets.
   */
  startBroadcasts() {
    // Thanks to https://github.com/flareofghast/node-advertiser/blob/master/advert.js
    const UDP_DEST = '255.255.255.255';
    const UDP_PORT = 4445;
    const BROADCAST_DELAY_MS = 4000;
    const broadcasts: { [key: string]: dgram.Socket } = {};

    const broadcast = async () => {
      Object.values(this.instances).forEach(async (container) => {
        const [msg, ip] = await container.broadcastToLan();
        if (msg) {
          if (broadcasts[ip]) {
            broadcasts[ip].send(msg, UDP_PORT, UDP_DEST);
          } else {
            const socket = dgram.createSocket('udp4');
            socket.bind(UDP_PORT, ip);
            socket.on('listening', () => {
              socket.setBroadcast(true);
              socket.send(msg, UDP_PORT, UDP_DEST);
            });

            socket.on('error', (err) => {
              this.logger.debug(`Cannot bind broadcaster to ip ${ip}`, err);
            });

            broadcasts[ip] = socket;
          }
        }
      });
    };
    setInterval(broadcast, BROADCAST_DELAY_MS);
  }

  /**
   * Get the available disk space for a path and send it to any listening clients.
   *
   * @param path Disk path to get data for
   */
  private async getFreeSpace(path: string): Promise<void> {
    try {
      const info = await check(path);
      this.socket.emit('host_diskspace', {
        availdisk: info.available,
        freedisk: info.free,
        totaldisk: info.total,
      });
    } catch (e) {
      this.logger.error('error fetching diskspace', e);
    }
  }

  /**
   * Get the total available disk space on the root filesystem (/) and send it to any listening clients
   */
  async getHostDiskspace(): Promise<void> {
    return this.getFreeSpace('/');
  }

  /**
   * Get the uptime, load, and free memory stats for the server and send it to any listening clients
   */
  async getHostHeartbeat(): Promise<void> {
    return new Promise((resolve, reject) => {
      // TODO: Replace procfs
      meminfo((err, stats) => {
        if (err) {
          return reject(err);
        }

        this.socket.emit('host_heartbeat', {
          uptime: os.uptime(),
          freemem: stats && stats.MemAvailable ? stats.MemAvailable * 1024 : os.freemem(),
          loadavg: os.loadavg(),
        });
        resolve();
      });
    });
  }

  /**
   * Get the list of potential Minecraft servers
   *
   * @returns List of subdirectories in the `${baseDir}/servers` folder
   */
  discover(): string[] {
    const searchDir = path.join(this.baseDir, DIRS.servers);
    return fs.readdirSync(searchDir, { withFileTypes: true }).reduce<string[]>((acc, d) => {
      if (d.isDirectory()) {
        acc.push(d.name);
      }
      return acc;
    }, []);
  }

  /**
   * Create a ServerContainer to track a Minecraft server instance
   *
   * @param name Instance name to track
   */
  track(name: string, config: ServerContainerConfig): void {
    if (this.instances[name]) {
      throw new Error(`${name} is already tracked!`);
    }

    this.instances[name] = new ServerContainer(name, config, this.socket);
    this.socket.emit('track_server', name);
  }

  /**
   * Stop tracking a Minecraft server instance
   *
   * @param name Instance name to stop tracking
   */
  untrack(name: string): void {
    try {
      this.instances[name].cleanup();
      delete this.instances[name];
    } catch (e) {
      this.logger.warn(`error cleaning up tracking for ${name}`, e);
    } finally {
      this.socket.emit('untrack_server', name);
    }
  }

  /**
   * Discover existing servers, start tracking them, and set up a watch to observe changes so that new servers can be
   * tracked and deleted servers can stop being tracked.
   *
   * @param config ServerContainer configuration data
   */
  startTracking(config: ServerContainerConfig) {
    const dirs = this.discover();
    for (const dir of dirs) {
      this.track(dir, config);
    }

    fs.watch(path.join(this.baseDir, DIRS.servers), () => {
      const newDirs = this.discover();

      // Start tracking new servers
      for (const dir of newDirs) {
        if (!(dir in this.instances)) {
          this.track(dir, config);
        }
      }

      // Stop tracking deleted servers
      for (const name of Object.keys(this.instances)) {
        if (newDirs.indexOf(name) < 0) {
          this.untrack(name);
        }
      }
    });
  }

  /**
   * Start watching the import directory for new archive files or archive files which are deleted and send an update to
   * listeners of the current valid list.
   */
  startImportWatch(): void {
    const importPath = path.join(this.baseDir, DIRS.import);
    const fw = Fireworm(importPath);

    fw.add('**/*.zip');
    fw.add('**/*.tar');
    fw.add('**/*.tgz');
    fw.add('**/*.tar.gz');

    fw.on('add', (fp: string | string[]) => {
      this.logger.info('New file found in import directory', fp);
      this.sendImportableList();
    });

    fw.on('remove', (fp: string | string[]) => {
      this.logger.info('File removed from import directory', fp);
      this.sendImportableList();
    });
  }

  /**
   * Start all the Minecraft server instances which have ServerContainer wrappers.
   */
  startServers(): void {
    const pool = new PromisePool<void, string>(Object.keys(this.instances), 1, async (name: string) => {
      return this.instances[name]
        .onrebootStart()
        .then((): Promise<void> => {
          this.logger.info(`Server started. Waiting ${MS_TO_PAUSE}`);
          return new Promise<void>((resolve) => {
            setTimeout(resolve, MS_TO_PAUSE);
          });
        })
        .catch((err) => {
          this.logger.error('Aborted server startup; condition not met:', err);
        });
    });

    pool.process();
  }

  /**
   * Stop and clean up all Minecraft server instances
   */
  shutdown() {
    for (const container of Object.values(this.instances)) {
      container.cleanup();
    }
  }

  /**
   * Read the stat info for all valid archive files in the import directory and send the data to any connected clients.
   */
  async sendImportableList(): Promise<void> {
    const importPath = path.join(this.baseDir, DIRS.import);
    const files = await fs.promises.readdir(importPath);
    const stats = await Promise.all(files.map((f) => fs.promises.stat(path.join(importPath, f))));
    const info = stats
      .map((s, i) => ({
        time: s.mtime,
        size: s.mtime,
        filename: files[i],
      }))
      .sort((a, b) => a.time.getTime() - b.time.getTime());

    this.socket.emit('archive_list', info);
  }

  /**
   * Load and send connected clients the list of available profiles
   *
   * @param sendExisting Only send what has already been loaded
   */
  async sendProfileList(sendExisting: boolean = false): Promise<void> {
    if (sendExisting && this.profiles.length) {
      this.socket.emit('profile_list', this.profiles);
      return;
    }

    const profileDir = path.join(this.baseDir, DIRS.profiles);
    const DOWNLOAD_LIMIT = 3;

    const profileHandler = async (c: Collection): Promise<Profile[]> => {
      try {
        let data: Profile[];
        if (c.request_args) {
          const response = await axios.get(c.request_args.url, { responseType: c.request_args.type });
          if (response.status !== 200) {
            throw new Error(response.data);
          }

          data = await c.handler(profileDir, response.data);
        } else {
          data = await c.handler(profileDir);
        }

        this.logger.info(`Downloaded information for collection: ${c.name} (${data.length} entries)`);
        return data;
      } catch (e) {
        this.logger.error(
          `Unable to retrieve profile ${c.name}. The definition for this profile may be improperly formed or is pointing to an invalid URI.`
        );
        return [];
      }
    };

    const pool = new PromisePool<Profile[], Collection>(Object.values(PROFILES), DOWNLOAD_LIMIT, profileHandler);

    this.profiles = (await pool.process()).flat();
    this.socket.emit('profile_list', this.profiles);
  }

  /**
   * Get the list of downloaded Spigot profiles and send it to any connected clients.
   */
  sendSpigotList(): void {
    const profileDir = path.join(this.baseDir, DIRS.profiles);
    const profiles = fs.readdirSync(profileDir);
    type spigotProfile = { [key: string]: { directory: string; jarfiles: string[] } };
    const spigotProfiles = profiles.reduce<spigotProfile>((acc: spigotProfile, name) => {
      const match = name.match(/(paper)?spigot_([\d.]+)/);
      if (match) {
        acc[match[0]] = {
          directory: match[0],
          jarfiles: fs.readdirSync(path.join(profileDir, match[0])).filter((f) => f.match(/.+\.jar/i)),
        };
      }
      return acc;
    }, {} as spigotProfile);

    this.socket.emit('spigot_list', spigotProfiles);
  }

  /**
   * Get the list of supported locales and send it to all connected clients. If there is an error, fall back and assume
   * the only available locale is en_US
   */
  sendLocaleList() {
    try {
      const locales = fs.readdirSync(path.join(__dirname, '..', 'html', 'locales')).reduce<string[]>((acc, f) => {
        const match = f.match(/^locale-([a-z]{2}_[A-Z]{2}).json$/);
        if (match) {
          acc.push(match[1]);
        }
        return acc;
      }, []);

      this.logger.info('found locales', locales);
      this.socket.emit('locale_list', locales);
    } catch (e) {
      logger.warn('error reading locale directory', e);
      this.socket.emit('locale_list', ['en_US']);
    }
  }

  private Connection = class {
    private user: Express.User;
    private ip: string;
    private owner: { uid: number; gid: number };
    private logger: typeof Logger;

    constructor(
      private sup: Server,
      private socket: socket.Socket
    ) {
      this.ip = socket.conn.remoteAddress;
      this.logger = sup.logger.child({ connection: this.ip });

      this.user = (socket.request as Request & { user: Express.User }).user;
      this.owner = { uid: userid.uid(this.user.username), gid: userid.gid(this.user.username)[0] };

      this.logger.info(`${this.user.username} connected from ${this.ip}`);
      socket.emit('whoami', this.user.username);
    }

    /**
     * Get the list of users on the system and send it to all connected clients
     */
    sendUserList() {
      const users: { username: string; uid: number; gid: number; home: string }[] = [];
      const groups: { groupname: string; gid: number }[] = [];

      passwd
        .getUsers()
        .on('user', (user) => {
          if (user.username === this.user.username) {
            users.push({
              username: user.username,
              uid: user.uid,
              gid: user.gid,
              home: user.home,
            });
          }
        })
        .on('end', () => {
          this.socket.emit('user_list', users);
        });

      passwd
        .getGroups()
        .on('group', (group) => {
          if (group.users.indexOf(this.user.username) >= 0 || group.gid === userid.gids(this.user.username)[0]) {
            if (group.gid > 0) {
              groups.push({
                groupname: group.groupname,
                gid: group.gid,
              });
            }
          }
        })
        .on('end', () => {
          this.socket.emit('group_list', groups);
        });
    }

    async dispatch(args: DispatchCommand): Promise<void> {
      this.logger.info(`Received emit command from ${this.ip}: ${this.user.username}`, args);
      switch (args.command) {
        case 'create_unconventional_server':
          if (!args.server_name) {
            this.logger.error('server_name is required');
            return;
          }

          await this.create(args.server_name, args.properties, true);
          break;

        case 'create':
          if (!args.server_name) {
            this.logger.error('server_name is required');
            return;
          }

          await this.create(args.server_name, args.properties);
          break;

        case 'download':
          await this.download(args.profile);
          break;

        case 'build_jar':
          if (!args.builder || !args.version) {
            this.logger.error('missing builder arguments');
            return;
          }

          await this.buildJar(args.builder, args.version);
          break;

        case 'delete_build':
          if (args.type !== 'spigot') {
            this.logger.error('Unknown type of craftbukkit server -- potential modified webui request?');
            return;
          }

          if (!args.version) {
            this.logger.error('version is required');
            return;
          }

          await this.delete(args.version);
          break;

        case 'copy_to_server':
          if (args.type !== 'spigot') {
            this.logger.error('Unknown type of craftbukkit server -- potential modified webui request?');
            return;
          }

          if (!args.server_name || !args.version) {
            this.logger.error('server_name and version are required');
            return;
          }

          await this.copy(args.server_name, args.version);
          break;

        case 'create_from_archive':
          if (!args.new_server_name || !args.filename) {
            this.logger.error('new_server_name and filename are required');
            return;
          }

          await this.createFromArchive(args.new_server_name, args.filename, args.awd_dir);
          break;

        case 'refresh_server_list':
          for (const s in this.sup.instances) {
            this.sup.socket.emit('track_servers', s);
          }
          break;

        case 'refresh_profile_list':
          this.sup.sendProfileList();
          this.sup.sendSpigotList();
          break;

        default:
          this.logger.warn(`Command ignored: no such command ${args.command}`);
          break;
      }
    }

    async create(
      name: string,
      properties: DispatchCommand['properties'],
      unconventional: boolean = false
    ): Promise<void> {
      const inst = new Instance(name, this.sup.baseDir);
      if (await inst.exists()) {
        this.logger.error(`Instance ${name} already exists`);
        return;
      }

      let allowedCreators = [this.user.username];
      if (this.sup.config.creators) {
        allowedCreators = this.sup.config.creators
          .trim()
          .split(',')
          .reduce<string[]>((acc, u) => {
            u = u.trim();
            if (u) {
              acc.push(u);
            }

            return acc;
          }, []);
        this.logger.info('Explicity authorized instance creators are:', allowedCreators);
      }

      try {
        inst.create(this.owner, unconventional);
        inst.overlaySp(properties || {});
        this.logger.info(`Server${unconventional ? ' (unconventional)' : ''} created in filesystem`);
      } catch (e) {
        this.logger.error(`Failed to create instance in filesystem as ${this.user.username}:`, e);
        return;
      }
    }

    async download(profile?: DispatchCommand['profile']): Promise<void> {
      if (!profile) {
        this.logger.error('no profile specified to download');
        return;
      }

      if (!this.sup.profiles.find((item) => item.id === profile.id)) {
        this.logger.error(`requested profile "${profile.id}" missing from definitions`);
        return;
      }

      const profileDir = path.join(this.sup.baseDir, DIRS.profiles, profile.id);
      const destPath = path.join(profileDir, profile.filename);

      try {
        fs.ensureDirSync(profileDir);
        const { data, headers, status } = await axios({
          url: profile.url,
          method: 'GET',
          responseType: 'stream',
          headers: { 'User-Agent': 'MineOS-node' },
        });

        if (status !== 200) {
          throw new Error(`GET ${profile.url} failed: status ${status}`);
        }

        // Not all servers will return content-length, so only update the progress if we have it
        const totalSize = headers['Content-Length'];
        if (totalSize) {
          const total = Number(totalSize);
          let transferred = 0;
          this.logger.debug(`${profile.url}: downloading ${totalSize} bytes`);

          data.on('data', (chunk: Buffer) => {
            transferred += chunk.length;

            profile.progress = {
              size: {
                total,
                transferred,
              },
              percent: transferred / total,
            };

            this.sup.socket.emit('file_progress', profile);
          });
        }

        // Pipe the output to the destination file
        data.pipe(fs.createWriteStream(destPath));

        await new Promise<void>((resolve) => {
          data.on('end', () => {
            if (profile && path.extname(profile.filename).toLowerCase() === '.zip') {
              fs.createReadStream(destPath)
                .pipe(unzip.Extract({ path: profileDir }))
                .on('error', (err) => {
                  this.logger.warn(`error unzipping ${profile.filename} with unzipper`, err);
                  const zip = new admzip(destPath);
                  zip.extractAllTo(profileDir, true); // true -> overwrite
                  resolve();
                })
                .on('close', () => {
                  resolve();
                });
            }
            resolve();
          });
        });
      } catch (e) {
        this.logger.error('Server was unable to download file:', profile.url);
        this.logger.error(e);
      }

      this.sup.sendProfileList();
    }

    async buildJar(builder: DispatchCommand['builder'], version: string): Promise<void> {
      if (!builder) {
        this.logger.error('missing all arguments for BuildTools');
        return;
      }

      const retval: DispatchResult = {
        command: 'BuildTools jar compilation',
        success: false,
        help_text: '',
      };

      try {
        const profilePath = path.join(this.sup.baseDir, DIRS.profiles);
        const workingDir = path.join(profilePath, `${builder.group}_${version}`);
        const btPath = path.join(profilePath, builder.id, builder.filename);
        const destPath = path.join(workingDir, builder.filename);
        const params = { cwd: workingDir };

        await fs.promises.mkdir(workingDir);
        await fs.copy(btPath, destPath);

        const binary = which.sync('java');

        this.logger.info('BuildTools starting with arguments:', builder);
        const proc = child.spawn(binary, ['-Xms512M', '-jar', destPath, '--rev', version], params);

        await new Promise<void>((resolve, reject) => {
          proc.stdout.on('data', (data) => {
            this.sup.socket.emit('build_jar_output', data.toString());
          });

          proc.stderr.on('data', (data) => {
            this.sup.socket.emit('build_jar_output', data.toString());
            this.logger.error('BuildTools stderr: ', data);
          });

          proc.on('close', (code) => {
            if (code === 0) {
              resolve();
            }
            reject(code);
          });
        });

        this.logger.info(`BuildTools jar compilation finished successfully in ${workingDir}`);
        this.logger.info(`Buildtools used: ${destPath}`);

        retval.success = true;
      } catch (e) {
        this.logger.error('could not build jar;  insufficient/incorrect arguments provided:', builder);
        this.logger.error(e);

        retval.help_text = `Error ${(e as any).errno} (${(e as any).code}): ${(e as any).path}`;
      }

      this.sup.socket.emit('host_notice', retval);
      this.sup.sendSpigotList();
    }

    async delete(version: string): Promise<void> {
      const retval: DispatchResult = {
        command: 'BuildTools jar compilation',
        success: false,
        help_text: '',
      };

      try {
        await fs.remove(path.join(this.sup.baseDir, DIRS.profiles, `spigot_${version}`));
        retval.success = true;
      } catch (e) {
        retval.help_text = `Error ${e}`;
      }

      this.sup.socket.emit('host_notice', retval);
      this.sup.sendSpigotList();
    }

    async copy(name: string, version: string): Promise<void> {
      const spigotPath = path.join(this.sup.baseDir, DIRS.profiles, `spigot_${version}`) + path.sep;
      const destPath = path.join(this.sup.baseDir, DIRS.servers, name) + path.sep;

      const proc = Rsync.build({
        source: spigotPath,
        destination: destPath,
        flags: 'au',
        shell: 'ssh',
      });

      proc.set('--include', '*.jar');
      proc.set('--exclude', '*');
      proc.set('--prune-empty-dirs');
      proc.set('--chown', `${this.owner.uid}:${this.owner.gid}`);

      const retval: DispatchResult = {
        command: 'BuildTools jar copy',
        success: false,
        help_text: '',
      };

      try {
        await proc.execute();
        retval.success = true;
      } catch (e) {
        retval.help_text = `Error ${e}`;
      }

      this.sup.socket.emit('host_notice', retval);

      for (const s in this.sup.instances) {
        this.sup.socket.emit('track_server', s);
      }
    }

    async createFromArchive(name: string, filename: string, awdDir?: string): Promise<void> {
      const inst = new Instance(name, this.sup.baseDir);

      if (await inst.exists()) {
        this.logger.error(`Instance ${name} already exists`);
        return;
      }

      const pathSegments: string[] = [];
      if (awdDir) {
        pathSegments.push(...[inst.env.baseDir, DIRS.archive, awdDir, filename]);
      } else {
        pathSegments.push(...[inst.env.baseDir, DIRS.import, filename]);
      }

      const filepath = path.join(...pathSegments);

      try {
        await inst.createFromArchive(this.owner, filepath);
        this.logger.info(`[${name}] Server created in filesystem.`);
        setTimeout(() => {
          this.sup.socket.emit('track_server', name);
        }, 1000);
      } catch (e) {
        this.logger.error(`error creating server from archive at ${filepath}:`, e);
      }
    }
  };
}
