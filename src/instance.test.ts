import { afterEach, describe, expect, jest, test } from '@jest/globals';
import child from 'child_process';
import fsExtra from 'fs-extra';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import ini from 'ini';
import { Rsync } from 'rsync2';
import which from 'which';

import mcquery from 'mcquery';
jest.mock('mcquery');

import { Tail } from 'tail';
jest.mock('tail');

import { CronTask, type ServerConfig } from './constants';
import './lib/logger';

const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  log: jest.fn(),
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

import { Instance } from './instance';

describe('Instance', () => {
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
    test('constructor should set properties', () => {
      const inst = new Instance('server1', '/path');
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

      afterAll(() => {
        jest.restoreAllMocks();
      });

      beforeEach(() => {
        (readIni as jest.Mock).mockImplementation(() => {
          return mockProps;
        });
      });

      afterEach(() => {
        jest.clearAllMocks();
      });

      test('should read server properties and cache result', () => {
        const inst = new Instance('server1', '/path');

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
        const inst = new Instance('server1', '/path');

        const spInit = inst.sp();
        expect(spInit).toEqual({});
      });

      test('should modify single property and invalidate the cache', () => {
        const inst = new Instance('server1', '/path');
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
        const inst = new Instance('server1', '/path');
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

      afterAll(() => {
        jest.restoreAllMocks;
      });

      beforeEach(() => {
        (readIni as jest.Mock).mockImplementation(() => {
          return mockConfig;
        });
      });

      afterEach(() => {
        jest.clearAllMocks();
      });

      test('should read server config and cache result', () => {
        const inst = new Instance('server1', '/path');

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
        const inst = new Instance('server1', '/path');

        const scInit = inst.sc();
        expect(scInit).toEqual({});
      });

      test('should modify single property and invalidate the cache', () => {
        const inst = new Instance('server1', '/path');
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

      afterAll(() => {
        jest.restoreAllMocks;
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

      afterEach(() => {
        jest.clearAllMocks();
      });

      test('should read cron config and cache result', () => {
        const inst = new Instance('server1', '/path');

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
        const inst = new Instance('server1', '/path');

        const ccInit = inst.crons();
        expect(ccInit).toEqual({});
      });

      test('should add a new cron task and invalidate the cache', () => {
        const inst = new Instance('server1', '/path');
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
        const inst = new Instance('server1', '/path');

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
        const inst = new Instance('server1', '/path');

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
        const inst = new Instance('server1', '/path');

        const ccInit = inst.setCron('fake', false);
        expect(ccInit).toEqual(mockCron);
        expect(readIni).toHaveBeenCalledTimes(1);
        expect(readIni).toHaveBeenCalledWith('/path/servers/server1/cron.config');
        expect(fsExtra.writeFileSync).not.toHaveBeenCalled();
      });

      test('should set the enabled property of the cron task and invalidate the cache', () => {
        const inst = new Instance('server1', '/path');

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
      let mockChildEmitter;

      beforeAll(() => {
        mockChildEmitter = new EventEmitter();
        jest.spyOn(mockChildEmitter, 'once');

        jest.spyOn(which, 'sync').mockReturnValue('/usr/bin/tar');
        jest.spyOn(fsExtra, 'ensureDirSync').mockImplementation(() => {});
        jest.spyOn(fsExtra, 'ensureFileSync').mockImplementation(() => {});
        jest.spyOn(fsExtra, 'chownSync').mockImplementation(() => {});
        jest.spyOn(fsExtra, 'writeFileSync').mockImplementation(() => {});
        jest.spyOn(fs, 'readFileSync').mockReturnValue(Buffer.from(''));
        (jest.spyOn(child, 'spawn') as jest.Mock).mockImplementation(() => {
          return mockChildEmitter;
        });
      });

      afterAll(() => {
        jest.restoreAllMocks();
      });

      beforeEach(() => {
        jest.spyOn(fsExtra.promises, 'stat').mockImplementation(() => {
          return Promise.reject();
        });
        jest.spyOn(Instance, 'listRunningInstancePids').mockReturnValue({});
        (jest.spyOn(fsExtra.promises, 'readdir') as jest.Mock).mockReturnValue(Promise.resolve(['/path/archive']));
      });

      afterEach(() => {
        jest.clearAllMocks();
        (fsExtra.promises.stat as jest.Mock).mockReset();
        (Instance.listRunningInstancePids as jest.Mock).mockReset();
      });

      test('should not create a server which already exists', async () => {
        (fsExtra.promises.stat as jest.Mock).mockReturnValue(Promise.resolve({}));

        const inst = new Instance('server1', '/path');
        expect(async () => inst.create({ uid: 1000, gid: 1000 })).rejects.toBeTruthy();
      });

      // This is an edge case if the files are manually deleted but the instance is not stopped first
      test('should not create a server which matches a running instance name', async () => {
        jest.spyOn(Instance, 'listRunningInstancePids').mockReturnValue({ server1: { java: 1000 } });
        const inst = new Instance('server1', '/path');
        expect(async () => inst.create({ uid: 1000, gid: 1000 })).rejects.toBeTruthy();
      });

      test('should create a regular minecraft server', async () => {
        const inst = new Instance('server1', '/path');
        await inst.create({ uid: 1000, gid: 1000 });

        expect(fsExtra.ensureDirSync).toHaveBeenCalledTimes(3);
        expect(fsExtra.ensureFileSync).toHaveBeenCalledTimes(3);
        expect(fsExtra.chownSync).toHaveBeenCalledTimes(6);
        expect(fsExtra.writeFileSync).toHaveBeenCalledTimes(4);
      });

      test('should create an unconventional minecraft server,', async () => {
        const inst = new Instance('server1', '/path');
        await inst.create({ uid: 1000, gid: 1000 }, true);

        expect(fsExtra.ensureDirSync).toHaveBeenCalledTimes(3);
        expect(fsExtra.ensureFileSync).toHaveBeenCalledTimes(3);
        expect(fsExtra.chownSync).toHaveBeenCalledTimes(6);
        expect(fsExtra.writeFileSync).toHaveBeenCalledTimes(1);
      });

      test('should reject creation from archive if file extension is not supported', async () => {
        const inst = new Instance('server1', '/path');
        const promise = inst.createFromArchive({ uid: 1000, gid: 1000 }, '/path/to/archive.yml');
        expect(async () => {
          await promise;
        }).rejects.toBeTruthy();
      });

      test('should reject creation from archive if tar returns an error', async () => {
        const inst = new Instance('server1', '/path');
        const promise = inst.createFromArchive({ uid: 1000, gid: 1000 }, '/path/to/archive.tgz');

        await new Promise<void>((resolve) => {
          setTimeout(() => {
            mockChildEmitter.emit('exit', 1);
            resolve();
          }, 1);
        });
        expect(async () => {
          await promise;
        }).rejects.toBeTruthy();
      });

      test('should create an archive from a tar file at an absolute path', async () => {
        const inst = new Instance('server1', '/path');
        const promise = inst.createFromArchive({ uid: 1000, gid: 1000 }, '/path/to/archive.tar');
        await new Promise<void>((resolve) => {
          setTimeout(() => {
            mockChildEmitter.emit('exit');
            resolve();
          }, 1);
        });

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
        const inst = new Instance('server1', '/path');
        const promise = inst.createFromArchive({ uid: 1000, gid: 1000 }, 'archive.tar.gz');
        await new Promise<void>((resolve) => {
          setTimeout(() => {
            mockChildEmitter.emit('exit');
            resolve();
          }, 1);
        });

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
      afterAll(() => {
        jest.restoreAllMocks();
      });

      beforeEach(() => {
        (jest.spyOn(fsExtra.promises, 'stat') as jest.Mock).mockImplementation(() => {
          return Promise.resolve({});
        });
        jest.spyOn(Instance, 'listRunningInstancePids').mockReturnValue({});
      });

      afterEach(() => {
        jest.clearAllMocks();
        (fsExtra.promises.stat as jest.Mock).mockReset();
        (Instance.listRunningInstancePids as jest.Mock).mockReset();
      });

      test('should not delete a server which does not exist', async () => {
        (fsExtra.promises.stat as jest.Mock).mockReturnValue(Promise.reject());
        const inst = new Instance('server1', '/path');
        expect(async () => inst.delete()).rejects.toBeTruthy();
      });

      test('should not delete a server which matches a running instance name', async () => {
        jest.spyOn(Instance, 'listRunningInstancePids').mockReturnValue({ server1: { java: 1000 } });
        const inst = new Instance('server1', '/path');
        expect(async () => inst.delete()).rejects.toBeTruthy();
      });

      test('should force remove all directories', async () => {
        jest.spyOn(fs.promises, 'rm').mockImplementation(async () => {});

        const inst = new Instance('server1', '/path');
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
      afterAll(() => {
        jest.restoreAllMocks();
      });

      describe('copyProfile', () => {
        beforeEach(() => {
          (jest.spyOn(fsExtra.promises, 'stat') as jest.Mock).mockImplementation(() => {
            return Promise.resolve({});
          });
          jest.spyOn(Instance, 'listRunningInstancePids').mockReturnValue({});
        });

        afterEach(() => {
          jest.clearAllMocks();
          (fsExtra.promises.stat as jest.Mock).mockReset();
          (Instance.listRunningInstancePids as jest.Mock).mockReset();
        });

        test('should reject if the instance does not exist', async () => {
          (fsExtra.promises.stat as jest.Mock).mockReturnValue(Promise.reject());

          const inst = new Instance('server1', '/path');
          await expect(async () => inst.copyProfile()).rejects.toBeTruthy();
        });

        test('should reject if the instance is running', async () => {
          jest.spyOn(Instance, 'listRunningInstancePids').mockReturnValue({ server1: { screen: 123 } });

          const inst = new Instance('server1', '/path');
          await expect(async () => inst.copyProfile()).rejects.toBeTruthy();
        });

        test('should reject if a profile is not set', async () => {
          const inst = new Instance('server1', '/path');
          jest.spyOn(inst, 'sc').mockReturnValue({} as ServerConfig);
          await expect(async () => inst.copyProfile()).rejects.toBeTruthy();
        });

        test('should use rsync to copy the profile files', async () => {
          const mockRsync = {
            set: jest.fn(),
            execute: jest.fn().mockReturnValue(Promise.resolve(0)),
          };
          jest.spyOn(Rsync, 'build').mockReturnValue(mockRsync);
          const inst = new Instance('server1', '/path');

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

          const inst = new Instance('server1', '/path');
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

          const inst = new Instance('server1', '/path');
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
      let inst: Instance;
      let mockSocket;

      afterAll(() => {
        jest.restoreAllMocks();
      });

      beforeEach(() => {
        jest.spyOn(which, 'sync').mockReturnValue('/usr/bin/screen');
        jest.spyOn(child, 'execFileSync').mockReturnValue(Buffer.from('result'));
        (jest.spyOn(fsExtra.promises, 'stat') as jest.Mock).mockImplementation(() => {
          return Promise.resolve({});
        });
        jest.spyOn(Instance, 'listRunningInstancePids').mockReturnValue({ server1: { java: 1000 } });
        inst = new Instance('server1', '/path');
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
          await expect(async () => inst.ping()).rejects.toBeTruthy();
        });

        test('should reject if the instance is a phar server', async () => {
          (inst.sc as jest.Mock).mockReturnValue({ java: { jarfile: 'server.phar' } });
          await expect(async () => inst.ping()).rejects.toBeTruthy();
        });

        test('should reject if the instance is not running', async () => {
          (Instance.listRunningInstancePids as jest.Mock).mockReturnValue({});
          await expect(async () => inst.ping()).rejects.toBeTruthy();
        });

        test('should reject if there is an error on the socket', async () => {
          const promise = inst.ping().catch((err) => {
            expect(err).toEqual('error');
          });

          mockSocket.emit('error', 'error');
          await promise;
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
          await expect(async () => inst.query()).rejects.toBeTruthy();
        });

        test('should reject if the instance is a phar server', async () => {
          (inst.sc as jest.Mock).mockReturnValue({ java: { jarfile: 'server.phar' } });
          await expect(async () => inst.query()).rejects.toBeTruthy();
        });

        test('should reject if there is an error querying the server', async () => {
          const mockMcqueryInstance = {
            full_stat: jest.fn().mockImplementation((cb: any) => {
              cb(new Error('error'));
            }),
            connect: () => Promise.resolve(),
          };
          mcquery.mockReturnValue(mockMcqueryInstance);
          await expect(async () => inst.query()).rejects.toBeTruthy();
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
          (jest.spyOn(fsExtra.promises, 'stat') as jest.Mock).mockImplementation(() => {
            return Promise.reject();
          });
          await expect(async () => inst.stuff('command')).rejects.toBeTruthy();
        });

        test('should reject if the instance is not running', async () => {
          (Instance.listRunningInstancePids as jest.Mock).mockReturnValue({});
          await expect(async () => inst.stuff('command')).rejects.toBeTruthy();
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
        let mockChild;

        beforeAll(() => {
          jest.useFakeTimers({ doNotFake: ['nextTick'] });
        });

        afterAll(() => {
          jest.useRealTimers();
        });

        beforeEach(() => {
          jest.spyOn(Instance, 'listRunningInstancePids').mockReturnValue({});
          mockChild = new EventEmitter();
          jest.spyOn(mockChild, 'once');
          (jest.spyOn(child, 'spawn') as jest.Mock).mockReturnValue(mockChild);
        });

        test('should reject if the instance does not exist', async () => {
          (jest.spyOn(fsExtra.promises, 'stat') as jest.Mock).mockImplementation(() => {
            return Promise.reject();
          });
          await expect(async () => inst.start()).rejects.toBeTruthy();
        });

        test('should reject if the instance is already running', async () => {
          jest.spyOn(Instance, 'listRunningInstancePids').mockReturnValue({ server1: { java: 1000 } });
          await expect(async () => inst.start()).rejects.toBeTruthy();
        });

        test('should reject if copying the profile results in an error', async () => {
          (inst.profileDelta as jest.Mock).mockReturnValue(Promise.reject(1));
          await expect(async () => inst.start()).rejects.toBeTruthy();
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
        beforeAll(() => {
          jest.useFakeTimers({ doNotFake: ['nextTick'] });
        });

        afterAll(() => {
          jest.useRealTimers();
        });

        beforeEach(() => {
          jest.spyOn(Instance, 'listRunningInstancePids').mockReturnValue({ server1: { java: 1000 } });
          jest.spyOn(inst, 'stuff').mockImplementation((command) => Promise.resolve(command));
        });

        test('should reject if the instance does not exist', async () => {
          (jest.spyOn(fsExtra.promises, 'stat') as jest.Mock).mockImplementation(() => {
            return Promise.reject();
          });
          await expect(async () => inst.stop()).rejects.toBeTruthy();
        });

        test('should resolve if the instance is not running', async () => {
          jest.spyOn(Instance, 'listRunningInstancePids').mockReturnValue({});
          await inst.stop();
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

          const promise = inst.stop();
          await new Promise(process.nextTick);
          jest.advanceTimersByTime(200);
          await new Promise(process.nextTick);

          await promise;
        });

        test('should reject if the instance does not stop within the iteration counter', async () => {
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
        beforeAll(() => {
          jest.useFakeTimers({ doNotFake: ['nextTick'] });
        });

        afterAll(() => {
          jest.useRealTimers();
        });

        beforeEach(() => {
          jest.spyOn(Instance, 'listRunningInstancePids').mockReturnValue({ server1: { java: 1000 } });
          jest.spyOn(process, 'kill').mockImplementation(() => true);
        });

        test('should reject if the instance does not exist', async () => {
          (jest.spyOn(fsExtra.promises, 'stat') as jest.Mock).mockImplementation(() => {
            return Promise.reject();
          });
          await expect(async () => inst.kill()).rejects.toBeTruthy();
        });

        test('should reject if there is no running java process', async () => {
          jest.spyOn(Instance, 'listRunningInstancePids').mockReturnValue({ server1: { screen: 1001 } });
          await expect(async () => inst.kill()).rejects.toBeTruthy();
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
          await expect(async () => inst.restart()).rejects.toBeTruthy();
        });

        it('should reject if the instance fails to start', async () => {
          jest.spyOn(inst, 'start').mockReturnValue(Promise.reject(new Error('error')));
          await expect(async () => inst.restart()).rejects.toBeTruthy();
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
          await expect(async () => inst.stopAndBackup()).rejects.toBeTruthy();
        });

        it('should reject if the instance fails to run the backup', async () => {
          jest.spyOn(inst, 'backup').mockReturnValue(Promise.reject(new Error('error')));
          await expect(async () => inst.stopAndBackup()).rejects.toBeTruthy();
        });

        it('should resolve if the instance succesfully restarts', async () => {
          await inst.stopAndBackup();
          expect(inst.stop).toHaveBeenCalledTimes(1);
          expect(inst.backup).toHaveBeenCalledTimes(1);
        });
      });

      describe('saveall', () => {
        beforeAll(() => {
          jest.useFakeTimers({ doNotFake: ['nextTick'] });
        });

        afterAll(() => {
          jest.useRealTimers();
        });

        beforeEach(() => {
          jest.spyOn(inst, 'stuff').mockReturnValue(Promise.resolve(''));
        });

        test('should reject if the instance does not exist', async () => {
          (jest.spyOn(fsExtra.promises, 'stat') as jest.Mock).mockImplementation(() => {
            return Promise.reject();
          });
          await expect(async () => inst.saveall()).rejects.toBeTruthy();
        });

        test('should reject if the instance is not running', async () => {
          (Instance.listRunningInstancePids as jest.Mock).mockReturnValue({});
          await expect(async () => inst.saveall()).rejects.toBeTruthy();
        });

        test('should reject if stuff fails to send the command', async () => {
          jest.spyOn(inst, 'stuff').mockReturnValue(Promise.reject(new Error('error')));
          await expect(async () => inst.saveall()).rejects.toBeTruthy();
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
        let mockTail;
        beforeAll(() => {
          jest.useFakeTimers({ doNotFake: ['nextTick'] });
        });

        afterAll(() => {
          jest.useRealTimers();
        });

        beforeEach(() => {
          jest.spyOn(inst, 'stuff').mockReturnValue(Promise.resolve(''));
          mockTail = new EventEmitter();
          (mockTail as any).unwatch = jest.fn();

          Tail.mockReturnValue(mockTail);
        });

        test('should reject if the instance does not exist', async () => {
          (jest.spyOn(fsExtra.promises, 'stat') as jest.Mock).mockImplementation(() => {
            return Promise.reject();
          });
          await expect(async () => inst.saveallLatestLog()).rejects.toBeTruthy();
        });

        test('should reject if the instance is not running', async () => {
          (Instance.listRunningInstancePids as jest.Mock).mockReturnValue({});
          await expect(async () => inst.saveallLatestLog()).rejects.toBeTruthy();
        });

        test('should reject if the tail cannot be started', async () => {
          Tail.mockImplementation(() => {
            throw new Error('error');
          });
          await expect(async () => inst.saveallLatestLog()).rejects.toBeTruthy();
        });

        test('should reject if the save message is not seen before the timeout', async () => {
          const promise = inst.saveallLatestLog();

          await new Promise(process.nextTick);
          jest.advanceTimersByTime(10000);
          await new Promise(process.nextTick);

          await expect(async () => promise).rejects.toBeTruthy();
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
      let inst: Instance;
      let mockChildEmitter: EventEmitter;

      beforeAll(() => {
        jest.spyOn(which, 'sync').mockImplementation((cmd) => `/usr/bin/${cmd}`);
      });

      afterAll(() => {
        jest.restoreAllMocks();
      });

      beforeEach(() => {
        inst = new Instance('server1', '/path');
        jest
          .spyOn(inst, 'getOwner')
          .mockReturnValue(Promise.resolve({ uid: 1000, gid: 1000, username: 'user', groupname: 'group' }));
        jest.spyOn(inst, 'stuff').mockImplementation((command) => Promise.resolve(command));
        jest.spyOn(inst, 'saveallLatestLog').mockReturnValue(Promise.resolve());
        jest.spyOn(inst, 'getAutosaveState').mockReturnValue(Promise.resolve(false));

        mockChildEmitter = new EventEmitter();
        jest.spyOn(mockChildEmitter, 'once');
        (jest.spyOn(child, 'spawn') as jest.Mock).mockImplementation(() => {
          return mockChildEmitter;
        });
      });

      afterEach(() => {
        jest.clearAllMocks();
      });

      describe('archive', () => {
        test('should reject if the tar process fails', async () => {
          const promise = inst.archive();
          await new Promise(process.nextTick);

          mockChildEmitter.emit('exit', 1);
          await new Promise(process.nextTick);

          await expect(async () => promise).rejects.toBeTruthy();
        });

        test('should attempt to force a save', async () => {
          const promise = inst.archive(true);
          await new Promise(process.nextTick);

          mockChildEmitter.emit('exit', 0);
          await new Promise(process.nextTick);

          await promise;
          expect(inst.stuff).toHaveBeenCalledTimes(1);
          expect(inst.stuff).toHaveBeenCalledWith('save-off');
          expect(inst.saveallLatestLog).toHaveBeenCalled();
          expect(child.spawn).toHaveBeenLastCalledWith(
            '/usr/bin/tar',
            [
              'czf',
              expect.stringMatching(/^\/path\/archive\/server1\/server-server1_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}.tgz$/),
              '.',
            ],
            { cwd: '/path/servers/server1', uid: 1000, gid: 1000 }
          );
        });

        test('should not fail if the forced save fails', async () => {
          (inst.saveallLatestLog as jest.Mock).mockReturnValue(Promise.reject('error'));
          const promise = inst.archive(true);
          await new Promise(process.nextTick);

          mockChildEmitter.emit('exit', 0);
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

          mockChildEmitter.emit('exit', 0);
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

          mockChildEmitter.emit('exit', 1);
          await new Promise(process.nextTick);

          await expect(() => promise).rejects.toBeTruthy();
        });

        test('should resolve if the backup runs successfully', async () => {
          const promise = inst.backup();
          await new Promise(process.nextTick);

          mockChildEmitter.emit('exit', 0);
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

          mockChildEmitter.emit('exit', 1);
          await new Promise(process.nextTick);

          await expect(() => promise).rejects.toBeTruthy();
        });

        test('should resolve if the restore runs successfully', async () => {
          const promise = inst.restore(10);
          await new Promise(process.nextTick);

          mockChildEmitter.emit('exit', 0);
          await new Promise(process.nextTick);

          await promise;
          expect(child.spawn).toHaveBeenCalledWith(
            '/usr/bin/rdiff-backup',
            ['--restore-as-of', '10', '--force', '/path/backup/server1', '/path/servers/server1'],
            { cwd: '/path/backup/server1' }
          );
        });
      });

      describe('previousVersions', () => {});

      describe('listIncrements', () => {});

      describe('listIncrementSizes', () => {});

      describe('listArchives', () => {});

      describe('prune', () => {});

      describe('deleteArchive', () => {});
    });
  });
});
