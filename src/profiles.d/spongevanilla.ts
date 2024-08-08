import fs from 'fs-extra';
import path from 'path';
import xml_parser from 'xml2js';

import profile, { type collection } from './template.js';

export default {
  name: 'SpongeVanilla',
  request_args: {
    url: 'https://repo.spongepowered.org/maven/org/spongepowered/spongevanilla/maven-metadata.xml',
    type: 'text',
  },
  handler: async (profile_dir, body) => {
    const p: profile[] = [];

    try {
      xml_parser.parseString(body, (inner_err, result) => {
        if (inner_err) throw inner_err;

        try {
          const packs =
            result['metadata']['versioning'][0]['versions'][0]['version'];

          for (const index in packs) {
            const item = new profile();
            const matches = packs[index].match(
              /([\d.]+)-([\d.]+)?-?(\D+)-(\d+)/,
            );

            item['version'] = packs[index];
            item['group'] = 'spongevanilla';

            if (!matches || matches.length < 5) {
              continue;
            }

            switch (matches[3]) {
              case 'DEV':
                item['type'] = 'snapshot';
                break;
              case 'BETA':
                item['type'] = 'release';
                break;
              default:
                item['type'] = 'old_version';
                break;
            }

            item['id'] =
              `SpongeVanilla-${matches[1]}${matches[3][0].toLowerCase()}${matches[4]}`;
            item['webui_desc'] =
              `Version ${matches[2]}, build ${matches[4]} (mc: ${matches[1]})`;
            item['weight'] = 5;
            item['filename'] = `spongevanilla-${item.version}.jar`;
            item['downloaded'] = fs.existsSync(
              path.join(profile_dir, item.id || '', item.filename || ''),
            );
            item['url'] =
              `https://repo.spongepowered.org/maven/org/spongepowered/spongevanilla/${item.version}/spongevanilla-${item.version}.jar`;
            p.push(item);
          }
        } catch (e) {
          console.error(e);
        }
      });
    } catch (e) {
      console.error(e);
    }

    return p;
  }, //end handler
} as collection;
