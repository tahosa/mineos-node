import fs from 'fs-extra';
import { constants } from 'node:fs';
import path from 'path';
import async from 'async';
import child_process from 'child_process';
import which from 'which';
import logging from 'winston';
import ini from 'ini';
import DecompressZip from 'decompress-zip';
import mcquery from 'mcquery';
import rsync from 'rsync';
import { Tail } from 'tail';
import strftime from 'strftime';
import userid from 'userid';
import procfs from 'procfs-stats';
import du from 'du';
import net from 'net';
import tmp from 'tmp';
import chownr from 'chownr';

import auth from './auth.js';
import { usedJavaVersion } from './java.js';

const F_OK = constants.F_OK;

const proc_paths = ['/proc', '/usr/compat/linux/proc', '/system/lxproc', '/compat/linux/proc'];
let PROC_PATH: string;

for (const proc in proc_paths) {
  try {
    fs.statSync(path.join(proc_paths[proc], 'uptime'));
    PROC_PATH = proc_paths[proc];
    break;
  } catch (e) {
    console.error(e);
  }
}

type incrementListItem = {
  step: string;
  time: string;
  size: string;
  cum: string;
};

export const DIRS = {
  servers: 'servers',
  backup: 'backup',
  archive: 'archive',
  profiles: 'profiles',
  import: 'import',
};

export const SP_DEFAULTS = {
  'server-port': 25565,
  'max-players': 20,
  'level-seed': '',
  gamemode: 0,
  difficulty: 1,
  'level-type': 'DEFAULT',
  'level-name': 'world',
  'max-build-height': 256,
  'generate-structures': 'true',
  'generator-settings': '',
  'server-ip': '0.0.0.0',
  'enable-query': 'false',
};

export const checkDependencies = (): { [key: string]: string } => {
  return {
    screen: which.sync('screen'),
    tar: which.sync('tar'),
    rsync: which.sync('rsync'),
    java: which.sync('java'),
    'rdiff-backup': which.sync('rdiff-backup'),
  };
};

export const server_list_up = () => {
  return Object.keys(server_pids_up());
};

export const server_pids_up = () => {
  let cmdline, environ;
  const pids = fs.readdirSync(PROC_PATH).filter((e) => {
    if (/^([0-9]+)$/.test(e)) {
      return e;
    }
  });
  const SCREEN_REGEX = /screen[^S]+S mc-([^\s]+)/i;
  const JAVA_REGEX = /\.mc-([^\s]+)/i;
  const servers_found: { [key: string]: { [key: string]: number } } = {};

  for (let i = 0; i < pids.length; i++) {
    try {
      cmdline = fs
        .readFileSync(path.join(PROC_PATH, pids[i].toString(), 'cmdline'))
        .toString('ascii')
        .replace(/\u0000/g, ' ');
    } catch (e) {
      continue;
    }

    const screen_match = SCREEN_REGEX.exec(cmdline);

    if (screen_match) {
      if (screen_match[1] in servers_found) servers_found[screen_match[1]]['screen'] = parseInt(pids[i]);
      else servers_found[screen_match[1]] = { screen: parseInt(pids[i]) };
    } else {
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
        if (java_match[1] in servers_found) servers_found[java_match[1]]['java'] = parseInt(pids[i]);
        else servers_found[java_match[1]] = { java: parseInt(pids[i]) };
      }
    }
  }
  return servers_found;
};

export default class mineos {
  server_name: string = '';
  env: { [key: string]: string } = {};
  memoized_files: { [key: string]: any } = {};
  memoize_timestamps: { [key: string]: any } = {};

  constructor(server_name: string, base_dir: string) {
    this.server_name = server_name;

    process.umask(0o002);

    this.env = {
      base_dir: base_dir,
      cwd: path.join(base_dir, DIRS['servers'], server_name),
      bwd: path.join(base_dir, DIRS['backup'], server_name),
      awd: path.join(base_dir, DIRS['archive'], server_name),
      pwd: path.join(base_dir, DIRS['profiles']),
      sp: path.join(base_dir, DIRS['servers'], server_name, 'server.properties'),
      sc: path.join(base_dir, DIRS['servers'], server_name, 'server.config'),
      cc: path.join(base_dir, DIRS['servers'], server_name, 'cron.config'),
    };
  }

  server_list = (base_dir: string) => {
    return fs.readdirSync(path.join(base_dir, DIRS['servers']));
  };

  valid_server_name = (server_name: string) => {
    return /^(?!\.)[a-zA-Z0-9_.]+$/.test(server_name);
  };

  extract_server_name = (base_dir: string, server_path: string): string => {
    const re = new RegExp(`${DIRS['servers']}/([a-zA-Z0-9_.]+)`);
    const matches = re.exec(server_path);
    if (matches) {
      return matches[1];
    } else {
      throw new Error('no server name in path');
    }
  };

  // ini related functions and vars
  read_ini = (
    filepath: string,
    callback: (arg0: NodeJS.ErrnoException | null, arg1?: { [key: string]: any }) => void
  ) => {
    fs.readFile(filepath, (err: NodeJS.ErrnoException | null, data: Buffer) => {
      if (err) {
        fs.writeFile(filepath, '', (inner_err) => {
          callback(inner_err);
        });
      } else {
        callback(err, ini.parse(data.toString()));
      }
    });
  };

  // server properties functions
  sp = (callback) => {
    const fn = 'server.properties';
    async.waterfall(
      [
        async.apply(fs.stat, this.env.sp),
        (stat_data, cb) => {
          if (fn in this.memoize_timestamps && this.memoize_timestamps[fn] - stat_data.mtime == 0) {
            this.memoized_files[fn](this.env.sp, cb);
          } else {
            this.memoize_timestamps[fn] = stat_data.mtime;
            this.memoized_files[fn] = async.memoize(this.read_ini);
            this.memoized_files[fn](this.env.sp, cb);
          }
        },
      ],
      callback
    );
  };

  modify_sp = (property, new_value, callback) => {
    async.waterfall(
      [
        async.apply(this.sp),
        (sp_data, cb) => {
          sp_data[property] = new_value;
          cb(null, sp_data);
        },
        (sp_data, cb) => {
          this.memoize_timestamps['server.properties'] = 0;
          fs.writeFile(this.env.sp, ini.stringify(sp_data), cb);
        },
      ],
      callback
    );
  };

  overlay_sp = (dict, callback) => {
    this.sp((err, props) => {
      for (const key in dict) props[key] = dict[key];

      const old_sp = props;
      this.memoize_timestamps['server.properties'] = 0;
      fs.writeFile(this.env.sp, ini.stringify(old_sp), callback);
    });
  };

