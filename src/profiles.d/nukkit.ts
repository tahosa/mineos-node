import fs from 'fs-extra';
import path from 'path';

import profile from './template';

export default {
  profile: {
    name: 'Nukkit',
    handler: function (profile_dir, callback) {
      const p: profile[] = [];

      try {
        let item = new profile();

        item['id'] = 'nukkit-stable';
        item['time'] = new Date().getTime();
        item['releaseTime'] = new Date().getTime();
        item['type'] = 'release';
        item['group'] = 'nukkit';
        item['webui_desc'] = 'Minecraft: PE server for Java (stable)';
        item['weight'] = 0;
        item['filename'] = 'nukkit-1.0-SNAPSHOT.jar';
        item['downloaded'] = fs.existsSync(
          path.join(profile_dir, item.id, item.filename),
        );
        item['version'] = 0;
        item['release_version'] = '';
        item['url'] =
          'http://ci.mengcraft.com:8081/job/nukkit/lastStableBuild/artifact/target/nukkit-1.0-SNAPSHOT.jar';

        p.push(JSON.parse(JSON.stringify(item)));

        item = new profile();

        item['id'] = 'nukkit-snapshot';
        item['time'] = new Date().getTime();
        item['releaseTime'] = new Date().getTime();
        item['type'] = 'snapshot';
        item['group'] = 'nukkit';
        item['webui_desc'] = 'Minecraft: PE server for Java (last successful)';
        item['weight'] = 0;
        item['filename'] = 'nukkit-1.0-SNAPSHOT.jar';
        item['downloaded'] = fs.existsSync(
          path.join(profile_dir, item.id, item.filename),
        );
        item['version'] = 0;
        item['release_version'] = '';
        item['url'] =
          'http://ci.mengcraft.com:8081/job/nukkit/lastSuccessfulBuild/artifact/target/nukkit-1.0-SNAPSHOT.jar';

        p.push(item);
      } catch (e) {
        console.error(e);
      }

      callback(null, p);
    }, //end handler
  },
};
