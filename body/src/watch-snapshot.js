import {readFileSync,statSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {config} from './config.js';
import {avatarLibrary,activeAvatarPath} from './avatar-library.js';
import {avatarState} from './avatar-state.js';
import {avatarView} from './avatar-view.js';
import {avatarPerformance} from './avatar-performance.js';
import {outfitList,outfitColors} from './avatar-outfits.js';
import {backgroundState,backgroundImage} from './avatar-background.js';
import {current} from './emotion.js';
const modelCache=new Map();
function modelAsset(file){
  const stamp=statSync(file).mtimeMs,cached=modelCache.get(file);if(cached?.stamp===stamp)return cached.asset;
  const bytes=readFileSync(file),asset={bytes,hash:createHash('sha256').update(bytes).digest('hex')};
  modelCache.set(file,{stamp,asset});if(modelCache.size>8)modelCache.delete(modelCache.keys().next().value);return asset;
}
export function watchSnapshot(){
  const assets=[];
  const add=(bytes)=>{const hash=createHash('sha256').update(bytes).digest('hex');assets.push({hash,bytes});return hash;};
  const model=modelAsset(activeAvatarPath());assets.push(model);const modelHash=model.hash,background=backgroundState();
  const backgroundHash=background.type==='image'?add(backgroundImage(background.value).bytes):null;
  const library=avatarLibrary();
  return {assets,snapshot:{modelHash,backgroundHash,background,view:avatarView.get(),performance:avatarPerformance.state(),palettes:outfitColors(),outfits:outfitList(),
    character:{id:'main',main:true,name:config.botName,appearance:avatarState.get(),feelings:current('avatar')},
    library:{active:library.active,revision:`${modelHash}:${library.revision}`,models:library.models.map(model=>({id:model.id,name:model.name,outfit:model.outfit})),report:null}}};
}
