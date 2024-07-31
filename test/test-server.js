import * as path from 'path'
import * as fs from 'fs-extra'
import * as async from 'async'
import * as userid from 'userid'
import * as whoami from 'whoami'
import * as mineos from '../mineos'
import * as server from '../server'
import * as events from 'events'
let test = exports;
let BASE_DIR = '/home/runner/minecraft';

test.setUp = function(callback) {
  fs.removeSync(BASE_DIR);
  callback();
}

test.tearDown = function(callback) {
  callback();
}

test.start_backend = function(test) {
  async.waterfall([
    function(cb) {
      fs.stat(BASE_DIR, function(err) {
        test.equal(err.code, 'ENOENT');
        test.ok(err);
        cb(!err);
      })
    }
  ])

  let be = server.backend(BASE_DIR, new events.EventEmitter);

  async.waterfall([
    function(cb) {
      fs.stat(BASE_DIR, function(err) {
        test.ifError(err);
        cb(err);
      })
    }
  ])

  test.ok(be.servers instanceof Object);
  test.ok(be.front_end instanceof events.EventEmitter);

  be.shutdown();
  test.done();
}
