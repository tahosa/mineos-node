import { afterEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'fs-extra';
import ini from 'ini';

import { CronTask } from './constants';
import { Instance } from './instance';
import { readIni } from './lib/util';

jest.mock('./lib/util', () => ({
  readIni: jest.fn(),
}));

describe('Instance', () => {
  describe('static', () => {
    afterEach(() => {
      jest.resetAllMocks();
    });

    afterAll(() => {
      jest.restoreAllMocks();
    });

    test('should read from server path', () => {
      jest.spyOn(fs, 'readdirSync').mockReturnValue([]);

      Instance.listInstances('/path');
      expect(fs.readdirSync).toHaveBeenCalledWith('/path/servers');
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

      (jest.spyOn(fs, 'readdirSync') as unknown as jest.MockedFunction<(path: string) => string[]>).mockReturnValue(
        Object.keys(mockProcesses)
      );
      (jest.spyOn(fs, 'readFileSync') as unknown as jest.MockedFunction<(path: string) => Buffer>).mockImplementation(
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
        jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
        (readIni as jest.Mock).mockImplementation(() => {
          return mockProps;
        });
      });

      afterAll(() => {
        jest.restoreAllMocks();
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

      test('should modify single property and invalidate the cache', () => {
        const inst = new Instance('server1', '/path');
        const newSp = { server: 'newValue' };

        const spInit = inst.modifySp('server', 'newValue');
        expect(spInit).toEqual(newSp);
        expect(readIni).toHaveBeenCalledTimes(1);
        expect(readIni).toHaveBeenCalledWith('/path/servers/server1/server.properties');
        expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
        expect(fs.writeFileSync).toHaveBeenCalledWith('/path/servers/server1/server.properties', ini.stringify(newSp));

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
        expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
        expect(fs.writeFileSync).toHaveBeenCalledWith('/path/servers/server1/server.properties', ini.stringify(newSp));

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
        jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
        (readIni as jest.Mock).mockImplementation(() => {
          return mockConfig;
        });
      });

      afterAll(() => {
        jest.restoreAllMocks;
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

      test('should modify single property and invalidate the cache', () => {
        const inst = new Instance('server1', '/path');
        const newSc = { java: { jarfile: 'newValue' } };

        const scInit = inst.modifySc('java', 'jarfile', 'newValue');
        expect(scInit).toEqual(newSc);
        expect(readIni).toHaveBeenCalledTimes(1);
        expect(readIni).toHaveBeenCalledWith('/path/servers/server1/server.config');
        expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
        expect(fs.writeFileSync).toHaveBeenCalledWith('/path/servers/server1/server.config', ini.stringify(newSc));

        const scCached = inst.sc();
        expect(scCached).toEqual(mockConfig);
        expect(readIni).toHaveBeenCalledTimes(2);
      });
    });

    describe('cron.config', () => {
      let mockCron;

      beforeAll(() => {
        jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
        (readIni as jest.Mock).mockImplementation(() => {
          return mockCron;
        });
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
        expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
        expect(fs.writeFileSync).toHaveBeenCalledWith(
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
        expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
        expect(fs.writeFileSync).toHaveBeenCalledWith('/path/servers/server1/cron.config', ini.stringify({}));

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
        expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
        expect(fs.writeFileSync).toHaveBeenCalledWith(
          '/path/servers/server1/cron.config',
          ini.stringify({ job1: { ...mockCron.job1, enabled: false } })
        );

        const ccCached = inst.crons();
        expect(ccCached).toEqual(mockCron);
        expect(readIni).toHaveBeenCalledTimes(2);
      });
    });
  });
});