  // server config functions
  sc = (callback) => {
    const fn = 'server.config';
    async.waterfall(
      [
        async.apply(fs.stat, this.env.sc),
        (stat_data, cb) => {
          if (fn in this.memoize_timestamps && this.memoize_timestamps[fn] - stat_data.mtime == 0) {
            this.memoized_files[fn](this.env.sc, cb);
          } else {
            this.memoize_timestamps[fn] = stat_data.mtime;
            this.memoized_files[fn] = async.memoize(this.read_ini);
            this.memoized_files[fn](this.env.sc, cb);
          }
        },
      ],
      (err, retval) => {
        if (err) {
          delete this.memoize_timestamps[fn];
          delete this.memoized_files[fn];
          callback(null, {});
        } else {
          callback(err, retval);
        }
      }
    );
  };

  modify_sc = (section, property, new_value, callback) => {
    async.waterfall(
      [
        async.apply(this.sc),
        (sc_data, cb) => {
          try {
            sc_data[section][property] = new_value;
          } catch (e) {
            sc_data[section] = {};
            sc_data[section][property] = new_value;
          }
          cb(null, sc_data);
        },
        (sc_data, cb) => {
          this.memoize_timestamps['server.config'] = 0;
          fs.writeFile(this.env.sc, ini.stringify(sc_data), cb);
        },
      ],
      callback
    );
  };

  // cron config functions
  crons = (callback) => {
    this.read_ini(this.env.cc, callback);
  };

  add_cron = (identifier, definition, callback) => {
    async.waterfall(
      [
        async.apply(this.crons),
        (cron_data, cb) => {
          cron_data[identifier] = definition;
          cron_data[identifier]['enabled'] = false;
          cb(null, cron_data);
        },
        (cron_data, cb) => {
          fs.writeFile(this.env.cc, ini.stringify(cron_data), cb);
        },
      ],
      callback
    );
  };

  delete_cron = (identifier, callback) => {
    async.waterfall(
      [
        async.apply(this.crons),
        (cron_data, cb) => {
          delete cron_data[identifier];
          cb(null, cron_data);
        },
        (cron_data, cb) => {
          fs.writeFile(this.env.cc, ini.stringify(cron_data), cb);
        },
      ],
      callback
    );
  };

  set_cron = (identifier, enabled, callback) => {
    async.waterfall(
      [
        async.apply(this.crons),
        (cron_data, cb) => {
          cron_data[identifier]['enabled'] = enabled;
          cb(null, cron_data);
        },
        (cron_data, cb) => {
          fs.writeFile(this.env.cc, ini.stringify(cron_data), cb);
        },
      ],
      callback
    );
  };

  create = (owner, callback) => {
    async.series(
      [
        async.apply(this.verify, '!exists'),
        async.apply(this.verify, '!up'),
        async.apply(fs.ensureDir, this.env.cwd),
        async.apply(fs.chown, this.env.cwd, owner['uid'], owner['gid']),
        async.apply(fs.ensureDir, this.env.bwd),
        async.apply(fs.chown, this.env.bwd, owner['uid'], owner['gid']),
        async.apply(fs.ensureDir, this.env.awd),
        async.apply(fs.chown, this.env.awd, owner['uid'], owner['gid']),
        async.apply(fs.ensureFile, this.env.sp),
        async.apply(fs.chown, this.env.sp, owner['uid'], owner['gid']),
        async.apply(fs.ensureFile, this.env.sc),
        async.apply(fs.chown, this.env.sc, owner['uid'], owner['gid']),
        async.apply(fs.ensureFile, this.env.cc),
        async.apply(fs.chown, this.env.cc, owner['uid'], owner['gid']),
        async.apply(this.overlay_sp, SP_DEFAULTS),
        async.apply(this.modify_sc, 'java', 'java_binary', ''),
        async.apply(this.modify_sc, 'java', 'java_xmx', '256'),
        async.apply(this.modify_sc, 'onreboot', 'start', false),
      ],
      callback
    );
  };

  create_unconventional_server = (owner, callback) => {
    async.series(
      [
        async.apply(this.verify, '!exists'),
        async.apply(this.verify, '!up'),
        async.apply(fs.ensureDir, this.env.cwd),
        async.apply(fs.chown, this.env.cwd, owner['uid'], owner['gid']),
        async.apply(fs.ensureDir, this.env.bwd),
        async.apply(fs.chown, this.env.bwd, owner['uid'], owner['gid']),
        async.apply(fs.ensureDir, this.env.awd),
        async.apply(fs.chown, this.env.awd, owner['uid'], owner['gid']),
        async.apply(fs.ensureFile, this.env.sp),
        async.apply(fs.chown, this.env.sp, owner['uid'], owner['gid']),
        async.apply(fs.ensureFile, this.env.sc),
        async.apply(fs.chown, this.env.sc, owner['uid'], owner['gid']),
        async.apply(fs.ensureFile, this.env.cc),
        async.apply(fs.chown, this.env.cc, owner['uid'], owner['gid']),
        async.apply(this.modify_sc, 'minecraft', 'unconventional', true),
      ],
      callback
    );
  };

