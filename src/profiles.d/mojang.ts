import axios from 'axios';
import path from 'path';
import fs from 'fs-extra';

import { PromisePool } from '../util.js';
import profile, { type collection } from './template.js';

type MojangVersion = {
  id: string;
  type: string;
  url: string;
  time: string;
  releaseTime: string;
};

type MojanDetails = {
  id: string;
  downloads: {
    server: {
      url: string;
    };
  };
};

export default {
  name: 'Mojang Official Minecraft Jars',
  request_args: {
    url: 'https://launchermeta.mojang.com/mc/game/version_manifest.json',
    type: 'json',
  },
  handler: async (profile_dir, body) => {
    const promise = new PromisePool<profile, MojangVersion>(body.versions as MojangVersion[], 2, async (version) => {
      let type: profile['type'] = 'old_version';

      switch (version.type) {
        case 'release':
          type = 'release';
          break;
        case 'snapshot':
          type = 'snapshot';
          break;
      }

      const id = version.id;
      const filename = `minecraft_server.${version.id}.jar`;

      let url = `https://s3.amazonaws.com/Minecraft.Download/versions/${id}/minecraft_server.${id}.jar`;
      const details = await axios<MojanDetails>({ url: version.url });
      if (details.data.id === version.id) {
        url = details.data.downloads.server.url;
      }

      const item: profile = {
        id,
        type,
        time: Date.parse(version.time),
        releaseTime: Date.parse(version.releaseTime),
        group: 'mojang',
        webui_desc: 'Official Mojang Jar',
        weight: 0,
        filename,
        downloaded: fs.existsSync(path.join(profile_dir, id, filename)),
        version: id,
        url,
      };

      return item;
    });

    return promise.process();
  },
} as collection;
