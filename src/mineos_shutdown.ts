#!/usr/bin/env node

import mineos, { server_list_up } from './mineos';
import * as fs from 'fs-extra';
import * as ini from 'ini';

function read_ini(filepath) {
  try {
    const data = fs.readFileSync(filepath);
    return ini.parse(data.toString());
  } catch (e) {
    return null;
  }
}

console.log('Stopping running games');

// List names of running servers
const servers = server_list_up();

// Read base directory configurations
const mineos_config =
  read_ini('/etc/mineos.conf') || read_ini('/usr/local/etc/mineos.conf') || {};
let base_directory = '/var/games/minecraft';

if ('base_directory' in mineos_config) {
  try {
    if (mineos_config['base_directory'].length < 2)
      throw new Error('Invalid base_directory length.');

    base_directory = mineos_config['base_directory'];
    fs.ensureDirSync(base_directory);
  } catch (e) {
    console.error(e, 'Aborting shutdown.');
    process.exit(2);
  }

  console.info('base_directory found in mineos.conf, using:', base_directory);
} else {
  console.error('base_directory not specified--missing mineos.conf?');
  console.error('Aborting startup.');
  process.exit(4);
}

// List of running servers
const server_watches: any[] = [];

function make_cb(server_watch) {
  return function () {
    console.log('    stopped server', server_watch.name);
    server_watch.running = false;
    for (const w of server_watches) {
      if (w.running) {
        console.log('  waiting for', w.name);
      }
    }
  };
}

for (const server of servers) {
  // obect to track state of server
  const server_watch = { name: server, running: true };
  server_watches.push(server_watch);

  const instance = new mineos(server, base_directory);
  console.log('Stopping', server);
  const cb_stopped = make_cb(server_watch);

  instance.stop(cb_stopped);
}
console.log('Waiting for servers to stop');
