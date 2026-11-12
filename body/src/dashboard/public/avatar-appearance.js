// Reversible material overrides. The original GLB and its textures are never rewritten.
import { eyeMaskTexture } from './avatar-eye-mask.js';
export function appearancePart(name){
  if(/wardrobe_fabric|wardrobe_dress|wardrobe_swimsuit|avaturn_look_/i.test(name))return 'clothing';
  if(/eyelash|eyeao|tear|teeth|tongue/i.test(name))return null;
  if(/hair/i.test(name))return 'hair';
  if(/eye|iris/i.test(name))return 'eyes';
  if(/head|face|skin/i.test(name))return 'face';
  return null;
}
export function motionMask(mesh,names){
  const geometry=mesh.geometry,position=geometry.attributes?.position;
  const mask=new Float32Array(position?.count ?? 0);let max=0;
  for(const name of names){
    const index=mesh.morphTargetDictionary?.[name];const morph=geometry.morphAttributes?.position?.[index];if(!morph)continue;
    for(let i=0;i<mask.length;i++){
      const dx=morph.getX(i)-(geometry.morphTargetsRelative?0:position.getX(i));
      const dy=morph.getY(i)-(geometry.morphTargetsRelative?0:position.getY(i));
      const dz=morph.getZ(i)-(geometry.morphTargetsRelative?0:position.getZ(i));
      mask[i]=Math.max(mask[i],Math.hypot(dx,dy,dz));max=Math.max(max,mask[i]);
    }
  }
  if(max>0)for(let i=0;i<mask.length;i++)mask[i]=Math.max(0,Math.min(1,(mask[i]/max-.12)/.5));
  return mask;
}
export function applyAvatarAppearance(root,state,THREE){
  const applied=new Set();
  root.traverse((mesh)=>{
    if(!mesh.isMesh)return;
    const originals=mesh.userData.appearanceOriginals ??= (Array.isArray(mesh.material)?mesh.material:[mesh.material]);
    const list=originals.map((original)=>{
      const part=appearancePart(mesh.name+' '+original.name);if(!part)return original;
      const material=original.clone();const previous=original.onBeforeCompile;
      const color=part==='hair'?state.hair:null;
      if(part==='clothing'){
        if(state.outfitColors?.fabric){material.color.set(state.outfitColors.fabric);applied.add('outfitFabric');}
        if(state.outfitColors?.sheen&&material.sheenColor){material.sheenColor.set(state.outfitColors.sheen);applied.add('outfitSheen');}
      }else if(part==='face'){
        if(!mesh.userData.appearanceMasks){
          mesh.geometry=mesh.geometry.clone();
          for(const [attribute,shapes] of Object.entries({avatarLipMask:['mouthPucker','mouthFunnel','viseme_PP'],avatarShadowMask:['eyeBlinkLeft','eyeBlinkRight'],avatarBlushMask:['cheekPuff','cheekSquintLeft','cheekSquintRight']}))mesh.geometry.setAttribute(attribute,new THREE.BufferAttribute(motionMask(mesh,shapes),1));
          mesh.userData.appearanceMasks=true;
        }
        material.onBeforeCompile=(shader,...args)=>{
          previous?.call(material,shader,...args);
          const declarations='attribute float avatarLipMask; attribute float avatarShadowMask; attribute float avatarBlushMask; varying vec3 avatarMasks;';
          shader.vertexShader=declarations+'\n'+shader.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>\navatarMasks=vec3(avatarLipMask,avatarShadowMask,avatarBlushMask);');
          shader.fragmentShader='varying vec3 avatarMasks; uniform vec3 avatarLip; uniform vec3 avatarShadow; uniform vec3 avatarBlush; uniform vec3 avatarStrength; uniform float avatarLipGloss;\n'+shader.fragmentShader;
          shader.uniforms.avatarLipGloss={value:state.lipGloss||0};
          // Lower roughness only on the lips: the face keeps its normal skin finish.
          shader.fragmentShader=shader.fragmentShader.replace('#include <roughnessmap_fragment>','#include <roughnessmap_fragment>\nroughnessFactor=mix(roughnessFactor,0.06,clamp(avatarMasks.x*avatarLipGloss,0.0,1.0));');
          shader.uniforms.avatarLip={value:new THREE.Color(state.lipstick||'#ffffff')};shader.uniforms.avatarShadow={value:new THREE.Color(state.eyeshadow||'#ffffff')};shader.uniforms.avatarBlush={value:new THREE.Color(state.blush||'#ffffff')};
          shader.uniforms.avatarStrength={value:new THREE.Vector3(state.lipstick?state.makeupIntensity:0,state.eyeshadow?state.makeupIntensity*.6:0,state.blush?state.makeupIntensity*.5:0)};
          shader.fragmentShader=shader.fragmentShader.replace('#include <map_fragment>',`#include <map_fragment>
            float lightness=max(.3,dot(diffuseColor.rgb,vec3(.299,.587,.114)));
            diffuseColor.rgb=mix(diffuseColor.rgb,avatarLip*lightness,avatarMasks.x*avatarStrength.x);
            diffuseColor.rgb=mix(diffuseColor.rgb,avatarShadow*lightness,avatarMasks.y*avatarStrength.y);
            diffuseColor.rgb=mix(diffuseColor.rgb,avatarBlush*lightness,avatarMasks.z*avatarStrength.z);`);
        };
        for(const field of ['lipstick','eyeshadow','blush'])if(state[field])applied.add(field);
        if(state.lipGloss)applied.add('lipGloss');
      }else if(part==='eyes' && (state.eyes||state.outerEye||state.irisInner||state.irisOuter||state.irisStarburst||state.irisFlecks)){
        const mask=eyeMaskTexture(original.map,THREE);
        if(!mask){material.dispose();return original;}
        material.onBeforeCompile=(shader,...args)=>{
          previous?.call(material,shader,...args);
          const layers=['eyes','irisInner','irisOuter','irisStarburst','irisFlecks'];
          shader.uniforms.avatarIrisPalette={value:layers.map(field=>new THREE.Color(state[field]||'#ffffff'))};
          shader.uniforms.avatarIrisEnabled={value:layers.map(field=>state[field]?1:0)};
          shader.uniforms.avatarSclera={value:new THREE.Color(state.outerEye||'#ffffff')};
          shader.uniforms.avatarEyeStrength={value:new THREE.Vector2(state.eyes?1:0,state.outerEye?1:0)};
          shader.uniforms.avatarEyeMask={value:mask};
          shader.fragmentShader='uniform vec3 avatarIrisPalette[5]; uniform float avatarIrisEnabled[5]; uniform vec3 avatarSclera; uniform vec2 avatarEyeStrength; uniform sampler2D avatarEyeMask;\n'+shader.fragmentShader;
          shader.fragmentShader=shader.fragmentShader.replace('#include <map_fragment>',`#include <map_fragment>
            #ifdef USE_MAP
            vec4 eyeRegions=texture2D(avatarEyeMask,vMapUv);
            float eyeLightness=dot(diffuseColor.rgb,vec3(.299,.587,.114));
            // Multiplicative luminance preserves dark grooves and bright radial fibers.
            float irisDetail=clamp(eyeLightness/.12,0.0,4.0);
            float irisRadius=eyeRegions.b;
            float innerRing=1.0-smoothstep(.48,.62,irisRadius);
            float outerRing=smoothstep(.80,.94,irisRadius);
            float starburst=smoothstep(.48,.72,eyeRegions.a)*(1.0-smoothstep(.65,.92,irisRadius));
            float flecks=smoothstep(.74,.90,eyeRegions.a)*smoothstep(.48,.68,irisRadius)*(1.0-smoothstep(.88,1.0,irisRadius));
            vec3 irisColor=mix(diffuseColor.rgb,avatarIrisPalette[0]*irisDetail,avatarIrisEnabled[0]);
            irisColor=mix(irisColor,avatarIrisPalette[1]*irisDetail,innerRing*avatarIrisEnabled[1]);
            irisColor=mix(irisColor,avatarIrisPalette[2]*irisDetail,outerRing*avatarIrisEnabled[2]);
            irisColor=mix(irisColor,avatarIrisPalette[3]*irisDetail,starburst*avatarIrisEnabled[3]);
            irisColor=mix(irisColor,avatarIrisPalette[4]*irisDetail,flecks*avatarIrisEnabled[4]);
            diffuseColor.rgb=mix(diffuseColor.rgb,irisColor,eyeRegions.r);
            diffuseColor.rgb=mix(diffuseColor.rgb,avatarSclera*max(.05,eyeLightness),eyeRegions.g*avatarEyeStrength.y);
            #endif`);
        };
        for(const field of ['eyes','irisInner','irisOuter','irisStarburst','irisFlecks','outerEye'])if(state[field])applied.add(field);
      }else if(part==='hair' && (color||state.hairStreak)){
        material.onBeforeCompile=(shader,...args)=>{
          previous?.call(material,shader,...args);shader.uniforms.avatarTint={value:new THREE.Color(color||'#ffffff')};
          shader.uniforms.avatarHairBase={value:color?1:0};
          shader.uniforms.avatarHairStreak={value:new THREE.Color(state.hairStreak||'#ffffff')};
          shader.uniforms.avatarHairStreakAmount={value:state.hairStreak?(state.hairStreakAmount??.35):0};
          shader.vertexShader='varying vec3 avatarHairPosition;\n'+shader.vertexShader;
          shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>\navatarHairPosition=position;');
          shader.fragmentShader='uniform vec3 avatarTint; uniform float avatarHairBase; uniform vec3 avatarHairStreak; uniform float avatarHairStreakAmount; varying vec3 avatarHairPosition;\n'+shader.fragmentShader;
          const replacement=`
            float hairShade=.3+.9*sqrt(clamp(lum,0.,1.));
            diffuseColor.rgb=mix(diffuseColor.rgb,avatarTint*hairShade,avatarHairBase);
            float strandCoordinate=avatarHairPosition.x*45.0;
            #ifdef USE_MAP
              strandCoordinate=vMapUv.x*24.0+.025*sin(vMapUv.y*6.283185);
            #endif
            float strandNumber=floor(strandCoordinate);
            float strandRank=fract(sin(strandNumber*127.1+31.7)*43758.5453);
            float strandSelected=step(strandRank,avatarHairStreakAmount)*step(.0001,avatarHairStreakAmount);
            float strandMask=(1.0-smoothstep(.10,.15,abs(fract(strandCoordinate)-.5)))*strandSelected;
            diffuseColor.rgb=mix(diffuseColor.rgb,avatarHairStreak*hairShade,strandMask);`;
          shader.fragmentShader=shader.fragmentShader.replace('#include <map_fragment>','#include <map_fragment>\nfloat lum=dot(diffuseColor.rgb,vec3(.299,.587,.114));'+replacement);
        };if(color)applied.add('hair');if(state.hairStreak&&(state.hairStreakAmount??.35)>0)applied.add('hairStreak');
      }
      material.customProgramCacheKey=()=>JSON.stringify([part,state]);material.needsUpdate=true;return material;
    });
    const current=Array.isArray(mesh.material)?mesh.material:[mesh.material];for(const old of current)if(!originals.includes(old))old.dispose?.();
    mesh.material=Array.isArray(mesh.material)?list:list[0];
  });
  return [...applied];
}
