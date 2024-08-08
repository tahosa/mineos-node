import axios from 'axios';
import fs from 'fs-extra';
import path from 'path';

import profile, { type collection } from './template.js';

export default (name) => {
  const lowername = name.toLowerCase();
  const titlename = name.charAt(0).toUpperCase() + lowername.substr(1);

  return {
    name: titlename,
    request_args: {
      url: `https://papermc.io/api/v2/projects/${lowername}/`,
      type: 'json',
    },
    handler: async (profile_dir, body) => {
      const p: profile[] = [];
      const paperVersions: Promise<any>[] = [];
      let weight = 0;

      try {
        for (const index in body.versions) {
          const version = body.versions[index];

          paperVersions.push(
            axios({
              url: `https://papermc.io/api/v2/projects/${lowername}/versions/${version}/`,
            }).catch((err) => {
              console.error(err);
            }) as Promise<string>,
          );
        }
        return Promise.all(paperVersions).then((responses) => {
          responses.forEach((response) => {
            const build = response.data.builds[response.data.builds.length - 1];
            const splitPath = response.request.path.split('/');
            const ver = splitPath[splitPath.length - 2];
            const item = new profile();

            item['id'] = `${titlename}-${ver}-${build}`;
            item['group'] = lowername;
            item['webui_desc'] = `Latest ${titlename} build for ${ver}`;
            item['weight'] = weight;
            item['filename'] = `${lowername}-${ver}-${build}.jar`;
            item['url'] =
              `${response.request.res.responseUrl}builds/${build}/downloads/${lowername}-${ver}-${build}.jar`;
            item['downloaded'] = fs.existsSync(
              path.join(profile_dir, item.id, item.filename),
            );
            item['version'] = ver;
            item['release_version'] = ver;
            item['type'] = 'release';

            p.push(item);
            weight++;
          });

          return p;
        });
      } catch (e) {
        console.log(e);
      }
    }, //end handler
  } as collection;
};
