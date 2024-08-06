import * as child_process from 'child_process';
import { sync } from 'which';

export async function usedJavaVersion(sc, callback) {
  let value;
  try {
    const java_binary = sync('java');
    value = (sc.java || {}).java_binary || java_binary;

    const java_version = child_process.spawnSync(`${value}`, ['-version']);

    const stdout = java_version.stdout.toString();
    const stderr = java_version.stderr.toString();

    const toReturn = stdout
      ? stdout.split('"')[1].split('"')[0]
      : stderr.split('"')[1].split('"')[0];

    callback(null, toReturn);
  } catch (e) {
    callback(null, `Error accessing location '${value}'`);
  }
}
