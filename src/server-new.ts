import type profile from './profiles.d/template.js';

import fs from 'fs-extra';
import path from 'node:path';
import Socket from 'socket.io';
import which from 'which';

import { DIRS } from './constants.js';
import { Logger } from './logger.js';
import child from 'node:child_process';

const logger = Logger('server');

export default class Server {
  baseDir: string;
  instances: { [key: string]: any /*InstanceContainer*/ } = {};
  profiles: profile[] = [];
  emitter: Socket;

  constructor(
    baseDir: string,
    emitter: Socket,
    // config: { creators?: string },
  ) {
    logger.debug(`creating server at ${baseDir}`);

    this.baseDir = baseDir;
    this.instances = {};
    this.profiles = [];
    this.emitter = emitter;

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
    const commit = child.execFileSync(gitPath, ['show', '--oneline', '-s'], {
      cwd: __dirname,
      encoding: 'utf8',
    });
    logger.info(`starting server using commit: ${commit}`);
  }

  startBroadcasts() {}
}
