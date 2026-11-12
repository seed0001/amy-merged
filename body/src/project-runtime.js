import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DATA_DIR } from './config.js';
import { resolve as resolveProjectPath, homeFolder } from './files.js';

const execute=promisify(execFile);
export function projectEnvironment(env=process.env){
  const permitted=new Set(['path','systemroot','windir','comspec','userprofile','home','homedrive','homepath','localappdata','appdata','temp','tmp','programfiles','programfiles(x86)','pythonpath','rocm_path','cuda_path']);
  const out=Object.fromEntries(Object.entries(env).filter(([key])=>permitted.has(key.toLowerCase())));
  out.PIP_DISABLE_PIP_VERSION_CHECK='1';out.PIP_NO_INPUT='1';out.NO_COLOR='1';return out;
}
export function createProjectRuntime({run=execute,resolve=resolveProjectPath,receipts=path.join(DATA_DIR,'project-runs'),platform=process.platform,node=process.execPath}={}){
  async function command(workspace,program,args,timeout=120000){
    const allowed=['node','python','python3','npm'];
    if(!allowed.includes(program))throw new Error('Use node, python or npm; commands run without a shell.');
    if(!Array.isArray(args)||args.some((arg)=>typeof arg!=='string'||arg.includes('\0')))throw new Error('Arguments must be a string array.');
    // A path that names another user's folder (a name typed from memory) is refused here, with the real one.
    const home=homeFolder();const owner=path.basename(home).toLowerCase();
    const typed=args.join(' ').match(/[A-Za-z]:[\\/]+Users[\\/]+([^\\/\s'"`]+)/i);
    if(typed&&typed[1].toLowerCase()!==owner)throw new Error(`That path uses the user folder "${typed[1]}", which isn't your owner's. Their home folder is ${home}; use that path or Desktop\\... instead.`);
    const cwd=resolve(workspace);mkdirSync(cwd,{recursive:true});
    let executable=program,argv=args;
    if(program==='node')executable=node;
    if(program==='python3'&&platform==='win32')executable='python';
    if(['python','python3'].includes(program)){const venvPython=path.join(cwd,'.venv',platform==='win32'?'Scripts/python.exe':'bin/python');if(existsSync(venvPython))executable=venvPython;}
    if(program==='npm'){
      const cli=process.env.npm_execpath?.endsWith('npm-cli.js')?process.env.npm_execpath:path.join(path.dirname(node),'node_modules','npm','bin','npm-cli.js');
      if(!existsSync(cli))throw new Error('npm CLI is not available beside Node.js.');
      executable=node;argv=[cli,...args];
    }
    const id=randomUUID(),at=Date.now();let result;
    try{const out=await run(executable,argv,{cwd,windowsHide:true,shell:false,timeout:Math.min(600000,Math.max(1000,timeout)),maxBuffer:2*1024*1024,env:projectEnvironment()});result={id,workspace:cwd,program,args,status:'succeeded',exitCode:0,stdout:String(out.stdout||'').slice(-20000),stderr:String(out.stderr||'').slice(-10000)};}
    catch(error){result={id,workspace:cwd,program,args,status:'failed',exitCode:typeof error.code==='number'?error.code:null,stdout:String(error.stdout||'').slice(-20000),stderr:String(error.stderr||error.message).slice(-10000),timedOut:Boolean(error.killed)};}
    result.at=at;result.finished=Date.now();mkdirSync(receipts,{recursive:true});result.receipt=path.join(receipts,id+'.json');writeFileSync(result.receipt,JSON.stringify(result,null,2));return result;
  }
  async function install(workspace,manager,packages){
    if(!['npm','python'].includes(manager))throw new Error('Choose npm or python dependencies.');
    if(!Array.isArray(packages)||!packages.length||packages.some((p)=>typeof p!=='string'||!p||p.startsWith('-')||/[\r\n\0]/.test(p)))throw new Error('Provide explicit package names, not command flags.');
    if(manager==='npm')return command(workspace,'npm',['install','--no-audit','--no-fund','--',...packages],600000);
    const cwd=resolve(workspace),venv=path.join(cwd,'.venv');
    if(!existsSync(venv)){const created=await command(cwd,'python',['-m','venv',venv],120000);if(created.status!=='succeeded')return created;}
    return {...await command(cwd,'python',['-m','pip','install','--',...packages],600000),environment:venv};
  }
  return {command,install};
}
let shared;
export const projectRuntime=()=>shared??=createProjectRuntime();
