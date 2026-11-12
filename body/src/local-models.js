import { codingToolCalls } from './coding-tools.js';
import { config } from './config.js';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { resolve } from './files.js';

export function createLocalModels({host=()=>config.ollama.host,fetcher=(...args)=>fetch(...args)}={}){
  async function request(route,body,timeout=30000){
    const response=await fetcher(new URL(route,host()),{method:body?'POST':'GET',headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(timeout)});
    if(!response.ok)throw new Error('Ollama '+route+' failed ('+response.status+').');
    const result=await response.json();if(result.error)throw new Error(result.error);return result;
  }
  const modelName=(name)=>{if(typeof name!=='string'||!name.trim()||/[\s\r\n\0]/.test(name))throw new Error('Give an exact Ollama model tag.');return name.trim();};
  const list=()=>request('/api/tags');
  async function show(name){return request('/api/show',{model:modelName(name)});}
  async function pull(name){name=modelName(name);await request('/api/pull',{model:name,stream:false},1800000);const installed=(await list()).models?.find((m)=>m.name===name || m.model===name);if(!installed)throw new Error('Pull finished but the model is absent from the local registry.');return {status:'installed',model:installed.name,digest:installed.digest,bytes:installed.size};}
  async function importGGUF(name,file){const full=resolve(file);if(!/\.gguf$/i.test(full)||!existsSync(full)||!statSync(full).isFile())throw new Error('Select a downloaded .gguf file.');const header=Buffer.alloc(4);const fd=(await import('node:fs')).openSync(full,'r');try{(await import('node:fs')).readSync(fd,header,0,4,0);}finally{(await import('node:fs')).closeSync(fd);}if(header.toString()!=='GGUF')throw new Error('This file does not have a GGUF header.');
    return request('/api/create',{model:modelName(name),files:{[full]:await (async()=>{const {createReadStream}=await import('node:fs');const {createHash}=await import('node:crypto');const hash=createHash('sha256');for await(const chunk of createReadStream(full))hash.update(chunk);const digest='sha256:'+hash.digest('hex');const present=await fetcher(new URL('/api/blobs/'+digest,host()),{method:'HEAD'});if(!present.ok){const stream=createReadStream(full);const uploaded=await fetcher(new URL('/api/blobs/'+digest,host()),{method:'POST',body:stream,duplex:'half',signal:AbortSignal.timeout(1800000)});if(!uploaded.ok)throw new Error('GGUF upload to Ollama failed.');}return digest;})()},stream:false},1800000);
  }
  async function test(name){
    const result=await request('/api/chat',{model:modelName(name),stream:false,think:false,keep_alive:'2m',options:{num_ctx:8192,num_predict:128,temperature:0},messages:[{role:'user',content:'Call the project_probe tool with value ready. Do not write an explanation.'}],tools:[{type:'function',function:{name:'project_probe',description:'A read-only tool-calling capability probe.',parameters:{type:'object',properties:{value:{type:'string'}},required:['value']}}}]},180000);
    const call=codingToolCalls(result.message,[{function:{name:'project_probe'}}]).find((c)=>c.function?.name==='project_probe' && c.function.arguments?.value==='ready');
    return {model:name,status:call?'tool-probe-passed':'tool-probe-failed',tool:call?.function?.name,arguments:call?.function?.arguments};
  }
  return {list,show,pull,importGGUF,test};
}
let models;
export const localModels=()=>models??=createLocalModels();
