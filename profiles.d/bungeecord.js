// import * as async from 'async'
import * as path from 'path'
import * as fs from 'fs-extra'
import * as profile from './template'

exports.profile = {
  name: 'BungeeCord',
  request_args: {
    url: 'http://ci.md-5.net/job/BungeeCord/rssAll',
    json: false
  },
  handler: function (profile_dir, body, callback) {
    let p = [];
    let weight = 0;

    try {
      import * as xml_parser from 'xml2js'

      xml_parser.parseString(body, function (inner_err, result) {
        try {
          let packs = result['feed']['entry'];

          for (let index in packs) {
            let item = new profile();
            let ref_obj = packs[index];

            item['version'] = packs[index]['id'][0].split(':').slice(-1)[0];
            item['group'] = 'bungeecord';
            item['type'] = 'release';
            item['id'] = 'BungeeCord-{0}'.format(item.version);
            item['webui_desc'] = packs[index]['title'][0];
            item['weight'] = weight;
            item['filename'] = 'BungeeCord-{0}.jar'.format(item.version);
            item['downloaded'] = fs.existsSync(path.join(profile_dir, item.id, item.filename));
            item['url'] = 'http://ci.md-5.net/job/BungeeCord/{0}/artifact/bootstrap/target/BungeeCord.jar'.format(item.version);
            p.push(item);
	    weight++;
          }
          callback(err || inner_err, p);
        } catch (e) { }
      })

    } catch (e) { console.log(e) }

    callback(null, p);
  } //end handler
}
