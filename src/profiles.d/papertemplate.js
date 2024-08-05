import * as path from "path";
import * as fs from "fs-extra";
import * as profile from "./template";
import * as axios from "axios";

module.exports = function papertemplate(name) {
  const lowername = name.toLowerCase();
  const titlename = name.charAt(0).toUpperCase() + lowername.substr(1);

  return {
    name: titlename,
    request_args: {
      url: `https://papermc.io/api/v2/projects/${lowername}/`,
      json: true,
    },
    handler: function (profile_dir, body, callback) {
      let p = [];
      let weight = 0;

      try {
        for (let index in body.versions) {
          let version = body.versions[index];

          p.push(
            axios({
              url: `https://papermc.io/api/v2/projects/${lowername}/versions/${version}/`,
            }).catch((err) => {
              console.log(err);
            }),
          );
        }
        Promise.all(p)
          .then((responses) => {
            p = [];
            responses.forEach((response) => {
              let build = response.data.builds[response.data.builds.length - 1];
              const splitPath = response.request.path.split("/");
              let ver = splitPath[splitPath.length - 2];
              let item = new profile();

              item["id"] = `${titlename}-${ver}-${build}`;
              item["group"] = lowername;
              item["webui_desc"] = `Latest ${titlename} build for ${ver}`;
              item["weight"] = weight;
              item["filename"] = `${lowername}-${ver}-${build}.jar`;
              item["url"] =
                `${response.request.res.responseUrl}builds/${build}/downloads/${lowername}-${ver}-${build}.jar`;
              item["downloaded"] = fs.existsSync(
                path.join(profile_dir, item.id, item.filename),
              );
              item["version"] = ver;
              item["release_version"] = ver;
              item["type"] = "release";

              p.push(item);
              weight++;
            });
          })
          .then(() => {
            callback(null, p);
          })
          .catch((err) => {
            console.error(err);
          });
      } catch (e) {
        console.log(e);
      }
    }, //end handler
  };
};
