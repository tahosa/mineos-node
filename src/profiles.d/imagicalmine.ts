import fs from 'fs-extra';
import path from 'path';

import Profile, { type Collection } from './template';

export default {
  name: 'Imagicalmine',
  handler: async (profile_dir) => {
    const p: Profile[] = [];

    try {
      const item = new Profile({
        id: 'imagicalmine',
        filename: 'ImagicalMine.phar',
        url: 'http://jenkins.imagicalmine.net:8080/job/ImagicalMine/lastStableBuild/artifact/releases/ImagicalMine.phar',
      });

      item.time = new Date().getTime();
      item.releaseTime = new Date().getTime();
      item.type = 'release';
      item.group = 'imagicalmine';
      item.webui_desc = 'Third-party Pocketmine build';
      item.weight = 0;
      item.downloaded = fs.existsSync(path.join(profile_dir, item.id, item.filename));
      item.version = 0;
      item.release_version = '';

      p.push(item);
    } catch (e) {
      console.error(e);
    }

    return p;
  }, //end handler
} as Collection;
