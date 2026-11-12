import {readFileSync,writeFileSync,mkdirSync,copyFileSync} from 'node:fs';
import path from 'node:path';
import {ROOT} from '../src/config.js';
import {watchSnapshot} from '../src/watch-snapshot.js';
const target=path.join(ROOT,'live-viewer'),publicDir=path.join(target,'public');mkdirSync(publicDir,{recursive:true});mkdirSync(path.join(target,'assets'),{recursive:true});
for(const name of ['avatar.js','avatar-appearance.js','avatar-eye-mask.js','avatar-performance.js','speech-articulation.js','generation-delivery-ui.js'])copyFileSync(path.join(ROOT,'src','dashboard','public',name),path.join(publicDir,name));
let html=readFileSync(path.join(ROOT,'src','dashboard','public','avatar.html'),'utf8');
html=html.replace('<title>','<title>New Champ Live · ');
const style=`<style>
body{overflow:hidden}body .topbar,body aside,body .dock,body #reopen,body .reopen,body .drop{display:none!important}
:root{--panel-w:0px!important}body .caption{bottom:32px!important}
#watchStatus{position:fixed;top:20px;left:24px;z-index:20;color:#eee;font:12px system-ui;letter-spacing:.12em;text-shadow:0 1px 6px #000}
#startWatching{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:30;background:#fff;color:#151722;border:0;padding:18px 28px;border-radius:30px;font:600 16px system-ui;cursor:pointer;box-shadow:0 8px 60px #0008}
#watchError{position:fixed;inset:0;display:grid;place-items:center;background:#11131b;color:#eee;z-index:40;font:18px system-ui}
</style>`;
html=html.replace('</head>',style+'</head>').replace('<body>','<body class="collapsed watch-only"><div id="watchStatus">Connecting to New Champ</div>');
html=html.replace('<script type="module" src="/avatar.js"></script>',`<script type="module">
window.WATCH_ONLY=true;
try{
 const key=new URLSearchParams(location.hash.slice(1)).get('key');
 const response=key?await fetch('/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key})}):await fetch('/session');
 if(!response.ok)throw new Error('Open your private New Champ watch link to continue.');
 await import('/avatar.js');
}catch(error){const box=document.createElement('div');box.id='watchError';box.textContent=error.message;document.body.append(box);}
</script>`);
writeFileSync(path.join(publicDir,'index.html'),html);
const {snapshot,assets}=watchSnapshot();for(const asset of assets)writeFileSync(path.join(target,'assets',asset.hash),asset.bytes);
writeFileSync(path.join(target,'seed.json'),JSON.stringify(snapshot));console.log('Prepared watch-only viewer and avatar assets.');
