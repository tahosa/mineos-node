import logging from 'winston';
import path from 'node:path';
import fs from 'node:fs';

const profile_manifests = {};

const normalizedPath = path.join(__dirname, 'profiles.d');

logging.info(normalizedPath);

fs.readdirSync(normalizedPath)
  .filter((fn) => fn.endsWith('.ts'))
  .forEach(async (file) => {
    if (!file.match('template.ts')) {
      const loadedProfile = await import('./profiles.d/' + file);
      if (loadedProfile.profile !== undefined) {
        const name = file.split('.')[0];
        profile_manifests[name] = loadedProfile.profile;
      }
    }
  });

export default { profile_manifests: profile_manifests };
