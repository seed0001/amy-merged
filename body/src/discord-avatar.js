import prism from 'prism-media';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { bus } from './events.js';
import {speechPhones} from './speech-phonemes.js';
import {compileArticulation} from './dashboard/public/speech-articulation.js';

export function pcmEnvelope(pcm,{rate=48000,channels=2,frameMs=40}={}){
  const samples=Math.floor(rate*frameMs/1000);const frames=[];
  for(let start=0;start<pcm.length;start+=samples*channels*2){
    let sum=0,crossings=0,last=0,count=0;
    for(let i=start;i<Math.min(pcm.length,start+samples*channels*2)-1;i+=channels*2){const v=pcm.readInt16LE(i)/32768;sum+=v*v;if(v*last<0)crossings++;last=v;count++;}
    const open=Math.max(0,Math.min(1,(Math.sqrt(sum/Math.max(1,count))-.008)*6));
    const bright=Math.min(1,crossings/Math.max(1,count)*7);
    frames.push({open,wide:open*bright,round:open*(1-bright)});
  }
  return {frames,frameMs,durationMs:pcm.length/(rate*channels*2)*1000};
}
// character: which cast member is speaking ('main' is her; a guest like the architect has his own id), so
// the Studio page moves that avatar's mouth and, in face view, turns the camera to them.
export async function prepareDiscordSpeech(clip,text,conversation,character='main'){
  if(!Buffer.isBuffer(clip)||clip.subarray(0,4).toString()!=='OggS')throw new Error('Expected an Ogg Opus speech clip.');
  const demux=new prism.opus.OggDemuxer(),decoder=new prism.opus.Decoder({rate:48000,channels:2,frameSize:960});
  const chunks=[];let bytes=0;
  const phonesJob=speechPhones(text).catch(()=>[]);
  await new Promise((resolve,reject)=>{
    const source=Readable.from([clip]);source.on('error',reject);demux.on('error',reject);decoder.on('error',reject);
    decoder.on('data',(chunk)=>{bytes+=chunk.length;if(bytes>48000*2*2*180){decoder.destroy(new Error('Speech envelope exceeds three minutes'));return;}chunks.push(chunk);});
    decoder.on('end',resolve);source.pipe(demux).pipe(decoder);
  });
  if(!bytes)throw new Error('Speech clip contained no decodable audio.');
  const pcm=Buffer.concat(chunks),samples=new Float32Array(Math.floor(pcm.length/4));
  for(let i=0;i<samples.length;i++)samples[i]=(pcm.readInt16LE(i*4)+pcm.readInt16LE(i*4+2))/65536;
  const track=compileArticulation(samples,48000,await phonesJob);
  const frames=track.frames.map(frame=>Object.fromEntries(['open','wide','round','bright'].map(key=>[key,Math.round(frame[key]*1000)/1000])));
  return {type:'start',id:randomUUID(),character:character||'main',conversation,text,frames,frameMs:track.frameMs,durationMs:track.durationMs,
    articulation:{version:2,cues:track.cues,timing:track.timing}};
}
const active=new Map();
export function startDiscordSpeech(packet,audio){const event={...packet,at:Date.now()};active.set(packet.conversation,event);bus.emit('discord-avatar',event);if(audio)bus.emit('discord-reply-audio',{packet:event,audio});return event;}
export function stopDiscordSpeech(conversation,id){const event=active.get(conversation);if(!event || (id && event.id!==id))return;active.delete(conversation);bus.emit('discord-avatar',{type:'stop',id:event.id,conversation,character:event.character,at:Date.now(),reason:id?'ended':'interrupted'});}
export const activeDiscordSpeech=()=>[...active.values()];