  create_from_archive = (owner, filepath, callback) => {
    const move_to_parent_dir = (source_dir, inner_callback) => {
      let remainder = '';
      const attempted_move = false;

      async.waterfall(
        [
          async.apply(fs.readdir, source_dir),
          (files, cb) => {
            if (files.length == 1) {
              remainder = files[0];
              cb(null);
            } else if (files.length == 4) {
              const sp_idx = files.indexOf('server.properties');
              const sc_idx = files.indexOf('server.config');
              const cc_idx = files.indexOf('cron.config');
              if (sp_idx >= 0) {
                files.splice(sp_idx, 1);
              }
              if (sc_idx >= 0) {
                files.splice(sc_idx, 1);
              }
              if (cc_idx >= 0) {
                files.splice(cc_idx, 1);
              }
              remainder = files[0];
              cb(!(files.length == 1)); // logically NOT-ing so len==1 continues
            } else cb(true);
          },
          (cb) => {
            const inside_dir = path.join(source_dir, remainder);
            fs.lstat(inside_dir, (err, stat) => {
              if (stat.isDirectory()) cb(null);
              else cb(true);
            });
          },
          (cb) => {
            const old_dir = path.join(source_dir, remainder);

            fs.readdir(old_dir, (err, files) => {
              if (!err)
                async.each(
                  files,
                  (file, inner_cb) => {
                    const old_filepath = path.join(old_dir, file);
                    const new_filepath = path.join(source_dir, file);

                    fs.move(old_filepath, new_filepath, { overwrite: true }, inner_cb);
                  },
                  cb
                );
              else cb(err);
            });
          },
        ],
        (err) => {
          if (attempted_move) inner_callback(err);
          else inner_callback(null); //not really an error if it cancelled because no parent dir
        }
      );
    };

    let dest_filepath: string = '';

    if (filepath.match(/\//))
      //if it has a '/', its hopefully an absolute path
      dest_filepath = filepath;
    // if it doesn't treat it as being from /import/
    else dest_filepath = path.join(this.env.base_dir, DIRS['import'], filepath);

    const split = dest_filepath.split('.');
    let extension = split.pop();

    if (extension == 'gz') if (split.pop() == 'tar') extension = 'tar.gz';

    switch (extension) {
      case 'zip':
        const unzipper_it = (cb) => {
          const unzipper = new DecompressZip(dest_filepath);

          unzipper.on('error', (err) => {
            cb(err);
          });

          unzipper.on('extract', () => {
            move_to_parent_dir(this.env.cwd, cb);
          });

          unzipper.extract({
            path: this.env.cwd,
          });
        };

        async.series(
          [
            async.apply(this.create, owner),
            async.apply(unzipper_it),
            async.apply(this.chown, owner['uid'], owner['gid']),
          ],
          callback
        );

        break;
      case 'tar.gz':
      case 'tgz':
      case 'tar':
        const binary = which.sync('tar');
        const args = ['-xf', dest_filepath];
        const params = { cwd: this.env.cwd, uid: owner.uid, gid: owner.gid };

        async.series(
          [
            async.apply(this.create, owner),
            (cb) => {
              this.memoize_timestamps = {};
              const proc = child_process.spawn(binary, args, params);
              proc.once('exit', (code) => {
                cb(new Error(`${code}`));
              });
            },
          ],
          callback
        );
        break;
    }
  };

  accept_eula = (callback) => {
    const EULA_PATH = path.join(this.env.cwd, 'eula.txt');

    async.waterfall(
      [
        async.apply(fs.outputFile, EULA_PATH, 'eula=true'),
        async.apply(fs.stat, this.env.cwd),
        (stat, cb) => {
          fs.chown(EULA_PATH, stat.uid, stat.gid, cb);
        },
      ],
      callback
    );
  };

  delete = (callback) => {
    async.series(
      [
        async.apply(this.verify, 'exists'),
        async.apply(this.verify, '!up'),
        async.apply(fs.remove, this.env.cwd),
        async.apply(fs.remove, this.env.bwd),
        async.apply(fs.remove, this.env.awd),
      ],
      callback
    );
  };

  get_start_args = (callback) => {
    type javaArgs = 'binary' | 'xmx' | 'xms' | 'jarfile' | 'jar_args' | 'java_tweaks' | number;

    const type_jar_unconventional = (inner_callback) => {
      const java_binary = which.sync('java');

      async.series<javaArgs>(
        {
          binary: (cb) => {
            this.sc((err, dict) => {
              const value = (dict.java || {}).java_binary || java_binary;
              cb(new Error(value.length ? undefined : 'No java binary assigned for server.'), value);
            });
          },
          xmx: (cb) => {
            this.sc((err, dict) => {
              const value = parseInt((dict.java || {}).java_xmx) || 0;

              cb(new Error(value >= 0 ? undefined : 'XMX heapsize must be positive integer >= 0'), value);
            });
          },
          xms: (cb) => {
            this.sc((err, dict) => {
              const xmx = parseInt((dict.java || {}).java_xmx) || 0;
              const xms = parseInt((dict.java || {}).java_xms) || 0;

              cb(
                new Error(
                  xmx >= xms && xms >= 0 ? undefined : 'XMS heapsize must be positive integer where XMX >= XMS >= 0'
                ),
                xms
              );
            });
          },
          jarfile: (cb) => {
            this.sc((err, dict) => {
              const jarfile = (dict.java || {}).jarfile;
              if (!jarfile) cb(new Error('Server not assigned a runnable jar'));
              else cb(null, jarfile);
            });
          },
          jar_args: (cb) => {
            this.sc((err, dict) => {
              const value = (dict.java || {}).jar_args || '';
              cb(null, value);
            });
          },
          java_tweaks: (cb) => {
            this.sc((err, dict) => {
              const value = (dict.java || {}).java_tweaks || null;
              cb(null, value);
            });
          },
        },
        (err, results) => {
          if (err) {
            inner_callback(err, {});
          } else {
            const args = ['-dmS', `mc-${this.server_name}`];
            args.push.apply(args, [`${results.binary}`, '-server']);

            if ((results.xmx as number) > 0) args.push(`-Xmx${results.xmx}M`);
            if ((results.xms as number) > 0) args.push(`-Xms${results.xms}M`);

            if (results.java_tweaks) {
              const splits = (results.java_tweaks as string).split(/ /);
              for (const i in splits) args.push(splits[i]);
            }

            args.push.apply(args, ['-jar', `${results.jarfile}`]);

            if (results.jar_args) {
              const splits = (results.jar_args as string).split(/ /);
              for (const i in splits) args.push(splits[i]);
            }

            inner_callback(null, args);
          }
        }
      );
    };

    const type_jar = (inner_callback) => {
      const java_binary = which.sync('java');

      async.series<javaArgs>(
        {
          binary: (cb) => {
            this.sc((err, dict) => {
              const value = (dict.java || {}).java_binary || java_binary;
              cb(value.length ? null : new Error('No java binary assigned for server.'), value);
            });
          },
          xmx: (cb) => {
            this.sc((err, dict) => {
              const value = parseInt((dict.java || {}).java_xmx) || 0;

              cb(value > 0 ? null : new Error('XMX heapsize must be positive integer > 0'), value);
            });
          },
          xms: (cb) => {
            this.sc((err, dict) => {
              const xmx = parseInt((dict.java || {}).java_xmx) || 0;
              const xms = parseInt((dict.java || {}).java_xms) || xmx;
              cb(
                xmx >= xms && xms > 0 ? null : new Error('XMS heapsize must be positive integer where XMX >= XMS > 0'),
                xms
              );
            });
          },
          jarfile: (cb) => {
            this.sc((err, dict) => {
              const jarfile = (dict.java || {}).jarfile;
              if (!jarfile) cb(new Error('Server not assigned a runnable jar'));
              else cb(null, jarfile);
            });
          },
          jar_args: (cb) => {
            this.sc((err, dict) => {
              const value = (dict.java || {}).jar_args || 'nogui';
              cb(null, value);
            });
          },
          java_tweaks: (cb) => {
            this.sc((err, dict) => {
              const value = (dict.java || {}).java_tweaks || null;
              cb(null, value);
            });
          },
        },
        (err, results) => {
          if (err) {
            inner_callback(err, {});
          } else {
            const args = ['-dmS', `mc-${this.server_name}`];
            args.push.apply(args, [`${results.binary}`, '-server', `-Xmx${results.xmx}M`, `-Xms${results.xms}M`]);

            if (results.java_tweaks) {
              const splits = (results.java_tweaks as string).split(/ /);
              for (const i in splits) args.push(splits[i]);
            }

            args.push.apply(args, ['-jar', `${results.jarfile}`]);

            if (results.jar_args) {
              const splits = (results.jar_args as string).split(/ /);
              for (const i in splits) args.push(splits[i]);
            }

            if ((results?.jarfile as string).toLowerCase().indexOf('forge') == 0)
              if ((results?.jarfile as string).slice(-13).toLowerCase() == 'installer.jar')
                args.push('--installServer');

            inner_callback(null, args);
          }
        }
      );
    };

    const type_phar = (inner_callback) => {
      async.series(
        {
          binary: (cb) => {
            const php7 = path.join(this.env.cwd, '/bin/php7/bin/php');
            try {
              fs.accessSync(php7, F_OK);
              cb(null, './bin/php7/bin/php');
            } catch (e) {
              cb(null, './bin/php5/bin/php');
            }
          },
          pharfile: (cb) => {
            this.sc((err, dict) => {
              const pharfile = (dict.java || {}).jarfile;
              if (!pharfile) cb(new Error('Server not assigned a runnable phar'));
              else cb(null, pharfile);
            });
          },
        },
        (err, results) => {
          if (err) {
            inner_callback(err, {});
          } else {
            const args = ['-dmS', `mc-${this.server_name}`, results.binary, results.pharfile];
            inner_callback(null, args);
          }
        }
      );
    };

    const type_cuberite = (inner_callback) => {
      const args = ['-dmS', `mc-${this.server_name}`, './Cuberite'];
      inner_callback(null, args);
    };

    async.waterfall(
      [
        async.apply(this.sc),
        (sc_data, cb) => {
          const jarfile = (sc_data.java || {}).jarfile;
          const unconventional = (sc_data.minecraft || {}).unconventional;

          if (!jarfile) cb('Cannot start server without a designated jar/phar.', null);
          else if (jarfile.slice(-4).toLowerCase() == '.jar') {
            if (unconventional) type_jar_unconventional(cb);
            else type_jar(cb);
          } else if (jarfile.slice(-5).toLowerCase() == '.phar') type_phar(cb);
          else if (jarfile == 'Cuberite') type_cuberite(cb);
        },
      ],
      callback
    );
  };

  copy_profile = (callback) => {
    function rsync_profile(source, dest, username, groupname, callback_er) {
      const obj = rsync.build({
        source: source,
        destination: dest,
        flags: 'au',
        shell: 'ssh',
      });

      obj.set('--chown', `${username}:${groupname}`);
      obj.set('--chmod', 'ug=rwX');

      obj.execute((error, code) => {
        callback_er(code);
      });
    }

    let owner_info = null;

    async.waterfall(
      [
        async.apply(this.verify, 'exists'),
        async.apply(this.verify, '!up'),
        async.apply(this.property, 'owner'),
        (owner, cb) => {
          owner_info = owner;
          cb();
        },
        async.apply(this.sc),
        (sc, cb) => {
          if ((sc.minecraft || {}).profile) {
            const source = path.join(this.env.pwd, sc.minecraft.profile) + '/';
            const dest = this.env.cwd + '/';
            rsync_profile(source, dest, owner_info?.['username'], owner_info?.['groupname'], cb);
          } else {
            cb(null);
          }
        },
      ],
      callback
    );
  };

  profile_delta = (profile, callback) => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    async.waterfall(
      [
        (cb) => {
          const obj = rsync.build({
            source: path.join(this.env.pwd, profile) + '/',
            destination: this.env.cwd + '/',
            flags: 'vrun',
            shell: 'ssh',
            output: [
              (output) => {
                stdout.push(output);
              },
              (output) => {
                stderr.push(output);
              },
            ],
          });

          obj.execute((error, code) => {
            if (error) cb(code, stderr);
            else cb(code, stdout);
          });
        },
        (incr_file_list, cb) => {
          incr_file_list.shift();
          incr_file_list.pop();

          let all_files: string[] = [];

          for (const i in incr_file_list) {
            if (incr_file_list[i].toString().match(/sent \d+ bytes/)) continue; //known pattern on freebsd: 'sent 79 bytes  received 19 bytes  196.00 bytes/sec'
            all_files = all_files.concat(incr_file_list[i].toString().split('\n'));
          }

          cb(
            null,
            all_files.filter((n) => {
              return n.length;
            })
          );
        },
      ],
      callback
    );
  };

  start = (callback) => {
    let args = null;
    const params = { cwd: this.env.cwd };

    async.waterfall(
      [
        async.apply(this.verify, 'exists'),
        async.apply(this.verify, '!up'),
        async.apply(this.property, 'owner'),
        (owner, cb) => {
          params['uid'] = owner['uid'];
          params['gid'] = owner['gid'];
          cb();
        },
        async.apply(this.get_start_args),
        (start_args, cb) => {
          args = start_args;
          cb();
        },
        async.apply(this.sc),
        (sc_data, cb) => {
          if ((sc_data.minecraft || {}).profile) {
            this.profile_delta(sc_data.minecraft.profile, (err, changed_files) => {
              if (err) {
                if (err == 23)
                  //source dir of profile non-existent
                  cb(); //ignore issue; profile non-essential to start (server_jar is req'd only)
                else cb(err);
              } else if (changed_files) this.copy_profile(cb);
              else cb();
            });
          } else {
            cb();
          }
        },
        async.apply(which, 'screen'),
        (binary, cb) => {
          const proc = child_process.spawn(binary, args || [], params);
          proc.once('close', cb);
        },
      ],
      (err, result) => {
        setTimeout(() => {
          callback(err, result);
        }, 100);
      }
    );
  };

  stop = (callback) => {
    const test_interval_ms = 200;
    let iterations = 0;
    const MAX_ITERATIONS_TO_QUIT = 150;

    async.series(
      [
        async.apply(this.verify, 'exists'),
        async.apply(this.verify, 'up'),
        async.apply(this.stuff, 'stop'),
        (cb) => {
          async.whilst(
            () => {
              if (iterations > MAX_ITERATIONS_TO_QUIT) return false;
              else return this.server_name in server_pids_up();
            },
            (cc) => {
              iterations += 1;
              setTimeout(cc, test_interval_ms);
            },
            () => {
              if (this.server_name in server_pids_up())
                cb(new Error()); //error, stop did not succeed
              else cb(null); //no error, stop succeeded as expected
            }
          );
        },
      ],
      callback
    );
  };

  restart = (callback) => {
    async.series([async.apply(this.stop), async.apply(this.start)], callback);
  };

  stop_and_backup = (callback) => {
    async.series([async.apply(this.stop), async.apply(this.backup)], callback);
  };

  kill = (callback) => {
    const pids = server_pids_up();
    const test_interval_ms = 200;
    const MAX_ITERATIONS_TO_QUIT = 150;

    if (!(this.server_name in pids)) {
      callback(true);
    } else {
      process.kill(pids[this.server_name].java, 'SIGKILL');
      let iterations = 0;

      async.doWhilst(
        (cb) => {
          iterations += 1;
          setTimeout(cb, test_interval_ms);
        },
        () => {
          if (iterations > MAX_ITERATIONS_TO_QUIT) return false;
          else return this.server_name in server_pids_up();
        },
        () => {
          if (this.server_name in server_pids_up())
            callback(true); //error, stop succeeded: false
          else callback(null); //no error, stop succeeded: true
        }
      );
    }
  };

  stuff = (msg, callback?) => {
    const params = { cwd: this.env.cwd };
    const binary = which.sync('screen');

    async.waterfall(
      [
        async.apply(this.verify, 'exists'),
        async.apply(this.verify, 'up'),
        (cb) => {
          this.property('owner', (err, result) => {
            params['uid'] = result['uid'];
            params['gid'] = result['gid'];
            cb(err);
          });
        },
        (cb) => {
          cb(
            null,
            child_process.spawn(
              binary,
              ['-S', `mc-${this.server_name}`, '-p', '0', '-X', 'eval', `stuff "${msg}\x0a"`],
              params
            )
          );
        },
      ],
      callback
    );
  };

  saveall = (seconds_delay?: string, callback?) => {
    const params = { cwd: this.env.cwd };
    const binary = which.sync('screen');
    const FALLBACK_DELAY_SECONDS = 5;

    async.series(
      [
        async.apply(this.verify, 'exists'),
        async.apply(this.verify, 'up'),
        (cb) => {
          this.property('owner', (err, result) => {
            params['uid'] = result['uid'];
            params['gid'] = result['gid'];
            cb(err);
          });
        },
        (cb) => {
          cb(
            null,
            child_process.spawn(
              binary,
              ['-S', `mc-${this.server_name}`, '-p', '0', '-X', 'eval', 'stuff "save-all\x0a"'],
              params
            )
          );
        },
        (cb) => {
          const actual_delay = (parseInt(seconds_delay || '') || FALLBACK_DELAY_SECONDS) * 1000;
          setTimeout(cb, actual_delay);
        },
      ],
      callback
    );
  };

  saveall_latest_log = (callback) => {
    const TIMEOUT_LENGTH = 10000;
    let new_tail;

    try {
      new_tail = new Tail(path.join(this.env.cwd, 'logs/latest.log'));
    } catch (e) {
      callback(true);
      return;
    }

    const timeout = setTimeout(() => {
      new_tail.unwatch();
      callback(true);
    }, TIMEOUT_LENGTH);

    new_tail.on('line', (data) => {
      const match = data.match(/INFO]: Saved the world/);
      if (match) {
        //previously on, return true
        clearTimeout(timeout);
        new_tail.unwatch();
        callback(null);
      }
    });

    async.waterfall(
      [async.apply(this.verify, 'exists'), async.apply(this.verify, 'up'), async.apply(this.stuff, 'save-all')],
      (err) => {
        if (err) {
          clearTimeout(timeout);
          new_tail.unwatch();
          callback(true);
        }
      }
    );
  };

