import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { findPeer, peerMention, bringPeer, peerConfiguration } from './peers.js';

test('configured companions retain their account IDs and name aliases', () => {
  const config=peerConfiguration();
  assert.equal(config.apps.length,4);
  assert.equal(findPeer(config.apps,'Howard').name,'Gramps');
  for(const peer of config.apps) assert.match(peer.id,/^\d+$/);
  assert.ok(config.ownerIds.length);
  assert.equal(peerMention(config.apps,'Alex','Hello').content,`<@${findPeer(config.apps,'Alex').id}> Hello`);
});
test('a running companion is brought into the requested voice channel without being launched again',async()=>{
  const calls=[];
  const result=await bringPeer({name:'Alex',port:3001},{voiceChannelId:'vc'},{fetchImpl:async(url,options)=>{calls.push({url,options});return {ok:true};},spawnImpl:()=>assert.fail('Already running')});
  assert.match(result,/joining/);
  assert.equal(JSON.parse(calls[1].options.body).channelId,'vc');
});
test('starting an offline companion preserves its identity by stripping Amy environment variables',async()=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'amy-peer-'));
  writeFileSync(path.join(dir,'start.bat'),'@echo off');
  let options;
  const result=await bringPeer({name:'Alex',port:3001,dir},{guildId:'g',voiceChannelId:'vc'},{fetchImpl:async()=>{throw Error('offline');},ownEnv:{DISCORD_TOKEN:'do-not-inherit',HALMINI_NAME:'Bella',PATH:'keep'},spawnImpl:(command,args,opts)=>{options=opts;const child=new EventEmitter();child.unref=()=>{};queueMicrotask(()=>child.emit('spawn'));return child;}});
  assert.match(result,/Started Alex/);
  assert.equal(options.env.DISCORD_TOKEN,undefined);
  assert.equal(options.env.HALMINI_NAME,undefined);
  assert.equal(options.env.PATH,'keep');
  assert.equal(options.windowsHide,true);
  assert.equal(JSON.parse(readFileSync(path.join(dir,'data/restart.json'))).voiceChannelId,'vc');
});
test('bot replies reach Amy even when the other companion suppressed its reply ping',async()=>{
  const source=readFileSync(new URL('./index.js',import.meta.url),'utf8');
  const code=source.slice(source.indexOf('client.on(Events.MessageCreate,'),source.indexOf('async function handlePeerRequest'));
  const sent=[];let receive;
  const client={user:{id:'amy',username:'Bella'},on:(event,fn)=>{receive=fn;}};
  const context=vm.createContext({client,Events:{MessageCreate:'message'},env:{HALMINI_NAME:'Bella'},PREFIX:'!',LISTEN_TO_BOTS:true,TEXT_CHANNELS:new Set(),send:msg=>sent.push(msg),handleCommand:()=>{}});
  vm.runInContext(code,context);
  await receive({author:{id:'alex',username:'Alex',bot:true},content:'Here is my answer.',guild:{members:{me:{displayName:'Bella'}}},channel:{id:'channel',messages:{fetch:async()=>({author:{id:'amy'}})}},id:'reply',reference:{messageId:'original'},mentions:{users:{has:()=>false}},member:{displayName:'Alex'}});
  assert.equal(sent.length,1);assert.equal(sent[0].author.bot,true);assert.equal(sent[0].direct,true);
});
test('Amy replies directly to the sending companion so its Discord mention routing can receive the answer',async()=>{
  const source=readFileSync(new URL('./index.js',import.meta.url),'utf8');
  const code=source.slice(source.indexOf('async function onEngineMessage'),source.indexOf('readline.createInterface'));
  const replies=[];
  const context=vm.createContext({client:{channels:{fetch:async()=>({messages:{fetch:async()=>({reply:async text=>replies.push(text)})},send:()=>assert.fail('Expected reply')})}},chunkMessage:text=>[text],log:()=>{}});
  vm.runInContext(code,context);
  await context.onEngineMessage({type:'say',channel:'channel',replyTo:'from-alex',content:'Hello Alex'});
  assert.deepEqual(replies,['Hello Alex']);
});
