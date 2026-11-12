import http from 'node:http';
import {readFile,writeFile,mkdir,stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {timingSafeEqual,createHash,createHmac} from 'node:crypto';
const ROOT=path.dirname(fileURLToPath(import.meta.url));
const same=(a,b)=>{const aa=Buffer.from(String(a||'')),bb=Buffer.from(String(b||''));return aa.length===bb.length&&aa.length>0&&timingSafeEqual(aa,bb);};
export async function createViewer({root=ROOT,publisherKey=process.env.PUBLISHER_KEY,watchKey=process.env.WATCH_KEY}={}){
  if(!publisherKey||!watchKey)throw new Error('Publisher and watch keys must be configured.');
  const session=createHmac('sha256',watchKey).update('new-champ-viewer').digest('hex');
  const clients=new Set();let snapshot=JSON.parse(await readFile(path.join(root,'seed.json'),'utf8')),lastSeen=0;
  const dynamic=path.join(root,'runtime-assets');await mkdir(dynamic,{recursive:true});
  const json=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
  const body=async(req,limit=10*1024*1024)=>{const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>limit)throw Object.assign(new Error('Request too large'),{status:413});chunks.push(chunk);}return Buffer.concat(chunks);};
  const broadcast=event=>{const data=`data: ${JSON.stringify(event)}\n\n`;for(const res of clients)if(!res.write(data)&&res.writableLength>12*1024*1024)res.destroy();};
  const stateEvents=()=>[
    {type:'background',background:snapshot.background},{type:'view',view:snapshot.view},
    {type:'appearance',appearance:snapshot.character.appearance},{type:'performance',performance:snapshot.performance},
    {type:'outfit-colors',palettes:snapshot.palettes},{type:'expression',character:'main',feelings:snapshot.character.feelings},
    {type:'relay-status',online:Date.now()-lastSeen<20000},
  ];
  const asset=async(hash)=>{
    if(!/^[a-f0-9]{64}$/.test(hash||''))throw Object.assign(new Error('Asset not found'),{status:404});
    for(const directory of [dynamic,path.join(root,'assets')])try{return await readFile(path.join(directory,hash));}catch{}
    throw Object.assign(new Error('Asset not found'),{status:404});
  };
  const server=http.createServer(async(req,res)=>{
    try{
      const url=new URL(req.url,'http://viewer');
      res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Content-Type-Options','nosniff');
      if(url.pathname==='/health')return json(res,200,{ok:true});
      const watchLink=url.pathname.match(/^\/watch\/([a-f0-9]+)$/i);
      if(req.method==='GET'&&watchLink){
        if(!same(watchLink[1],watchKey))return json(res,401,{error:'Invalid watch link.'});
        const secure=req.headers['x-forwarded-proto']==='https'?'; Secure':'';
        res.writeHead(302,{'Set-Cookie':`watch_session=${session}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${secure}`,Location:'/', 'Cache-Control':'no-store'});
        return res.end();
      }
      const authenticated=(req.headers.cookie||'').split(';').some(cookie=>same(cookie.trim(),`watch_session=${session}`));
      if(url.pathname==='/session'){
        if(req.method==='GET')return json(res,authenticated?200:401,{ok:authenticated});
        if(req.method!=='POST')return json(res,405,{error:'Method not allowed'});
        const input=JSON.parse(await body(req,4096));if(!same(input.key,watchKey))return json(res,401,{error:'Use your private watch link.'});
        const secure=req.headers['x-forwarded-proto']==='https'?'; Secure':'';
        res.setHeader('Set-Cookie',`watch_session=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${secure}`);
        return json(res,200,{ok:true});
      }
      if(url.pathname.startsWith('/publisher/')){
        if(!same(req.headers.authorization,`Bearer ${publisherKey}`))return json(res,401,{error:'Unauthorized'});
        if(req.method==='PUT'&&url.pathname.startsWith('/publisher/assets/')){
          const hash=url.pathname.split('/').at(-1),bytes=await body(req,60*1024*1024);
          if(createHash('sha256').update(bytes).digest('hex')!==hash)return json(res,400,{error:'Invalid asset hash'});
          await writeFile(path.join(dynamic,hash),bytes);lastSeen=Date.now();return json(res,200,{ok:true});
        }
        if(req.method!=='POST')return json(res,405,{error:'Method not allowed'});
        const input=JSON.parse(await body(req));lastSeen=Date.now();
        if(url.pathname==='/publisher/snapshot'){
          if(input.character?.id!=='main'||!/^[a-f0-9]{64}$/.test(input.modelHash))return json(res,400,{error:'Invalid snapshot'});
          await asset(input.modelHash);snapshot=input;for(const event of stateEvents())broadcast(event);
          return json(res,200,{ok:true});
        }
        if(url.pathname==='/publisher/event'){
          if(!['discord-speech','expression','performance'].includes(input.type))return json(res,400,{error:'Unsupported event'});
          broadcast(input);return json(res,200,{ok:true});
        }
        return json(res,404,{error:'Not found'});
      }
      if(url.pathname.startsWith('/api/')){
        if(!authenticated)return json(res,401,{error:'Use your private watch link.'});
        if(req.method!=='GET')return json(res,405,{error:'Watch-only service'});
        if(url.pathname==='/api/avatar/live'){
          res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache',Connection:'keep-alive'});
          for(const event of stateEvents())res.write(`data: ${JSON.stringify(event)}\n\n`);clients.add(res);
          const keep=setInterval(()=>res.write(': live\n\n'),15000);
          res.on('close',()=>{clearInterval(keep);clients.delete(res);});return;
        }
        if(url.pathname==='/api/avatar/characters')return json(res,200,[snapshot.character]);
        if(url.pathname==='/api/avatar/library')return json(res,200,snapshot.library);
        if(url.pathname==='/api/avatar/outfits')return json(res,200,snapshot.outfits);
        if(url.pathname==='/api/avatar/model/main'){
          res.writeHead(200,{'Content-Type':'model/gltf-binary','Cache-Control':'no-cache'});return res.end(await asset(snapshot.modelHash));
        }
        if(url.pathname.startsWith('/api/avatar/background/image/')){
          if(url.pathname.split('/').at(-1)!==snapshot.background?.value)return json(res,404,{error:'Not found'});
          res.writeHead(200,{'Content-Type':snapshot.background.mime,'Cache-Control':'private,max-age=60'});return res.end(await asset(snapshot.backgroundHash));
        }
        return json(res,404,{error:'Not found'});
      }
      if(req.method!=='GET')return json(res,405,{error:'Watch-only service'});
      const filename=url.pathname==='/'?'index.html':url.pathname.slice(1);
      if(!/^[a-zA-Z0-9_.-]+$/.test(filename))return json(res,404,{error:'Not found'});
      const mime=filename.endsWith('.js')?'text/javascript':filename.endsWith('.html')?'text/html':'application/octet-stream';
      const bytes=await readFile(path.join(root,'public',filename));res.writeHead(200,{'Content-Type':mime,'Cache-Control':'no-cache'});res.end(bytes);
    }catch(error){if(!res.headersSent)json(res,error.status||500,{error:error.status?error.message:'Request failed'});else res.end();}
  });
  return {server,getSnapshot:()=>snapshot};
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
  const {server}=await createViewer();server.listen(Number(process.env.PORT||8080),'0.0.0.0',()=>console.log('New Champ live viewer ready'));
}
