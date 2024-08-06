export default class profile {
  id: string | null;
  time: number | null;
  releaseTime: number | null;
  type: 'release' | 'snapshot' | 'old_version' | null;
  group: string | null;
  webui_desc: string | null;
  weight: number;
  downloaded: boolean;
  filename: string | null;
  version: string | number | null;

  constructor() {
    this.id = null;
    this.time = null;
    this.releaseTime = null;
    this.type = null; //
    this.group = null; //mojang, ftb, ftb_third_party, pocketmine, etc.
    this.webui_desc = null;
    this.weight = 0;
    this.downloaded = false;
    this.filename = null; // minecraft_server.1.8.8.jar
    this.version = null; // 1.8.8,
  }
}