  archive = (callback) => {
    const binary = which.sync('tar');
    const filename = `server-${this.server_name}_${strftime('%Y-%m-%d_%H:%M:%S')}.tgz`;
    const args = ['czf', path.join(this.env.awd, filename), '.'];

    const params = { cwd: this.env.cwd };

    async.series(
      [
        (cb) => {
          this.property('owner', (err, result) => {
            params['uid'] = result['uid'];
            params['gid'] = result['gid'];
            cb(err);
          });
        },
        (cb) => {
          const proc = child_process.spawn(binary, args, params);
          proc.once('exit', (code) => {
            cb(new Error(`${code}`));
          });
        },
      ],
      callback
    );
  };

  archive_with_commit = (callback) => {
    const binary = which.sync('tar');
    const filename = `server-${this.server_name}_${strftime('%Y-%m-%d_%H:%M:%S')}.tgz`;
    const args = ['czf', path.join(this.env.awd, filename), '.'];

    const params = { cwd: this.env.cwd };
    let autosave = true;

    async.series(
      [
        (cb) => {
          this.property('autosave', (err, result) => {
            autosave = result;
            cb(err);
          });
        },
        async.apply(this.stuff, 'save-off'),
        async.apply(this.saveall_latest_log),
        (cb) => {
          this.property('owner', (err, result) => {
            params['uid'] = result['uid'];
            params['gid'] = result['gid'];
            cb(err);
          });
        },
        (cb) => {
          const proc = child_process.spawn(binary, args, params);
          proc.once('exit', () => {
            cb(null);
          });
        },
        (cb) => {
          if (autosave) this.stuff('save-on', cb);
          else cb(null);
        },
      ],
      callback
    );
  };

