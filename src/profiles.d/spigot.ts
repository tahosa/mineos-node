import fs from 'fs-extra';
import path from 'path';

import Profile, { type Collection } from './template';

export default {
  name: 'Spigot',
  handler: async (profile_dir) => {
    const p: Profile[] = [];

    try {
      const item = new Profile({
        id: 'BuildTools-latest',
        filename: 'BuildTools.jar',
        url: 'https://hub.spigotmc.org/jenkins/job/BuildTools/lastSuccessfulBuild/artifact/target/BuildTools.jar',
      });

      item.time = new Date().getTime();
      item.releaseTime = new Date().getTime();
      item.type = 'release';
      item.group = 'spigot';
      item.webui_desc = 'Latest BuildTools.jar for building Spigot/Craftbukkit';
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
