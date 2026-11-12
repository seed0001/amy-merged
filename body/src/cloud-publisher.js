import {existsSync,readFileSync} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DATA_DIR} from './config.js';
import {bus,activity} from './events.js';
import {watchSnapshot} from './watch-snapshot.js';
import {speechPhones} from './speech-phonemes.js';
export function startCloudPublisher(){
  const file=path.join(DATA_DIR,'cloud-viewer.json');if(!existsSync(file))return;
  const settings=JSON.parse(readFileSync(file,'utf8'));if(!settings.url||!settings.publisherKey)return;
  const base=new URL(settings.url);if(base.protocol!=='https:')throw new Error('Cloud viewer requires HTTPS.');
  const uploaded=new Set();let syncing=null,stopped=false,lastFailure=0;
  async function request(route,body,binary=false){
    const response=await fetch(new URL(route,base),{method:binary?'PUT':'POST',headers:{Authorization:`Bearer ${settings.publisherKey}`,'Content-Type':binary?'application/octet-stream':'application/json'},body:binary?body:JSON.stringify(body),signal:AbortSignal.timeout(30000)});
    if(!response.ok)throw new Error(`Viewer relay HTTP ${response.status}`);
  }
  const failed=(error)=>{if(Date.now()-lastFailure>60000){lastFailure=Date.now();activity('error',{where:'cloud viewer',message:error.message});}};
  async function sync(){
    if(stopped)return;if(syncing)return syncing;
    syncing=(async()=>{const {assets,snapshot}=watchSnapshot();
      for(const asset of assets)if(!uploaded.has(asset.hash)){await request('/publisher/assets/'+asset.hash,asset.bytes,true);uploaded.add(asset.hash);}
      await request('/publisher/snapshot',snapshot);
    })().catch(error=>{uploaded.clear();throw error;}).finally(()=>{syncing=null;});return syncing;
  }
  let eventQueue=Promise.resolve();
  function event(data){eventQueue=eventQueue.then(async()=>{try{await sync();await request('/publisher/event',data);}catch(error){failed(error);}});return eventQueue;}
  const voice=({packet,audio})=>event({type:'discord-speech',speech:{...packet,audio:audio.toString('base64'),mime:'audio/ogg'}});
  let textQueue=Promise.resolve();
  const text=({lines})=>{textQueue=textQueue.then(async()=>{
    for(const line of lines){const phones=await speechPhones(line.text).catch(()=>[]);
      await event({type:'discord-speech',speech:{type:'start',id:randomUUID(),character:'main',at:Date.now(),text:line.text,audio:line.audio.toString('base64'),mime:'audio/mpeg',phones}});
    }
  }).catch(failed);};
  // Stops, and a peer bot's lines (peer-avatar.js: mouth only, no audio), go out as they are.
  const stop=packet=>{if(packet.type==='stop'||packet.peer)event({type:'discord-speech',speech:packet});};
  const expression=packet=>event({type:'expression',character:packet.character||'main',feelings:packet.feelings,at:packet.at});
  bus.on('discord-reply-audio',voice);bus.on('discord-text-reply',text);bus.on('discord-avatar',stop);bus.on('avatar-expression',expression);
  const timer=setInterval(()=>sync().catch(failed),5000);timer.unref();sync().catch(failed);
  return ()=>{stopped=true;clearInterval(timer);bus.off('discord-reply-audio',voice);bus.off('discord-text-reply',text);bus.off('discord-avatar',stop);bus.off('avatar-expression',expression);};
}
