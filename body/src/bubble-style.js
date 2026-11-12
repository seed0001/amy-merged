import {existsSync,readFileSync,writeFileSync,renameSync} from 'node:fs';
import path from 'node:path';
import {DATA_DIR} from './config.js';
import {bus} from './events.js';
// How big the tool and background bubbles on her avatar page are: 1 is normal, and she can change it by voice.
export const DEFAULT_BUBBLES={scale:1};
export const BUBBLE_LIMITS={scale:[.75,3]};
export function createBubbleStyle(file=path.join(DATA_DIR,'bubble-style.json'),emit=state=>bus.emit('avatar-bubble-style',state)){
  const get=()=>({...DEFAULT_BUBBLES,...(existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{})});
  function set(scale){
    const [min,max]=BUBBLE_LIMITS.scale;
    if(!Number.isFinite(scale)||scale<min||scale>max)throw new Error(`size must be between ${min} and ${max}; nothing was changed.`);
    const next={scale:+scale.toFixed(3)};
    writeFileSync(file+'.tmp',JSON.stringify(next,null,2));renameSync(file+'.tmp',file);emit(next);return next;
  }
  return {get,set};
}
export const bubbleStyle=createBubbleStyle();
