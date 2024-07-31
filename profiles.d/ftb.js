// import * as async from 'async'
// import * as path from 'path'
// import * as fs from 'fs-extra'
// import * as profile from './template'

// exports.profile = {
//     name: 'Feed the Beast Mod Packs',
//     request_args: {
//       url: 'https://api.modpacks.ch/public/modpack/all',
//       json: true
//     },
//     handler: function(profile_dir, body, callback) {
//       let p = [];

//       try {
//         import * as request from 'request'
//         let p = [];

//         let q = async.queue(function(obj, cb) {
//             async.waterfall([
//             async.apply(request, obj.url),
//             function(response, body, inner_cb) {
//               try{
//                 let ids = JSON.parse(body)["packs"];
//               }catch(e){

//               }
//                 inner_cb(response.statusCode != 200, ids)
//             },
//             function(ids, inner_cb) {
//               for (let id in ids){
//                 async.waterfall([
//                     async.apply(request, 'https://api.modpacks.ch/public/modpack/' + id),
//                     function(response,body,inner_cb){
//                         try{
//                             let parsed = JSON.parse(body);
//                         } catch (e){}

//                         inner_cb(response.statusCode != 200, parsed)
//                     },
//                     function(details, inner_cb){
//                         details["versions"].forEach( ver => {
//                             ver.id
//                         })
//                     }
//                 ])
//               }
//             }
//         ])
// })
//       } catch (e) {}

//       callback(null, p);
//     }, //end handler
//     postdownload: function(profile_dir, dest_filepath, callback) {
//       callback();
//     }
// }
