import {readFileSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {config,DATA_DIR} from '../src/config.js';
import {registerLocalAvatar,avatarLibrary,selectAvatar} from '../src/avatar-library.js';
import {avatarState} from '../src/avatar-state.js';
const baseSha256=createHash('sha256').update(readFileSync(config.avatar.path)).digest('hex');
const data=JSON.parse(readFileSync(path.join(DATA_DIR,'avatar-state.json'),'utf8'));
const description=data._models?.[baseSha256]||{};
const outfits=[];
const previous=avatarLibrary();const previousOutfit=previous.models.find(model=>model.id===previous.active)?.outfit;
for(const [id,name] of [['dress','Teal textured A-line dress'],['dress-pleated','Midnight satin pleated midi dress'],['dress-wrap','Burgundy wrap-style dress'],['swimsuit','Navy one-piece swimsuit']]){
  const source=path.join(DATA_DIR,'outfits',id+'.glb');
  const model=registerLocalAvatar(source,name,{outfit:id,baseSha256});
  avatarState.describeModel(source,description);outfits.push({id,name,modelId:model.id});
}
writeFileSync(path.join(DATA_DIR,'outfits','wardrobe.json'),JSON.stringify({baseSha256,outfits},null,2));
const replacement=outfits.find(outfit=>outfit.id===previousOutfit);if(replacement&&replacement.modelId!==previous.active)selectAvatar(replacement.modelId);
console.log('Installed outfits:',outfits.map(outfit=>outfit.name).join(', '));
