import fs from 'fs-extra';
import path from 'path';
import xml_parser from 'xml2js';

import profile, { type collection } from './template.js';

export default {
  name: 'BungeeCord',
  request_args: {
    url: 'http://ci.md-5.net/job/BungeeCord/rssAll',
    type: 'text',
  },
  handler: async (profile_dir, body) => {
    const p: profile[] = [];
    let weight = 0;

    try {
      xml_parser.parseString(body, (inner_err, result) => {
        if (inner_err) throw inner_err;

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
      });
    } catch (e) {
      console.log(e);
    }

    return p;
  }, //end handler
} as collection;
