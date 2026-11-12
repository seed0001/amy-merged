import {phonemize} from 'phonemizer';
const cache=new Map();let queue=Promise.resolve();
const MAP={p:'PP',b:'PP',m:'PP',f:'FF',v:'FF','θ':'TH','ð':'TH',t:'DD',d:'DD','ɾ':'DD',k:'kk',g:'kk','ɡ':'kk','ŋ':'kk',s:'SS',z:'SS','ʃ':'CH','ʒ':'CH','tʃ':'CH','dʒ':'CH',n:'nn',l:'nn','ɹ':'RR',r:'RR','ɻ':'RR','ɜ':'RR','ɚ':'RR','ɑ':'aa','ɐ':'aa','æ':'aa','ʌ':'aa',a:'aa','ɛ':'E',e:'E','ɪ':'I',i:'I','ɔ':'O','ɒ':'O',o:'O','ʊ':'U',u:'U',w:'U',j:'I','ə':'aa',h:'aa'};
export function ipaPhones(ipa){
  const symbols=String(ipa).normalize('NFC').replaceAll('t͡ʃ','tʃ').replaceAll('d͡ʒ','dʒ');
  const result=[];let stressed=false;
  for(let i=0;i<symbols.length;i++){
    let phone=symbols[i];if(phone==='ˈ'||phone==='ˌ'){stressed=true;continue;}
    if(phone==='ː'){if(result.length)result.at(-1).weight*=1.25;continue;}
    if(phone==='|'||/[,.!?;]/.test(phone)){result.push({phone:'sil',viseme:'sil',weight:.9});continue;}
    if(MAP[symbols.slice(i,i+2)]){phone=symbols.slice(i,i+2);i++;}
    const viseme=MAP[phone];if(!viseme)continue;
    const vowel=['aa','E','I','O','U','RR'].includes(viseme);
    let weight=vowel?1.5:['SS','FF','TH','CH'].includes(viseme)?1:.65;
    if(stressed&&vowel){weight*=1.25;stressed=false;}
    if(phone==='ə'||phone==='h')weight*=.7;
    result.push({phone,viseme,weight});
  }
  return result.slice(0,1024);
}
export async function speechPhones(text){
  text=String(text||'').trim().slice(0,4000);if(!text)return [];
  if(cache.has(text))return cache.get(text);
  const work=queue.then(async()=>ipaPhones((await phonemize(text,'en-us')).join(' | ')));
  queue=work.catch(()=>{});cache.set(text,work);
  if(cache.size>128)cache.delete(cache.keys().next().value);
  try{return await work;}catch(error){cache.delete(text);throw error;}
}
