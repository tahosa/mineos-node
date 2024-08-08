import type profile from './profiles.d/template.js';
import { type collection } from './profiles.d/template.js';

import Socket from 'socket.io';
import axios from 'axios';
import async from 'async';
import path from 'node:path';
import os from 'node:os';
import logging from 'winston';
import fs from 'fs-extra';
import procfs from 'procfs-stats';
import { check } from 'diskusage';
import which from 'which';
import child from 'child_process';
import rsync from 'rsync';
import dgram from 'dgram';
import Fireworm from 'fireworm/index.js';
import request from 'request';
import userid from 'userid';
import progress from 'request-progress';
import unzip from 'unzipper';
import admzip from 'adm-zip';
import child_process from 'node:child_process';
import passwd from 'etc-passwd';
import { constants } from 'node:fs';
import introspect from 'introspect';
import { Tail } from 'tail';
import { CronJob } from 'cron';
import { randomUUID } from 'node:crypto';
import hash from 'object-hash';

import auth from './auth.js';
import mineos, { DIRS } from './mineos.js';
import PROFILES from './profiles.js';
import { PromisePool } from './util.js';

const SOURCES = PROFILES.profile_manifests;
const F_OK = constants.F_OK;

logging.add(
  new logging.transports.File({
    filename: '/var/log/mineos.log',
    handleExceptions: true,
    level: 'debug',
  }),
);

export default class server {
  base_dir: string;
  servers = {};
  profiles: profile[] = [];
  front_end: Socket;
  commit_msg = '';

