import path from 'path';
import fs from 'fs-extra';

import Profile, { type Collection } from './template';

export default {
  name: 'Forge Mod',
  request_args: {
    url: 'http://files.minecraftforge.net/maven/net/minecraftforge/forge/promotions_slim.json',
    type: 'json',
  },
  handler: async (profile_dir, body) => {
    const p: Profile[] = [];

    try {
      for (const index in body.promos) {
        let item: Profile;
        const mcver = index.split('-')[0];
        const forgever = body.promos[index];

        const ver = mcver.match(/(\d+)\.(\d+)\.?(\d+)?/) || [];

        if (parseInt(ver[1]) <= 1 && parseInt(ver[2]) <= 5) {
          // skip version 1.5.2 and earlier--non installer.jar model not supported workflow
          continue;
        } else if (mcver == '1.10') {
          // 1.x major, .10 minor but not .10.2, chosen because url construction
          item = new Profile({
            id: index,
            filename: `forge-${mcver}-${forgever}-${mcver}-installer.jar`,
            url: `http://maven.minecraftforge.net/net/minecraftforge/forge/1.10-${forgever}-1.10.0/forge-1.10-${forgever}-1.10.0-installer.jar`,
          });
          item.downloaded = fs.existsSync(path.join(profile_dir, item.id, item.filename));
        } else if (parseInt(ver[1]) == 1 && parseInt(ver[2]) >= 7 && parseInt(ver[2]) <= 9) {
          // 1.x major, .7-.9 minor, chosen because url construction
          const filename = `forge-${mcver}-${forgever}-${mcver}-installer.jar`;
          item = new Profile({
            id: index,
            filename,
            url: `http://files.minecraftforge.net/maven/net/minecraftforge/forge/${mcver}-${forgever}-${mcver}/${filename}`,
          });
          item.downloaded = fs.existsSync(path.join(profile_dir, item.id, item.filename));
        } else {
          const filename = `forge-${mcver}-${forgever}-installer.jar`;
          item = new Profile({
            id: index,
            filename,
            url: `http://files.minecraftforge.net/maven/net/minecraftforge/forge/${mcver}-${forgever}/${filename}`,
          });
          item.downloaded = fs.existsSync(path.join(profile_dir, item.id, item.filename));
        }

        item.id = index;
        item.type = 'release';
        item.group = 'forge';
        item.webui_desc = `Forge Jar (build ${forgever})`;
        item.weight = 0;
        item.version = index;
        item.release_version = forgever;
        p.push(item);
      }
    } catch (e) {
      console.error(e);
    }

    return p;
  }, //end handler
} as Collection;
