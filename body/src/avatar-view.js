import {existsSync,readFileSync,writeFileSync,renameSync} from 'node:fs';
import path from 'node:path';
import {DATA_DIR} from './config.js';
import {bus} from './events.js';
export const DEFAULT_VIEW={scale:1,zoom:1,frame:'body'};
// The only camera presets the Studio page has (dashboard/public/avatar.js frame()). eyes is the tightest:
// just the eyes; there is no hands or other partial frame; closer still is zoom, up to 4.
export const FRAMES={eyes:'eyes only, tight on the eyes',face:'head close-up',bust:'head and shoulders',body:'full body'};
export const LIMITS={scale:[.5,2],zoom:[.25,4]};
export function createAvatarView(file=path.join(DATA_DIR,'avatar-view.json'),emit=state=>bus.emit('avatar-view',state)){
  const get=()=>({...DEFAULT_VIEW,...(existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{})});
  function set(patch={},reset=false){
    const next=reset?{...DEFAULT_VIEW}:get();
    for(const [key,[min,max]] of Object.entries(LIMITS))if(patch[key]!==undefined){
      if(!Number.isFinite(patch[key])||patch[key]<min||patch[key]>max)throw new Error(`${key} must be between ${min} and ${max}; nothing was changed.`);next[key]=patch[key];
    }
    if(patch.frame!==undefined){
      if(!Object.hasOwn(FRAMES,patch.frame))throw new Error(`there is no "${patch.frame}" frame, so nothing was changed. The viewer only has: ${Object.entries(FRAMES).map(([k,v])=>`${k} (${v})`).join(', ')}. For closer still, raise zoom (up to ${LIMITS.zoom[1]}).`);
      next.frame=patch.frame;
      // A named preset fits the selected model size; later zoom/size edits are independent.
      if(patch.zoom===undefined)next.zoom=1/next.scale;
    }
    writeFileSync(file+'.tmp',JSON.stringify(next,null,2));renameSync(file+'.tmp',file);emit(next);return next;
  }
  return {get,set};
}
export const avatarView=createAvatarView();
