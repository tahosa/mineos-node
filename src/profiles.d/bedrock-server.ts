import fs from 'fs-extra';
import path from 'path';

import profile, { type collection } from './template';

export default {
  name: 'Minecraft Bedrock',
  handler: async (profile_dir: string): Promise<profile[]> => {
    const p: profile[] = [];

    const versions: [string, number][] = [
      ['1.18.33.02', 0],
      ['1.18.31.04', 0],
      ['1.18.30.04', 0],
      ['1.18.12.01', 0],
      ['1.18.11.01', 0],
      ['1.18.2.03', 0],
      ['1.18.1.02', 0],
      ['1.18.0.02', 0],
      ['1.17.41.01', 0],
      ['1.17.40.06', 0],
      ['1.17.34.02', 0],
      ['1.17.33.01', 0],
      ['1.17.32.02', 0],
      ['1.17.31.01', 0],
      ['1.17.30.04', 0],
      ['1.17.11.01', 0],
      ['1.17.10.04', 0],
      ['1.16.221.01', 1],
      ['1.14.60.5', 2],
      ['1.13.3.0', 3],
      ['1.12.1.1', 4],
      ['1.11.4.2', 5],
      ['1.10.0.7', 6],
      ['1.9.0.15', 7],
      ['1.8.1.2', 8],
      ['1.7.0.13', 9],
      ['1.6.1.0', 10],
    ];

    try {
      // BEGIN PARSING LOGIC
      for (const [v, weight] of versions) {
        const id = `bedrock-server-${v}`;
        const filename = `bedrock-server-${v}.zip`;
        p.push({
          id,
          type: 'release',
          group: 'bedrock-server',
          webui_desc: `${v} Linux x64 release`,
          weight,
          filename,
          downloaded: fs.existsSync(path.join(profile_dir, id, filename)),
          version: 0,
          release_version: v,
          url: `https://minecraft.azureedge.net/bin-linux/bedrock-server-${v}`,
        });
      }
    } catch (e) {
      console.error(e);
    }

    return p;
  }, //end handler
  postdownload: async (profile_dir) => {
    // perform an async chmod of the unipper extracted bedrock_server binary
    return fs.chmod(profile_dir + '/bedrock_server', 0o755);
  },
} as collection;
