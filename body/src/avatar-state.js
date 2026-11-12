import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { bus } from './events.js';
import { createHash } from 'node:crypto';
import { activeAvatarPath } from './avatar-library.js';

const COLORS={black:'#111111',white:'#eeeeee',red:'#c82836',blue:'#3278cc',green:'#408b57',brown:'#754b32',blonde:'#d9b76c',blond:'#d9b76c',pink:'#dc709d',purple:'#8053ad',silver:'#bfc4ce',grey:'#85878e',gray:'#85878e',hazel:'#8f8241',auburn:'#9b4d35',ginger:'#bf6a32',rose:'#b8647e',nude:'#b97f74',coral:'#df7970',gold:'#cda54e',orange:'#d87830'};
export const APPEARANCE_FIELDS=['hair','hairStreak','eyes','irisInner','irisOuter','irisStarburst','irisFlecks','outerEye','lipstick','eyeshadow','blush'];
export function colorValue(value){
  const clean=String(value).trim().toLowerCase();
  if(['none','default','reset'].includes(clean))return null;
  if(COLORS[clean])return COLORS[clean];
  if(/^#[0-9a-f]{6}$/.test(clean))return clean;
  if(/^#[0-9a-f]{3}$/.test(clean))return '#'+[...clean.slice(1)].map((c)=>c+c).join('');
  throw new Error('Use a known color name or #RRGGBB; use none to restore the model default.');
}
export function createAvatarState(file=path.join(DATA_DIR,'avatar-state.json'),emit=(event)=>bus.emit('avatar-appearance',event)){
  const load=()=>{if(!existsSync(file))return {};return JSON.parse(readFileSync(file,'utf8'));};
  const get=(id='main')=>({character:id,hair:null,hairStreak:null,hairStreakAmount:0.35,eyes:null,irisInner:null,irisOuter:null,irisStarburst:null,irisFlecks:null,outerEye:null,lipstick:null,eyeshadow:null,blush:null,lipGloss:0,makeupIntensity:0.55,...load()[id]});
  function set(id,patch,reset=false){
    if(!/^[a-z0-9_-]+$/i.test(id))throw new Error('Invalid character ID.');
    const state=load();const next=reset?{character:id,hair:null,hairStreak:null,hairStreakAmount:0.35,eyes:null,irisInner:null,irisOuter:null,irisStarburst:null,irisFlecks:null,outerEye:null,lipstick:null,eyeshadow:null,blush:null,lipGloss:0,makeupIntensity:0.55}:get(id);
    for(const key of APPEARANCE_FIELDS)if(patch[key]!==undefined && patch[key]!=='')next[key]=patch[key]===null?null:colorValue(patch[key]);
    if(patch.makeupIntensity!==undefined){if(!Number.isFinite(patch.makeupIntensity)||patch.makeupIntensity<0||patch.makeupIntensity>1)throw new Error('Makeup intensity must be between 0 and 1.');next.makeupIntensity=patch.makeupIntensity;}
    if(patch.lipGloss!==undefined){if(!Number.isFinite(patch.lipGloss)||patch.lipGloss<0||patch.lipGloss>1)throw new Error('Lip gloss must be between 0 (off) and 1 (high shine).');next.lipGloss=patch.lipGloss;}
    if(patch.hairStreakAmount!==undefined){if(!Number.isFinite(patch.hairStreakAmount)||patch.hairStreakAmount<0||patch.hairStreakAmount>1)throw new Error('Hair streak amount must be between 0 (none) and 1 (most streaks).');next.hairStreakAmount=patch.hairStreakAmount;}
    next.updatedAt=Date.now();state[id]=next;
    writeFileSync(file+'.tmp',JSON.stringify(state,null,2));renameSync(file+'.tmp',file);emit(next);return next;
  }
  const modelKey=(modelPath)=>createHash('sha256').update(readFileSync(modelPath)).digest('hex');
  function describeModel(modelPath,description){
    const state=load();
    const traits={};
    for(const field of APPEARANCE_FIELDS)if(typeof description[field]==='string' && description[field].trim())traits[field]=description[field].trim().slice(0,300);
    state._models ??= {};state._models[modelKey(modelPath)]={...traits,source:'Inspected original GLB textures'};
    writeFileSync(file+'.tmp',JSON.stringify(state,null,2));renameSync(file+'.tmp',file);
    return traits;
  }
  return {get,set,describeModel,prompt(id='main',modelPath=id==='main'?activeAvatarPath():null){
    const s=get(id);let baseline={};
    try{baseline=load()._models?.[modelKey(modelPath)] || {};}catch{}
    const appearance=APPEARANCE_FIELDS.map((field)=>{
      const override=s[field];
      const named=override && Object.entries(COLORS).find(([,hex])=>hex===override)?.[0];
      return `${field}: ${override ? (named || override)+' (saved cosmetic override)' : baseline[field] || 'original model texture; color has not been measured'}`;
    }).join('; ');
    return 'Your current visible 3D avatar appearance: '+appearance+'. Eyes means the inner colored iris; outerEye means the surrounding sclera (eye whites). They are independent, and iris color changes preserve the pupil and eye whites. Use these known traits when asked what you look like; you do not need camera access to describe this saved avatar. Do not say your whole appearance is unknown when traits are provided. Only undescribed traits are unknown. A null cosmetic override means the original model texture is in use, not that a known original color is unknown. Original descriptions apply only to the exact inspected GLB; switching models does not carry them over. Saved cosmetic data: '+JSON.stringify(s)+'. These choices persist across sessions and are separate from generated pictures.';
  }};
}
export const avatarState=createAvatarState();
