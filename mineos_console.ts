#!/usr/bin/env node

import * as getopt from 'node-getopt'
import mineos from './mineos'
import * as child_process from 'child_process'
import * as introspect from 'introspect'
import 'node:process';

const opt = getopt.create([
  ['s' , 'server_name=SERVER_NAME'  , 'server name'],
  ['d' , 'base_dir=BASE_DIR'        , 'defaults to /var/games/minecraft'],
  ['D' , 'debug'                    , 'show debug output'],
  ['V' , 'version'                  , 'show version'],
  ['h' , 'help'                     , 'display this help']
])              // create Getopt instance
.bindHelp()     // bind option 'help' to default action
.parseSystem(); // parse command line

const base_dir = (opt.options || {}).base_dir || '/var/games/minecraft';
let instance: mineos;

if ('version' in opt.options) {
  return_git_commit_hash(function(code, hash) {
    if (!code)
      console.log(hash);
    process.exit(code);
  })
} else {
  instance = new mineos(opt.options.server_name, base_dir);
  if (opt.argv[0] in instance) { //first provided param matches a function name) {
    handle_server(opt, function(code, retval) {
      for (const idx in retval)
        console.log(retval[idx])
      process.exit(code);
    })
  } else {
    retrieve_property(opt, function(code, retval) {
      for (const idx in retval)
        console.log(retval[idx])
      process.exit(code);
    })
  }
}

function return_git_commit_hash(callback) {


  const gitproc = child_process.spawn('git', 'log -n 1 --pretty=format:"%H"'.split(' '));
  let commit_value = '';

  gitproc.stdout.on('data', function(data) {
    const buffer = Buffer.from(data, 'ascii');
    commit_value = buffer.toString('ascii');
  });

  gitproc.on('error', function(code) {
    // branch if path does not exist
    if (code)
      callback(true, undefined);
  });

  gitproc.on('exit', function(code) {
    if (code == 0) // branch if all is well
      callback(code, commit_value);
    else
      callback(true, undefined);
  });
}

function handle_server(args, callback) {
  const command = args.argv.shift();
  const fn = instance[command];
  const arg_array: any[] = [];
  const required_args = introspect(fn);

  while (required_args.length) {
    const ra = required_args.shift();

    switch (ra) {
      case 'callback':
        arg_array.push(function(err, payload) {
          const retval: any[] = [];

          if (!err) {
            retval.push(`[${args.options.server_name}] Successfully executed "${command}"`);
            if (payload)
              retval.push(payload)
          } else {
            retval.push(`[${args.options.server_name}] Error executing "${command}" because server condition not met: ${err}`);
          }

          callback( (err ? 1 : 0), retval );
        })
        break;
      case 'owner':
        try {
          const owner_pair = opt.argv.shift().split(':');
          if (owner_pair.length != 2)
            throw 'err';
          arg_array.push({
            uid: parseInt(owner_pair[0]),
            gid: parseInt(owner_pair[1])
          })
        } catch (e) {
          callback(1, ['Provide owner attribute as uid:gid pair, e.g., 1000:1000']);
          return;
        }
        break;
      default:
        arg_array.push(opt.argv.shift())
        break;
    } //end switch
  } //end while

  fn.apply(instance, arg_array); //actually run the function with the args
}

function retrieve_property(args, callback) {
  const property = args.argv.shift();
  const fn = instance.property;
  const arg_array = [property];
  const retval: any[] = [];

  arg_array.push(function(err, payload) {
    if (!err && payload !== undefined) {
      retval.push(`[${args.options.server_name}] Queried property: "${property}"`);
      retval.push(payload);
    } else {
      retval.push(`[${args.options.server_name}] Error querying property "${property}"`, err);
    }
    callback( (err ? 1 : 0), retval);
  });

  // @ts-expect-error
  fn.apply(instance, arg_array);
}
