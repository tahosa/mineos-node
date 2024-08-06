import fs from 'fs-extra';
import path from 'path';
import xml_parser from 'xml2js';

import profile from './template';

export default {
  profile: {
    name: 'BungeeCord',
    request_args: {
      url: 'http://ci.md-5.net/job/BungeeCord/rssAll',
      json: false,
    },
    handler: (profile_dir, body, callback) => {
      const p: profile[] = [];
      let weight = 0;

      try {
        xml_parser.parseString(body, (inner_err, result) => {
          try {
            const packs = result['feed']['entry'];

            for (const index in packs) {
              const item = new profile();

              item['version'] = packs[index]['id'][0].split(':').slice(-1)[0];
              item['group'] = 'bungeecord';
              item['type'] = 'release';
              item['id'] = `BungeeCord-${item.version}`;
              item['webui_desc'] = packs[index]['title'][0];
              item['weight'] = weight;
              item['filename'] = `BungeeCord-${item.version}.jar`;
              item['downloaded'] = fs.existsSync(
                path.join(profile_dir, item.id, item.filename),
              );
              item['url'] =
                `http://ci.md-5.net/job/BungeeCord/${item.version}/artifact/bootstrap/target/BungeeCord.jar`;
              p.push(item);
              weight++;
            }
            callback(inner_err, p);
          } catch (e) {
            callback(e, p);
          }
        });
      } catch (e) {
        console.log(e);
      }

      callback(null, p);
    }, //end handler
  },
};
