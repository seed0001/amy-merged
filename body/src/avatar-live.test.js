import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {startDashboard} from './dashboard/server.js';
import {config} from './config.js';
import {startDiscordSpeech,stopDiscordSpeech} from './discord-avatar.js';
import {bus} from './events.js';
import {speechPhones} from './speech-phonemes.js';

test('appearance API persists data and live stream carries Discord movement without audio',async()=>{
  config.dashboard.host='127.0.0.1';config.dashboard.port=0;config.dashboard.password='';
  const server=startDashboard({});await once(server,'listening');
  const base='http://127.0.0.1:'+server.address().port;
  const abort=new AbortController();let reader;
  const listeners=bus.listenerCount('discord-avatar');
  try{
    const saved=await fetch(base+'/api/avatar/appearance',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({hair:'purple',eyes:'green'})}).then(r=>r.json());
    assert.equal(saved.hair,'#8053ad');
    const read=await fetch(base+'/api/avatar/appearance').then(r=>r.json());assert.equal(read.eyes,'#408b57');
    const response=await fetch(base+'/api/avatar/live',{signal:abort.signal});reader=response.body.getReader();
    const first=new TextDecoder().decode((await reader.read()).value);assert.match(first,/#8053ad/);
    assert.match(first,/^data: \{"type":"power","online":false\}\n\ndata: \{"type":"sleep"/);
    startDiscordSpeech({type:'start',id:'api-test',character:'main',conversation:'api-test',text:'hello',frameMs:40,frames:[{open:.5,wide:.2,round:.3}]});
    const next=new TextDecoder().decode((await reader.read()).value);
    assert.match(next,/discord-speech/);assert.match(next,/frames/);assert.doesNotMatch(next,/"audio"|"clip"|base64/);
    stopDiscordSpeech('api-test');
    const stop=new TextDecoder().decode((await reader.read()).value);assert.match(stop,/"type":"stop"/);
  }finally{
    stopDiscordSpeech('api-test');abort.abort();await reader?.cancel().catch(()=>{});
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
    for(let i=0;i<20 && bus.listenerCount('discord-avatar')!==listeners;i++)await new Promise(resolve=>setTimeout(resolve,5));assert.equal(bus.listenerCount('discord-avatar'),listeners);
    // The speech event above starts the espeak phonemizer (a wasm module) initialising on V8's background threads.
    // The runner force-exits the moment this file is done, and on Windows exiting while that is still in flight
    // aborts the process (libuv: "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)"), so wait for it to be ready.
    await speechPhones('hello');
  }
});