  constructor(
    base_dir: string,
    socket_emitter: Socket,
    user_config: { creators?: string },
  ) {
    this.base_dir = base_dir;
    this.servers = {};
    this.profiles = [];
    this.front_end = socket_emitter;
    this.commit_msg = '';

    process.umask(0o002);

    fs.ensureDirSync(base_dir);
    fs.ensureDirSync(path.join(base_dir, DIRS['servers']));
    fs.ensureDirSync(path.join(base_dir, DIRS['backup']));
    fs.ensureDirSync(path.join(base_dir, DIRS['archive']));
    fs.ensureDirSync(path.join(base_dir, DIRS['import']));
    fs.ensureDirSync(path.join(base_dir, DIRS['profiles']));

    fs.chmod(path.join(base_dir, DIRS['import']), 0o777);

    (async () => {
      const gitPath = await which('git');
      this.commit_msg = await new Promise<string>((resolve, reject) => {
        const opts = { cwd: __dirname };
        child.execFile(
          gitPath,
          ['show', '--oneline', '-s'],
          opts,
          (error, stdout) => {
            if (error) {
              reject(error);
              return;
            }

            resolve(stdout);
          },
        );
      });

      logging.info('Starting up server, using commit:', this.commit_msg);
    })();

    (() => {
      //thanks to https://github.com/flareofghast/node-advertiser/blob/master/advert.js
      const udp_broadcaster = {};
      const UDP_DEST = '255.255.255.255';
      const UDP_PORT = 4445;
      const BROADCAST_DELAY_MS = 4000;

      async.forever(
        (next) => {
          for (const s in this.servers) {
            this.servers[s].broadcast_to_lan((msg, server_ip) => {
              if (msg) {
                if (udp_broadcaster[server_ip]) {
                  udp_broadcaster[server_ip].send(
                    msg,
                    0,
                    msg.length,
                    UDP_PORT,
                    UDP_DEST,
                  );
                } else {
                  udp_broadcaster[server_ip] = dgram.createSocket('udp4');
                  udp_broadcaster[server_ip].bind(UDP_PORT, server_ip);
                  udp_broadcaster[server_ip].on('listening', () => {
                    udp_broadcaster[server_ip].setBroadcast(true);
                    udp_broadcaster[server_ip].send(
                      msg,
                      0,
                      msg.length,
                      UDP_PORT,
                      UDP_DEST,
                    );
                  });
                  udp_broadcaster[server_ip].on('error', () => {
                    logging.error('Cannot bind broadcaster to ip ' + server_ip);
                  });
                }
              }
            });
          }
          setTimeout(() => {
            next();
          }, BROADCAST_DELAY_MS);
        },
        () => {},
      );
    })();

    (() => {
      const HOST_DU_HEARTBEAT_DELAY_MS = 10000; // statvfs might be heavy, every 10s should be reasonable
      const HOST_HEARTBEAT_DELAY_MS = 1000;

      /**
       * Obtains the disk utilisation for a given mount point using statvfs
       *
       * @param {string} path The disk mount point to monitor for free space
       */
      const getFreeSpace = async (path) => {
        try {
          const info = await check(path);
          if (this.front_end) {
            this.front_end.emit('host_diskspace', {
              availdisk: info.available,
              freedisk: info.free,
              totaldisk: info.total,
            });
          } else {
            throw new Error('front_end not set');
          }
        } catch (err) {
          logging.error('Failure in server.js:getFreeSpace() ' + err);
        }
      };

      /**
       * A callback function fired by setInterval (below)
       * in turn calls Promise getFreeSpace()
       */
      const host_diskspace = async () => {
        await getFreeSpace('/');
      };

      const host_heartbeat = () => {
        async.waterfall([async.apply(procfs['meminfo'])], (err, meminfo) => {
          this.front_end.emit('host_heartbeat', {
            uptime: os.uptime(),
            freemem:
              meminfo && meminfo['MemAvailable']
                ? meminfo['MemAvailable'] * 1024
                : os.freemem(),
            loadavg: os.loadavg(),
          });
        });
      };

      setInterval(host_diskspace, HOST_DU_HEARTBEAT_DELAY_MS);
      setInterval(host_heartbeat, HOST_HEARTBEAT_DELAY_MS);
    })();

    (() => {
      const server_path = path.join(base_dir, DIRS['servers']);

      const discover = () => {
        //http://stackoverflow.com/a/24594123/1191579
        return fs.readdirSync(server_path).filter((p) => {
          try {
            return fs.statSync(path.join(server_path, p)).isDirectory();
          } catch (e) {
            logging.warn(
              `Filepath ${path.join(server_path, p)} does not point to an existing directory`,
            );
          }
        });
      };

      const track = (sn) => {
        this.servers[sn] = null;
        //if new server_container() isn't instant, double broadcast might trigger this if/then twice
        //setting to null is immediate and prevents double execution
        this.servers[sn] = new server_container(
          sn,
          user_config,
          this.front_end,
        );
        this.front_end.emit('track_server', sn);
      };

      const untrack = (sn) => {
        try {
          this.servers[sn].cleanup();
          delete this.servers[sn];
        } catch (e) {
          //if server has already been deleted and this is running for reasons unknown, catch and ignore
        } finally {
          this.front_end.emit('untrack_server', sn);
        }
      };

      const discovered_servers = discover();
      for (const i in discovered_servers) track(discovered_servers[i]);

      fs.watch(server_path, () => {
        const current_servers = discover();

        for (const i in current_servers)
          if (!(current_servers[i] in this.servers))
            //if detected directory not a discovered server, track
            track(current_servers[i]);

        for (const s in this.servers)
          if (current_servers.indexOf(s) < 0) untrack(s);
      });
    })();

    (() => {
      const importable_archives = path.join(base_dir, DIRS['import']);

      const fw = Fireworm(importable_archives);
      fw.add('**/*.zip');
      fw.add('**/*.tar');
      fw.add('**/*.tgz');
      fw.add('**/*.tar.gz');

      fw.on('add', (fp) => {
        logging.info('[WEBUI] New file found in import directory', fp);
        this.send_importable_list();
      }).on('remove', (fp) => {
        logging.info('[WEBUI] File removed from import directory', fp);
        this.send_importable_list();
      });
    })();

    setTimeout(() => {
      this.start_servers();
    }, 5000);

    this.front_end.on('connection', (socket) => {
      const ip_address = socket.request.connection.remoteAddress;
      const username = socket.request.user.username;

      const OWNER_CREDS = {
        uid: userid.uid(username),
        gid: userid.gids(username)[0],
      };

      const webui_dispatcher = (args) => {
        let instance;
        logging.info(
          `[WEBUI] Received emit command from ${ip_address}:${username}`,
          args,
        );
        switch (args.command) {
          case 'create':
            instance = new mineos(args.server_name, base_dir);

            async.series(
              [
                async.apply(instance.verify, '!exists'),
                (cb) => {
                  let whitelisted_creators = [username]; //by default, accept create attempt by current user
                  if (user_config?.creators) {
                    //if creators key:value pair exists, use it
                    whitelisted_creators = user_config['creators'].split(',');
                    whitelisted_creators = whitelisted_creators.filter(
                      (e) => e,
                    ); //remove non-truthy entries like ''
                    whitelisted_creators = whitelisted_creators.map((e) =>
                      e.trim(),
                    ); //remove trailing and tailing whitespace

                    logging.info(
                      'Explicitly authorized server creators are:',
                      whitelisted_creators,
                    );
                  }
                  cb(
                    !(whitelisted_creators.indexOf(username) >= 0)
                      ? new Error()
                      : null,
                  );
                },
                async.apply(instance.create, OWNER_CREDS),
                async.apply(instance.overlay_sp, args.properties),
              ],
              (err) => {
                if (!err)
                  logging.info(
                    `[${args.server_name}] Server created in filesystem.`,
                  );
                else {
                  logging.info(
                    `[${args.server_name}] Failed to create server in filesystem as user ${username}.`,
                  );
                  logging.error(err);
                }
              },
            );
            break;
          case 'create_unconventional_server':
            instance = new mineos(args.server_name, base_dir);

            async.series(
              [
                async.apply(instance.verify, '!exists'),
                async.apply(instance.create_unconventional_server, OWNER_CREDS),
              ],
              (err) => {
                if (!err)
                  logging.info(
                    `[${args.server_name}] Server (unconventional) created in filesystem.`,
                  );
                else logging.error(err);
              },
            );
            break;
          case 'download':
            for (const idx in this.profiles) {
              if (this.profiles[idx].id == args.profile.id) {
                const profile_dir = path.join(
                  base_dir,
                  'profiles',
                  args.profile.id,
                );
                const dest_filepath = path.join(
                  profile_dir,
                  args.profile.filename,
                );

                async.series(
                  [
                    async.apply(fs.ensureDir, profile_dir),
                    (cb) => {
                      progress(
                        request({
                          url: args.profile.url,
                          headers: { 'User-Agent': 'MineOS-node' },
                        }),
                        { throttle: 250, delay: 100 },
                      )
                        .on('error', (err) => {
                          logging.error(err);
                        })
                        .on('progress', (state) => {
                          args.profile.progress = state;
                          this.front_end.emit('file_progress', args.profile);
                        })
                        .on('complete', (response) => {
                          if (response.statusCode == 200) {
                            logging.info(
                              `[WEBUI] Successfully downloaded ${args.profile.url} to ${dest_filepath}`,
                            );
                          } else {
                            logging.error(
                              '[WEBUI] Server was unable to download file:',
                              args.profile.url,
                            );
                            logging.error(
                              `[WEBUI] Remote server returned status ${response.statusCode} with headers:`,
                              response.headers,
                            );
                          }
                          cb(response.statusCode != 200 ? new Error() : null);
                        })
                        .pipe(fs.createWriteStream(dest_filepath));
                    },
                    (cb) => {
                      switch (
                        path.extname(args.profile.filename).toLowerCase()
                      ) {
                        case '.jar':
                          cb();
                          break;
                        case '.zip':
                          fs.createReadStream(dest_filepath).pipe(
                            unzip
                              .Extract({ path: profile_dir })
                              .on('close', () => {
                                cb();
                              })
                              .on('error', () => {
                                //Unzip error occurred, falling back to adm-zip
                                const zip = new admzip(dest_filepath);
                                zip.extractAllTo(profile_dir, true); //true => overwrite
                                cb();
                              }),
                          );
                          break;
                        default:
                          cb();
                          break;
                      }
                    },
                    (cb) => {
                      // wide-area net try/catch. addressing issue of multiple simultaneous downloads.
                      // current theory: if multiple downloads occuring, and one finishes, forcing a
                      // redownload of profiles, SOURCES might be empty/lacking the unfinished dl.
                      // opting for full try/catch around postdownload to gracefully handle profile errors
                      try {
                        if (SOURCES[args.profile['group']].postdownload) {
                          SOURCES[args.profile['group']].postdownload!(
                            profile_dir,
                            dest_filepath,
                          )
                            .then(() => {
                              cb();
                            })
                            .catch((err) => {
                              cb(err);
                            });
                        } else cb();
                      } catch (e) {
                        logging.error(
                          'simultaneous download race condition means postdownload hook may not have executed. redownload the profile to ensure proper operation.',
                        );
                        logging.error(
                          `exception in postdownload server.js try/catch ${e}`,
                        );
                        cb();
                      }
                    },
                  ],
                  () => {
                    this.send_profile_list();
                  },
                );
                break;
              }
            }
            break;
          case 'build_jar':
            let profile_path: string,
              working_dir: string,
              bt_path: string,
              dest_path: string,
              params: { cwd: string };
            try {
              profile_path = path.join(base_dir, DIRS['profiles']);
              working_dir = path.join(
                profile_path,
                `${args.builder.group}_${args.version}`,
              );
              bt_path = path.join(
                profile_path,
                args.builder.id,
                args.builder.filename,
              );
              dest_path = path.join(working_dir, args.builder.filename);
              params = { cwd: working_dir };
            } catch (e) {
              logging.error(
                '[WEBUI] Could not build jar; insufficient/incorrect arguments provided:',
                args,
              );
              logging.error(e);
              return;
            }

            async.series(
              [
                async.apply(fs.mkdir, working_dir),
                async.apply(fs.copy, bt_path, dest_path),
                (cb) => {
                  const binary = which.sync('java');
                  const proc = child_process.spawn(
                    binary,
                    ['-Xms512M', '-jar', dest_path, '--rev', args.version],
                    params,
                  );

                  proc.stdout.on('data', (data) => {
                    this.front_end.emit('build_jar_output', data.toString());
                    //logging.debug('stdout: ' + data);
                  });

                  logging.info(
                    '[WEBUI] BuildTools starting with arguments:',
                    args,
                  );

                  proc.stderr.on('data', (data) => {
                    this.front_end.emit('build_jar_output', data.toString());
                    logging.error('stderr: ' + data);
                  });

                  proc.on('close', (code) => {
                    cb(new Error(`${code}`));
                  });
                },
              ],
              (err) => {
                logging.info(
                  `[WEBUI] BuildTools jar compilation finished ${err ? 'unsuccessfully' : 'successfully'} in ${working_dir}`,
                );
                logging.info(`[WEBUI] Buildtools used: ${dest_path}`);

                const retval = {
                  command: 'BuildTools jar compilation',
                  success: true,
                  help_text: '',
                };

                if (err) {
                  retval['success'] = false;
                  retval['help_text'] = `Error: ${err}`;
                }

                this.front_end.emit('host_notice', retval);
                this.send_spigot_list();
              },
            );
            break;
          case 'delete_build':
            let spigot_path: string;
            if (args.type == 'spigot') {
              spigot_path = path.join(
                base_dir,
                DIRS['profiles'],
                'spigot_' + args.version,
              );
            } else {
              logging.error(
                '[WEBUI] Unknown type of craftbukkit server -- potential modified webui request?',
              );
              return;
            }

            fs.remove(spigot_path, (err) => {
              const retval = {
                command: 'Delete BuildTools jar',
                success: true,
                help_text: '',
              };

              if (err) {
                retval['success'] = false;
                retval['help_text'] = `Error ${err}`;
              }

              this.front_end.emit('host_notice', retval);
              this.send_spigot_list();
            });
            break;
          case 'copy_to_server':
            if (args.type == 'spigot')
              spigot_path =
                path.join(
                  base_dir,
                  DIRS['profiles'],
                  'spigot_' + args.version,
                ) + '/';
            else {
              logging.error(
                '[WEBUI] Unknown type of craftbukkit server -- potential modified webui request?',
              );
              return;
            }
            dest_path =
              path.join(base_dir, DIRS['servers'], args.server_name) + '/';

            const obj = rsync.build({
              source: spigot_path,
              destination: dest_path,
              flags: 'au',
              shell: 'ssh',
            });

            obj.set('--include', '*.jar');
            obj.set('--exclude', '*');
            obj.set('--prune-empty-dirs');
            obj.set('--chown', `${OWNER_CREDS.uid}:${OWNER_CREDS.gid}`);

            obj.execute((error, code) => {
              const retval = {
                command: 'BuildTools jar copy',
                success: true,
                help_text: '',
              };

              if (error) {
                retval['success'] = false;
                retval['help_text'] = `Error ${error} (${code})`;
              }

              this.front_end.emit('host_notice', retval);
              for (const s in this.servers)
                this.front_end.emit('track_server', s);
            });

            break;
          case 'refresh_server_list':
            for (const s in this.servers)
              this.front_end.emit('track_server', s);
            break;
          case 'refresh_profile_list':
            this.send_profile_list();
            this.send_spigot_list();
            break;
          case 'create_from_archive':
            instance = new mineos(args.new_server_name, base_dir);
            let filepath: string;
            if (args.awd_dir)
              filepath = path.join(
                instance.env.base_dir,
                DIRS['archive'],
                args.awd_dir,
                args.filename,
              );
            else
              filepath = path.join(
                instance.env.base_dir,
                DIRS['import'],
                args.filename,
              );

            async.series(
              [
                async.apply(instance.verify, '!exists'),
                async.apply(
                  instance.create_from_archive,
                  OWNER_CREDS,
                  filepath,
                ),
              ],
              (err) => {
                if (!err) {
                  logging.info(
                    `[${args.new_server_name}] Server created in filesystem.`,
                  );
                  setTimeout(() => {
                    this.front_end.emit('track_server', args.new_server_name);
                  }, 1000);
                } else logging.error(err);
              },
            );
            break;
          default:
            logging.warn(`Command ignored: no such command ${args.command}`);
            break;
        }
      };

      const send_user_list = () => {
        const users: any[] = [];
        const groups: any[] = [];

        passwd
          .getUsers()
          .on('user', (user_data) => {
            if (user_data.username == username)
              users.push({
                username: user_data.username,
                uid: user_data.uid,
                gid: user_data.gid,
                home: user_data.home,
              });
          })
          .on('end', () => {
            socket.emit('user_list', users);
          });

        passwd
          .getGroups()
          .on('group', (group_data) => {
            if (
              group_data.users.indexOf(username) >= 0 ||
              group_data.gid == userid.gids(username)[0]
            ) {
              if (group_data.gid > 0) {
                groups.push({
                  groupname: group_data.groupname,
                  gid: group_data.gid,
                });
              }
            }
          })
          .on('end', () => {
            socket.emit('group_list', groups);
          });
      };

      logging.info(`[WEBUI] ${username} connected from ${ip_address}`);
      socket.emit('whoami', username);
      socket.emit('commit_msg', this.commit_msg);
      socket.emit('change_locale', (user_config || {})['webui_locale']);
      socket.emit('optional_columns', (user_config || {})['optional_columns']);

      for (const server_name in this.servers)
        socket.emit('track_server', server_name);

      socket.on('command', webui_dispatcher);
      send_user_list();
      this.send_profile_list(true);
      this.send_spigot_list();
      this.send_importable_list();
      this.send_locale_list();
    });
  }

