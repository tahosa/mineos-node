import bedrockServer from './profiles.d/bedrock-server.js';
import bedrockWrapper from './profiles.d/bedrock-wrapper.js';
import bungeecord from './profiles.d/bungeecord.js';
import cuberite from './profiles.d/cuberite.js';
import forge from './profiles.d/forge.js';
import ftb_legacy from './profiles.d/ftb_legacy.js';
import ftb_thirdparty_legacy from './profiles.d/ftb_thirdparty_legacy.js';
import imagicalmine from './profiles.d/imagicalmine.js';
import mianite from './profiles.d/mianite.js';
import mojang from './profiles.d/mojang.js';
import nukkit from './profiles.d/nukkit.js';
import paperspigot from './profiles.d/paperspigot.js';
import spigot from './profiles.d/spigot.js';
import spongevanilla from './profiles.d/spongevanilla.js';
import { collection } from './profiles.d/template.js';
import travertine from './profiles.d/travertine.js';
import waterfall from './profiles.d/waterfall.js';

export default {
  profile_manifests: {
    'bedrock-server': bedrockServer,
    'bedrock-wrapper': bedrockWrapper,
    bungeecord: bungeecord,
    cuberite: cuberite,
    forge: forge,
    ftb_legacy: ftb_legacy,
    ftb_thirdparty_legacy: ftb_thirdparty_legacy,
    imagicalmine: imagicalmine,
    mianite: mianite,
    mojang: mojang,
    nukkit: nukkit,
    paperspigot: paperspigot,
    spigot: spigot,
    spongevanilla: spongevanilla,
    travertine: travertine,
    waterfall: waterfall,
  },
} as {
  profile_manifests: { [key: string]: collection };
};