  backup = (callback) => {
    const binary = which.sync('rdiff-backup');
    const args = ['--exclude', path.join(this.env.cwd, 'dynmap'), `${this.env.cwd}/`, this.env.bwd];
    const params = { cwd: this.env.bwd }; //bwd!

    async.series(
      [
        (cb) => {
          this.property('owner', (err, result) => {
            params['uid'] = result['uid'];
            params['gid'] = result['gid'];
            cb(err);
          });
        },
        (cb) => {
          const proc = child_process.spawn(binary, args, params);
          proc.once('exit', (code) => {
            cb(new Error(`${code}`));
          });
        },
      ],
      callback
    );
  };

  restore = (step, callback) => {
    const binary = which.sync('rdiff-backup');
    const args = ['--restore-as-of', step, '--force', this.env.bwd, this.env.cwd];
    const params = { cwd: this.env.bwd };

    const proc = child_process.spawn(binary, args, params);
    proc.once('exit', (code) => {
      callback(code);
    });
  };

  list_increments = (callback) => {
    const binary = which.sync('rdiff-backup');
    const args = ['--list-increments', this.env.bwd];
    const params = { cwd: this.env.bwd };
    const regex = /^.+ +(\w{3} \w{3} {1,2}\d{1,2} \d{2}:\d{2}:\d{2} \d{4})/;
    const increment_lines: incrementListItem[] = [];

    const rdiff = child_process.spawn(binary, args, params);

    rdiff.stdout.on('data', (data) => {
      const buffer = Buffer.from(data, 'ascii');
      // --list-incremets option returns increments in reverse order
      const lines = buffer.toString('ascii').split('\n').reverse();
      let incrs = 0;

      for (let i = 0; i < lines.length; i++) {
        const match = lines[i].match(regex);
        if (match) {
          increment_lines.push({
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
      // branch if path does not exist
      if (code) callback(true, []);
    });

    rdiff.on('exit', (code) => {
      if (code == 0) {
        // branch if all is well
        callback(code, increment_lines);
      } // branch if dir exists, not an rdiff-backup dir
      else callback(true, []);
    });
  };

  list_increment_sizes = (callback) => {
    const binary = which.sync('rdiff-backup');
    const args = ['--list-increment-sizes', this.env.bwd];
    const params = { cwd: this.env.bwd };
    const regex = /^(\w.*?) {3,}(.*?) {2,}([^ ]+ \w*)/;
    const increment_lines: incrementListItem[] = [];

    const rdiff = child_process.spawn(binary, args, params);

    rdiff.stdout.on('data', (data) => {
      const buffer = Buffer.from(data, 'ascii');
      const lines = buffer.toString('ascii').split('\n');
      let incrs = 0;

      // Since rdiff-backup v2.1.1a0 increments been listed in ascending order instead of descending
      // https://github.com/rdiff-backup/rdiff-backup/blob/v2.1.1a0/CHANGELOG.adoc#11-changes
      for (let i = lines.length - 1; i >= 0; i--) {
        const match = lines[i].match(regex);
        if (match) {
          increment_lines.push({
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
      // branch if path does not exist
      if (code) callback(true, []);
    });

    rdiff.on('exit', (code) => {
      if (code == 0)
        // branch if all is well
        callback(code, increment_lines);
      // branch if dir exists, not an rdiff-backup dir
      else callback(true, []);
    });
  };

  list_archives = (callback) => {
    const awd = this.env['awd'];
    const all_info: { time?: Date; size?: number; filename: string }[] = [];

    fs.readdir(awd, (err, files) => {
      if (!err) {
        const fullpath = files.map((value) => {
          return path.join(awd, value);
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
            return (b.time?.getTime() || 0) - (a.time?.getTime() || 0);
          });

          callback(err || inner_err, all_info);
        });
      } else {
        callback(err, all_info);
      }
    });
  };

  prune = (step, callback) => {
    const binary = which.sync('rdiff-backup');
    const args = ['--force', '--remove-older-than', step, this.env.bwd];
    const params = { cwd: this.env.bwd };
    const proc = child_process.spawn(binary, args, params);

    proc.on('error', (code) => {
      callback(code, null);
    });

    proc.on('error', (code) => {
      // branch if path does not exist
      if (code) callback(true);
    });

    proc.on('exit', (code) => {
      if (code == 0)
        // branch if all is well
        callback(code);
      // branch if dir exists, not an rdiff-backup dir
      else callback(true);
    });
  };

  delete_archive = (filename, callback) => {
    const archive_path = path.join(this.env['awd'], filename);

    fs.remove(archive_path, (err) => {
      callback(err);
    });
  };

  property = (property: string, callback) => {
    let pids: ReturnType<typeof server_pids_up>;
    switch (property) {
      case 'owner':
        fs.stat(this.env.cwd, (err, stat_info) => {
          if (err) callback(err, {});
          else {
            try {
              callback(err, {
                uid: stat_info['uid'],
                gid: stat_info['gid'],
                username: userid.username(stat_info['uid']),
                groupname: userid.groupname(stat_info['gid']),
              });
            } catch (e) {
              callback(err, {
                uid: stat_info['uid'],
                gid: stat_info['gid'],
                username: '?',
                groupname: '?',
              });
            }
          }
        });
        break;
      case 'owner_uid':
        fs.stat(this.env.cwd, (err, stat_info) => {
          if (err) callback(err, null);
          else callback(err, stat_info['uid']);
        });
        break;
      case 'owner_gid':
        fs.stat(this.env.cwd, (err, stat_info) => {
          if (err) callback(err, null);
          else callback(err, stat_info['gid']);
        });
        break;
      case 'exists':
        fs.stat(this.env.sp, (err, stat_info) => {
          callback(null, !!stat_info);
        });
        break;
      case '!exists':
        fs.stat(this.env.sp, (err, stat_info) => {
          callback(null, !stat_info);
        });
        break;
      case 'up':
        pids = server_pids_up();
        callback(null, this.server_name in pids);
        break;
      case '!up':
        pids = server_pids_up();
        callback(null, !(this.server_name in pids));
        break;
      case 'java_pid':
        pids = server_pids_up();
        try {
          callback(null, pids[this.server_name]['java']);
        } catch (e) {
          callback(true, null);
        }
        break;
      case 'screen_pid':
        pids = server_pids_up();
        try {
          callback(null, pids[this.server_name]['screen']);
        } catch (e) {
          callback(true, null);
        }
        break;
      case 'server-port':
        this.sp((err, dict) => {
          callback(err, dict['server-port']);
        });
        break;
      case 'server-ip':
        this.sp((err, dict) => {
          callback(err, dict['server-ip']);
        });
        break;
      case 'memory':
        pids = server_pids_up();
        if (this.server_name in pids) {
          procfs['PROC'] = PROC_PATH; //procfs will default to /proc--this is determined more accurately by mineos.js!
          const ps = procfs(pids[this.server_name]['java']);
          ps.status((err, data) => {
            callback(err, data);
          });
        } else {
          callback(true, null);
        }
        break;
      case 'ping':
        async.waterfall(
          [
            async.apply(this.sc),
            (sc_data, cb) => {
              const jarfile = (sc_data.java || {}).jarfile;

              if (jarfile && jarfile.slice(-5).toLowerCase() == '.phar') cb(true, null);
              else {
                pids = server_pids_up();
                if (this.server_name in pids) {
                  this.ping((err, ping) => {
                    cb(err, ping);
                  });
                } else {
                  cb(true, null);
                }
              }
            },
          ],
          callback
        );
        break;
      case 'query':
        this.query((err, dict) => {
          callback(err, dict);
        });
        break;
      case 'server.properties':
        this.sp((err, dict) => {
          callback(err, dict);
        });
        break;
      case 'server.config':
        this.sc((err, dict) => {
          callback(err, dict);
        });
        break;
      case 'du_awd':
        try {
          const DU_TIMEOUT = 2000;

          let timer: NodeJS.Timeout | undefined = setTimeout(() => {
            timer = undefined;
            return callback(null, 0);
          }, DU_TIMEOUT);

          du(this.env.awd, { disk: true }, (err, size) => {
            clearTimeout(timer);
            if (timer) return callback(err, size);
          });
        } catch (e) {
          callback(null, 0);
        }
        break;
      case 'du_bwd':
        try {
          const DU_TIMEOUT = 3000;

          let timer: NodeJS.Timeout | undefined = setTimeout(() => {
            timer = undefined;
            return callback(null, 0);
          }, DU_TIMEOUT);

          du(this.env.bwd, { disk: true }, (err, size) => {
            clearTimeout(timer);
            if (timer) return callback(err, size);
          });
        } catch (e) {
          callback(null, 0);
        }
        break;
      case 'du_cwd':
        try {
          const DU_TIMEOUT = 3000;

          let timer: NodeJS.Timeout | undefined = setTimeout(() => {
            timer = undefined;
            return callback(null, 0);
          }, DU_TIMEOUT);

          du(this.env.cwd, { disk: true }, (err, size) => {
            clearTimeout(timer);
            if (timer) return callback(err, size);
          });
        } catch (e) {
          callback(null, 0);
        }
        break;
      case 'broadcast':
        this.sc((err, dict) => {
          callback(err, (dict['minecraft'] || {}).broadcast);
        });
        break;
      case 'onreboot_start':
        this.sc((err, dict) => {
          const val = (dict['onreboot'] || {}).start;
          try {
            const boolean_ified = val === true || JSON.parse(val.toLowerCase());
            callback(err, boolean_ified);
          } catch (e) {
            callback(err, false);
          }
        });
        break;
      case 'unconventional':
        this.sc((err, dict) => {
          callback(err, !!(dict['minecraft'] || {}).unconventional);
        });
        break;
      case 'commit_interval':
        this.sc((err, dict) => {
          const interval = parseInt((dict['minecraft'] || {})['commit_interval']);
          if (interval > 0) callback(null, interval);
          else callback(null, null);
        });
        break;
      case 'eula':
        fs.readFile(path.join(this.env.cwd, 'eula.txt'), (err, data) => {
          if (err) {
            callback(null, undefined);
          } else {
            const REGEX_EULA_TRUE = /eula\s*=\s*true/i;
            const lines = data.toString().split('\n');
            let matches = false;
            for (const i in lines) {
              if (lines[i].match(REGEX_EULA_TRUE)) matches = true;
            }
            callback(null, matches);
          }
        });
        break;
      case 'server_files':
        const server_files: string[] = [];

        async.waterfall(
          [
            async.apply(fs.readdir, this.env.cwd),
            (sf, cb) => {
              server_files.push(
                ...sf.filter((file) => {
                  return file.substr(-4).toLowerCase() == '.jar';
                })
              );
              server_files.push(
                ...sf.filter((file) => {
                  return file.substr(-5).toLowerCase() == '.phar';
                })
              );
              server_files.push(
                ...sf.filter((file) => {
                  return file == 'Cuberite';
                })
              );
              cb();
            },
            async.apply(this.sc),
            (sc_data, cb) => {
              let active_profile_dir = '';
              try {
                active_profile_dir = path.join(this.env.pwd, sc_data.minecraft.profile);
              } catch (e) {
                cb();
                return;
              }

              fs.readdir(active_profile_dir, (err, files) => {
                if (err) {
                  cb();
                } else {
                  server_files.push(
                    ...files.filter((file) => {
                      return (
                        (file.slice(-4).toLowerCase() == '.jar' && server_files.indexOf(file) < 0) ||
                        (file.slice(-5).toLowerCase() == '.phar' && server_files.indexOf(file) < 0) ||
                        (file == 'Cuberite' && server_files.indexOf(file) < 0)
                      );
                    })
                  );
                  cb();
                }
              });
            },
          ],
          (err) => {
            callback(err, server_files);
          }
        );
        break;
      case 'autosave':
        const TIMEOUT_LENGTH = 2000;
        const new_tail = new Tail(path.join(this.env.cwd, 'logs/latest.log'));

        const timeout = setTimeout(() => {
          new_tail.unwatch();
          return callback(null, true); //default to true for unsupported server functionality fallback
        }, TIMEOUT_LENGTH);

        new_tail.on('line', (data) => {
          if (data.match(/INFO]: Saving is already turned on/)) {
            //previously on, return true
            clearTimeout(timeout);
            new_tail.unwatch();
            return callback(null, true);
          }
          if (data.match(/INFO]: Turned on world auto-saving/)) {
            //previously off, return false
            clearTimeout(timeout);
            new_tail.unwatch();

            this.stuff('save-off', () => {
              //reset initial state
              return callback(null, false); //return initial state
            });
          }
        });

        this.stuff('save-on');
        break;
      case 'FTBInstall.sh':
        fs.stat(path.join(this.env.cwd, 'FTBInstall.sh'), (err, stat_data) => {
          callback(null, !!stat_data);
        });
        break;
      case 'java_version_in_use':
        this.sc((err, dict) => {
          usedJavaVersion(dict).then(callback);
        });

        break;
      default:
        callback(true, undefined);
        break;
    }
  };

  verify = (test, callback) => {
    this.property(test, (err, result) => {
      if (err || !result) callback(test);
      else callback(null);
    });
  };

  ping = (callback) => {
    const swapBytes = (buffer: Buffer): Buffer => {
      //http://stackoverflow.com/a/7460958/1191579
      const l = buffer.length;
      if (l & 0x01) {
        throw new Error('Buffer length must be even');
      }
      for (let i = 0; i < l; i += 2) {
        const a = buffer[i];
        buffer[i] = buffer[i + 1];
        buffer[i + 1] = a;
      }
      return buffer;
    };

    const splitBuffer = (buf: Buffer, delimiter: number): Buffer[] => {
      //http://stackoverflow.com/a/8920913/1191579
      const arr: Buffer[] = [];
      let p = 0;

      for (let i = 0; i < buf.length; i++) {
        if (buf[i] !== delimiter) continue;
        if (i === 0) {
          p = 1;
          continue; // skip if it's at the start of buffer
        }
        arr.push(buf.subarray(p, i));
        p = i + 1;
      }

      // add final part
      if (p < buf.length) {
        arr.push(buf.subarray(p, buf.length));
      }

      return arr;
    };

    function buffer_to_ascii(buf) {
      let retval = '';
      for (let i = 0; i < buf.length; i++) retval += buf[i] == 0x0000 ? '' : String.fromCharCode(buf[i]);
      return retval;
    }

    function send_query_packet(port) {
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
          callback(null, {
            protocol: parseInt(modern_split[0]),
            server_version: modern_split[1],
            motd: modern_split[2],
            players_online: parseInt(modern_split[3]),
            players_max: parseInt(modern_split[4]),
          });
        } else if (legacy_split.length == 3) {
          if (String.fromCharCode(legacy_split[0][-1]) == '\u0000') {
            // modern ping to legacy server
            callback(null, {
              protocol: '',
              server_version: '',
              motd: buffer_to_ascii(legacy_split[0].subarray(3, legacy_split[0].length - 1)),
              players_online: parseInt(buffer_to_ascii(legacy_split[1])),
              players_max: parseInt(buffer_to_ascii(legacy_split[2])),
            });
          }
        }
      });

      socket.on('error', (err) => {
        logging.error(`Ping, MC Server not available on port ${port}`);
        //logging.debug(err);
        //logging.debug(err.stack);
        callback(err, null);
      });

      socket.connect({ port: port });
    }

    this.sp((err, dict) => {
      if (err) {
        logging.error('Ping, error while getting server port');
        callback(err, null);
        return;
      }
      send_query_packet(dict['server-port']);
    });
  };

  query = (callback) => {
    let q;
    let retval = {};

    async.waterfall(
      [
        async.apply(this.sc),
        (dict, cb) => {
          const jarfile = (dict.java || {}).jarfile;
          if (jarfile) cb(jarfile.slice(-5).toLowerCase() == '.phar');
          else cb(true);
        },
        async.apply(this.property, 'server-port'),
        (port, cb) => {
          q = new mcquery('localhost', port);
          cb();
        },
        (cb) => {
          q.connect((err) => {
            if (err || !q.online) cb(err);
            else q.full_stat(cb);
          });
        },
        (pingback, cb) => {
          retval = pingback;
          cb();
        },
      ],
      () => {
        q.close();
        callback(null, retval);
      }
    );
  };

  previous_version = (filepath, restore_as_of, callback) => {
    const binary = which.sync('rdiff-backup');
    const abs_filepath = path.join(this.env.bwd, filepath);

    tmp.file((err, new_file_path) => {
      if (err) throw err;

      const args = ['--force', '--restore-as-of', restore_as_of, abs_filepath, new_file_path];
      const params = { cwd: this.env.bwd };
      const proc = child_process.spawn(binary, args, params);

      proc.on('error', (code) => {
        callback(code, null);
      });

      proc.on('exit', (code) => {
        if (code == 0) {
          fs.readFile(new_file_path, (inner_err, data) => {
            callback(inner_err, data.toString());
          });
        } else {
          callback(code, null);
        }
      });
    });
  };

  previous_property = (restore_as_of, callback) => {
    this.previous_version('server.properties', restore_as_of, (err, file_contents) => {
      if (err) {
        callback(err, null);
      } else {
        callback(err, ini.decode(file_contents));
      }
    });
  };

  chown = (uid, gid, callback) => {
    async.series(
      [
        async.apply(auth.verify_ids, uid, gid),
        async.apply(this.verify, 'exists'),
        async.apply(chownr, this.env.cwd, uid, gid),
        async.apply(chownr, this.env.bwd, uid, gid),
        async.apply(chownr, this.env.awd, uid, gid),
      ],
      callback
    );
  };

  sync_chown = (callback) => {
    // chowns awd,bwd,cwd to the owner of cwd.
    // duplicates functionality of chown because it does not assume sp existence

    async.series(
      [
        async.apply(fs.stat, this.env.cwd),
        (cb) => {
          fs.stat(this.env.cwd, (err, stat_info) => {
            async.series(
              [
                async.apply(fs.ensureDir, this.env.bwd),
                async.apply(fs.ensureDir, this.env.awd),
                async.apply(chownr, this.env.cwd, stat_info.uid, stat_info.gid),
                async.apply(chownr, this.env.bwd, stat_info.uid, stat_info.gid),
                async.apply(chownr, this.env.awd, stat_info.uid, stat_info.gid),
              ],
              cb
            );
          });
        },
      ],
      callback
    );
  };

  run_installer = (callback) => {
    const args = ['FTBInstall.sh'];
    const params = { cwd: this.env.cwd };

    async.waterfall(
      [
        async.apply(this.verify, 'exists'),
        async.apply(this.verify, '!up'),
        async.apply(this.property, 'owner'),
        (owner, cb) => {
          params['uid'] = owner['uid'];
          params['gid'] = owner['gid'];
          cb();
        },
        async.apply(which, 'sh'),
        (binary, cb) => {
          const proc = child_process.spawn(binary, args, params);
          proc.once('close', cb);
        },
      ],
      callback
    );
  };

  renice = (niceness, callback) => {
    let binary;
    const params = { cwd: this.env.cwd };

    async.waterfall(
      [
        async.apply(this.verify, 'exists'),
        async.apply(this.verify, 'up'),
        async.apply(this.property, 'owner'),
        (owner, cb) => {
          params['uid'] = owner['uid'];
          params['gid'] = owner['gid'];
          cb();
        },
        async.apply(which, 'renice'),
        (bin, cb) => {
          binary = bin;
          cb();
        },
        async.apply(this.property, 'java_pid'),
      ],
      (err, pid) => {
        if (!err) {
          const proc = child_process.spawn(binary, ['-n', niceness, '-p', pid], params);
          proc.once('close', callback);
        } else {
          callback(true);
        }
      }
    );
  };
}
