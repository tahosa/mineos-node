import fs from 'fs-extra';
import path from 'path';

import profile, { type collection } from './template';

export default {
  name: 'Imagicalmine',
  handler: async (profile_dir) => {
    const p: profile[] = [];

    try {
      const item = new profile();

      item['id'] = 'imagicalmine';
      item['time'] = new Date().getTime();
      item['releaseTime'] = new Date().getTime();
      item['type'] = 'release';
      item['group'] = 'imagicalmine';
      item['webui_desc'] = 'Third-party Pocketmine build';
      item['weight'] = 0;
      item['filename'] = 'ImagicalMine.phar';
      item['downloaded'] = fs.existsSync(
        path.join(profile_dir, item.id, item.filename),
      );
      item['version'] = 0;
      item['release_version'] = '';
      item['url'] =
        'http://jenkins.imagicalmine.net:8080/job/ImagicalMine/lastStableBuild/artifact/releases/ImagicalMine.phar';

      p.push(item);
    } catch (e) {
      console.error(e);
      throw e;
    }

    return p;
  }, //end handler
} as collection;
