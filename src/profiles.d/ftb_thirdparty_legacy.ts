import fs from 'fs-extra';
import path from 'path';
import xml_parser from 'xml2js';

import profile, { type collection } from './template.js';

export default {
  name: 'Feed the Beast Third-Party Server Packs - old',
  request_args: {
    url: 'http://dist.creeper.host/FTB2/static/thirdparty.xml',
    type: 'text',
  },
  handler: async (profile_dir, body) => {
    const p: profile[] = [];

    try {
      xml_parser.parseString(body, (inner_err, result) => {
        const packs = result['modpacks']['modpack'];

        for (const index in packs) {
          const item = new profile();
          const ref_obj = packs[index]['$'];

          item['id'] = `${ref_obj['dir']}-${ref_obj['version']}`;
          //item['time'] = ref_obj['time'];
          //item['releaseTime'] = ref_obj['releaseTime'];
          item['type'] = 'release';
          item['group'] = 'ftb_third_party_old';
          item['webui_desc'] =
            `${ref_obj['name']} (mc: ${ref_obj['mcVersion']})`;
          item['weight'] = 3;
          item['filename'] = ref_obj['serverPack'];
          item['url'] =
            `http://dist.creeper.host/FTB2/modpacks/${ref_obj.dir}/${ref_obj.version.replace(/\./g, '_')}/${ref_obj.serverPack}`;
          item['downloaded'] = fs.existsSync(
            path.join(profile_dir, item.id, item.filename || ''),
          );
          item['version'] = ref_obj['mcVersion'];
          item['release_version'] = ref_obj['version'];
          p.push(item);

          const old_versions = ref_obj['oldVersions'].split(';');
          for (const idx in old_versions) {
            const new_item = new profile();

            new_item['id'] = `${ref_obj['dir']}-${old_versions[idx]}`;
            //new_item['time'] = ref_obj['time'];
            //new_item['releaseTime'] = ref_obj['releaseTime'];
            new_item['type'] = 'old_version';
            new_item['group'] = 'ftb_third_party_old';
            new_item['webui_desc'] = ref_obj['name'];
            new_item['weight'] = 3;
            new_item['filename'] = ref_obj['serverPack'];
            new_item['url'] =
              `http://dist.creeper.host/FTB2/modpacks/${ref_obj.dir}/${ref_obj.version.replace(/\./g, '_')}/${ref_obj.serverPack}`;
            new_item['downloaded'] = fs.existsSync(
              path.join(profile_dir, new_item.id, new_item.filename || ''),
            );
            new_item['version'] = ref_obj['mcVersion'];
            new_item['release_version'] = old_versions[idx];

            if (
              old_versions[idx].length > 0 &&
              old_versions[idx] != ref_obj['version']
            )
              p.push(new_item);
          }
        }
      });
    } catch (e) {
      console.error(e);
    }

    return p;
  }, //end handler
} as collection;
