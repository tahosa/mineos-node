import fs from 'fs-extra';
import path from 'path';
import xml_parser from 'xml2js';

import Profile, { type Collection } from './template';

export default {
  name: 'BungeeCord',
  request_args: {
    url: 'http://ci.md-5.net/job/BungeeCord/rssAll',
    type: 'text',
  },
  handler: async (profile_dir, body) => {
    const p: Profile[] = [];
    let weight = 0;

    try {
      xml_parser.parseString(body, (inner_err, result) => {
        if (inner_err) throw inner_err;

        const packs = result['feed']['entry'];

        for (const index in packs) {
          const version = packs[index]['id'][0].split(':').slice(-1)[0];
          const item = new Profile({
            id: `BungeeCord-${version}`,
            filename: `BungeeCord-${version}.jar`,
            url: `http://ci.md-5.net/job/BungeeCord/${version}/artifact/bootstrap/target/BungeeCord.jar`,
          });

          item.version = version;
          item.group = 'bungeecord';
          item.type = 'release';
          item.webui_desc = packs[index]['title'][0];
          item.weight = weight;
          item.downloaded = fs.existsSync(path.join(profile_dir, item.id, item.filename));
          p.push(item);
          weight++;
        }
      });
    } catch (e) {
      console.log(e);
    }

    return p;
  }, //end handler
} as Collection;
