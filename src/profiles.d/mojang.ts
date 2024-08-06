import async from 'async';
import path from 'path';
import fs from 'fs-extra';
import request from 'request';

import profile from './template';

export default {
  profile: {
    name: 'Mojang Official Minecraft Jars',
    request_args: {
      url: 'https://launchermeta.mojang.com/mc/game/version_manifest.json',
      json: true,
    },
    handler: (profile_dir, body, callback) => {
      const p: profile[] = [];

      const q = async.queue<ReturnType<typeof request>>((obj, cb) => {
        async.waterfall([
          async.apply(request, obj.url),
          (response, body, inner_cb) => {
            inner_cb(response.statusCode != 200, body);
          },
          (body, inner_cb) => {
            let parsed: any;
            try {
              parsed = JSON.parse(body);
            } catch (err) {
              callback(err);
              inner_cb(err);
              return;
            }
            for (const idx in p)
              if (p[idx]['id'] == obj['id'])
                try {
                  p[idx]['url'] = parsed['downloads']['server']['url'];
                } catch (e) {
                  console.error(e);
                }
            inner_cb();
          },
        ]);
        cb();
      }, 2);

      q.pause();

      try {
        // BEGIN PARSING LOGIC
        for (const index in body.versions) {
          const item = new profile();
          const ref_obj = body.versions[index];

          item['id'] = ref_obj['id'];
          item['time'] = ref_obj['time'];
          item['releaseTime'] = ref_obj['releaseTime'];
          item['group'] = 'mojang';
          item['webui_desc'] = 'Official Mojang Jar';
          item['weight'] = 0;
          item['filename'] = `minecraft_server.${ref_obj['id']}.jar`;
          item['downloaded'] = fs.existsSync(
            path.join(profile_dir, item.id || '', item.filename),
          );
          item['version'] = ref_obj['id'];
          item['release_version'] = ref_obj['id'];
          item['url'] =
            `https://s3.amazonaws.com/Minecraft.Download/versions/${item.version}/minecraft_server.${item.version}.jar`;

          switch (ref_obj['type']) {
            case 'release':
              item['type'] = ref_obj['type'];
              q.push({ id: item['id'], url: ref_obj.url });
              p.push(item);
              break;
            case 'snapshot':
              item['type'] = ref_obj['type'];
              q.push({ id: item['id'], url: ref_obj.url });
              p.push(item);
              break;
            default:
              item['type'] = 'old_version'; //old_alpha, old_beta
              //q.push({ id: item['id'], url: ref_obj.url });
              break;
          }
          //p.push(item);
        }
      } catch (e) {
        console.error(e);
      }

      q.resume();
      q.drain = async () => {
        callback(null, p);
      };
    }, //end handler
    postdownload: (profile_dir, dest_filepath, callback) => {
      callback();
    },
  },
};
