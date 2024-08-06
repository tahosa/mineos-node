import fs from 'fs-extra';
import path from 'path';
import xml_parser from 'xml2js';

import profile from './template';

export default {
  profile: {
    name: 'SpongeVanilla',
    request_args: {
      url: 'https://repo.spongepowered.org/maven/org/spongepowered/spongevanilla/maven-metadata.xml',
      json: false,
      gzip: true,
    },
    handler: function (profile_dir, body, callback) {
      const p: profile[] = [];

      try {
        xml_parser.parseString(body, function (inner_err, result) {
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
            callback(inner_err, p);
          } catch (e) {
            console.error(e);
          }
        });
      } catch (e) {
        console.error(e);
      }

      callback(null, p);
    }, //end handler
  },
};
