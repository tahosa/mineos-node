import { afterEach, describe, expect, jest, test } from '@jest/globals';
import child from 'child_process';
import fsExtra from 'fs-extra';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import ini from 'ini';
import { Rsync } from 'rsync2';
import which from 'which';

import { CronTask, type ServerConfig } from './constants';
import './lib/logger';
import { readIni } from './lib/util';

jest.mock('./lib/util', () => ({
  readIni: jest.fn(),
}));

const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  log: jest.fn(),
}

jest.mock('./lib/logger', () => ({
  Logger: {
    child: () => mockLogger
  }
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

      (jest.spyOn(fsExtra, 'readdirSync') as unknown as jest.MockedFunction<(path: string) => string[]>).mockReturnValue(
        Object.keys(mockProcesses)
      );
      (jest.spyOn(fsExtra, 'readFileSync') as unknown as jest.MockedFunction<(path: string) => Buffer>).mockImplementation(
        (path: string) => {
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
        }
      );

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
        expect(fsExtra.writeFileSync).toHaveBeenCalledWith('/path/servers/server1/server.properties', ini.stringify(newSp));

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
        expect(fsExtra.writeFileSync).toHaveBeenCalledWith('/path/servers/server1/server.properties', ini.stringify(newSp));

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
        jest.spyOn(fsExtra.promises, 'stat').mockImplementation(() => { return Promise.reject(); });
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
        const promise = inst.createFromArchive({ uid: 1000, gid: 1000 }, '/path/to/archive.yml')
        expect(async () => { await promise }).rejects.toBeTruthy();
      });

      test('should reject creation from archive if tar returns an error', async () => {
        const inst = new Instance('server1', '/path');
        const promise = inst.createFromArchive({ uid: 1000, gid: 1000 }, '/path/to/archive.tgz')

        await new Promise<void>((resolve) => { setTimeout(() => { mockChildEmitter.emit('exit', 1); resolve(); }, 1) });
        expect(async () => { await promise }).rejects.toBeTruthy();
      });

      test('should create an archive from a tar file at an absolute path', async () => {
        const inst = new Instance('server1', '/path');
        const promise = inst.createFromArchive({ uid: 1000, gid: 1000 }, '/path/to/archive.tar')
        await new Promise<void>((resolve) => { setTimeout(() => { mockChildEmitter.emit('exit'); resolve(); }, 1) });

        await promise;

        expect(fsExtra.ensureDirSync).toHaveBeenCalledTimes(3);
        expect(fsExtra.ensureFileSync).toHaveBeenCalledTimes(3);
        expect(fsExtra.chownSync).toHaveBeenCalledTimes(6);
        expect(fsExtra.writeFileSync).toHaveBeenCalledTimes(4);

        expect(child.spawn).toHaveBeenCalledWith('/usr/bin/tar', ['-xf', '/path/to/archive.tar'], { cwd: inst.env.cwd, uid: 1000, gid: 1000 });
      });

      test('should create an archive from a tar.gz file in the import directory', async () => {
        const inst = new Instance('server1', '/path');
        const promise = inst.createFromArchive({ uid: 1000, gid: 1000 }, 'archive.tar.gz')
        await new Promise<void>((resolve) => { setTimeout(() => { mockChildEmitter.emit('exit'); resolve(); }, 1) });

        await promise;

        expect(fsExtra.ensureDirSync).toHaveBeenCalledTimes(3);
        expect(fsExtra.ensureFileSync).toHaveBeenCalledTimes(3);
        expect(fsExtra.chownSync).toHaveBeenCalledTimes(6);
        expect(fsExtra.writeFileSync).toHaveBeenCalledTimes(4);

        expect(child.spawn).toHaveBeenCalledWith('/usr/bin/tar', ['-xf', `${inst.env.baseDir}/import/archive.tar.gz`], { cwd: inst.env.cwd, uid: 1000, gid: 1000 });
      });
    });

    describe('delete', () => {
      afterAll(() => {
        jest.restoreAllMocks();
      });

      beforeEach(() => {
        (jest.spyOn(fsExtra.promises, 'stat') as jest.Mock).mockImplementation(() => { return Promise.resolve({}); });
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
          (jest.spyOn(fsExtra.promises, 'stat') as jest.Mock).mockImplementation(() => { return Promise.resolve({}); });
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
            execute: jest.fn().mockReturnValue(Promise.resolve(0))
          };
          jest.spyOn(Rsync, 'build').mockReturnValue(mockRsync);
          const inst = new Instance('server1', '/path');

          jest.spyOn(inst, 'sc').mockReturnValue({minecraft: {profile: 'vanilla_1.20'}} as ServerConfig);
          jest.spyOn(inst, 'getOwner').mockResolvedValue({ username: 'user', groupname: 'group', uid: 1000, gid: 1000 })

          const result = await inst.copyProfile()
          expect(result).toEqual(0);
          expect(Rsync.build).toHaveBeenCalledWith({
            source: '/path/profiles/vanilla_1.20/',
            destination: '/path/servers/server1/',
            flags: 'au',
            shell: 'ssh',
          });

          expect(mockRsync.set).toHaveBeenCalledTimes(2);
          expect(mockRsync.set.mock.calls).toEqual([['chown', 'user:group'], ['chmod', 'ug=rwX']])
        });
      });

      describe('delta', () => {
        afterEach(() => {
          jest.resetAllMocks();
        });

        test('should reject with the error if rsync fails', async () => {
          const mockRsync = {
            execute: jest.fn().mockReturnValue(Promise.resolve(1))
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
              mockOutput('multiline.md\n\nnextline.toml')
              mockOutput('rsync trailer');

              return Promise.resolve(0);
            })
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
            output: [expect.anything()]
          })
        });
      });
    });

    describe('minecraft server instance interactions', () => {
      //const pingReponse = '\xff\x32\xa7\x31\x00127\x001.20\x00A Minecraft Server\x000\x0020';

      describe('ping', () => {

      });

      describe('query', () => {

      });

      describe('stuff', () => {

      });

      describe('start', () => {

      });

      describe('stop', () => {

      });

      describe('kill', () => {

      });
    });
  });
});