  start_servers() {
    const MS_TO_PAUSE = 10000;

    async.eachLimit(
      Object.keys(this.servers),
      1,
      (server_name, callback) => {
        this.servers[server_name].onreboot_start((err) => {
          if (err)
            logging.error(
              `[${server_name}] Aborted server startup; condition not met:`,
              err,
            );
          else
            logging.info(
              `[${server_name}] Server started. Waiting ${MS_TO_PAUSE} ms...`,
            );

          setTimeout(
            () => {
              callback();
            },
            err ? 1 : MS_TO_PAUSE,
          );
        });
      },
      () => {},
    );
  }

  shutdown() {
    for (const server_name in this.servers) this.servers[server_name].cleanup();
  }

  async send_profile_list(send_existing?: boolean) {
    if (send_existing && this.profiles.length)
      //if requesting to just send what you already have AND they are already present
      this.front_end.emit('profile_list', this.profiles);
    else {
      const profile_dir = path.join(this.base_dir, DIRS['profiles']);
      const pool = new PromisePool<profile[], [string, collection]>(
        Object.entries(SOURCES),
        3,
        async ([name, profile]) => {
          try {
            let output: profile[] = [];
            if (profile.request_args) {
              const response = await axios.get(profile.request_args.url, {
                responseType: profile.request_args.type,
              });
              if (response.status != 200) {
                throw new Error(`${response.data}`);
              } else {
                output = await profile.handler(profile_dir, response.data);
              }
            } else {
              output = await profile.handler(profile_dir);
            }

            logging.info(
              `Downloaded information for collection: ${name} (${output.length} entries)`,
            );
            return output;
          } catch (e) {
            logging.error(
              `Unable to retrieve profile: ${name}. The definition for this profile may be improperly formed or is pointing to an invalid URI.`,
            );
            return [];
          }
        },
      );

      this.profiles = (await pool.process()).flat();
      this.front_end.emit('profile_list', this.profiles);
    }
  }

