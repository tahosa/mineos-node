import axios from 'axios';

import Profile, { type Collection } from './template';

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
      const p: Profile[] = [];
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
              return '';
            })
          );
        }
        return Promise.all(paperVersions).then((responses) => {
          responses.forEach((response) => {
            const build = response.data.builds[response.data.builds.length - 1];
            const splitPath = response.request.path.split('/');
            const ver = splitPath[splitPath.length - 2];
            const item = new Profile({
              id: `${titlename}-${ver}-${build}`,
              filename: `${lowername}-${ver}-${build}.jar`,
              url: `${response.request.res.responseUrl}builds/${build}/downloads/${lowername}-${ver}-${build}.jar`,
            });

            item.group = lowername;
            item.webui_desc = `Latest ${titlename} build for ${ver}`;
            item.weight = weight;
            item.version = ver;
            item.release_version = ver;
            item.type = 'release';

            p.push(item);
            weight++;
          });

          return p;
        });
      } catch (e) {
        console.log(e);
        return [];
      }
    }, //end handler
  } as Collection;
};
