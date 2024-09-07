import child from 'child_process';
import which from 'which';

import { type ServerConfig } from './constants';

export async function usedJavaVersion(sc: ServerConfig): Promise<string> {
  return await new Promise((res, rej) => {
    let value = 'unknown';
    try {
      const java_binary = which.sync('java');
      value = sc.java?.java_binary || java_binary;

      const java_version = child.spawnSync(`${value}`, ['-version']);

      const stdout = java_version.stdout.toString();
      const stderr = java_version.stderr.toString();

      const toReturn = stdout ? stdout.split('"')[1].split('"')[0] : stderr.split('"')[1].split('"')[0];

      res(toReturn);
    } catch (e) {
      rej(`Error accessing location '${value}'`);
    }
  });
}
