import fs from 'fs-extra';
import path from 'path';

import Profile, { type Collection } from './template';

export default {
  name: 'Nukkit',
  handler: async (profile_dir) => {
    const p: Profile[] = [];

    try {
      let item = new Profile({
        id: 'nukkit-stable',
        filename: 'nukkit-1.0-SNAPSHOT.jar',
        url: 'http://ci.mengcraft.com:8081/job/nukkit/lastStableBuild/artifact/target/nukkit-1.0-SNAPSHOT.jar',
      });

      item.time = new Date().getTime();
      item.releaseTime = new Date().getTime();
      item.type = 'release';
      item.group = 'nukkit';
      item.webui_desc = 'Minecraft: PE server for Java (stable)';
      item.weight = 0;
      item.downloaded = fs.existsSync(path.join(profile_dir, item.id, item.filename));
      item.version = 0;
      item.release_version = '';

      p.push(JSON.parse(JSON.stringify(item)));

      item = new Profile({
        id: 'nukkit-snapshot',
        filename: 'nukkit-1.0-SNAPSHOT.jar',
        url: 'http://ci.mengcraft.com:8081/job/nukkit/lastSuccessfulBuild/artifact/target/nukkit-1.0-SNAPSHOT.jar',
      });

      item.time = new Date().getTime();
      item.releaseTime = new Date().getTime();
      item.type = 'snapshot';
      item.group = 'nukkit';
      item.webui_desc = 'Minecraft: PE server for Java (last successful)';
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
