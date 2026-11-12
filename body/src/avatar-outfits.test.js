import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {config,DATA_DIR,ROOT} from './config.js';
import {registerLocalAvatar,avatarLibrary,activeAvatarPath,reportAvatar,validateGlb} from './avatar-library.js';
import {outfitList,wearOutfit,setOutfitColors,outfitColors} from './avatar-outfits.js';
import {applyAvatarAppearance} from './dashboard/public/avatar-appearance.js';

function glb(label){
  const json=Buffer.from(JSON.stringify({asset:{version:'2.0'},scenes:[{}],meshes:[{name:label}]}));
  const padded=Buffer.concat([json,Buffer.alloc((4-json.length%4)%4,32)]),bytes=Buffer.alloc(20+padded.length);
  bytes.write('glTF');bytes.writeUInt32LE(2,4);bytes.writeUInt32LE(bytes.length,8);bytes.writeUInt32LE(padded.length,12);bytes.writeUInt32LE(0x4e4f534a,16);padded.copy(bytes,20);return bytes;
}
test('wardrobe switches fitted models, restores suit and rejects outfits for a different base',()=>{
  const original=config.avatar.path;config.avatar.path=path.join(DATA_DIR,'test-avatar.glb');writeFileSync(config.avatar.path,glb('original'));
  const directory=path.join(DATA_DIR,'outfits');mkdirSync(directory,{recursive:true});
  const source=path.join(directory,'test-dress.glb');writeFileSync(source,glb('dress'));
  try{
    const model=registerLocalAvatar(source,'Dress',{outfit:'dress'});
    assert.equal(registerLocalAvatar(source,'Dress').id,model.id);
    const baseSha256=createHash('sha256').update(readFileSync(config.avatar.path)).digest('hex');
    writeFileSync(path.join(directory,'wardrobe.json'),JSON.stringify({baseSha256,outfits:[{id:'dress',name:'Dress',modelId:model.id}]}));
    assert.deepEqual(outfitList().outfits.map(o=>o.id),['suit','dress']);
    const selection=wearOutfit('dress');assert.equal(avatarLibrary().active,model.id);assert.equal(outfitList().active,'dress');
    reportAvatar({revision:selection.revision,ok:false,error:'test failure'});assert.equal(outfitList().active,'suit');assert.equal(activeAvatarPath(),config.avatar.path);
    wearOutfit('dress');wearOutfit('suit');assert.equal(avatarLibrary().active,'original');
    setOutfitColors('dress',{fabric:'purple',sheen:'silver'});setOutfitColors('suit',{fabric:'blue'});
    assert.deepEqual(outfitColors().dress,{fabric:'#8053ad',sheen:'#bfc4ce'});
    assert.equal(outfitColors().suit.fabric,'#3278cc');
    setOutfitColors('dress',{fabric:'none'});assert.equal(outfitColors().dress.fabric,null);assert.equal(outfitColors().dress.sheen,'#bfc4ce');
    const before=outfitColors();assert.throws(()=>setOutfitColors('dress',{fabric:'unknown color'}));assert.deepEqual(outfitColors(),before);
    assert.throws(()=>setOutfitColors('missing',{fabric:'red'}),/installed outfit/);
    writeFileSync(config.avatar.path,glb('different avatar'));assert.deepEqual(outfitList().outfits.map(o=>o.id),['suit']);
    assert.deepEqual(outfitColors(),{});
    assert.throws(()=>wearOutfit('dress'),/Unknown outfit/);
  }finally{config.avatar.path=original;}
});
test('outfit recoloring keeps fabric maps and finish and restores the original palette',()=>{
  const color=value=>({value,set(next){this.value=next;}});
  const original={name:'Wardrobe_fabric_dress',color:color('#25878c'),sheenColor:color('#889999'),roughness:.72,sheen:.3,normalMap:{weave:true},roughnessMap:{weave:true},
    clone(){return {...this,color:color(this.color.value),sheenColor:color(this.sheenColor.value)};},dispose(){}};
  const mesh={isMesh:true,name:'Wardrobe_dress',userData:{},material:original};const root={traverse:fn=>fn(mesh)};
  applyAvatarAppearance(root,{outfitColors:{fabric:'#aa2244',sheen:'#ddccaa'}},{});
  assert.equal(mesh.material.color.value,'#aa2244');assert.equal(mesh.material.sheenColor.value,'#ddccaa');
  assert.equal(mesh.material.normalMap,original.normalMap);assert.equal(mesh.material.roughnessMap,original.roughnessMap);assert.equal(mesh.material.roughness,.72);assert.equal(mesh.material.sheen,.3);
  assert.equal(original.color.value,'#25878c');
  applyAvatarAppearance(root,{outfitColors:{}},{});assert.equal(mesh.material.color.value,'#25878c');assert.equal(mesh.material.sheenColor.value,'#889999');
});
test('generated real outfits retain the original facial morphs and skeleton',t=>{
  const source=path.join(ROOT,'data','avatar.glb');
  const variants=['dress','dress-pleated','dress-wrap','swimsuit'].map(id=>path.join(ROOT,'data','outfits',id+'.glb'));
  if(!existsSync(source)||variants.some(file=>!existsSync(file)))return t.skip('Local outfit assets have not been built.');
  const original=validateGlb(readFileSync(source));
  for(const file of variants){
    const variant=validateGlb(readFileSync(file));
    assert.deepEqual(variant.skins,original.skins);
    for(const mesh of original.meshes.filter(mesh=>/Head|Eye|Teeth|Tongue|hair/i.test(mesh.name)))assert.deepEqual(variant.meshes.find(item=>item.name===mesh.name),mesh);
    assert.ok(variant.meshes.some(mesh=>mesh.name.startsWith('Wardrobe_')));
    for(let i=0;i<original.accessors.length;i++)assert.deepEqual(variant.accessors[i],original.accessors[i]);
  }
});
test('dress styles have distinct silhouettes and preserve their fabric maps and sheen',t=>{
  const variants=['dress','dress-pleated','dress-wrap'].map(id=>path.join(ROOT,'data','outfits',id+'.glb'));
  if(variants.some(file=>!existsSync(file)))return t.skip('Local dress assets have not been built.');
  const hems=[],roughness=[];
  for(const file of variants){
    const variant=validateGlb(readFileSync(file));
    const mesh=variant.meshes.find(mesh=>mesh.name.startsWith('Wardrobe_'));
    const primitive=mesh.primitives[0],material=variant.materials[primitive.material];
    assert.ok(primitive.attributes.TEXCOORD_0!==undefined);
    assert.ok(material.normalTexture);assert.ok(material.pbrMetallicRoughness.metallicRoughnessTexture);
    assert.ok(material.extensions.KHR_materials_sheen);
    hems.push(variant.accessors[primitive.attributes.POSITION].min[1].toFixed(3));
    roughness.push(material.pbrMetallicRoughness.roughnessFactor);
  }
  assert.equal(new Set(hems).size,3);assert.equal(new Set(roughness).size,3);
});
