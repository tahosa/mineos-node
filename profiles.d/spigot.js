// import * as async from 'async'
import * as path from 'path'
import * as fs from 'fs-extra'
import * as profile from './template'

exports.profile = {
  name: 'Spigot',
  handler: function (profile_dir, callback) {
    let p = [];

    try {
      let item = new profile();

      item['id'] = 'BuildTools-latest';
      item['time'] = new Date().getTime();
      item['releaseTime'] = new Date().getTime();
      item['type'] = 'release';
      item['group'] = 'spigot';
      item['webui_desc'] = 'Latest BuildTools.jar for building Spigot/Craftbukkit';
      item['weight'] = 0;
      item['filename'] = 'BuildTools.jar';
      item['downloaded'] = fs.existsSync(path.join(profile_dir, item.id, item.filename));
      item['version'] = 0;
      item['release_version'] = '';
      item['url'] = 'https://hub.spigotmc.org/jenkins/job/BuildTools/lastSuccessfulBuild/artifact/target/BuildTools.jar';

      p.push(item);

    } catch (e) { }

    callback(null, p);
  } //end handler

}
