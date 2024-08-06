import bedrockServer from './profiles.d/bedrock-server';
import bedrockWrapper from './profiles.d/bedrock-wrapper';
import bungeecord from './profiles.d/bungeecord';
import cuberite from './profiles.d/cuberite';
import forge from './profiles.d/forge';
import ftb_legacy from './profiles.d/ftb_legacy';
import ftb_thirdparty_legacy from './profiles.d/ftb_thirdparty_legacy';
import imagicalmine from './profiles.d/imagicalmine';
import mianite from './profiles.d/mianite';
import mojang from './profiles.d/mojang';
import nukkit from './profiles.d/nukkit';
import paperspigot from './profiles.d/paperspigot';
import spigot from './profiles.d/spigot';
import spongevanilla from './profiles.d/spongevanilla';
import { collection } from './profiles.d/template';
import travertine from './profiles.d/travertine';
import waterfall from './profiles.d/waterfall';

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
