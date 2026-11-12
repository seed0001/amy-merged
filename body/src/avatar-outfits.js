import { existsSync,readFileSync,writeFileSync,renameSync,mkdirSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { config,DATA_DIR } from './config.js';
import { avatarLibrary,selectAvatar } from './avatar-library.js';
import { colorValue } from './avatar-state.js';
import { bus } from './events.js';
import { wardrobeEntries } from './seamstress.js';
const colorsFile=path.join(DATA_DIR,'outfits','colors.json');
function baseHash(){return createHash('sha256').update(readFileSync(config.avatar.path)).digest('hex');}
export function outfitColors(){
  if(!existsSync(colorsFile)||!existsSync(config.avatar.path))return {};
  const saved=JSON.parse(readFileSync(colorsFile,'utf8'));return saved.baseSha256===baseHash()?saved.palettes:{};
}
export function setOutfitColors(id,{fabric,sheen}){
  const wardrobe=outfitList();id ||= wardrobe.active;
  if(!wardrobe.outfits.some(outfit=>outfit.id===id))throw new Error('Choose an installed outfit before setting its colors.');
  const palettes=outfitColors(),next={fabric:null,sheen:null,...palettes[id]};
  for(const [field,value] of Object.entries({fabric,sheen}))if(value!==undefined&&value!=='')next[field]=value===null?null:colorValue(value);
  palettes[id]=next;mkdirSync(path.dirname(colorsFile),{recursive:true});
  writeFileSync(colorsFile+'.tmp',JSON.stringify({baseSha256:baseHash(),palettes},null,2));renameSync(colorsFile+'.tmp',colorsFile);
  bus.emit('avatar-outfit-colors',palettes);return {id,colors:next};
}
export function outfitList(){
  const file=path.join(DATA_DIR,'outfits','wardrobe.json');
  const wardrobe=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{outfits:[]};
  const originalHash=createHash('sha256').update(readFileSync(config.avatar.path)).digest('hex');
  // Her own sewn outfits (seamstress.js) sit in the wardrobe beside the built-in ones.
  const outfits=[{id:'suit',name:'Original suit',modelId:'original'},...(wardrobe.baseSha256===originalHash?wardrobe.outfits:[]),...wardrobeEntries()];
  const library=avatarLibrary();
  const palettes=outfitColors();
  return {outfits:outfits.map(outfit=>({...outfit,colors:palettes[outfit.id]||{fabric:null,sheen:null}})),active:outfits.find(outfit=>outfit.modelId===library.active)?.id||null,report:library.report,palettes};
}
export function wearOutfit(id){
  const outfit=outfitList().outfits.find(outfit=>outfit.id===id);
  if(!outfit)throw new Error('Unknown outfit. List available outfits first.');
  const selected=selectAvatar(outfit.modelId);
  return {outfit,revision:selected.revision,message:selected.message};
}
// Her own collection: outfit designs she makes from what's installed (a base garment plus the fabric
// and sheen colours she picked) with a name and her notes. Wearing a design puts the base on and
// applies its colours. New garments themselves (new meshes) are not made here; that's the owner's
// avatar pipeline. designs.json lives beside the wardrobe and survives a memory wipe (it's her work).
const designsFile=path.join(DATA_DIR,'outfits','designs.json');
const readDesigns=()=>{try{return existsSync(designsFile)?JSON.parse(readFileSync(designsFile,'utf8')):{designs:[],next:1};}catch{return {designs:[],next:1};}};
const writeDesigns=(state)=>{mkdirSync(path.dirname(designsFile),{recursive:true});writeFileSync(designsFile+'.tmp',JSON.stringify(state,null,2));renameSync(designsFile+'.tmp',designsFile);};
export function listDesigns(){return readDesigns().designs;}
export function saveDesign({name,base,fabric,sheen,notes=''}){
  const wardrobe=outfitList();base ||= wardrobe.active;
  if(!wardrobe.outfits.some(o=>o.id===base))throw new Error(`Unknown base outfit "${base}". Installed: ${wardrobe.outfits.map(o=>o.id).join(', ')}.`);
  const clean=String(name??'').trim().slice(0,60);if(clean.length<2)throw new Error('Give the design a name.');
  const colors={fabric:fabric===undefined||fabric===''?null:fabric===null?null:colorValue(fabric),sheen:sheen===undefined||sheen===''?null:sheen===null?null:colorValue(sheen)};
  if(!colors.fabric&&!colors.sheen)throw new Error('A design needs at least a fabric or a sheen colour of its own; otherwise it is just the base outfit.');
  const state=readDesigns();
  const design={id:`design-${state.next++}`,name:clean,base,colors,notes:String(notes).slice(0,300),at:Date.now()};
  state.designs.push(design);writeDesigns(state);bus.emit('avatar-outfit-designs',state.designs);
  return design;
}
export function wearDesign(id){
  const design=listDesigns().find(d=>d.id===id||d.name.toLowerCase()===String(id).toLowerCase());
  if(!design)throw new Error(`No design "${id}" in your collection. Your designs: ${listDesigns().map(d=>`${d.id} (${d.name})`).join(', ')||'none yet'}.`);
  const worn=wearOutfit(design.base);
  const colored=setOutfitColors(design.base,{fabric:design.colors.fabric??null,sheen:design.colors.sheen??null});
  return {design,worn,colored,message:`${worn.message} Colours applied for "${design.name}".`};
}
export function outfitPrompt(){
  try{const wardrobe=outfitList();const active=wardrobe.outfits.find(outfit=>outfit.id===wardrobe.active);return `3D avatar wardrobe: ${wardrobe.outfits.map(outfit=>`${outfit.id}: ${outfit.name}, saved colors ${JSON.stringify(outfit.colors)}`).join('; ')}. Selected outfit: ${active?.name||'custom avatar'}. Names describe the original style; saved fabric and sheen colors override its original color. Use avatar_outfit to switch clothing or set colors on this same avatar; this is separate from generated selfie looks. A selection needs player feedback to confirm it rendered. Your own collection (designs you made: a base garment in your colours, with a name): ${listDesigns().map(d=>`${d.id} "${d.name}" (${d.base}, fabric ${d.colors.fabric??'original'}, sheen ${d.colors.sheen??'original'})`).join('; ')||'nothing designed yet'}. avatar_outfit design saves a new one; wear with a design id puts it on. New garments themselves you make with the seamstress tool: designed by you, cut from patterns to your body, sewn and draped; they show here as "(sewn)" once finished.`;}catch{return '';}
}
