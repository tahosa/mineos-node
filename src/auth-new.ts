import crypt from 'apache-crypt';
import fs from 'fs-extra';
import hash from 'sha512crypt-node';
import nodePosix from 'posix';
import passwd from 'etc-passwd';
import userid from 'userid';

// @ts-expect-error: Typescript cannot resolve this node-gyp module for some reason
import authenticatePam from 'authenticate-pam';

/**
 * Attempt to authenticate against the system using PAM, /etc/shadow, or posix authentication
 *
 * @param user Username
 * @param plaintext Plaintext password
 * @returns True if authenticated, false if authentication runs but fails, Promise rejected on authentication process errors
 */
export const authenticate = async (user: string, plaintext: string): Promise<boolean> => {
  const shadow = async (): Promise<boolean> => {
    // Return true for auth success, false for auth failure, reject on error

    await fs.promises.stat('/etc/shadow');
    return await new Promise((resolve, reject) => {
      passwd.getShadow({ username: user }, (err, shadowInfo) => {
        if (err) {
          reject(err);
        }

        if (shadowInfo && shadowInfo.password === '!') {
          reject('invalid password in /etc/shadow');
        } else if (shadowInfo) {
          const pwParts = shadowInfo['password'].split(/\$/);
          const salt = pwParts[2];
          const pwHash = hash.sha512crypt(plaintext, salt);

          const passed = pwHash === shadowInfo['password'];
          resolve(passed);
        } else {
          reject('no information returned from /etc/shadow');
        }
      });
    });
  };

  const posix = async (): Promise<boolean> => {
    // Return true for auth success, false for auth failure, reject on error
    return await new Promise((resolve, reject) => {
      try {
        const userData = nodePosix.getpwnam(user);

        // Attempt to use crypt first
        if (crypt(plaintext, userData.passwd) === userData.passwd) {
          resolve(true);
        }

        // Crypt hash fails on FreeNAS so try sha512
        else if (userData) {
          const password_parts = userData.passwd.split(/\$/);
          const salt = password_parts[2];
          const new_hash = hash.sha512crypt(plaintext, salt);

          const passed = new_hash === userData.passwd;
          resolve(passed);
        } else {
          reject('no information from getpwnam');
        }
      } catch (e) {
        reject(e);
      }
    });
  };

  const pam = async (): Promise<boolean> => {
    // Return true for auth success, false for auth failure, reject on error
    return await new Promise((resolve, reject) => {
      authenticatePam.authenticate(user, plaintext, (err) => {
        if (err) {
          reject(err);
        }
        resolve(true);
      });
    });
  };

  // Try authenticating in this order: PAM, shadow, posix
  // If one fails (rejects the promise), it tries the next in the sequence
  return await pam()
    .catch(() => {
      return shadow();
    })
    .catch(() => {
      return posix();
    });
};

/**
 * Check if a user is a member of the given group
 *
 * @param username Username
 * @param group Group name
 * @returns True if the user is a member, false if the user is not a member
 */
export const testMembership = async (username: string, group: string): Promise<boolean> => {
  return await new Promise((resolve) => {
    let isMember = false;
    passwd
      .getGroups()
      .on('group', (groupData) => {
        if (group == groupData.groupname)
          try {
            if (groupData.users.indexOf(username) >= 0 || groupData.gid == userid.gids(username)[0]) isMember = true;
          } catch (e) {
            console.error(e);
          }
      })
      .on('end', () => {
        resolve(isMember);
      });
  });
};

/**
 * Check if a user ID and group ID exist on the system
 *
 * @param uid UID to check
 * @param gid GID to check
 * @returns [uidExists: boolean, gidExists: boolean] Tuple indicating if the UID, GID, or both exist
 */
export const existsOnSystem = async (uid, gid): Promise<boolean[]> => {
  return await Promise.all([
    new Promise<boolean>((resolve) => {
      passwd
        .getUsers()
        .on('user', (userData) => {
          if (userData.uid === uid) {
            resolve(true);
          }
        })
        .on('end', () => {
          resolve(false);
        });
    }),
    new Promise<boolean>((resolve) => {
      passwd
        .getGroups()
        .on('group', (group_data) => {
          if (group_data.gid === gid) {
            resolve(true);
          }
        })
        .on('end', () => {
          resolve(false);
        });
    }),
  ]);
};
