import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {codingToolCalls} from './coding-tools.js';
import {createLocalModels} from './local-models.js';
import {createProjectRuntime,projectEnvironment} from './project-runtime.js';
import {enabledTools,runTool} from './tools.js';

test('coder JSON bridge accepts only complete calls to offered tools',()=>{
  const tools=[{function:{name:'write'}}];
  assert.equal(codingToolCalls({content:'{"name":"write","arguments":{"text":"code"}}'},tools).length,1);
  for(const content of ['I would call write','{"name":"shell","arguments":{}}','{"name":"write","arguments":{},"explanation":"extra"}'])assert.equal(codingToolCalls({content},tools).length,0);
});
test('model probe requires the requested tool and argument, not fluent text',async()=>{
  const make=(message)=>createLocalModels({host:()=> 'http://localhost:11434',fetcher:async()=>({ok:true,json:async()=>({message})})});
  assert.equal((await make({content:'ready'}).test('coder')).status,'tool-probe-failed');
  assert.equal((await make({content:'{"name":"project_probe","arguments":{"value":"wrong"}}'}).test('coder')).status,'tool-probe-failed');
  assert.equal((await make({content:'{"name":"project_probe","arguments":{"value":"ready"}}'}).test('coder')).status,'tool-probe-passed');
});
test('project runner executes code with receipt and records failures without a shell',async()=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'project-run-'));
  const runtime=createProjectRuntime({resolve:p=>p,receipts:path.join(root,'receipts')});
  const good=await runtime.command(root,'node',['-e','console.log(2+3)']);
  assert.equal(good.status,'succeeded');assert.equal(good.stdout.trim(),'5');assert.equal(JSON.parse(readFileSync(good.receipt)).exitCode,0);
  const bad=await runtime.command(root,'node',['-e','process.exit(7)']);assert.equal(bad.status,'failed');assert.equal(bad.exitCode,7);
  await assert.rejects(runtime.command(root,'powershell',[]));
  assert.equal(projectEnvironment({PATH:'bin',HF_TOKEN:'secret',OPENAI_API_KEY:'secret'}).HF_TOKEN,undefined);
});
test('research helpers cannot execute projects or download local models',async()=>{
  const ctx={helper:true,perms:{owner:true,files:true},speaker:{id:'dashboard'},userText:'research only'};
  assert.ok(!enabledTools(ctx).some(t=>t.function.name==='project_runtime'));
  assert.match(await runTool('project_runtime',JSON.stringify({action:'run',workspace:'Documents',program:'node',args:[]}),ctx),/Error|allowed|available/i);
  assert.match(await runTool('models_local',JSON.stringify({action:'pull',model:'anything'}),ctx),/Error|owner/i);
});