  send_spigot_list() {
    const profiles_dir = path.join(this.base_dir, DIRS['profiles']);
    const spigot_profiles = {};

    async.waterfall(
      [
        async.apply(fs.readdir, profiles_dir),
        (listing, cb) => {
          for (const i in listing) {
            const match = listing[i].match(/(paper)?spigot_([\d.]+)/);
            if (match)
              spigot_profiles[match[0]] = {
                directory: match[0],
                jarfiles: fs
                  .readdirSync(path.join(profiles_dir, match[0]))
                  .filter((a) => {
                    return a.match(/.+\.jar/i);
                  }),
              };
          }
          cb();
        },
      ],
      () => {
        this.front_end.emit('spigot_list', spigot_profiles);
      },
    );
  }

  send_locale_list() {
    async.waterfall(
      [
        async.apply(fs.readdir, path.join(__dirname, 'html', 'locales')),
        (locale_paths, cb) => {
          const locales = locale_paths.map((r) => {
            return r.match(/^locale-([a-z]{2}_[A-Z]{2}).json$/)[1];
          });
          cb(null, locales);
        },
      ],
      (err, output) => {
        logging.info(output);
        if (!err) this.front_end.emit('locale_list', output);
        else this.front_end.emit('locale_list', ['en_US']);
      },
    );
  }

  send_importable_list() {
    const importable_archives = path.join(this.base_dir, DIRS['import']);
    const all_info: { time?: Date; size?: number; filename: string }[] = [];

    fs.readdir(importable_archives, (err, files) => {
      if (!err) {
        const fullpath = files.map((value) => {
          return path.join(importable_archives, value);
        });

        async.map<string, fs.Stats>(fullpath, fs.stat, (inner_err, results) => {
          results?.forEach((value, index) => {
            all_info.push({
              time: value?.mtime,
              size: value?.size,
              filename: files[index],
            });
          });

          all_info.sort((a, b) => {
            return (a.time?.getTime() || 0) - (b.time?.getTime() || 0);
          });

          this.front_end.emit('archive_list', all_info);
        });
      }
    });
  }
}

export class server_container {
  instance: mineos;
  nsp;
  tails = {};
  notices: string[] = [];
  cron = {};
  intervals = {};
  HEARTBEAT_INTERVAL_MS = 5000;
  COMMIT_INTERVAL_MIN = null;

