import * as async from 'async'
import * as path from 'path'
import * as fs from 'fs-extra'
import * as profile from './template'

exports.profile = {
  name: 'Mianite',
  request_args: {
    url: 'http://mianite.us/repo?api=true',
    json: true
  },
  handler: function (profile_dir, body, callback) {
    let p = [];

    try {
      for (let r in body) {
        let item = new profile();
        let ref_obj = body[r];
        try {
          let version = ref_obj.version.match(/[\d+]\.[\d+]\.[\d+]/)[0];
        } catch (e) {
          continue;
        }

        item['id'] = ref_obj['version'];
        item['group'] = 'mianite';
        item['webui_desc'] = 'Realm of Mianite {0}'.format(version);
        item['weight'] = 10;
        item['filename'] = path.basename(ref_obj['download']);
        item['url'] = ref_obj['download'];
        item['downloaded'] = fs.existsSync(path.join(profile_dir, item.id, item.filename));
        item['version'] = version;
        item['release_version'] = version;

        switch (ref_obj['version_tag']) {
          case 'Recommended':
            item['type'] = 'release';
            break;
          default:
            if (ref_obj.version.match(/RC|A/))
              item['type'] = 'snapshot';
            else
              item['type'] = 'release';
            break;
        }

        p.push(item);
      }

    } catch (e) { console.log(e) }

    callback(null, p);
  } //end handler

}
