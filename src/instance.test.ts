import { afterEach, describe, expect, jest, test } from '@jest/globals';
import child, { type ChildProcess } from 'child_process';
import fsExtra from 'fs-extra';
import { EventEmitter } from 'node:events';
import fs, { type Stats } from 'node:fs';
import net from 'node:net';
import ini from 'ini';
import { Rsync } from 'rsync2';
import userid from 'userid';

import chownr from 'chownr';
jest.mock('chownr');

import du from 'du';
jest.mock('du');

import mcquery from 'mcquery';
jest.mock('mcquery');

import procfs from 'procfs-stats';
jest.mock('procfs-stats');

import { Tail } from 'tail';
jest.mock('tail');

import which from 'which';
jest.mock('which');

import { CronTask, type ServerConfig } from './constants';
import './lib/logger';

const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  log: jest.fn(),
  child: () => mockLogger,
};

jest.mock('./lib/logger', () => ({
  Logger: {
    child: () => mockLogger,
  },
}));

import { readIni } from './lib/util';

jest.mock('./lib/util', () => ({
  readIni: jest.fn(),
  splitBuffer: (jest.requireActual('./lib/util') as any).splitBuffer,
  bufferToAscii: (jest.requireActual('./lib/util') as any).bufferToAscii,
}));

import { existsOnSystem } from './auth-new';
jest.mock('./auth-new', () => ({
  existsOnSystem: jest.fn(),
}));

import { Instance } from './instance';