  constructor(server_name, user_config, socket) {
    // when evoked, creates a permanent 'mc' instance, namespace, and place for file tails.
    this.instance = new mineos(server_name, user_config.base_directory);
    this.nsp = socket.of(`/${server_name}`);

    logging.info(`[${server_name}] Discovered server`);

    // check that awd and bwd also exist alongside cwd or create and chown
    let missing_dir = false;
    try {
      fs.accessSync(this.instance.env.bwd, F_OK);
    } catch (e) {
      missing_dir = true;
    }
    try {
      fs.accessSync(this.instance.env.awd, F_OK);
    } catch (e) {
      missing_dir = true;
    }

    if (missing_dir) {
      async.series([
        async.apply(fs.ensureDir, this.instance.env.bwd),
        async.apply(fs.ensureDir, this.instance.env.awd),
        async.apply(this.instance.sync_chown),
      ]);
    }

    //async.series([ async.apply(instance.sync_chown) ]);
    //uncomment sync_chown to correct perms on server discovery
    //commenting out for high cpu usage on startup

    let files_to_tail = [
      'logs/latest.log',
      'server.log',
      'proxy.log.0',
      'logs/fml-server-latest.log',
    ];
    if ((user_config || {}).additional_logfiles) {
      //if additional_logfiles key:value pair exists, use it
      let additional = user_config['additional_logfiles'].split(',');
      additional = additional.filter((e) => e); //remove non-truthy entries like ''
      additional = additional.map((e) => e.trim()); //remove trailing and tailing whitespace
      additional = additional.map((e) =>
        path.normalize(e).replace(/^(\.\.[/\\])+/, ''),
      ); //normalize path, remove traversal

      logging.info('Explicitly added files to tail are:', additional);
      files_to_tail = files_to_tail.concat(additional);
    }

    for (const i in files_to_tail) this.make_tail(files_to_tail[i]);

    (() => {
      let skip_dirs = fs.readdirSync(this.instance.env.cwd).filter((p) => {
        try {
          return fs.statSync(path.join(this.instance.env.cwd, p)).isDirectory();
        } catch (e) {
          logging.error(e);
          return false;
        }
      });

      const default_skips = [
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
      for (const i in default_skips)
        if (skip_dirs.indexOf(default_skips[i]) == -1)
          skip_dirs.push(default_skips[i]);

      skip_dirs = skip_dirs.filter((e) => e !== 'logs'); // remove 'logs' from blacklist!

      logging.info(`[${server_name}] Using skipDirEntryPatterns: ${skip_dirs}`);

      const fw = Fireworm(this.instance.env.cwd, {
        skipDirEntryPatterns: skip_dirs,
      });

      for (const i in skip_dirs) {
        fw.ignore(skip_dirs[i]);
      }
      fw.add('**/server.properties');
      fw.add('**/server.config');
      fw.add('**/cron.config');
      fw.add('**/eula.txt');
      fw.add('**/server-icon.png');
      fw.add('**/config.yml');

      const FS_DELAY = 250;
      const handle_event = (fp) => {
        // because it is unknown when fw triggers on add/change and
        // further because if it catches DURING the write, it will find
        // the file has 0 size, adding arbitrary delay.
        // process.nexttick didnt work.
        const file_name = path.basename(fp);
        switch (file_name) {
          case 'server.properties':
            setTimeout(() => {
              this.broadcast_sp();
            }, FS_DELAY);
            break;
          case 'server.config':
            setTimeout(() => {
              this.broadcast_sc();
            }, FS_DELAY);
            break;
          case 'cron.config':
            setTimeout(() => {
              this.broadcast_cc();
            }, FS_DELAY);
            break;
          case 'eula.txt':
            setTimeout(() => {
              this.emit_eula();
            }, FS_DELAY);
            break;
          case 'server-icon.png':
            setTimeout(() => {
              this.broadcast_icon();
            }, FS_DELAY);
            break;
          case 'config.yml':
            setTimeout(() => {
              this.broadcast_cy();
            }, FS_DELAY);
            break;
        }
      };

      fw.on('add', handle_event);
      fw.on('change', handle_event);
    })();

    const heartbeat = () => {
      clearInterval(this.intervals['heartbeat']);
      this.intervals['heartbeat'] = setInterval(
        heartbeat,
        this.HEARTBEAT_INTERVAL_MS * 3,
      );

      async.parallel(
        {
          up: (cb) => {
            this.instance.property('up', (err, is_up) => {
              cb(null, is_up);
            });
          },
          memory: (cb) => {
            this.instance.property('memory', (err, mem) => {
              cb(null, err ? {} : mem);
            });
          },
          ping: (cb) => {
            this.instance.property(
              'unconventional',
              (err, is_unconventional) => {
                if (is_unconventional)
                  cb(null, {}); //ignore ping--wouldn't respond in any meaningful way
                else
                  this.instance.property('ping', (err, ping) => {
                    cb(null, err ? {} : ping);
                  });
              },
            );
          },
          query: (cb) => {
            this.instance.property('server.properties', (err, dict) => {
              if ((dict || {})['enable-query'])
                this.instance.property('query', cb);
              else cb(null, {}); //ignore query--wouldn't respond in any meaningful way
            });
          },
        },
        (err, retval) => {
          clearInterval(this.intervals['heartbeat']);
          this.intervals['heartbeat'] = setInterval(
            heartbeat,
            this.HEARTBEAT_INTERVAL_MS,
          );

          this.nsp.emit('heartbeat', {
            server_name: server_name,
            timestamp: Date.now(),
            payload: retval,
          });
        },
      );
    };

    this.intervals['heartbeat'] = setInterval(
      heartbeat,
      this.HEARTBEAT_INTERVAL_MS,
    );

    const world_committer = () => {
      async.waterfall([
        async.apply(this.instance.property, 'commit_interval'),
        (minutes) => {
          if (minutes != this.COMMIT_INTERVAL_MIN) {
            //upon change or init
            this.COMMIT_INTERVAL_MIN = minutes;
            if (minutes > 0) {
              logging.info(
                `[${server_name}] committing world to disk every ${minutes} minutes.`,
              );
              this.intervals['commit'] = setInterval(
                this.instance.saveall,
                minutes * 60 * 1000,
              );
            } else {
              logging.info(
                `[${server_name}] not committing world to disk automatically (interval set to ${minutes})`,
              );
              clearInterval(this.intervals['commit']);
            }
          }
        },
      ]);
    };

    this.intervals['world_commit'] = setInterval(
      world_committer,
      1 * 60 * 1000,
    );

    (() => {
      const cron_dispatcher = (args) => {
        const arg_array: any[] = [];

        const fn = this.instance[args.command];
        const required_args = introspect(fn);

        for (const i in required_args) {
          // all callbacks expected to follow the pattern (success, payload).
          if (required_args[i] == 'callback')
            arg_array.push((err) => {
              args.success = !err;
              args.err = err;
              args.time_resolved = Date.now();
              if (err)
                logging.error(
                  `[${server_name}] command "${args.command}" errored out:`,
                  args,
                );
            });
          else if (required_args[i] in args) {
            arg_array.push(args[required_args[i]]);
          }
        }

        fn.apply(this.instance, arg_array);
      };

      this.instance.crons((err, cron_dict) => {
        for (const cronhash in cron_dict) {
          if (cron_dict[cronhash].enabled) {
            try {
              this.cron[cronhash] = new CronJob({
                cronTime: cron_dict[cronhash].source,
                onTick: () => {
                  cron_dispatcher(this);
                },
                start: true,
                context: cron_dict[cronhash],
              });
            } catch (e) {
              // catches invalid cron expressions
              logging.warn(
                `[${server_name}] invalid cron expression:`,
                cronhash,
                cron_dict[cronhash],
              );
              this.instance.set_cron(cronhash, false, () => {});
            }
          }
        }
      });
    })();

    this.nsp.on('connection', async (socket) => {
      const ip_address = socket.request.connection.remoteAddress;
      const username = socket.request.user.username;
      const NOTICES_QUEUE_LENGTH = 10; // 0 < q <= 10

      const server_dispatcher = (args) => {
        let fn, required_args;
        const arg_array: any[] = [];

        try {
          fn = this.instance[args.command];
          required_args = introspect(fn);
          // receives an array of all expected arguments, using introspection.
          // they are in order as listed by the function definition, which makes iteration possible.
        } catch (e) {
          args.success = false;
          args.error = e;
          args.time_resolved = Date.now();
          this.nsp.emit('server_fin', args);
          logging.error('server_fin', args);

          while (this.notices.length > NOTICES_QUEUE_LENGTH)
            this.notices.shift();
          this.notices.push(args);
          return;
        }

        for (const i in required_args) {
          // all callbacks expected to follow the pattern (success, payload).
          if (required_args[i] == 'callback')
            arg_array.push((err) => {
              args.success = !err;
              args.err = err;
              args.time_resolved = Date.now();
              this.nsp.emit('server_fin', args);
              if (err)
                logging.error(
                  `[${this.instance.server_name}] command "${args.command}" errored out:`,
                  args,
                );
              logging.info('server_fin', args);

              while (this.notices.length > NOTICES_QUEUE_LENGTH)
                this.notices.shift();

              if (args.command != 'delete') this.notices.push(args);
            });
          else if (required_args[i] in args) {
            arg_array.push(args[required_args[i]]);
          } else {
            args.success = false;
            logging.error(
              'Provided values missing required argument',
              required_args[i],
            );
            args.error = `Provided values missing required argument: ${required_args[i]}`;
            this.nsp.emit('server_fin', args);
            return;
          }
        }

        if (args.command == 'delete') this.cleanup();

        logging.info(
          `[${this.instance.server_name}] received request "${args.command}"`,
        );
        fn.apply(this.instance, arg_array);
      };

      const produce_receipt = (args) => {
        /* when a command is received, immediately respond to client it has been received */
        logging.info(
          `[${this.instance.server_name}] ${ip_address} issued command : "${args.command}"`,
        );
        args.uuid = randomUUID();
        args.time_initiated = Date.now();
        this.nsp.emit('server_ack', args);

        switch (args.command) {
          case 'chown':
            async.waterfall(
              [
                async.apply(this.instance.property, 'owner'),
                (owner_data, cb) => {
                  if (owner_data.username != username)
                    cb(
                      'Only the current user owner may reassign server ownership.',
                    );
                  else if (owner_data.uid != args.uid)
                    cb('You may not change the user owner of the server.');
                  else cb();
                },
              ],
              (err) => {
                if (err) {
                  args.success = false;
                  args.err = err;
                  args.time_resolved = Date.now();
                  logging.error(
                    `[${this.instance.server_name}] command "${args.command}" errored out:`,
                    args,
                  );
                  this.nsp.emit('server_fin', args);
                } else {
                  server_dispatcher(args);
                }
              },
            );
            break;
          default:
            server_dispatcher(args);
            break;
        }
      };

      const get_file_contents = (rel_filepath) => {
        if (rel_filepath in this.tails) {
          //this is the protection from malicious client
          // a tail would only exist for a file the server has opened
          const abs_filepath = path.join(
            this.instance.env['cwd'],
            rel_filepath,
          );
          const FILESIZE_LIMIT_THRESHOLD = 256000;

          async.waterfall(
            [
              async.apply(fs.stat, abs_filepath),
              (stat_data, cb) => {
                cb(stat_data.size > FILESIZE_LIMIT_THRESHOLD);
              },
              async.apply(fs.readFile, abs_filepath),
              (data, cb) => {
                logging.info(
                  `[${this.instance.server_name}] transmittting existing file contents: ${rel_filepath} (${data.length} bytes)`,
                );
                this.nsp.emit('file head', {
                  filename: rel_filepath,
                  payload: data.toString(),
                });
                cb();
              },
            ],
            (err) => {
              if (err) {
                const msg = `File is too large (> ${FILESIZE_LIMIT_THRESHOLD / 1000} KB).  Only newly added lines will appear here.`;
                this.nsp.emit('file head', {
                  filename: rel_filepath,
                  payload: msg,
                });
              }
            },
          );
        }
      };

      const get_available_tails = () => {
        for (const t in this.tails)
          get_file_contents(
            this.tails[t].filename.replace(this.instance.env.cwd + '/', ''),
          );
      };

      const get_prop = (requested) => {
        logging.info(
          `[${this.instance.server_name}] ${ip_address} requesting property: ${requested.property}`,
        );
        this.instance.property(requested.property, (err, retval) => {
          logging.info(
            `[${this.instance.server_name}] returned to ${ip_address}: ${retval}`,
          );
          this.nsp.emit('server_fin', {
            server_name: server_name,
            property: requested.property,
            payload: retval,
          });
        });
      };

      const get_archives = () => {
        logging.debug(
          `[${this.instance.server_name}] ${username} requesting server archives`,
        );
        this.instance.list_archives((err, results) => {
          if (err)
            logging.error(
              `[${this.instance.server_name}] Error with get_archives`,
              err,
              results,
            );
          this.nsp.emit('archives', { payload: results });
        });
      };

      const get_increments = () => {
        logging.debug(
          `[${this.instance.server_name}] ${username} requesting server increments`,
        );
        this.instance.list_increments((err, results) => {
          if (err)
            logging.error(
              `[${this.instance.server_name}] Error with get_increments`,
              err,
              results,
            );
          this.nsp.emit('increments', { payload: results });
        });
      };

      const get_increment_sizes = () => {
        logging.debug(
          `[${this.instance.server_name}] ${username} requesting server increment sizes`,
        );
        this.instance.list_increment_sizes((err, results) => {
          if (err)
            logging.error(
              `[${this.instance.server_name}] Error with get_increment_sizes`,
              err,
              results,
            );
          this.nsp.emit('increment_sizes', { payload: results });
        });
      };

      const get_page_data = (page) => {
        switch (page) {
          case 'glance':
            logging.debug(
              `[${this.instance.server_name}] ${username} requesting server at a glance info`,
            );

            async.parallel(
              {
                du_awd: async.apply(this.instance.property, 'du_awd'),
                du_bwd: async.apply(this.instance.property, 'du_bwd'),
                du_cwd: async.apply(this.instance.property, 'du_cwd'),
                owner: async.apply(this.instance.property, 'owner'),
                server_files: async.apply(
                  this.instance.property,
                  'server_files',
                ),
                ftb_installer: async.apply(
                  this.instance.property,
                  'FTBInstall.sh',
                ),
                eula: async.apply(this.instance.property, 'eula'),
                base_dir: (cb) => {
                  cb(null, user_config.base_directory);
                },
                java_version_in_use: async.apply(
                  this.instance.property,
                  'java_version_in_use',
                ),
              },
              (err, results) => {
                if (err instanceof Object)
                  logging.error(
                    `[${this.instance.server_name}] Error with get_page_data glance`,
                    err,
                    results,
                  );
                this.nsp.emit('page_data', { page: page, payload: results });
              },
            );
            break;

          default:
            this.nsp.emit('page_data', { page: page });
            break;
        }
      };

      const manage_cron = (opts) => {
        const reload_cron = (callback) => {
          for (const c in this.cron) {
            try {
              this.cron[c].stop();
            } catch (e) {
              console.warn('Error stopping cron job: ', this.cron[c], e);
            }
          }
          this.cron = {};

          this.instance.crons((err, cron_dict) => {
            for (const cronhash in cron_dict) {
              if (cron_dict[cronhash].enabled) {
                try {
                  this.cron[cronhash] = new CronJob({
                    cronTime: cron_dict[cronhash].source,
                    onTick: () => {
                      server_dispatcher(this);
                    },
                    start: true,
                    context: cron_dict[cronhash],
                  });
                } catch (e) {
                  //catches invalid cron pattern, disables cron
                  logging.warn(
                    `[${this.instance.server_name}] ${ip_address} invalid cron expression submitted:`,
                    cron_dict[cronhash].source,
                  );
                  this.instance.set_cron(opts.hash, false, () => {});
                }
              }
            }
            callback();
          });
        };

        const operation = opts.operation;
        delete opts.operation;

        switch (operation) {
          case 'create':
            const cron_hash = hash(opts);
            logging.info(
              `[${this.instance.server_name}] ${ip_address} requests cron creation:`,
              cron_hash,
              opts,
            );

            opts['enabled'] = false;

            async.series([
              async.apply(this.instance.add_cron, cron_hash, opts),
              async.apply(reload_cron),
            ]);
            break;
          case 'delete':
            logging.info(
              `[${this.instance.server_name}] ${ip_address} requests cron deletion: ${opts.hash}`,
            );

            try {
              this.cron[opts.hash].stop();
            } catch (e) {
              console.warn(
                'Error deleting cron job: ',
                this.cron[opts.hash],
                e,
              );
            }

            try {
              delete this.cron[opts.hash];
            } catch (e) {
              console.warn(
                'Error deleting cron job: ',
                this.cron[opts.hash],
                e,
              );
            }

            async.series([
              async.apply(this.instance.delete_cron, opts.hash),
              async.apply(reload_cron),
            ]);
            break;
          case 'start':
            logging.info(
              `[${this.instance.server_name}] ${ip_address} starting cron: ${opts.hash}`,
            );

            async.series([
              async.apply(this.instance.set_cron, opts.hash, true),
              async.apply(reload_cron),
            ]);
            break;
          case 'suspend':
            logging.info(
              `[${this.instance.server_name}] ${ip_address} suspending cron: ${opts.hash}`,
            );

            async.series([
              async.apply(this.instance.set_cron, opts.hash, false),
              async.apply(reload_cron),
            ]);
            break;
          default:
            logging.warn(
              `[${this.instance.server_name}] ${ip_address} requested unexpected cron operation: ${operation}`,
              opts,
            );
        }
      };

      const connection_handler = (err) => {
        if (err) socket.disconnect();
        else {
          logging.info(
            `[${this.instance.server_name}] ${username} (${ip_address}) joined server namespace`,
          );

          socket.on('command', (args) => {
            produce_receipt(args);
          });
          socket.on('get_file_contents', (path) => {
            get_file_contents(path);
          });
          socket.on('get_available_tails', () => {
            get_available_tails();
          });
          socket.on('property', (requested) => {
            get_prop(requested);
          });
          socket.on('page_data', (page) => {
            get_page_data(page);
          });
          socket.on('archives', () => {
            get_archives();
          });
          socket.on('increments', () => {
            get_increments();
          });
          socket.on('increment_sizes', () => {
            get_increment_sizes();
          });
          socket.on('cron', (opts) => {
            manage_cron(opts);
          });
          socket.on('server.properties', () => {
            this.broadcast_sp();
          });
          socket.on('server.config', () => {
            this.broadcast_sc();
          });
          socket.on('cron.config', () => {
            this.broadcast_cc();
          });
          socket.on('server-icon.png', () => {
            this.broadcast_icon();
          });
          socket.on('config.yml', () => {
            this.broadcast_cy();
          });
          socket.on('req_server_activity', () => {
            this.broadcast_notices();
          });
        }
      };

      this.instance.property('owner', (err, data) => {
        auth.test_membership(username, data.groupname, (isValid) => {
          connection_handler(!isValid);
        });
      });
    }); //nsp on connect container ends
  }

  broadcast_to_lan(callback) {
    async.waterfall(
      [
        async.apply(this.instance.verify, 'exists'),
        async.apply(this.instance.verify, 'up'),
        async.apply(this.instance.sc),
        (sc_data, cb) => {
          const broadcast_value = (sc_data.minecraft || {}).broadcast;
          cb(!broadcast_value); //logically notted to make broadcast:true pass err cb
        },
        async.apply(this.instance.sp),
      ],
      (err, sp_data: any) => {
        if (err) callback(null);
        else {
          const msg = Buffer.from(
            '[MOTD]' +
              sp_data.motd +
              '[/MOTD][AD]' +
              sp_data['server-port'] +
              '[/AD]',
          );
          const server_ip = sp_data['server-ip'];
          callback(msg, server_ip);
        }
      },
    );
  }

  onreboot_start(callback) {
    async.waterfall(
      [
        async.apply(this.instance.property, 'onreboot_start'),
        (autostart, cb) => {
          logging.info(
            `[${this.instance.server_name}] autostart = ${autostart}`,
          );
          cb(!autostart); //logically NOT'ing so that autostart = true continues to next func
        },
        async.apply(this.instance.start),
      ],
      (err) => {
        callback(err);
      },
    );
  }

  cleanup() {
    for (const t in this.tails) this.tails[t].unwatch();

    for (const i in this.intervals) clearInterval(this.intervals[i]);

    this.nsp.removeAllListeners();
  }

  emit_eula() {
    async.waterfall([
      async.apply(this.instance.property, 'eula'),
      (accepted, cb) => {
        logging.info(
          `[${this.instance.server_name}] eula.txt detected: ${accepted ? 'ACCEPTED' : 'NOT YET ACCEPTED'} (eula=${accepted})`,
        );
        this.nsp.emit('eula', accepted);
        cb();
      },
    ]);
  }

  broadcast_icon() {
    // function to encode file data to base64 encoded string
    //http://www.hacksparrow.com/base64-encoding-decoding-in-node-js.html
    const filepath = path.join(this.instance.env.cwd, 'server-icon.png');
    fs.readFile(filepath, (err, data) => {
      if (!err && data.toString('hex', 0, 4) == '89504e47')
        //magic number for png first 4B
        this.nsp.emit('server-icon.png', Buffer.from(data).toString('base64'));
    });
  }

  broadcast_cy() {
    // function to broadcast raw config.yml from bungeecord
    const filepath = path.join(this.instance.env.cwd, 'config.yml');
    fs.readFile(filepath, (err, data) => {
      if (!err) this.nsp.emit('config.yml', Buffer.from(data).toString());
    });
  }

  broadcast_notices() {
    this.nsp.emit('notices', this.notices);
  }

  broadcast_sp() {
    this.instance.sp((err, sp_data) => {
      logging.debug(
        `[${this.instance.server_name}] broadcasting server.properties`,
      );
      this.nsp.emit('server.properties', sp_data);
    });
  }

  broadcast_sc() {
    this.instance.sc((err, sc_data) => {
      logging.debug(
        `[${this.instance.server_name}] broadcasting server.config`,
      );
      if (!err) this.nsp.emit('server.config', sc_data);
    });
  }

  broadcast_cc() {
    this.instance.crons((err, cc_data) => {
      logging.debug(`[${this.instance.server_name}] broadcasting cron.config`);
      if (!err) this.nsp.emit('cron.config', cc_data);
    });
  }

  make_tail(rel_filepath) {
    /* makes a file tail relative to the CWD, e.g., /var/games/minecraft/servers/myserver.
       tails are used to get live-event reads on files.

       if the server does not exist, a watch is made in the interim, waiting for its creation.
       once the watch is satisfied, the watch is closed and a tail is finally created.
    */
    const abs_filepath = path.join(this.instance.env.cwd, rel_filepath);

    if (rel_filepath in this.tails) {
      logging.warn(
        `[${this.instance.server_name}] Tail already exists for ${rel_filepath}`,
      );
      return;
    }

    try {
      const new_tail = new Tail(abs_filepath);
      logging.info(
        `[${this.instance.server_name}] Created tail on ${rel_filepath}`,
      );
      new_tail.on('line', (data) => {
        //logging.info(`[${this.instance.server_name}] ${rel_filepath}: transmitting new tail data`);
        this.nsp.emit('tail_data', { filepath: rel_filepath, payload: data });
      });
      this.tails[rel_filepath] = new_tail;
    } catch (e) {
      logging.error(
        `[${this.instance.server_name}] Create tail on ${rel_filepath} failed: `,
        e,
      );
      if ((e as any).errno != -2) {
        logging.error(e);
        return; //exit execution to perhaps curb a runaway process
      }
      logging.info(
        `[${this.instance.server_name}] Watching for file generation: ${rel_filepath}`,
      );

      const default_skips = [
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
      const fw = Fireworm(this.instance.env.cwd, {
        skipDirEntryPatterns: default_skips,
      });

      fw.add(`**/${rel_filepath}`);
      fw.on('add', (fp) => {
        if (abs_filepath == fp) {
          fw.clear();
          logging.info(
            `[${this.instance.server_name}] ${path.basename(fp)} created! Watchfile ${rel_filepath} closed`,
          );
          async.nextTick(() => {
            this.make_tail(rel_filepath);
          });
        }
      });
    }
  }

  direct_dispatch(user, args) {
    let fn, required_args;
    const arg_array: any[] = [];
    async.waterfall(
      [
        async.apply(this.instance.property, 'owner'),
        (ownership_data, cb) => {
          auth.test_membership(user, ownership_data.groupname, (is_valid) => {
            cb(null, is_valid);
          });
        },
        (is_valid, cb) => {
          cb(!is_valid); //logical NOT'ted:  is_valid ? falsy error, !is_valid ? truthy error
        },
      ],
      (err) => {
        if (err) {
          logging.error(
            `User "${user}" does not have permissions on [${args.server_name}]:`,
            args,
          );
        } else {
          try {
            fn = this.instance[args.command];
            required_args = introspect(fn);
            // receives an array of all expected arguments, using introspection.
            // they are in order as listed by the function definition, which makes iteration possible.
          } catch (e) {
            args.success = false;
            args.error = e;
            args.time_resolved = Date.now();
            this.nsp.emit('server_fin', args);
            logging.error('server_fin', args);

            return;
          }

          for (const i in required_args) {
            // all callbacks expected to follow the pattern (success, payload).
            if (required_args[i] == 'callback')
              arg_array.push((err) => {
                args.success = !err;
                args.err = err;
                args.time_resolved = Date.now();
                this.nsp.emit('server_fin', args);
                if (err)
                  logging.error(
                    `[${this.instance.server_name}] command "${args.command}" errored out:`,
                    args,
                  );
                logging.info('server_fin', args);
              });
            else if (required_args[i] in args) {
              arg_array.push(args[required_args[i]]);
            } else {
              args.success = false;
              logging.error(
                'Provided values missing required argument',
                required_args[i],
              );
              args.error = `Provided values missing required argument: ${required_args[i]}`;
              this.nsp.emit('server_fin', args);
              return;
            }
          }

          if (args.command == 'delete') this.cleanup();

          logging.info(
            `[${this.instance.server_name}] received request "${args.command}"`,
          );
          fn.apply(this.instance, arg_array);
        }
      },
    );
  }
}
