import async from 'async';
import crypt from 'apache-crypt';
import fs from 'fs-extra';
import hash from 'sha512crypt-node';
import nodePosix from 'posix';
import passwd from 'etc-passwd';
import userid from 'userid';

// authenticate-pam is an ESM module, so we need this workaround to import it
// @ts-ignore
const authenticatePam = require('authenticate-pam'); // eslint-disable-line @typescript-eslint/no-var-requires

const auth = {
  authenticate_shadow: (user, plaintext, callback) => {
    const etc_shadow = (inner_callback) => {
      // return true if error, false if auth failed, string for user if successful

      fs.stat('/etc/shadow', (err) => {
        if (err) inner_callback(true);
        else {
          passwd.getShadow({ username: user }, (err, shadow_info) => {
            if (shadow_info && shadow_info.password == '!')
              inner_callback(false);
            else if (shadow_info) {
              const password_parts = shadow_info['password'].split(/\$/);
              const salt = password_parts[2];
              const new_hash = hash.sha512crypt(plaintext, salt);

              const passed = new_hash == shadow_info['password'] ? user : false;
              inner_callback(passed);
            } else {
              inner_callback(true);
            }
          });
        }
      });
    };

    const posix = (inner_callback) => {
      // return true if error, false if auth failed, string for user if successful
      try {
        const user_data = nodePosix.getpwnam(user);
        if (crypt(plaintext, user_data.passwd) == user_data.passwd)
          inner_callback(user);
        else if (user_data) {
          // the crypt hash method fails on FreeNAS so try the sha512
          const password_parts = user_data.passwd.split(/\$/);
          const salt = password_parts[2];
          const new_hash = hash.sha512crypt(plaintext, salt);

          const passed = new_hash == user_data.passwd ? user : false;
          inner_callback(passed);
        } else inner_callback(false);
      } catch (e) {
        inner_callback(true);
      }
    };

    const pam = (inner_callback) => {
      // return true if error, false if auth failed, string for user if successful

      authenticatePam.authenticate(user, plaintext, (err) => {
        if (err) inner_callback(false);
        else inner_callback(user);
      });
    };

    pam((pam_passed) => {
      //due to the stack of different auths, a false if auth failed is largely ignored
      if (typeof pam_passed == 'string') callback(pam_passed);
      else
        etc_shadow((etc_passed) => {
          if (typeof etc_passed == 'string') callback(etc_passed);
          else
            posix((posix_passed) => {
              if (typeof posix_passed == 'string') callback(posix_passed);
              else callback(false);
            });
        });
    });
  },

  test_membership: (username, group, callback) => {
    let membership_valid = false;
    passwd
      .getGroups()
      .on('group', (group_data) => {
        if (group == group_data.groupname)
          try {
            if (
              group_data.users.indexOf(username) >= 0 ||
              group_data.gid == userid.gids(username)[0]
            )
              membership_valid = true;
          } catch (e) {
            console.error(e);
          }
      })
      .on('end', () => {
        callback(membership_valid);
      });
  },

  verify_ids: (uid, gid, callback) => {
    let uid_present = false;
    let gid_present = false;

    async.series(
      [
        (cb) => {
          passwd
            .getUsers()
            .on('user', (user_data) => {
              if (user_data.uid == uid) uid_present = true;
            })
            .on('end', () => {
              if (!uid_present)
                cb(new Error(`UID ${uid} does not exist on this system`));
              else cb();
            });
        },
        (cb) => {
          passwd
            .getGroups()
            .on('group', (group_data) => {
              if (group_data.gid == gid) gid_present = true;
            })
            .on('end', () => {
              if (!gid_present)
                cb(new Error(`GID ${gid} does not exist on this system`));
              else cb();
            });
        },
      ],
      callback,
    );
  },
};

export default auth;
