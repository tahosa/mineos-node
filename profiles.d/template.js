import * as async from 'async'
import * as path from 'path'
import * as fs from 'fs-extra'
// import * as profile from './template'

module.exports = function () {
  return {
    id: null,
    time: null,
    releaseTime: null,
    type: null, // release, snapshot, old_version
    group: null, //mojang, ftb, ftb_third_party, pocketmine, etc.
    webui_desc: null,
    weight: 0,
    downloaded: false,
    filename: null, // minecraft_server.1.8.8.jar
    version: null // 1.8.8,
  }
}