describe('Instance', () => {
  beforeAll(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick'] });
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  describe('static', () => {
    afterEach(() => {
      jest.resetAllMocks();
    });

    afterAll(() => {
      jest.restoreAllMocks();
    });

    test('should read from server path', () => {
      jest.spyOn(fsExtra, 'readdirSync').mockReturnValue([]);

      Instance.listInstances('/path');
      expect(fsExtra.readdirSync).toHaveBeenCalledWith('/path/servers');
    });

    test('should validate instance names', () => {
      expect(Instance.validInstanceName('aaa')).toBe(true);
      expect(Instance.validInstanceName('server_1')).toBe(true);
      expect(Instance.validInstanceName('myserver')).toBe(true);
      expect(Instance.validInstanceName('1111')).toBe(true);

      expect(Instance.validInstanceName('.aaa')).toBe(false);
      expect(Instance.validInstanceName('')).toBe(false);
      expect(Instance.validInstanceName('something!')).toBe(false);
      expect(Instance.validInstanceName('#hashtag')).toBe(false);
      expect(Instance.validInstanceName('my server')).toBe(false);
      expect(Instance.validInstanceName('bukkit^ftb')).toBe(false);
    });

    test('should find all running server instances', () => {
      const mockProcesses = {
        '100': {
          cmdline: '/usr/bin/SCREEN\x00-dmS\x00mc-server1',
          environ: '',
        },
        '101': {
          cmdline: '',
          environ: 'STY=100.mc-server1\x00TERM=screen',
        },
        '200': {
          cmdline: '',
          environ: 'STY=201.mc-server2\x00TERM=screen',
        },
        '201': {
          cmdline: '/usr/bin/SCREEN\x00-dmS\x00mc-server2',
          environ: '',
        },
        '300': {
          // Throw an EACCESS error on this case to simulate reading a process from another user
          cmdline: 'error',
          envirion: '',
        },
        '301': {
          // Throw an EACCESS error on this case to simulate reading a process from another user
          cmdline: '',
          envirion: 'error',
        },
        unrelated: {},
      };

      (
        jest.spyOn(fsExtra, 'readdirSync') as unknown as jest.MockedFunction<(path: string) => string[]>
      ).mockReturnValue(Object.keys(mockProcesses));
      (
        jest.spyOn(fsExtra, 'readFileSync') as unknown as jest.MockedFunction<(path: string) => Buffer>
      ).mockImplementation((path: string) => {
        const procMatch = path.match(/(\d+)\/(cmdline|environ)$/);
        if (!procMatch) {
          throw new Error(`unexpected input to mock: ${path}`);
        }

        if (mockProcesses[procMatch[1]][procMatch[2]] === 'error') {
          throw {
            errno: -13,
            syscall: 'open',
            code: 'EACCESS',
            path,
          };
        }

        return Buffer.from(mockProcesses[procMatch[1]][procMatch[2]]);
      });

      const serverPids = Instance.listRunningInstancePids();
      expect(serverPids).toEqual({
        server1: {
          screen: 100,
          java: 101,
        },
        server2: {
          screen: 201,
          java: 200,
        },
      });
    });

    test('should extract instance name from string or throw an error', () => {
      expect(Instance.extractInstanceName('/path/to/someserver', '/path/to')).toEqual('someserver');
      expect(() => {
        Instance.extractInstanceName('/path/to/someserver');
      }).toThrowError('no instance name in /path/to/someserver');
    });
  });

  describe('instance', () => {
    let inst: Instance;

    afterAll(() => {
      jest.restoreAllMocks();
    });

    beforeEach(() => {
      inst = new Instance('server1', '/path');
    });

    afterEach(() => {
      jest.clearAllMocks();
    });

    test('constructor should set properties', () => {
      expect(inst.name).toEqual('server1');
      expect(inst.env.baseDir).toEqual('/path');
      expect(inst.env.cwd).toEqual('/path/servers/server1');
      expect(inst.env.bwd).toEqual('/path/backup/server1');
      expect(inst.env.awd).toEqual('/path/archive/server1');
      expect(inst.env.pwd).toEqual('/path/profiles');
      expect(inst.env.sp).toEqual('/path/servers/server1/server.properties');
      expect(inst.env.sc).toEqual('/path/servers/server1/server.config');
      expect(inst.env.cc).toEqual('/path/servers/server1/cron.config');
    });

    describe('server.properties', () => {
      const mockProps = {
        server: 'properties',
      };

      beforeAll(() => {
        jest.spyOn(fsExtra, 'writeFileSync').mockImplementation(() => {});
      });

      beforeEach(() => {
        (readIni as jest.Mock).mockImplementation(() => {
          return mockProps;
        });
      });

      test('should read server properties and cache result', () => {
        const spInit = inst.sp();
        expect(spInit).toEqual(mockProps);
        expect(readIni).toHaveBeenCalledTimes(1);
        expect(readIni).toHaveBeenCalledWith('/path/servers/server1/server.properties');

        const spCached = inst.sp();
        expect(spCached).toEqual(mockProps);
        expect(readIni).toHaveBeenCalledTimes(1);
      });

      test('should return an empty objct is no data is returned by readIni', () => {
        (readIni as jest.Mock).mockImplementation(() => {
          return null;
        });

        const spInit = inst.sp();
        expect(spInit).toEqual({});
      });

      test('should modify single property and invalidate the cache', () => {
        const newSp = { server: 'newValue' };

        const spInit = inst.modifySp('server', 'newValue');
        expect(spInit).toEqual(newSp);
        expect(readIni).toHaveBeenCalledTimes(1);
        expect(readIni).toHaveBeenCalledWith('/path/servers/server1/server.properties');
        expect(fsExtra.writeFileSync).toHaveBeenCalledTimes(1);
        expect(fsExtra.writeFileSync).toHaveBeenCalledWith(
          '/path/servers/server1/server.properties',
          ini.stringify(newSp)
        );

        const spCached = inst.sp();
        expect(spCached).toEqual(mockProps);
        expect(readIni).toHaveBeenCalledTimes(2);
      });

      test('should overlay multiple values and invalidate the cache', () => {
        const newSp = {
          server: 'newValue',
          otherProp: 'anotherValue',
        };

        const spInit = inst.overlaySp(newSp);
        expect(spInit).toEqual(newSp);
        expect(readIni).toHaveBeenCalledTimes(1);
        expect(readIni).toHaveBeenCalledWith('/path/servers/server1/server.properties');
        expect(fsExtra.writeFileSync).toHaveBeenCalledTimes(1);
        expect(fsExtra.writeFileSync).toHaveBeenCalledWith(
          '/path/servers/server1/server.properties',
          ini.stringify(newSp)
        );

        const spCached = inst.sp();
        expect(spCached).toEqual(mockProps);
        expect(readIni).toHaveBeenCalledTimes(2);
      });
    });

    describe('server.config', () => {
      const mockConfig = {
        java: {
          jarfile: 'config',
        },
      };

      beforeAll(() => {
        jest.spyOn(fsExtra, 'writeFileSync').mockImplementation(() => {});
      });

      beforeEach(() => {
        (readIni as jest.Mock).mockImplementation(() => {
          return mockConfig;
        });
      });

      test('should read server config and cache result', () => {
        const scInit = inst.sc();
        expect(scInit).toEqual(mockConfig);
        expect(readIni).toHaveBeenCalledTimes(1);
        expect(readIni).toHaveBeenCalledWith('/path/servers/server1/server.config');

        const scCached = inst.sc();
        expect(scCached).toEqual(mockConfig);
        expect(readIni).toHaveBeenCalledTimes(1);
      });

      test('should return an empty objct is no data is returned by readIni', () => {
        (readIni as jest.Mock).mockImplementation(() => {
          return null;
        });

        const scInit = inst.sc();
        expect(scInit).toEqual({});
      });

      test('should modify single property and invalidate the cache', () => {
        const newSc = { java: { jarfile: 'newValue' } };

        const scInit = inst.modifySc('java', 'jarfile', 'newValue');
        expect(scInit).toEqual(newSc);
        expect(readIni).toHaveBeenCalledTimes(1);
        expect(readIni).toHaveBeenCalledWith('/path/servers/server1/server.config');
        expect(fsExtra.writeFileSync).toHaveBeenCalledTimes(1);
        expect(fsExtra.writeFileSync).toHaveBeenCalledWith('/path/servers/server1/server.config', ini.stringify(newSc));

        const scCached = inst.sc();
        expect(scCached).toEqual(mockConfig);
        expect(readIni).toHaveBeenCalledTimes(2);
      });
    });

    describe('cron.config', () => {
      let mockCron;

      beforeAll(() => {
        jest.spyOn(fsExtra, 'writeFileSync').mockImplementation(() => {});
      });

      beforeEach(() => {
        mockCron = {
          job1: {
            command: 'backup',
            source: '15 */8 * * *',
            enabled: false,
            msg: '',
          },
        };
        (readIni as jest.Mock).mockImplementation(() => {
          return mockCron;
        });
      });

      test('should read cron config and cache result', () => {
        const ccInit = inst.crons();
        expect(ccInit).toEqual(mockCron);
        expect(readIni).toHaveBeenCalledTimes(1);
        expect(readIni).toHaveBeenCalledWith('/path/servers/server1/cron.config');

        const ccCached = inst.crons();
        expect(ccCached).toEqual(mockCron);
        expect(readIni).toHaveBeenCalledTimes(1);
      });

      test('should return an empty objct is no data is returned by readIni', () => {
        (readIni as jest.Mock).mockImplementation(() => {
          return null;
        });

        const ccInit = inst.crons();
        expect(ccInit).toEqual({});
      });

      test('should add a new cron task and invalidate the cache', () => {
        const newJob = {
          command: 'archive',
          source: '0 0 * * *',
          enabled: true,
        } as CronTask;

        const ccInit = inst.addCron('newJob', newJob);
        // New jobs start disabled
        expect(ccInit).toEqual({ ...mockCron, newJob: { ...newJob, enabled: false } });
        expect(readIni).toHaveBeenCalledTimes(1);
        expect(readIni).toHaveBeenCalledWith('/path/servers/server1/cron.config');
        expect(fsExtra.writeFileSync).toHaveBeenCalledTimes(1);
        expect(fsExtra.writeFileSync).toHaveBeenCalledWith(
          '/path/servers/server1/cron.config',
          ini.stringify({ ...mockCron, newJob: { ...newJob, enabled: false } })
        );

        const ccCached = inst.crons();
        expect(ccCached).toEqual(mockCron);
        expect(readIni).toHaveBeenCalledTimes(2);
      });

      test('should delete the cron task and invalidate the cache', () => {
        const ccInit = inst.deleteCron('job1');
        expect(ccInit).toEqual({});
        expect(readIni).toHaveBeenCalledTimes(1);
        expect(readIni).toHaveBeenCalledWith('/path/servers/server1/cron.config');
        expect(fsExtra.writeFileSync).toHaveBeenCalledTimes(1);
        expect(fsExtra.writeFileSync).toHaveBeenCalledWith('/path/servers/server1/cron.config', ini.stringify({}));

        const ccCached = inst.crons();
        expect(ccCached).toEqual(mockCron);
        expect(readIni).toHaveBeenCalledTimes(2);
      });

      test('should set the enabled property of the cron task and invalidate the cache', () => {
        const ccInit = inst.setCron('job1', false);
        expect(ccInit).toEqual({ job1: { ...mockCron.job1, enabled: false } });
        expect(readIni).toHaveBeenCalledTimes(1);
        expect(readIni).toHaveBeenCalledWith('/path/servers/server1/cron.config');
        expect(fsExtra.writeFileSync).toHaveBeenCalledTimes(1);
        expect(fsExtra.writeFileSync).toHaveBeenCalledWith(
          '/path/servers/server1/cron.config',
          ini.stringify({ job1: { ...mockCron.job1, enabled: false } })
        );

        const ccCached = inst.crons();
        expect(ccCached).toEqual(mockCron);
        expect(readIni).toHaveBeenCalledTimes(2);
      });

      test('should not make any changes if the cron hash does not exist', () => {
        const ccInit = inst.setCron('fake', false);
        expect(ccInit).toEqual(mockCron);
        expect(readIni).toHaveBeenCalledTimes(1);
        expect(readIni).toHaveBeenCalledWith('/path/servers/server1/cron.config');
        expect(fsExtra.writeFileSync).not.toHaveBeenCalled();
      });

      test('should set the enabled property of the cron task and invalidate the cache', () => {
        const ccInit = inst.setCron('job1', false);
        expect(ccInit).toEqual({ job1: { ...mockCron.job1, enabled: false } });
        expect(readIni).toHaveBeenCalledTimes(1);
        expect(readIni).toHaveBeenCalledWith('/path/servers/server1/cron.config');
        expect(fsExtra.writeFileSync).toHaveBeenCalledTimes(1);
        expect(fsExtra.writeFileSync).toHaveBeenCalledWith(
          '/path/servers/server1/cron.config',
          ini.stringify({ job1: { ...mockCron.job1, enabled: false } })
        );

        const ccCached = inst.crons();
        expect(ccCached).toEqual(mockCron);
        expect(readIni).toHaveBeenCalledTimes(2);
      });
    });

    describe('create', () => {
      let mockChild: EventEmitter;

      beforeAll(() => {
        mockChild = new EventEmitter();
        jest.spyOn(mockChild, 'once');

        jest.spyOn(which, 'sync').mockReturnValue('/usr/bin/tar');
        jest.spyOn(fsExtra, 'ensureDirSync').mockImplementation(() => {});
        jest.spyOn(fsExtra, 'ensureFileSync').mockImplementation(() => {});
        jest.spyOn(fsExtra, 'chownSync').mockImplementation(() => {});
        jest.spyOn(fsExtra, 'writeFileSync').mockImplementation(() => {});
        jest.spyOn(fs, 'readFileSync').mockReturnValue(Buffer.from(''));
        jest.spyOn(child, 'spawn').mockReturnValue(mockChild as ChildProcess);
      });

      beforeEach(() => {
        (jest.spyOn(fsExtra.promises, 'readdir') as jest.Mock).mockReturnValue(Promise.resolve(['/path/archive']));
        jest.spyOn(inst, 'exists').mockReturnValue(Promise.resolve(false));
        jest.spyOn(inst, 'isUp').mockReturnValue(false);
      });

      test('should not create a server which already exists', async () => {
        (inst.exists as jest.Mock).mockReturnValue(Promise.resolve(true));
        await expect(() => inst.create({ uid: 1000, gid: 1000 })).rejects.toBeTruthy();
      });

      // This is an edge case if the files are manually deleted but the instance is not stopped first
      test('should not create a server which matches a running instance name', async () => {
        (inst.isUp as jest.Mock).mockReturnValue(true);
        await expect(() => inst.create({ uid: 1000, gid: 1000 })).rejects.toBeTruthy();
      });

      test('should create a regular minecraft server', async () => {
        await inst.create({ uid: 1000, gid: 1000 });

        expect(fsExtra.ensureDirSync).toHaveBeenCalledTimes(3);
        expect(fsExtra.ensureFileSync).toHaveBeenCalledTimes(3);
        expect(fsExtra.chownSync).toHaveBeenCalledTimes(6);
        expect(fsExtra.writeFileSync).toHaveBeenCalledTimes(4);
      });

      test('should create an unconventional minecraft server,', async () => {
        await inst.create({ uid: 1000, gid: 1000 }, true);

        expect(fsExtra.ensureDirSync).toHaveBeenCalledTimes(3);
        expect(fsExtra.ensureFileSync).toHaveBeenCalledTimes(3);
        expect(fsExtra.chownSync).toHaveBeenCalledTimes(6);
        expect(fsExtra.writeFileSync).toHaveBeenCalledTimes(1);
      });

      test('should reject creation from archive if file extension is not supported', async () => {
        const promise = inst.createFromArchive({ uid: 1000, gid: 1000 }, '/path/to/archive.yml');
        await expect(() => promise).rejects.toBeTruthy();
      });

      test('should reject creation from archive if tar returns an error', async () => {
        const promise = inst.createFromArchive({ uid: 1000, gid: 1000 }, '/path/to/archive.tgz');
        await new Promise(process.nextTick);

        mockChild.emit('exit', 1);
        await new Promise(process.nextTick);

        await expect(() => promise).rejects.toBeTruthy();
      });

      test('should create an archive from a tar file at an absolute path', async () => {
        const promise = inst.createFromArchive({ uid: 1000, gid: 1000 }, '/path/to/archive.tar');
        await new Promise(process.nextTick);

        mockChild.emit('exit', 0);
        await new Promise(process.nextTick);

        await promise;

        expect(fsExtra.ensureDirSync).toHaveBeenCalledTimes(3);
        expect(fsExtra.ensureFileSync).toHaveBeenCalledTimes(3);
        expect(fsExtra.chownSync).toHaveBeenCalledTimes(6);
        expect(fsExtra.writeFileSync).toHaveBeenCalledTimes(4);

        expect(child.spawn).toHaveBeenCalledWith('/usr/bin/tar', ['-xf', '/path/to/archive.tar'], {
          cwd: inst.env.cwd,
          uid: 1000,
          gid: 1000,
        });
      });

      test('should create an archive from a tar.gz file in the import directory', async () => {
        const promise = inst.createFromArchive({ uid: 1000, gid: 1000 }, 'archive.tar.gz');
        await new Promise(process.nextTick);

        mockChild.emit('exit', 0);
        await new Promise(process.nextTick);

        await promise;

        expect(fsExtra.ensureDirSync).toHaveBeenCalledTimes(3);
        expect(fsExtra.ensureFileSync).toHaveBeenCalledTimes(3);
        expect(fsExtra.chownSync).toHaveBeenCalledTimes(6);
        expect(fsExtra.writeFileSync).toHaveBeenCalledTimes(4);

        expect(child.spawn).toHaveBeenCalledWith('/usr/bin/tar', ['-xf', `${inst.env.baseDir}/import/archive.tar.gz`], {
          cwd: inst.env.cwd,
          uid: 1000,
          gid: 1000,
        });
      });
    });

    describe('delete', () => {
      beforeEach(() => {
        jest.spyOn(inst, 'exists').mockReturnValue(Promise.resolve(true));
        jest.spyOn(inst, 'isUp').mockReturnValue(false);
      });

      test('should not delete a server which does not exist', async () => {
        (inst.exists as jest.Mock).mockReturnValue(Promise.resolve(false));
        await expect(() => inst.delete()).rejects.toBeTruthy();
      });

      test('should not delete a server which matches a running instance name', async () => {
        (inst.isUp as jest.Mock).mockReturnValue(true);
        await expect(() => inst.delete()).rejects.toBeTruthy();
      });

      test('should force remove all directories', async () => {
        jest.spyOn(fs.promises, 'rm').mockImplementation(async () => {});

        await inst.delete();

        const rmOptions = { recursive: true, force: true };
        expect(fs.promises.rm).toHaveBeenCalledTimes(3);
        expect(fs.promises.rm).toHaveBeenCalledWith(inst.env.cwd, rmOptions);
        expect(fs.promises.rm).toHaveBeenCalledWith(inst.env.bwd, rmOptions);
        expect(fs.promises.rm).toHaveBeenCalledWith(inst.env.awd, rmOptions);

        (fs.promises.rm as jest.Mock).mockReset();
      });
    });

    describe('profile', () => {
      describe('copyProfile', () => {
        beforeEach(() => {
          jest.spyOn(inst, 'exists').mockReturnValue(Promise.resolve(true));
          jest.spyOn(inst, 'isUp').mockReturnValue(false);
        });

        test('should reject if the instance does not exist', async () => {
          (inst.exists as jest.Mock).mockReturnValue(Promise.resolve(false));
          await expect(() => inst.copyProfile()).rejects.toBeTruthy();
        });

        test('should reject if the instance is running', async () => {
          (inst.isUp as jest.Mock).mockReturnValue(true);
          await expect(() => inst.copyProfile()).rejects.toBeTruthy();
        });

        test('should reject if a profile is not set', async () => {
          jest.spyOn(inst, 'sc').mockReturnValue({} as ServerConfig);
          await expect(() => inst.copyProfile()).rejects.toBeTruthy();
        });

        test('should use rsync to copy the profile files', async () => {
          const mockRsync = {
            set: jest.fn(),
            execute: jest.fn().mockReturnValue(Promise.resolve(0)),
          };
          jest.spyOn(Rsync, 'build').mockReturnValue(mockRsync);

          jest.spyOn(inst, 'sc').mockReturnValue({ minecraft: { profile: 'vanilla_1.20' } } as ServerConfig);
          jest
            .spyOn(inst, 'getOwner')
            .mockResolvedValue({ username: 'user', groupname: 'group', uid: 1000, gid: 1000 });

          const result = await inst.copyProfile();
          expect(result).toEqual(0);
          expect(Rsync.build).toHaveBeenCalledWith({
            source: '/path/profiles/vanilla_1.20/',
            destination: '/path/servers/server1/',
            flags: 'au',
            shell: 'ssh',
          });

          expect(mockRsync.set).toHaveBeenCalledTimes(2);
          expect(mockRsync.set.mock.calls).toEqual([
            ['chown', 'user:group'],
            ['chmod', 'ug=rwX'],
          ]);
        });
      });

      describe('delta', () => {
        afterEach(() => {
          jest.resetAllMocks();
        });

        test('should reject with the error if rsync fails', async () => {
          const mockRsync = {
            execute: jest.fn().mockReturnValue(Promise.resolve(1)),
          };
          jest.spyOn(Rsync, 'build').mockReturnValue(mockRsync);

          await expect(() => inst.profileDelta('vanilla_1.20')).rejects.toEqual(1);
        });

        test('should return the list of file differences', async () => {
          let mockOutput: (string) => void;
          const mockRsync = {
            execute: jest.fn().mockImplementation(() => {
              mockOutput('rsync header');
              mockOutput('sent 1234 bytes');
              mockOutput('file.txt');
              mockOutput('multiline.md\n\nnextline.toml');
              mockOutput('rsync trailer');

              return Promise.resolve(0);
            }),
          };
          jest.spyOn(Rsync, 'build').mockImplementation((config) => {
            mockOutput = config.output[0];
            return mockRsync;
          });

          const result = await inst.profileDelta('vanilla_1.20');
          expect(result).toEqual(['file.txt', 'multiline.md', 'nextline.toml']);
          expect(Rsync.build).toHaveBeenCalledTimes(1);
          expect(Rsync.build).toHaveBeenCalledWith({
            source: '/path/profiles/vanilla_1.20/',
            destination: '/path/servers/server1/',
            flags: 'vrun',
            shell: 'ssh',
            output: [expect.anything()],
          });
        });
      });
    });

    describe('minecraft server instance interactions', () => {
      let mockSocket;

      beforeEach(() => {
        jest.spyOn(which, 'sync').mockReturnValue('/usr/bin/screen');
        jest.spyOn(child, 'execFileSync').mockReturnValue(Buffer.from('result'));

        jest.spyOn(inst, 'exists').mockReturnValue(Promise.resolve(true));
        jest.spyOn(inst, 'isUp').mockReturnValue(true);
        jest.spyOn(inst, 'sp').mockReturnValue({ 'server-port': 25565 });
        jest.spyOn(inst, 'sc').mockReturnValue({
          java: { jarfile: 'minecraft_server.jar' },
          minecraft: { profile: 'profile' },
        } as ServerConfig);
        jest.spyOn(inst, 'getOwner').mockReturnValue(
          Promise.resolve({
            uid: 1000,
            gid: 1000,
            username: 'user',
            groupname: 'group',
          })
        );
        jest.spyOn(inst, 'getStartArgs').mockReturnValue(['arg1', 'arg2']);
        jest.spyOn(inst, 'profileDelta').mockReturnValue(Promise.resolve([]));
        jest.spyOn(inst, 'copyProfile').mockReturnValue(Promise.resolve(0));

        mockSocket = new EventEmitter() as net.Socket;
        mockSocket.setTimeout = jest.fn() as any;
        mockSocket.connect = jest.fn() as any;
        mockSocket.write = jest.fn() as any;
        mockSocket.end = jest.fn() as any;

        jest.spyOn(net, 'Socket').mockImplementation(() => mockSocket);
      });

      afterEach(() => {
        jest.resetAllMocks();
      });

      describe('ping', () => {
        test('should reject if there is not a port set for the instance', async () => {
          (inst.sp as jest.Mock).mockReturnValue({});
          await expect(() => inst.ping()).rejects.toBeTruthy();
        });

        test('should reject if the instance is a phar server', async () => {
          (inst.sc as jest.Mock).mockReturnValue({ java: { jarfile: 'server.phar' } });
          await expect(() => inst.ping()).rejects.toBeTruthy();
        });

        test('should reject if the instance is not running', async () => {
          (inst.isUp as jest.Mock).mockReturnValue(false);
          await expect(() => inst.ping()).rejects.toBeTruthy();
        });

        test('should reject if there is an error on the socket', async () => {
          const promise = inst.ping();
          mockSocket.emit('error', 'error');
          await expect(() => promise).rejects.toBeTruthy();
        });

        test('should return data for legacy minecraft servers', async () => {
          const legacyResponse = Buffer.from([
            0xff, 0x00, 0x17, 0x00, 0x41, 0x00, 0x20, 0x00, 0x4d, 0x00, 0x69, 0x00, 0x6e, 0x00, 0x65, 0x00, 0x63, 0x00,
            0x72, 0x00, 0x61, 0x00, 0x66, 0x00, 0x74, 0x00, 0x20, 0x00, 0x53, 0x00, 0x65, 0x00, 0x72, 0x00, 0x76, 0x00,
            0x65, 0x00, 0x72, 0x00, 0xa7, 0x00, 0x30, 0x00, 0xa7, 0x00, 0x32, 0x00, 0x30,
          ]);
          const promise = inst.ping();
          mockSocket.emit('connect');
          mockSocket.emit('data', legacyResponse);

          const data = await promise;

          expect(data.serverVersion).toEqual('');
          expect(data.motd).toEqual('A Minecraft Server');
          expect(data.playersOnline).toEqual(0);
          expect(data.playersMax).toEqual(20);
          expect(data.protocol).toBeUndefined();

          expect(mockSocket.write).toHaveBeenCalled();
          expect(mockSocket.end).toHaveBeenCalled();
          expect(mockSocket.connect).toHaveBeenCalledWith({ port: 25565 });
        });

        test('should return data for modern minecraft servers', async () => {
          const modernResponse = Buffer.from([
            0xff, 0x00, 0x25, 0x00, 0xa7, 0x00, 0x31, 0x00, 0x00, 0x00, 0x31, 0x00, 0x32, 0x00, 0x37, 0x00, 0x00, 0x00,
            0x31, 0x00, 0x2e, 0x00, 0x32, 0x00, 0x30, 0x00, 0x00, 0x00, 0x41, 0x00, 0x20, 0x00, 0x4d, 0x00, 0x69, 0x00,
            0x6e, 0x00, 0x65, 0x00, 0x63, 0x00, 0x72, 0x00, 0x61, 0x00, 0x66, 0x00, 0x74, 0x00, 0x20, 0x00, 0x53, 0x00,
            0x65, 0x00, 0x72, 0x00, 0x76, 0x00, 0x65, 0x00, 0x72, 0x00, 0x00, 0x00, 0x30, 0x00, 0x00, 0x00, 0x32, 0x00,
            0x30,
          ]);
          const promise = inst.ping();
          mockSocket.emit('connect');
          mockSocket.emit('data', modernResponse);

          const data = await promise;

          expect(data.serverVersion).toEqual('1.20');
          expect(data.protocol).toEqual(127);
          expect(data.motd).toEqual('A Minecraft Server');
          expect(data.playersOnline).toEqual(0);
          expect(data.playersMax).toEqual(20);

          expect(mockSocket.write).toHaveBeenCalled();
          expect(mockSocket.end).toHaveBeenCalled();
          expect(mockSocket.connect).toHaveBeenCalledWith({ port: 25565 });
        });
      });

      describe('query', () => {
        test('should reject if there is not a port set for the instance', async () => {
          (inst.sc as jest.Mock).mockReturnValue({});
          await expect(() => inst.query()).rejects.toBeTruthy();
        });

        test('should reject if the instance is a phar server', async () => {
          (inst.sc as jest.Mock).mockReturnValue({ java: { jarfile: 'server.phar' } });
          await expect(() => inst.query()).rejects.toBeTruthy();
        });

        test('should reject if there is an error querying the server', async () => {
          const mockMcqueryInstance = {
            full_stat: jest.fn().mockImplementation((cb: any) => {
              cb(new Error('error'));
            }),
            connect: () => Promise.resolve(),
          };
          mcquery.mockReturnValue(mockMcqueryInstance);
          await expect(() => inst.query()).rejects.toBeTruthy();
        });

        test('should return the value from mcquery', async () => {
          const mockMcqueryInstance = {
            full_stat: jest.fn().mockImplementation((cb: any) => {
              cb(null, { data: 'value' });
            }),
            connect: () => Promise.resolve(),
          };
          mcquery.mockReturnValue(mockMcqueryInstance);

          const result = await inst.query();
          expect(result).toEqual({ data: 'value' });
        });
      });

      describe('stuff', () => {
        test('should reject if the instance does not exist', async () => {
          (inst.exists as jest.Mock).mockReturnValue(Promise.resolve(false));
          await expect(() => inst.stuff('command')).rejects.toBeTruthy();
        });

        test('should reject if the instance is not running', async () => {
          (inst.isUp as jest.Mock).mockReturnValue(false);
          await expect(() => inst.stuff('command')).rejects.toBeTruthy();
        });

        test('should call screen with the command', async () => {
          const result = await inst.stuff('command');
          expect(result).toEqual('result');
          expect(child.execFileSync).toHaveBeenCalledWith(
            '/usr/bin/screen',
            ['-S', 'mc-server1', '-p', '0', '-X', 'eval', 'stuff "command\x0a"'],
            {
              cwd: inst.env.cwd,
              uid: 1000,
              gid: 1000,
              username: 'user',
              groupname: 'group',
            }
          );
        });
      });

      describe('start', () => {
        let mockChild: EventEmitter;

        beforeEach(() => {
          jest.spyOn(inst, 'isUp').mockReturnValue(false);
          mockChild = new EventEmitter();
          jest.spyOn(mockChild, 'once');
          jest.spyOn(child, 'spawn').mockReturnValue(mockChild as ChildProcess);
        });

        test('should reject if the instance does not exist', async () => {
          (inst.exists as jest.Mock).mockReturnValue(Promise.resolve(false));
          await expect(() => inst.start()).rejects.toBeTruthy();
        });

        test('should reject if the instance is already running', async () => {
          (inst.isUp as jest.Mock).mockReturnValue(true);
          await expect(() => inst.start()).rejects.toBeTruthy();
        });

        test('should reject if copying the profile results in an error', async () => {
          (inst.profileDelta as jest.Mock).mockReturnValue(Promise.reject(1));
          await expect(() => inst.start()).rejects.toBeTruthy();
        });

        test('should assume sensible defaults if the profile and start args are missing', async () => {
          (inst.sc as jest.Mock).mockReturnValue({});
          const promise = inst.start();
          await new Promise(process.nextTick);

          jest.advanceTimersByTime(2001);
          await new Promise(process.nextTick);

          await promise;
          expect(child.spawn).toHaveBeenCalledWith('/usr/bin/screen', ['arg1', 'arg2'], {
            cwd: inst.env.cwd,
            uid: 1000,
            gid: 1000,
          });
          expect(inst.copyProfile).not.toHaveBeenCalled();
        });

        test('should ignore errors if the profile source directory does not exist', async () => {
          (inst.profileDelta as jest.Mock).mockReturnValue(Promise.reject(23));
          const promise = inst.start();
          await new Promise(process.nextTick);

          jest.advanceTimersByTime(2001);
          await new Promise(process.nextTick);

          await promise;
          expect(child.spawn).toHaveBeenCalledWith('/usr/bin/screen', ['arg1', 'arg2'], {
            cwd: inst.env.cwd,
            uid: 1000,
            gid: 1000,
          });
          expect(inst.copyProfile).not.toHaveBeenCalled();
        });

        test('should copy the profile when the instance starts if there are any files', async () => {
          (inst.profileDelta as jest.Mock).mockReturnValue(Promise.resolve(['file']));
          const promise = inst.start();
          await new Promise(process.nextTick);

          jest.advanceTimersByTime(2001);
          await new Promise(process.nextTick);

          await promise;
          expect(child.spawn).toHaveBeenCalledWith('/usr/bin/screen', ['arg1', 'arg2'], {
            cwd: inst.env.cwd,
            uid: 1000,
            gid: 1000,
          });
          expect(inst.copyProfile).toHaveBeenCalled();
        });

        test('should reject if the instance exits with an error code within the timeout', async () => {
          const promise = inst.start();
          await new Promise(process.nextTick);

          mockChild.emit('close', 1);

          jest.advanceTimersByTime(1000);
          await new Promise(process.nextTick);

          await expect(() => promise).rejects.toBeTruthy();
          expect(child.spawn).toHaveBeenCalledWith('/usr/bin/screen', ['arg1', 'arg2'], {
            cwd: inst.env.cwd,
            uid: 1000,
            gid: 1000,
          });
        });

        test('should resolve if the process does not close within the timeout', async () => {
          const promise = inst.start();
          await new Promise(process.nextTick);

          jest.advanceTimersByTime(2001);
          await new Promise(process.nextTick);

          await promise;
          expect(child.spawn).toHaveBeenCalledWith('/usr/bin/screen', ['arg1', 'arg2'], {
            cwd: inst.env.cwd,
            uid: 1000,
            gid: 1000,
          });
        });

        test('should resolve if the process exits cleanly within the timeout', async () => {
          const promise = inst.start();
          await new Promise(process.nextTick);

          mockChild.emit('close', 0);

          jest.advanceTimersByTime(1000);
          await new Promise(process.nextTick);

          await promise;
          expect(child.spawn).toHaveBeenCalledWith('/usr/bin/screen', ['arg1', 'arg2'], {
            cwd: inst.env.cwd,
            uid: 1000,
            gid: 1000,
          });
        });
      });

      describe('stop', () => {
        beforeEach(() => {
          jest.spyOn(inst, 'stuff').mockImplementation((command) => Promise.resolve(command));
        });

        test('should reject if the instance does not exist', async () => {
          (inst.exists as jest.Mock).mockReturnValue(Promise.resolve(false));
          await expect(() => inst.stop()).rejects.toBeTruthy();
        });

        test('should resolve if the instance is not running', async () => {
          (inst.isUp as jest.Mock).mockReturnValue(false);
          await inst.stop();
        });

        test('should resolve if the instance exits within the iteration counter', async () => {
          let counter = 0;
          jest.spyOn(inst, 'isUp').mockImplementation(() => {
            if (counter === 0) {
              counter++;
              return true;
            }
            counter++;
            return false;
          });

          const promise = inst.stop();
          await new Promise(process.nextTick);
          jest.advanceTimersByTime(200);
          await new Promise(process.nextTick);

          await promise;
        });

        test('should reject if the instance does not stop within the iteration counter', async () => {
          (inst.isUp as jest.Mock).mockReturnValue(true);
          const promise = inst.stop();
          await new Promise(process.nextTick);

          for (let i = 0; i < 150; i++) {
            await new Promise(process.nextTick);
            jest.advanceTimersByTime(200);
          }

          await expect(() => promise).rejects.toBeTruthy();
        });
      });

      describe('kill', () => {
        beforeEach(() => {
          // This function uses more than just the isUp() check, so this suite needs to mock the underlying feature
          jest.spyOn(Instance, 'listRunningInstancePids').mockReturnValue({ server1: { java: 1000 } });
          jest.spyOn(process, 'kill').mockImplementation(() => true);
        });

        test('should reject if the instance does not exist', async () => {
          (inst.exists as jest.Mock).mockReturnValue(Promise.resolve(false));
          await expect(() => inst.kill()).rejects.toBeTruthy();
        });

        test('should reject if there is no running java process', async () => {
          jest.spyOn(Instance, 'listRunningInstancePids').mockReturnValue({ server1: { screen: 1001 } });
          await expect(() => inst.kill()).rejects.toBeTruthy();
        });

        test('should resolve if the instance has no running processes', async () => {
          jest.spyOn(Instance, 'listRunningInstancePids').mockReturnValue({});
          await inst.kill();
        });

        test('should resolve if the instance exits within the iteration counter', async () => {
          let counter = 0;
          jest.spyOn(Instance, 'listRunningInstancePids').mockImplementation(() => {
            if (counter === 0) {
              counter++;
              return { server1: { java: 1000 } } as any;
            }
            counter++;
            return {};
          });

          const promise = inst.kill();
          await new Promise(process.nextTick);
          jest.advanceTimersByTime(200);
          await new Promise(process.nextTick);

          await promise;
        });

        test('should reject if the instance does not stop within the iteration counter', async () => {
          const promise = inst.kill();
          await new Promise(process.nextTick);

          for (let i = 0; i < 150; i++) {
            await new Promise(process.nextTick);
            jest.advanceTimersByTime(200);
          }

          await expect(() => promise).rejects.toBeTruthy();
        });
      });

      describe('restart', () => {
        beforeEach(() => {
          jest.spyOn(inst, 'stop').mockReturnValue(Promise.resolve());
          jest.spyOn(inst, 'start').mockReturnValue(Promise.resolve());
        });

        it('should reject if the instance fails to stop', async () => {
          jest.spyOn(inst, 'stop').mockReturnValue(Promise.reject(new Error('error')));
          await expect(() => inst.restart()).rejects.toBeTruthy();
        });

        it('should reject if the instance fails to start', async () => {
          jest.spyOn(inst, 'start').mockReturnValue(Promise.reject(new Error('error')));
          await expect(() => inst.restart()).rejects.toBeTruthy();
        });

        it('should resolve if the instance succesfully restarts', async () => {
          await inst.restart();
          expect(inst.stop).toHaveBeenCalledTimes(1);
          expect(inst.start).toHaveBeenCalledTimes(1);
        });
      });

      describe('stopAndBackup', () => {
        beforeEach(() => {
          jest.spyOn(inst, 'stop').mockReturnValue(Promise.resolve());
          jest.spyOn(inst, 'backup').mockReturnValue(Promise.resolve());
        });

        it('should reject if the instance fails to stop', async () => {
          jest.spyOn(inst, 'stop').mockReturnValue(Promise.reject(new Error('error')));
          await expect(() => inst.stopAndBackup()).rejects.toBeTruthy();
        });

        it('should reject if the instance fails to run the backup', async () => {
          jest.spyOn(inst, 'backup').mockReturnValue(Promise.reject(new Error('error')));
          await expect(() => inst.stopAndBackup()).rejects.toBeTruthy();
        });

        it('should resolve if the instance succesfully restarts', async () => {
          await inst.stopAndBackup();
          expect(inst.stop).toHaveBeenCalledTimes(1);
          expect(inst.backup).toHaveBeenCalledTimes(1);
        });
      });

      describe('saveall', () => {
        beforeEach(() => {
          jest.spyOn(inst, 'stuff').mockReturnValue(Promise.resolve(''));
        });

        test('should reject if the instance does not exist', async () => {
          (inst.exists as jest.Mock).mockReturnValue(Promise.resolve(false));
          await expect(() => inst.saveall()).rejects.toBeTruthy();
        });

        test('should reject if the instance is not running', async () => {
          (inst.isUp as jest.Mock).mockReturnValue(false);
          await expect(() => inst.saveall()).rejects.toBeTruthy();
        });

        test('should reject if stuff fails to send the command', async () => {
          jest.spyOn(inst, 'stuff').mockReturnValue(Promise.reject(new Error('error')));
          await expect(() => inst.saveall()).rejects.toBeTruthy();
        });

        test('should wait the configured amount of time before resolving', async () => {
          const promise = inst.saveall(2);
          await new Promise(process.nextTick);

          jest.advanceTimersByTime(2000);
          await new Promise(process.nextTick);

          await promise;
          expect(inst.stuff).toHaveBeenCalledWith('save-all');
        });
      });

      describe('saveallLatestLog', () => {
        let mockTail: EventEmitter & { unwatch?: () => void };
        beforeEach(() => {
          jest.spyOn(inst, 'stuff').mockReturnValue(Promise.resolve(''));
          mockTail = new EventEmitter();
          mockTail.unwatch = jest.fn();

          (Tail as jest.Mock).mockReturnValue(mockTail);
        });

        test('should reject if the instance does not exist', async () => {
          (inst.exists as jest.Mock).mockReturnValue(Promise.resolve(false));
          await expect(() => inst.saveallLatestLog()).rejects.toBeTruthy();
        });

        test('should reject if the instance is not running', async () => {
          (inst.isUp as jest.Mock).mockReturnValue(false);
          await expect(() => inst.saveallLatestLog()).rejects.toBeTruthy();
        });

        test('should reject if the tail cannot be started', async () => {
          (Tail as jest.Mock).mockImplementation(() => {
            throw new Error('error');
          });
          await expect(() => inst.saveallLatestLog()).rejects.toBeTruthy();
        });

        test('should reject if the save message is not seen before the timeout', async () => {
          const promise = inst.saveallLatestLog();

          await new Promise(process.nextTick);
          jest.advanceTimersByTime(10000);
          await new Promise(process.nextTick);

          await expect(() => promise).rejects.toBeTruthy();
          expect(inst.stuff).toHaveBeenCalledWith('save-all');
          expect(mockTail.unwatch).toHaveBeenCalled();
        });

        test('should resolve once the save message is seen', async () => {
          const promise = inst.saveallLatestLog();
          await new Promise(process.nextTick);

          mockTail.emit('line', '[INFO]: Saved the world');

          jest.advanceTimersByTime(10000);
          await new Promise(process.nextTick);

          await promise;
          expect(inst.stuff).toHaveBeenCalledWith('save-all');
          expect(mockTail.unwatch).toHaveBeenCalled();
        });
      });
    });

    describe('backup and archive functions', () => {
      let mockChild: EventEmitter & { stdout?: EventEmitter };

      beforeAll(() => {
        jest.spyOn(which, 'sync').mockImplementation((cmd) => `/usr/bin/${cmd}`);
      });

      beforeEach(() => {
        jest
          .spyOn(inst, 'getOwner')
          .mockReturnValue(Promise.resolve({ uid: 1000, gid: 1000, username: 'user', groupname: 'group' }));
        jest.spyOn(inst, 'stuff').mockImplementation((command) => Promise.resolve(command));
        jest.spyOn(inst, 'saveallLatestLog').mockReturnValue(Promise.resolve());
        jest.spyOn(inst, 'getAutosaveState').mockReturnValue(Promise.resolve(false));

        mockChild = new EventEmitter();
        jest.spyOn(mockChild, 'once');
        jest.spyOn(child, 'spawn').mockReturnValue(mockChild as ChildProcess);
      });

      describe('archive', () => {
        test('should reject if the tar process fails', async () => {
          const promise = inst.archive();
          await new Promise(process.nextTick);

          mockChild.emit('exit', 1);
          await new Promise(process.nextTick);

          await expect(() => promise).rejects.toBeTruthy();
        });

        test('should attempt to force a save', async () => {
          const promise = inst.archive(true);
          await new Promise(process.nextTick);

          mockChild.emit('exit', 0);
          await new Promise(process.nextTick);

          await promise;
          expect(inst.stuff).toHaveBeenCalledTimes(1);
          expect(inst.stuff).toHaveBeenCalledWith('save-off');
          expect(inst.saveallLatestLog).toHaveBeenCalled();
          expect(child.spawn).toHaveBeenLastCalledWith(
            '/usr/bin/tar',
            [
              'czf',
              expect.stringMatching(
                /^\/path\/archive\/server1\/server-server1_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}.tgz$/
              ),
              '.',
            ],
            { cwd: '/path/servers/server1', uid: 1000, gid: 1000 }
          );
        });

        test('should not fail if the forced save fails', async () => {
          (inst.saveallLatestLog as jest.Mock).mockReturnValue(Promise.reject('error'));
          const promise = inst.archive(true);
          await new Promise(process.nextTick);

          mockChild.emit('exit', 0);
          await new Promise(process.nextTick);

          await promise;
          expect(inst.stuff).toHaveBeenCalledTimes(1);
          expect(inst.stuff).toHaveBeenCalledWith('save-off');
          expect(inst.saveallLatestLog).toHaveBeenCalled();
        });

        test('should re-enable saving if it was on before archiving', async () => {
          (inst.getAutosaveState as jest.Mock).mockReturnValue(Promise.resolve(true));
          const promise = inst.archive(true);
          await new Promise(process.nextTick);

          mockChild.emit('exit', 0);
          await new Promise(process.nextTick);

          await promise;
          expect(inst.stuff).toHaveBeenCalledTimes(2);
          expect(inst.stuff).toHaveBeenCalledWith('save-off');
          expect(inst.stuff).toHaveBeenCalledWith('save-on');
          expect(inst.saveallLatestLog).toHaveBeenCalled();
        });
      });

      describe('backup', () => {
        test('should reject if the rdiff process returns an error', async () => {
          const promise = inst.backup();
          await new Promise(process.nextTick);

          mockChild.emit('exit', 1);
          await new Promise(process.nextTick);

          await expect(() => promise).rejects.toBeTruthy();
        });

        test('should resolve if the backup runs successfully', async () => {
          const promise = inst.backup();
          await new Promise(process.nextTick);

          mockChild.emit('exit', 0);
          await new Promise(process.nextTick);

          await promise;
          expect(child.spawn).toHaveBeenCalledWith(
            '/usr/bin/rdiff-backup',
            ['--exclude', '/path/servers/server1/dynmap', '/path/servers/server1/', '/path/backup/server1'],
            { cwd: '/path/backup/server1', uid: 1000, gid: 1000 }
          );
        });
      });

      describe('restore', () => {
        test('should reject if the rdiff process returns an error', async () => {
          const promise = inst.restore(10);
          await new Promise(process.nextTick);

          mockChild.emit('exit', 1);
          await new Promise(process.nextTick);

          await expect(() => promise).rejects.toBeTruthy();
        });

        test('should resolve if the restore runs successfully', async () => {
          const promise = inst.restore(10);
          await new Promise(process.nextTick);

          mockChild.emit('exit', 0);
          await new Promise(process.nextTick);

          await promise;
          expect(child.spawn).toHaveBeenCalledWith(
            '/usr/bin/rdiff-backup',
            ['--restore-as-of', '10', '--force', '/path/backup/server1', '/path/servers/server1'],
            { cwd: '/path/backup/server1' }
          );
        });
      });

      describe('previousVersion', () => {
        beforeEach(() => {
          jest.spyOn(fs.promises, 'readFile').mockReturnValue(Promise.resolve(Buffer.from('file contents')));
          jest.spyOn(fs.promises, 'mkdtemp').mockImplementation((prefix) => Promise.resolve(`${prefix}-mock`));
        });

        test('should reject if a temporary file cannot be created', async () => {
          (fs.promises.mkdtemp as jest.Mock).mockReturnValue(Promise.reject('error'));
          await expect(() => inst.previousVersion('filename', 1)).rejects.toBeTruthy();
        });

        test('should reject if rdiff-backup has an error', async () => {
          const promise = inst.previousVersion('filename', 1);
          await new Promise(process.nextTick);

          mockChild.emit('error', new Error('error'));
          await new Promise(process.nextTick);

          await expect(() => promise).rejects.toBeTruthy();
        });

        test('should reject if rdiff-backup returns an error status', async () => {
          const promise = inst.previousVersion('filename', 1);
          await new Promise(process.nextTick);

          mockChild.emit('exit', 1);
          await new Promise(process.nextTick);

          await expect(() => promise).rejects.toBeTruthy();
        });

        test('should reject if reading the temp file has an error', async () => {
          (fs.promises.readFile as jest.Mock).mockReturnValue(Promise.reject('error'));
          const promise = inst.previousVersion('filename', 1);
          await new Promise(process.nextTick);

          mockChild.emit('exit', 0);
          await new Promise(process.nextTick);
          await new Promise(process.nextTick);

          await expect(() => promise).rejects.toBeTruthy();
        });

        test('should resolve with the contents of the file', async () => {
          const promise = inst.previousVersion('filename', 1);
          await new Promise(process.nextTick);

          mockChild.emit('exit', 0);
          await new Promise(process.nextTick);
          await new Promise(process.nextTick);

          const result = await promise;
          expect(result).toEqual('file contents');
        });
      });

      describe('listIncrements', () => {
        let mockStdout: EventEmitter;

        beforeEach(() => {
          mockStdout = new EventEmitter();
          mockChild.stdout = mockStdout;
        });

        test('should reject if rdiff-backup has an error', async () => {
          const promise = inst.listIncrements();
          await new Promise(process.nextTick);

          mockChild.emit('error', new Error('error'));
          await new Promise(process.nextTick);

          await expect(() => promise).rejects.toBeTruthy();
        });

        test('should reject if rdiff-backup returns an error status', async () => {
          const promise = inst.listIncrements();
          await new Promise(process.nextTick);

          mockChild.emit('exit', 1);
          await new Promise(process.nextTick);

          await expect(() => promise).rejects.toBeTruthy();
        });

        test('should filter non-matching lines and return increments in a guaranteed order', async () => {
          const promise = inst.listIncrements();
          await new Promise(process.nextTick);

          const mockIncrements = `
Found 4 increments:
    increments.2024-01-01T00:00:00Z.dir   Mon Jan  1 00:00:00 2024
    increments.2024-04-30T00:00:00Z.dir   Mon Apr 30 00:00:00 2024
    increments.2024-02-01T00:00:00Z.dir   Thu Feb  1 00:00:00 2024
    increments.2024-03-01T00:00:00Z.dir   Fri Mar  1 00:00:00 2024
Current Mirror: Mon Apr 30 00:00:00 2024
          `;

          mockStdout.emit('data', mockIncrements);
          await new Promise(process.nextTick);

          mockChild.emit('exit', 0);
          await new Promise(process.nextTick);

          const result = await promise;
          expect(result.length).toEqual(4);

          expect(result[0].time).toEqual('Mon Apr 30 00:00:00 2024');
          expect(result[0].step).toEqual('0B');

          expect(result[1].time).toEqual('Fri Mar  1 00:00:00 2024');
          expect(result[1].step).toEqual('1B');

          expect(result[2].time).toEqual('Thu Feb  1 00:00:00 2024');
          expect(result[2].step).toEqual('2B');

          expect(result[3].time).toEqual('Mon Jan  1 00:00:00 2024');
          expect(result[3].step).toEqual('3B');
        });
      });

      describe('listIncrementSizes', () => {
        let mockStdout: EventEmitter;

        beforeEach(() => {
          mockStdout = new EventEmitter();
          mockChild.stdout = mockStdout;
        });

        test('should reject if rdiff-backup has an error', async () => {
          const promise = inst.listIncrementSizes();
          await new Promise(process.nextTick);

          mockChild.emit('error', new Error('error'));
          await new Promise(process.nextTick);

          await expect(() => promise).rejects.toBeTruthy();
        });

        test('should reject if rdiff-backup returns an error status', async () => {
          const promise = inst.listIncrementSizes();
          await new Promise(process.nextTick);

          mockChild.emit('exit', 1);
          await new Promise(process.nextTick);

          await expect(() => promise).rejects.toBeTruthy();
        });

        test('should filter non-matching lines and return increments in a guaranteed order', async () => {
          const promise = inst.listIncrementSizes();
          await new Promise(process.nextTick);

          const mockIncrements = `
        Time                       Size        Cumulative size
------------------------------------------------------------------
Mon Jan  1 00:00:00 2024        5.11 MB          5.11 MB
Mon Apr 30 00:00:00 2024        7.03 MB          25.2 MB
Thu Feb  1 00:00:00 2024        6.11 MB          11.2 MB
Fri Mar  1 00:00:00 2024        6.95 MB          18.2 MB
          `;

          mockStdout.emit('data', mockIncrements);
          await new Promise(process.nextTick);

          mockChild.emit('exit', 0);
          await new Promise(process.nextTick);

          const result = await promise;
          expect(result.length).toEqual(4);
          expect(result[0].time).toEqual('Mon Apr 30 00:00:00 2024');
          expect(result[0].step).toEqual('0B');
          expect(result[0].size).toEqual('7.03 MB');
          expect(result[0].cum).toEqual('25.2 MB');

          expect(result[1].time).toEqual('Fri Mar  1 00:00:00 2024');
          expect(result[1].step).toEqual('1B');
          expect(result[1].size).toEqual('6.95 MB');
          expect(result[1].cum).toEqual('18.2 MB');

          expect(result[2].time).toEqual('Thu Feb  1 00:00:00 2024');
          expect(result[2].step).toEqual('2B');
          expect(result[2].size).toEqual('6.11 MB');
          expect(result[2].cum).toEqual('11.2 MB');

          expect(result[3].time).toEqual('Mon Jan  1 00:00:00 2024');
          expect(result[3].step).toEqual('3B');
          expect(result[3].size).toEqual('5.11 MB');
          expect(result[3].cum).toEqual('5.11 MB');
        });
      });

      describe('listArchives', () => {
        beforeEach(() => {
          jest
            .spyOn(fs.promises, 'readdir')
            .mockReturnValue(Promise.resolve(['2024-01-01.tar.gz', '2024-02-02.tar.gz'] as any));
          jest.spyOn(fs.promises, 'stat').mockImplementation((file) => {
            return Promise.resolve({
              mtime: new Date(file.toString().split('/').slice(-1)[0].split('.')[0]),
              size: 100,
            } as Stats);
          });
        });

        test('should reject if the archive drectory cannot be read', async () => {
          (fs.promises.readdir as jest.Mock).mockReturnValue(Promise.reject('error'));
          await expect(() => inst.listArchives()).rejects.toBeTruthy();
        });

        test('should reject if any archive file cannot be read', async () => {
          (fs.promises.stat as jest.Mock).mockImplementation((path: any) => {
            if (path.match('2024-02-02')) {
              return Promise.reject('error');
            }

            return Promise.resolve({
              mtime: new Date(path.toString().split('.')[0]),
              size: 100,
            } as Stats);
          });
          await expect(() => inst.listArchives()).rejects.toBeTruthy();
        });

        test('should return archives sorted by modification time', async () => {
          const result = await inst.listArchives();
          expect(result.length).toEqual(2);

          expect(result[0].time).toEqual(new Date('2024-02-02'));
          expect(result[0].filename).toEqual('2024-02-02.tar.gz');

          expect(result[1].time).toEqual(new Date('2024-01-01'));
          expect(result[1].filename).toEqual('2024-01-01.tar.gz');
        });
      });

      describe('prune', () => {
        test('should reject if rdiff-backup has an error', async () => {
          const promise = inst.prune(2);
          await new Promise(process.nextTick);

          mockChild.emit('error', 'error');
          await new Promise(process.nextTick);

          await expect(() => promise).rejects.toBeTruthy();
        });

        test('should reject if rdiff-backup returns an error status', async () => {
          const promise = inst.prune(2);
          await new Promise(process.nextTick);

          mockChild.emit('exit', 1);
          await new Promise(process.nextTick);

          await expect(() => promise).rejects.toBeTruthy();
        });

        test('should resolve if the backups were pruned', async () => {
          const promise = inst.prune(2);
          await new Promise(process.nextTick);

          mockChild.emit('exit', 0);
          await new Promise(process.nextTick);

          await promise;
          expect(child.spawn).toHaveBeenCalledWith(
            '/usr/bin/rdiff-backup',
            ['--force', '--remove-older-than', '2', inst.env.bwd],
            { cwd: inst.env.bwd }
          );
        });
      });

      describe('deleteArchive', () => {
        test('should reject if there is an error deleting the file', async () => {
          jest.spyOn(fs.promises, 'rm').mockReturnValue(Promise.reject('error'));
          await expect(() => inst.deleteArchive('2024-01-01.tar.gz')).rejects.toBeTruthy();
        });

        test('should resolve if the file is able to be deleted', async () => {
          jest.spyOn(fs.promises, 'rm').mockReturnValue(Promise.resolve());
          await inst.deleteArchive('2024-01-01.tar.gz');
          expect(fs.promises.rm).toHaveBeenLastCalledWith('/path/archive/server1/2024-01-01.tar.gz');
        });
      });
    });

    describe('filesystem ownership and permissions', () => {
      beforeEach(() => {
        jest.spyOn(fs.promises, 'stat').mockReturnValue(Promise.resolve({ uid: 1000, gid: 1000 } as Stats));
        jest.spyOn(userid, 'username').mockReturnValue('user');
        jest.spyOn(userid, 'groupname').mockReturnValue('group');
      });

      afterEach(() => {
        jest.resetAllMocks();
      });

      describe('getOwner', () => {
        test('should reject if stat has an error', async () => {
          (fs.promises.stat as jest.Mock).mockReturnValue(Promise.reject('error'));

          await expect(() => inst.getOwner()).rejects.toBeTruthy();
        });

        test('should look up the uid and gid', async () => {
          const result = await inst.getOwner();
          expect(result.uid).toEqual(1000);
          expect(result.username).toEqual('user');
          expect(result.gid).toEqual(1000);
          expect(result.groupname).toEqual('group');
        });
      });

      describe('chown', () => {
        beforeEach(() => {
          (existsOnSystem as jest.Mock).mockReturnValue(Promise.resolve([true, true]));
          jest.spyOn(inst, 'exists').mockReturnValue(Promise.resolve(true));
          (chownr as jest.Mock).mockImplementation((path, uid, gid, cb: any) => {
            cb();
          });
        });

        afterEach(() => {
          jest.resetAllMocks();
        });

        test('should reject if the uid does not exist', async () => {
          (existsOnSystem as jest.Mock).mockReturnValue(Promise.resolve([false, true]));
          await expect(() => inst.chown(1000, 1000)).rejects.toBeTruthy();
        });

        test('should reject if the gid does not exist', async () => {
          (existsOnSystem as jest.Mock).mockReturnValue(Promise.resolve([true, false]));
          await expect(() => inst.chown(1000, 1000)).rejects.toBeTruthy();
        });

        test('should reject if the instance does not exist', async () => {
          jest.spyOn(inst, 'exists').mockReturnValue(Promise.resolve(false));
          await expect(() => inst.chown(1000, 1000)).rejects.toBeTruthy();
        });

        test('should reject if chownr has an error', async () => {
          (chownr as jest.Mock).mockImplementation((path, uid, gid, cb: any) => {
            cb(new Error('error'));
          });
          await expect(() => inst.chown(1000, 1000)).rejects.toBeTruthy();
        });

        test('should resolve if chownr is successful', async () => {
          await inst.chown(1000, 1000);
          expect(chownr).toHaveBeenCalledTimes(3);
          expect(chownr).toHaveBeenCalledWith(inst.env.cwd, 1000, 1000, expect.anything());
          expect(chownr).toHaveBeenCalledWith(inst.env.bwd, 1000, 1000, expect.anything());
          expect(chownr).toHaveBeenCalledWith(inst.env.awd, 1000, 1000, expect.anything());
        });
      });

      describe('fixOwnership', () => {
        beforeEach(() => {
          jest.spyOn(fs.promises, 'stat').mockReturnValue(Promise.resolve({ uid: 1000, gid: 1000 } as Stats));
          (jest.spyOn(fsExtra, 'ensureDir') as jest.Mock).mockReturnValue(Promise.resolve());
          (chownr as jest.Mock).mockImplementation((path, uid, gid, cb: any) => {
            cb();
          });
        });

        afterEach(() => {
          jest.resetAllMocks();
        });

        test('should reject if stat fails', async () => {
          (fs.promises.stat as jest.Mock).mockReturnValue(Promise.reject('error'));
          await expect(() => inst.fixOwnership()).rejects.toBeTruthy();
        });

        test('should reject if ensureDir fails', async () => {
          (fsExtra.ensureDir as jest.Mock).mockReturnValue(Promise.reject('error'));
          await expect(() => inst.fixOwnership()).rejects.toBeTruthy();
        });

        test('should reject if chownr has an error', async () => {
          (chownr as jest.Mock).mockImplementation((path, uid, gid, cb: any) => {
            cb(new Error('error'));
          });
          await expect(() => inst.fixOwnership()).rejects.toBeTruthy();
        });

        test('should resolve if chownr is successful', async () => {
          await inst.fixOwnership();
          expect(chownr).toHaveBeenCalledTimes(3);
          expect(chownr).toHaveBeenCalledWith(inst.env.cwd, 1000, 1000, expect.anything());
          expect(chownr).toHaveBeenCalledWith(inst.env.bwd, 1000, 1000, expect.anything());
          expect(chownr).toHaveBeenCalledWith(inst.env.awd, 1000, 1000, expect.anything());
        });
      });
    });

    describe('utilities', () => {
      describe('runInstallcer', () => {
        let mockChild: EventEmitter;

        beforeEach(() => {
          jest.spyOn(inst, 'exists').mockReturnValue(Promise.resolve(true));
          jest.spyOn(inst, 'isUp').mockReturnValue(false);
          jest.spyOn(inst, 'getOwner').mockReturnValue(
            Promise.resolve({
              uid: 1000,
              gid: 1000,
              username: 'user',
              groupname: 'group',
            })
          );

          (which as unknown as jest.Mock).mockImplementation((command) => Promise.resolve(`/usr/bin/${command}`));

          mockChild = new EventEmitter();
          jest.spyOn(child, 'spawn').mockImplementation(() => mockChild as ChildProcess);
        });

        test('should reject if the instance does not exist', async () => {
          (inst.exists as jest.Mock).mockReturnValue(Promise.resolve(false));
          await expect(() => inst.runInstaller()).rejects.toBeTruthy();
        });

        test('should reject if the instance is running', async () => {
          (inst.isUp as jest.Mock).mockReturnValue(true);
          await expect(() => inst.runInstaller()).rejects.toBeTruthy();
        });

        test('should reject if the installer process exits with an error', async () => {
          const promise = inst.runInstaller();

          await new Promise(process.nextTick);
          mockChild.emit('close', 1);
          await new Promise(process.nextTick);

          await expect(() => promise).rejects.toBeTruthy();
        });

        test('should run the installer in a sub-shell', async () => {
          const promise = inst.runInstaller();

          await new Promise(process.nextTick);
          mockChild.emit('close', 0);
          await new Promise(process.nextTick);

          await promise;
          expect(child.spawn).toHaveBeenLastCalledWith('/usr/bin/sh', ['FTBInstall.sh'], {
            cwd: inst.env.cwd,
            uid: 1000,
            gid: 1000,
          });
        });
      });

      describe('renice', () => {
        let mockChild: EventEmitter;

        beforeEach(() => {
          jest.spyOn(which, 'sync').mockImplementation((cmd) => `/usr/bin/${cmd}`);

          jest.spyOn(inst, 'isUp').mockReturnValue(true);
          jest.spyOn(inst, 'exists').mockReturnValue(Promise.resolve(true));
          jest.spyOn(inst, 'getChildPid').mockReturnValue(101);
          jest
            .spyOn(inst, 'getOwner')
            .mockReturnValue(Promise.resolve({ uid: 1000, gid: 1000, username: 'user', groupname: 'group' }));

          mockChild = new EventEmitter();
          jest.spyOn(child, 'spawn').mockImplementation(() => mockChild as ChildProcess);
        });

        test('should reject if the instance does not exist', async () => {
          (inst.exists as jest.Mock).mockReturnValue(Promise.resolve(false));
          await expect(() => inst.renice(1)).rejects.toBeTruthy();
        });

        test('should reject if the instance is not running', async () => {
          (inst.isUp as jest.Mock).mockReturnValue(false);
          await expect(() => inst.renice(1)).rejects.toBeTruthy();
        });

        test('should reject if there is no java process', async () => {
          (inst.getChildPid as jest.Mock).mockReturnValue(undefined);
          await expect(() => inst.renice(1)).rejects.toBeTruthy();
        });

        test('should reject if the renice process returns an error status', async () => {
          const promise = inst.renice(10);
          await new Promise(process.nextTick);
          mockChild.emit('close', 1);
          await new Promise(process.nextTick);

          await expect(() => promise).rejects.toBeTruthy();
        });

        test('should call renice to set the java process priority', async () => {
          const promise = inst.renice(10.501);
          await new Promise(process.nextTick);
          mockChild.emit('close', 0);
          await new Promise(process.nextTick);

          await promise;
          expect(child.spawn).toHaveBeenLastCalledWith('/usr/bin/renice', ['-n', '11', '-p', '101'], {
            cwd: inst.env.cwd,
            uid: 1000,
            gid: 1000,
          });
        });
      });

      describe('du', () => {
        beforeEach(() => {
          (du as jest.Mock).mockImplementation((path, options, cb: any) => {
            cb(null, 1000);
          });
        });

        test('rejects if an invalid directory is queried', async () => {
          await expect(() => inst.du('bad' as any)).rejects.toBeTruthy();
        });

        test('rejects if du does not return within the timeout', async () => {
          (du as jest.Mock).mockImplementation(() => {});

          const promise = inst.du('awd');
          jest.advanceTimersByTime(3000);
          await new Promise(process.nextTick);

          await expect(() => promise).rejects.toBeTruthy();
        });

        test('rejects if du returns an error', async () => {
          (du as jest.Mock).mockImplementation((path, options, cb: any) => {
            cb(new Error('error'));
          });

          const promise = inst.du('awd');
          jest.advanceTimersByTime(1000);
          await new Promise(process.nextTick);

          await expect(() => promise).rejects.toBeTruthy();
        });

        test('ensures that a number always gets returned', async () => {
          (du as jest.Mock).mockImplementation((path, options, cb: any) => {
            cb(null, undefined);
          });

          const promise = inst.du('awd');
          jest.advanceTimersByTime(1000);
          await new Promise(process.nextTick);

          const result = await promise;
          expect(result).toEqual(0);
        });

        test('gets the size of the archive directory', async () => {
          const promise = inst.du('awd');
          jest.advanceTimersByTime(1000);
          await new Promise(process.nextTick);

          const result = await promise;
          expect(result).toEqual(1000);
        });

        test('gets the size of the backup directory', async () => {
          const promise = inst.du('bwd');
          jest.advanceTimersByTime(1000);
          await new Promise(process.nextTick);

          const result = await promise;
          expect(result).toEqual(1000);
        });

        test('gets the size of the instance server directory', async () => {
          const promise = inst.du('cwd');
          jest.advanceTimersByTime(1000);
          await new Promise(process.nextTick);

          const result = await promise;
          expect(result).toEqual(1000);
        });
      });

      describe('acceptEula', () => {
        beforeEach(() => {
          (jest.spyOn(fsExtra, 'outputFile') as jest.Mock).mockReturnValue(Promise.resolve());
          jest.spyOn(fs.promises, 'stat').mockReturnValue(Promise.resolve({ uid: 1000, gid: 1000 } as Stats));
          jest.spyOn(fs.promises, 'chown').mockReturnValue(Promise.resolve());
        });

        test('should reject if the eula file cannot be created', async () => {
          (fsExtra.outputFile as jest.Mock).mockReturnValue(Promise.reject('error'));
          await expect(() => inst.acceptEula()).rejects.toBeTruthy();
        });

        test('should reject if the ownership of the server instance directory cannot be queried', async () => {
          (fs.promises.stat as jest.Mock).mockReturnValue(Promise.reject('error'));
          await expect(() => inst.acceptEula()).rejects.toBeTruthy();
        });

        test('should reject if the ownership of the eula file cannot be changed', async () => {
          (fs.promises.chown as jest.Mock).mockReturnValue(Promise.reject('error'));
          await expect(() => inst.acceptEula()).rejects.toBeTruthy();
        });

        test('should create the eula file with the correct permissions', async () => {
          await inst.acceptEula();
          expect(fsExtra.outputFile).toHaveBeenCalledWith('/path/servers/server1/eula.txt', 'eula=true');
          expect(fs.promises.stat).toHaveBeenCalledWith('/path/servers/server1');
          expect(fs.promises.chown).toHaveBeenCalledWith('/path/servers/server1/eula.txt', 1000, 1000);
        });
      });
    });

    describe('properties', () => {
      describe('exists', () => {
        test('should return false if stat has an error', async () => {
          jest.spyOn(fs.promises, 'stat').mockReturnValue(Promise.reject('error'));
          expect(await inst.exists()).toEqual(false);
        });

        test('should return true if there is stat data for the server properties', async () => {
          jest.spyOn(fs.promises, 'stat').mockReturnValue(Promise.resolve({ uid: 1000, gid: 1000 } as Stats));
          expect(await inst.exists()).toEqual(true);
        });
      });

      describe('isUp', () => {
        test('should return false if there are no processes running for the instance', () => {
          jest.spyOn(Instance, 'listRunningInstancePids').mockReturnValue({ server2: { java: 100, screen: 101 } });
          expect(inst.isUp()).toEqual(false);
        });

        test('should return true if only a java process exists', () => {
          jest.spyOn(Instance, 'listRunningInstancePids').mockReturnValue({ server1: { java: 100 } });
          expect(inst.isUp()).toEqual(true);
        });

        test('should return true if only a screen process exists', () => {
          jest.spyOn(Instance, 'listRunningInstancePids').mockReturnValue({ server1: { screen: 101 } });
          expect(inst.isUp()).toEqual(true);
        });

        test('should return true if both java and screen processes exist', () => {
          jest.spyOn(Instance, 'listRunningInstancePids').mockReturnValue({ server1: { java: 100, screen: 101 } });
          expect(inst.isUp()).toEqual(true);
        });
      });

      describe('getStartArgs', () => {
        beforeEach(() => {
          jest.spyOn(which, 'sync').mockReturnValue('/usr/bin/java');
        });

        test('should throw an error if the jarfile not specified', () => {
          jest.spyOn(inst, 'sc').mockReturnValue({ java: {} } as ServerConfig);
          expect(() => inst.getStartArgs()).toThrowError('Cannot start instance without a designated jar/phar');
        });

        test('should throw an error if the jarfile is of an unknown type', () => {
          jest.spyOn(inst, 'sc').mockReturnValue({ java: { jarfile: 'bad.txt' } } as ServerConfig);
          expect(() => inst.getStartArgs()).toThrowError('unknown jar type bad.txt');
        });

        describe('jar server', () => {
          test('should throw an error if no java binary is set', () => {
            (which.sync as jest.Mock).mockReturnValue('');
            jest.spyOn(inst, 'sc').mockReturnValue({ java: { jarfile: 'server.jar' } } as ServerConfig);
            expect(() => inst.getStartArgs()).toThrowError('no java binary assigned for instance');
          });

          test('should throw an error if the Xmx heap max value is invalid', () => {
            jest
              .spyOn(inst, 'sc')
              .mockReturnValue({ java: { jarfile: 'server.jar', java_xmx: '0' } } as unknown as ServerConfig);
            expect(() => inst.getStartArgs()).toThrowError('Xmx heapsize must be a positive integer > 0');
          });

          test('should throw an error if the Xms heap min value is invalid', () => {
            jest.spyOn(inst, 'sc').mockReturnValue({
              java: { jarfile: 'server.jar', java_xmx: '10', java_xms: '-1' },
            } as unknown as ServerConfig);
            expect(() => inst.getStartArgs()).toThrowError(
              'Xms heapsize must be a positive integer where Xmx >= Xms >= 0'
            );
          });

          test('should throw an error if the Xms heap min value is larger than Xmx', () => {
            jest.spyOn(inst, 'sc').mockReturnValue({
              java: { jarfile: 'server.jar', java_xmx: '10', java_xms: '20' },
            } as unknown as ServerConfig);
            expect(() => inst.getStartArgs()).toThrowError(
              'Xms heapsize must be a positive integer where Xmx >= Xms >= 0'
            );
          });

          test('should add the forge install command for forge servers', () => {
            jest.spyOn(inst, 'sc').mockReturnValue({
              java: { jarfile: 'forge-installer.jar', java_xmx: '10', java_xms: '5' },
            } as unknown as ServerConfig);
            const args = inst.getStartArgs();
            expect(args).toEqual([
              '-dmS',
              'mc-server1',
              '/usr/bin/java',
              '-server',
              '-Xmx10M',
              '-Xms5M',
              '-jar',
              'forge-installer.jar',
              '--installServer',
            ]);
          });

          test('should not treat unconventional servers as forge servers', () => {
            jest.spyOn(inst, 'sc').mockReturnValue({
              java: { jarfile: 'forge-installer.jar', java_xmx: '10', java_xms: '5' },
              minecraft: { unconventional: true },
            } as unknown as ServerConfig);
            const args = inst.getStartArgs();
            expect(args).toEqual([
              '-dmS',
              'mc-server1',
              '/usr/bin/java',
              '-server',
              '-Xmx10M',
              '-Xms5M',
              '-jar',
              'forge-installer.jar',
            ]);
          });

          test('should return the complete set of of arguments for the java process', () => {
            jest.spyOn(inst, 'sc').mockReturnValue({
              java: {
                java_binary: '/opt/alternatives/java/openjdk-21/bin/java',
                jarfile: 'server.jar',
                java_xmx: '10',
                java_xms: '5',
                jar_args: '--arg1 --arg2',
                java_tweaks: '-tweak1 -tweak2',
              },
            } as unknown as ServerConfig);
            const args = inst.getStartArgs();
            expect(args).toEqual([
              '-dmS',
              'mc-server1',
              '/opt/alternatives/java/openjdk-21/bin/java',
              '-server',
              '-Xmx10M',
              '-Xms5M',
              '-tweak1',
              '-tweak2',
              '-jar',
              'server.jar',
              '--arg1',
              '--arg2',
            ]);
          });

          test('should use sensible defaults for optional arguments', () => {
            jest.spyOn(inst, 'sc').mockReturnValue({ java: { jarfile: 'server.jar' } } as unknown as ServerConfig);
            const args = inst.getStartArgs();
            expect(args).toEqual(['-dmS', 'mc-server1', '/usr/bin/java', '-server', '-Xmx256M', '-jar', 'server.jar']);
          });
        });

        describe('phar server', () => {
          test('should use PHP7 if it is available', () => {
            jest.spyOn(fsExtra, 'accessSync').mockImplementation(() => {});
            jest.spyOn(inst, 'sc').mockReturnValue({ java: { jarfile: 'server.phar' } } as unknown as ServerConfig);
            const args = inst.getStartArgs();
            expect(args).toEqual(['-dmS', 'mc-server1', './bin/php7/bin/php', 'server.phar']);
          });

          test('should use PHP5 if PHP7 is not available', () => {
            jest.spyOn(fsExtra, 'accessSync').mockImplementation(() => {
              throw new Error('error');
            });
            jest.spyOn(inst, 'sc').mockReturnValue({ java: { jarfile: 'server.phar' } } as unknown as ServerConfig);
            const args = inst.getStartArgs();
            expect(args).toEqual(['-dmS', 'mc-server1', './bin/php5/bin/php', 'server.phar']);
          });
        });

        describe('cuberite server', () => {
          test('should invoke the Cuberite binary directly', () => {
            jest.spyOn(inst, 'sc').mockReturnValue({ java: { jarfile: 'Cuberite' } } as unknown as ServerConfig);
            const args = inst.getStartArgs();
            expect(args).toEqual(['-dmS', 'mc-server1', './Cuberite']);
          });
        });
      });

      describe('getChildPid', () => {
        test('should return the java process number if one exists', () => {
          jest.spyOn(Instance, 'listRunningInstancePids').mockReturnValue({ server1: { java: 101 } });
          expect(inst.getChildPid('java')).toEqual(101);
        });

        test('should return undefined for the java process if it is not found', () => {
          jest.spyOn(Instance, 'listRunningInstancePids').mockReturnValue({ server1: {} });
          expect(inst.getChildPid('java')).toBeUndefined();
        });

        test('should return the screen process number if one exists', () => {
          jest.spyOn(Instance, 'listRunningInstancePids').mockReturnValue({ server1: { screen: 100 } });
          expect(inst.getChildPid('screen')).toEqual(100);
        });

        test('should return undefined for the screen process if it is not found', () => {
          jest.spyOn(Instance, 'listRunningInstancePids').mockReturnValue({ server1: {} });
          expect(inst.getChildPid('screen')).toBeUndefined();
        });
      });

      describe('getJavaProcessStats', () => {
        beforeEach(() => {
          jest.spyOn(Instance, 'listRunningInstancePids').mockReturnValue({ server1: { java: 101 } });
        });

        test('should reject if no processs are running for this instance', async () => {
          (Instance.listRunningInstancePids as jest.Mock).mockReturnValue({});
          await expect(() => inst.getJavaProcessStats()).rejects.toBeTruthy();
        });

        test('should reject if the java process for this instance is not running', async () => {
          (Instance.listRunningInstancePids as jest.Mock).mockReturnValue({ server1: { screen: 100 } });
          await expect(() => inst.getJavaProcessStats()).rejects.toBeTruthy();
        });

        test('should reject if procfs has an error', async () => {
          const mockProcfs = {
            status: jest.fn().mockImplementation((cb: any) => {
              cb(new Error('error'));
            }),
          };
          (procfs as unknown as jest.Mock).mockImplementation(() => mockProcfs);
          await expect(() => inst.getJavaProcessStats()).rejects.toBeTruthy();
        });

        test('should return the process stats for the java process', async () => {
          const mockProcfs = {
            status: jest.fn().mockImplementation((cb: any) => {
              cb(null, { data: 'value' });
            }),
          };
          (procfs as unknown as jest.Mock).mockImplementation(() => mockProcfs);
          const result = await inst.getJavaProcessStats();

          expect(result).toEqual({ data: 'value' });
        });
      });

      describe('getRunnableJarFiles', () => {
        beforeEach(() => {
          jest.spyOn(inst, 'sc').mockReturnValue({ minecraft: { profile: 'profile1' } } as ServerConfig);
        });

        test('should reject if reading any of the dirs has an error', async () => {
          jest.spyOn(fs.promises, 'readdir').mockReturnValue(Promise.reject('error'));
          await expect(() => inst.getRunnableJarFiles()).rejects.toBeTruthy();
        });

        test('should return the list of files in the instance directory combined with the list from the profile directory', async () => {
          jest
            .spyOn(fs.promises, 'readdir')
            .mockReturnValueOnce(Promise.resolve(['java.jar', 'php.phar', 'Cuberite'] as any));
          jest
            .spyOn(fs.promises, 'readdir')
            .mockReturnValueOnce(Promise.resolve(['java-profile.jar', 'php-profile.phar'] as any));

          const result = await inst.getRunnableJarFiles();
          expect(result).toEqual(['java.jar', 'php.phar', 'Cuberite', 'java-profile.jar', 'php-profile.phar']);
        });
      });

      describe('getAutosaveState', () => {
        let mockTail: EventEmitter & { unwatch?: () => void };
        beforeEach(() => {
          jest.spyOn(inst, 'stuff').mockReturnValue(Promise.resolve(''));
          mockTail = new EventEmitter();
          mockTail.unwatch = jest.fn();

          (Tail as jest.Mock).mockReturnValue(mockTail);
        });

        test('should resolve true if no log message is seen before the timeout to support legacy servers', async () => {
          const promise = inst.getAutosaveState();
          await new Promise(process.nextTick);

          jest.advanceTimersByTime(2000);
          await new Promise(process.nextTick);

          expect(await promise).toEqual(true);
          expect(mockTail.unwatch).toHaveBeenCalled();
        });

        test('should resolve true if auto-save is on', async () => {
          const promise = inst.getAutosaveState();
          await new Promise(process.nextTick);

          mockTail.emit('line', '[INFO]: Saving is already turned on');
          jest.advanceTimersByTime(1000);
          await new Promise(process.nextTick);

          expect(await promise).toEqual(true);
          expect(mockTail.unwatch).toHaveBeenCalled();
        });

        test('should resolve false if auto-save is off', async () => {
          const promise = inst.getAutosaveState();
          await new Promise(process.nextTick);

          mockTail.emit('line', '[INFO]: Turned on world auto-saving');
          jest.advanceTimersByTime(1000);
          await new Promise(process.nextTick);

          expect(await promise).toEqual(false);
          expect(mockTail.unwatch).toHaveBeenCalled();
          expect(inst.stuff).toHaveBeenCalledWith('save-off');
        });
      });

      describe('getEulaState', () => {
        test('should reject if there is an error reading the EULA file', async () => {
          jest.spyOn(fs.promises, 'readFile').mockReturnValue(Promise.reject('error'));
          await expect(() => inst.getEulaState()).rejects.toBeTruthy();
        });

        test('should resolve false if the eula has not been accepted', async () => {
          jest.spyOn(fs.promises, 'readFile').mockReturnValue(Promise.resolve(Buffer.from('eula\ntrue\n')));
          expect(await inst.getEulaState()).toEqual(false);
        });

        test('should resolve true if the eula has been accepted', async () => {
          jest.spyOn(fs.promises, 'readFile').mockReturnValue(Promise.resolve(Buffer.from('\neula=true\n')));
          expect(await inst.getEulaState()).toEqual(true);
        });
      });

      describe('isFTBServer', () => {
        test('should resolve false if stat has an error', async () => {
          jest.spyOn(fs.promises, 'stat').mockReturnValue(Promise.reject('error'));
          expect(await inst.isFTBServer()).toEqual(false);
        });

        test('should resolve true if stat data is returned for the FTB install script', async () => {
          jest.spyOn(fs.promises, 'stat').mockReturnValue(Promise.resolve({} as Stats));
          expect(await inst.isFTBServer()).toEqual(true);
        });
      });
    });
  });
});
