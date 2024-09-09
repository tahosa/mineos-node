import fs from 'fs-extra';
import path from 'path';

import Profile, { type Collection } from './template';

export default {
  name: 'Mianite',
  request_args: {
    url: 'http://mianite.us/repo?api=true',
    type: 'json',
  },
  handler: async (profile_dir, body) => {
    const p: Profile[] = [];

    try {
      for (const r in body) {
        const ref_obj = body[r];
        const item = new Profile({
          id: ref_obj['version'],
          filename: path.basename(ref_obj['download']),
          url: ref_obj['download'],
        });

        let version: string;
        try {
          version = ref_obj.version.match(/[\d+]\.[\d+]\.[\d+]/)[0];
        } catch (e) {
          continue;
        }

        item.group = 'mianite';
        item.webui_desc = `Realm of Mianite ${version}`;
        item.weight = 10;
        item.downloaded = fs.existsSync(path.join(profile_dir, item.id || '', item.filename));
        item.version = version;
        item.release_version = version;

        switch (ref_obj['version_tag']) {
          case 'Recommended':
            item.type = 'release';
            break;
          default:
            if (ref_obj.version.match(/RC|A/)) item.type = 'snapshot';
            else item.type = 'release';
            break;
        }

        p.push(item);
      }
    } catch (e) {
      console.log(e);
    }

    return p;
  }, //end handler
} as Collection;
