import test from 'node:test';
import assert from 'node:assert/strict';
import { managesPeers } from './bot-role.js';
import { config } from './config.js';
import { enabledTools, runTool } from './tools.js';
test('every companion has the common framework; only its management role exposes peer control',async()=>{
  const original=config.ownerIds;config.ownerIds=['test-owner'];
  const peerApps=config.peerApps;config.peerApps=['test-peer']; // bring_peer needs PEER_APPS; don't depend on the local .env
  try{
    const ctx={perms:{owner:true,files:true,search:true},speaker:{id:'test-owner'},userText:'list',turn:'1',conversation:'test'};
    const names=enabledTools(ctx).map((tool)=>tool.function.name);
    for(const name of ['goal','research_goal','calendar','project'])assert.ok(names.includes(name),name);
    assert.equal(names.includes('bring_peer'),managesPeers);
    assert.equal(names.includes('bot_control'),managesPeers);
    if(!managesPeers){assert.match(String(await runTool('bot_control',{action:'list'},ctx)),/not.available|isn.t available/i);}
  }finally{config.ownerIds=original;config.peerApps=peerApps;}
});
