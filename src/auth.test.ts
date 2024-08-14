// These imports must be in this order because of the hoisting logic used to mock modules.
// For some reason to use EventEmitter in a mock this order is necessary.
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import crypt from 'apache-crypt';
import fs from 'node:fs'
import nodePosix from 'posix';
import hash from 'sha512crypt-node';
import userid from 'userid';

// @ts-expect-error: Typescript cannot resolve this node-gyp module for some reason
import authenticatePam from 'authenticate-pam';

jest.mock('etc-passwd', () => {
  const userEmitter = new EventEmitter();
  jest.spyOn(userEmitter, 'on');

  const groupEmitter = new EventEmitter();
  jest.spyOn(groupEmitter, 'on');

  return {
    getUsers: () => userEmitter,
    getGroups: () => groupEmitter,
    getShadow: jest.fn(),
  };
});

import passwd from 'etc-passwd';

import './lib/logger';

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

import { authenticate, existsOnSystem, testMembership } from './auth-new';

describe('auth', () => {
  describe('authenticate', () => {
      const expectedUser = 'minecraft';
      const expectedPassword = 'password';

      const salt = 'salt'
      const sha512crypt = hash.sha512crypt(expectedPassword, salt);
      const apacheCrypt = crypt(expectedPassword);

      let mockPam;
      let mockShadow;
      let mockPosix;

      beforeAll(() => {
        jest.spyOn(fs.promises, 'stat').mockReturnValue(Promise.resolve({} as fs.Stats));
        mockPam = jest.spyOn(authenticatePam, 'authenticate');
        mockShadow = jest.spyOn(passwd, 'getShadow');
        mockPosix = jest.spyOn(nodePosix, 'getpwnam')
      });

      afterAll(() => {
        jest.resetAllMocks();
      });

      beforeEach(() => {
        // Default pam and shadow to throw errors to guarantee fallbacks
        // These are overridden as needed in each test
        mockPam.mockImplementation(() => {
          throw new Error('pam error');
        })
        mockShadow.mockImplementation(() => {
          throw new Error('shadow error');
        });
      });

      afterEach(() => {
        jest.resetAllMocks();
      });

      test('pam - should return true if the PAM is able to authenticate', async () => {
        mockPam.mockImplementation((user, plaintext, cb) => {
          // Logical not - Matches: error == false, No match: error == true
          cb(plaintext !== expectedPassword)
        });

        const result = await authenticate(expectedUser, expectedPassword);
        expect(result).toEqual(expectedUser);
      });

      test('pam/shadow - should fall back to shadow if PAM authentication fails', async () => {
        mockPam.mockImplementation((user, plaintext, cb) => {
          cb('error')
        });

        mockShadow.mockImplementation((data, cb) => {
          cb(null, {password: sha512crypt})
        });

        const result = await authenticate(expectedUser, expectedPassword)
        expect(result).toEqual(expectedUser);
      });

      test('shadow - should return true if the hashed and salted password matches', async () => {
        mockShadow.mockImplementation((data, cb) => {
          cb(null, {password: sha512crypt})
        });

        const result = await authenticate(expectedUser, expectedPassword)
        expect(result).toEqual(expectedUser);
      });

      test('shadow/posix(crypt) - should fall back to posix if shadow has an error', async () => {
        mockShadow.mockImplementation((data, cb) => {
          cb('error')
        });
        mockPosix.mockReturnValue({passwd: apacheCrypt});

        const result = await authenticate(expectedUser, expectedPassword)
        expect(result).toEqual(expectedUser);
      });

      test('shadow/posix(crypt) - should fall back to posix if the password is "!"', async () => {
        mockShadow.mockImplementation((data, cb) => {
          cb(null, { password: '!' })
        });
        mockPosix.mockReturnValue({passwd: apacheCrypt});

        const result = await authenticate(expectedUser, expectedPassword)
        expect(result).toEqual(expectedUser);
      });

      test('shadow/posix(crypt) - should fall back to posix if shadow returns no data', async () => {
        mockShadow.mockImplementation((data, cb) => {
          cb(null, null)
        });
        mockPosix.mockReturnValue({passwd: apacheCrypt});

        const result = await authenticate(expectedUser, expectedPassword)
        expect(result).toEqual(expectedUser);
      });

      test('shadow/posix(sha512crypt) - should fall back to posix if the password does not match', async () => {
        mockShadow.mockImplementation((data, cb) => {
          cb(null, { password: `$6$${salt}$doesnotmatch` })
        });
        mockPosix.mockReturnValue({passwd: sha512crypt});

        const result = await authenticate(expectedUser, expectedPassword)
        expect(result).toEqual(expectedUser);
      });

      test('posix - should reject the promise if there is an error retrieving posix data', async () => {
        const err = new Error('posix error')
        mockPosix.mockImplementation(() => { throw err });

        await expect(async () => { await authenticate(expectedUser, 'all_failed'); }).rejects.toEqual(err)
      });

      test('posix - should reject the promise if no posix auth data is returned for the user', async () => {
        mockPosix.mockReturnValue(null);

        await expect(async () => { await authenticate(expectedUser, 'all_failed'); }).rejects.toBeTruthy()
      });

      test('posix - should reject the promise if the password does not match', async () => {
        mockPosix.mockReturnValue({ passwd: `$6$${salt}$doesnotmatch` });

        await expect(async () => { await authenticate(expectedUser, 'all_failed'); }).rejects.toBeTruthy()
      });

      test('posix - should reject the promise if the password is not returned by getpwnam', async () => {
        mockPosix.mockReturnValue({ passwd: 'x' });

        await expect(async () => { await authenticate(expectedUser, 'all_failed'); }).rejects.toBeTruthy()
      });

      test('posix - should reject the promise if there is an error', async () => {
        const err = new Error('sha512crypt error')
        mockPosix.mockReturnValue({ passwd: sha512crypt });
        jest.spyOn(hash, 'sha512crypt').mockImplementation(() => { throw err })

        await expect(async () => { await authenticate(expectedUser, 'all_failed'); }).rejects.toEqual(err)
      });
    });

  describe('testMembership', () => {
    const expectedGroupname = 'minecraft';
    const expectedUsername = 'getgroups'
    const expectedGid = 1001;
    let mockGetGroups;

    beforeAll(() => {
      mockGetGroups = passwd.getGroups();

      mockGetGroups.on.mockImplementation((event: string, cb: (data?: { users: string[], gid: number, groupname: string }) => any) => {
        if (event === 'group') {
          cb({ users: [expectedUsername], gid: expectedGid, groupname: expectedGroupname });
        }
        if (event === 'end') {
          cb();
        }
        return mockGetGroups;
      });
    });

    afterAll(() => {
      jest.resetAllMocks();
    });

    afterEach(() => {
      jest.clearAllMocks();
    });

    test('should return true if the user group matches the return from getGroups', async () => {
      const promise = testMembership(expectedUsername, expectedGroupname);
      mockGetGroups.emit('group');

      const result = await promise;
      expect(result).toBe(true);
    });

    test('should return true if the user group matches the return from userid', async () => {
      jest.spyOn(userid, 'gids').mockReturnValue([expectedGid]);
      const promise = testMembership('userid', expectedGroupname);
      mockGetGroups.emit('group');

      const result = await promise;
      expect(result).toBe(true);
    });

    test('should return false if the user is not a member of the group', async () => {
      const promise = testMembership(expectedUsername, 'anothergroup');
      mockGetGroups.emit('end');

      const result = await promise;
      expect(result).toBe(false);
    });

    test('should handle errors from userid', async () => {
      jest.spyOn(userid, 'gids').mockImplementation(() => {
        throw new Error('userid error')
      });
      const promise = testMembership('userid', expectedGroupname);
      mockGetGroups.emit('group');
      mockGetGroups.emit('end');

      const result = await promise;
      expect(result).toBe(false);
      expect(mockLogger.error).toHaveBeenCalledTimes(1);
    });
  });

  describe('existsOnSystem', () => {
    const expectedId = 1001;
    let mockGetUsers;
    let mockGetGroups;

    beforeAll(() => {
      mockGetUsers = passwd.getUsers();
      mockGetGroups = passwd.getGroups();

      mockGetUsers.on.mockImplementation((event: string, cb: (data?: { uid: number }) => any) => {
        if (event === 'user') {
          cb({ uid: expectedId });
        }
        if (event === 'end') {
          cb();
        };
        return mockGetUsers;
      });

      mockGetGroups.on.mockImplementation((event: string, cb: (data?: { gid: number }) => any) => {
        if (event === 'group') {
          cb({ gid: expectedId });
        }
        if (event === 'end') {
          cb();
        };
        return mockGetGroups;
      });
    });

    afterAll(() => {
      jest.resetAllMocks();
    });

    afterEach(() => {
      jest.clearAllMocks();
    });

    test('should return [false, false] if neither matches an existing entry', async () => {
      const promise = existsOnSystem(1, 1);
      mockGetUsers.emit('user');
      mockGetGroups.emit('group');

      const result = await promise;
      expect(result).toEqual([false, false]);
    });

    test('should return [false, false] if the listing of users and groups ends before a match is found', async () => {
      const promise = existsOnSystem(1, 1);
      mockGetUsers.emit('end');
      mockGetGroups.emit('end');

      const result = await promise;
      expect(result).toEqual([false, false]);
    });

    test('should return [true, false] if the user exists but not group', async () => {
      const promise = existsOnSystem(expectedId, 1);
      mockGetUsers.emit('user');
      mockGetUsers.emit('end');
      mockGetGroups.emit('group');
      mockGetGroups.emit('end');

      const result = await promise;
      expect(result).toEqual([true, false]);
    });

    test('should return [false, true] if the user does not exist but the group does', async () => {
      const promise = existsOnSystem(1, expectedId);
      mockGetUsers.emit('user');
      mockGetUsers.emit('end');
      mockGetGroups.emit('group');
      mockGetGroups.emit('end');

      const result = await promise;
      expect(result).toEqual([false, true]);
    });

    test('should return [true, true] if both exist', async () => {
      const promise = existsOnSystem(expectedId, expectedId);
      mockGetUsers.emit('user');
      mockGetUsers.emit('end');
      mockGetGroups.emit('group');
      mockGetGroups.emit('end');

      const result = await promise;
      expect(result).toEqual([true, true]);
    });
  });
});
