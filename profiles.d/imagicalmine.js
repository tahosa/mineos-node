
// import * as async from 'async'
import * as path from 'path'
import * as fs from 'fs-extra'
import * as profile from './template'

exports.profile = {
  name: 'Imagicalmine',
  handler: function (profile_dir, callback) {
    let p = [];

    try {
      let item = new profile();

      item['id'] = 'imagicalmine';
      item['time'] = new Date().getTime();
      item['releaseTime'] = new Date().getTime();
      item['type'] = 'release';
      item['group'] = 'imagicalmine';
      item['webui_desc'] = 'Third-party Pocketmine build';
      item['weight'] = 0;
      item['filename'] = 'ImagicalMine.phar';
      item['downloaded'] = fs.existsSync(path.join(profile_dir, item.id, item.filename));
      item['version'] = 0;
      item['release_version'] = '';
      item['url'] = 'http://jenkins.imagicalmine.net:8080/job/ImagicalMine/lastStableBuild/artifact/releases/ImagicalMine.phar';

      p.push(item);
    } catch (e) { }

    callback(null, p);
  } //end handler
}
