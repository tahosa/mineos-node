import fs from 'fs-extra';
import path from 'path';

import Profile, { type Collection } from './template';

export default {
  name: 'MineOS Bedrock Wrapper',
  handler: async (profile_dir) => {
    const p: Profile[] = [];

    try {
      const item = new Profile({
        id: 'bedrock-server-wrapper',
        filename: 'mineos-bedrock-wrapper-1.0-SNAPSHOT.jar',
        url: 'https://github.com/tucks/mineos-bedrock-wrapper/raw/master/download/latest/mineos-bedrock-wrapper-1.0-SNAPSHOT.jar',
      });

      item.type = 'snapshot';
      item.group = 'bedrock-wrapper';
      item.webui_desc = 'Bedrock Server Wrapper';
      item.weight = 0;
      item.downloaded = fs.existsSync(path.join(profile_dir, item.id, item.filename));
      item.version = 0;
      item.release_version = '1.0';

      p.push(item);
    } catch (e) {
      console.error(e);
    }

    return p;
  }, //end handler
} as Collection;
