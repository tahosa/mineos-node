import fs from 'node:fs';
import ini from 'ini';

export const readIni = (filepath: string): { [key: string]: any } => {
  try {
    const data = fs.readFileSync(filepath);
    return ini.parse(data.toString());
  } catch (e) {
    console.error(e);
    return {};
  }
};
