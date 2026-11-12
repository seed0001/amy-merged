import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DATA_DIR } from './config.js';
import { bus, activity } from './events.js';
import { fileBytes } from './files.js';
import { colorValue } from './avatar-state.js';
const directory=path.join(DATA_DIR,'backgrounds'),file=path.join(directory,'background.json');
const shaders=path.join(directory,'shaders');
// Every image and shader she or Owner saves stays here, so changing the background never loses one.
const library=path.join(directory,'library.json');
const readLibrary=()=>existsSync(library)?JSON.parse(readFileSync(library,'utf8')):[];
function remember(entry){
  mkdirSync(directory,{recursive:true});
  const all=readLibrary().filter((e)=>e.value!==entry.value);all.push({...entry,at:Date.now()});
  writeFileSync(library+'.tmp',JSON.stringify(all,null,2));renameSync(library+'.tmp',library);
}
export const backgroundLibrary=()=>readLibrary();
// What the browser page says happened when it applied the last background. Failures go to the log, so
// she can see them and tell Owner.
const reportFile=path.join(directory,'last-report.json');
export const backgroundReport=()=>existsSync(reportFile)?JSON.parse(readFileSync(reportFile,'utf8')):null;
export function reportBackground({ok,message='',revision=''}){
  const entry={ok:Boolean(ok),message:String(message).slice(0,300),revision:String(revision).slice(0,80),at:Date.now()};
  mkdirSync(directory,{recursive:true});writeFileSync(reportFile,JSON.stringify(entry,null,2));
  if(!entry.ok)activity('background-error',{message:entry.message,revision:entry.revision});
  return entry;
}
const SHADER_LIMIT=12000;
// Her own animated backgrounds are GLSL fragment shaders (Shadertoy style), not JavaScript: they run
// on the GPU and can only draw pixels, so nothing she writes can touch the page or the server.
export function checkShader(code){
  const source=String(code??'');
  if(!source.trim())throw new Error('A shader needs code.');
  if(source.length>SHADER_LIMIT)throw new Error(`Keep the shader under ${SHADER_LIMIT} characters.`);
  if(!/void\s+mainImage\s*\(\s*out\s+vec4\s+\w+\s*,\s*in\s+vec2\s+\w+\s*\)/.test(source))throw new Error('Define void mainImage(out vec4 fragColor, in vec2 fragCoord) that sets the pixel color.');
  if(/#\s*(include|version|extension)/.test(source)||/\bgl_FragColor\b|\buniform\s+sampler/.test(source))throw new Error('Shader code may not use #include, #version, #extension, samplers or gl_FragColor.');
  return source;
}
export function backgroundShader(id){
  if(!/^[a-f0-9-]{36}$/.test(id))throw new Error('Invalid background shader ID.');
  return readFileSync(path.join(shaders,id),'utf8');
}

// Her 3D scenes: a world she builds herself behind her avatar, drawn by the Studio page (avatar.js,
// sceneRig). A scene is JSON: a sky, fog, lights, layers of geometry each with its own GLSL material,
// particle fields, a camera sway and an optional full-screen post shader. Every shader is hers; the
// page only wraps them. The contract for each piece is in knowledge/tools.md ("scene"), and nothing
// here can reach the page or the server: it is all GPU code and numbers.
const scenes=path.join(directory,'scenes');
const SCENE_LIMIT=120000;
const GEOMETRY=['plane','sphere','box','torus','cylinder','cone','ring','terrain','dome','lathe','mesh','tube'];
const MESH_LIMIT=60000; // numbers in a raw mesh's positions (20,000 vertices)
// A pottery profile: [radius, height] points from the bottom up, spun around the vertical axis.
function checkProfile(profile,where){
  if(!Array.isArray(profile)||profile.length<2||profile.length>400)throw new Error(`${where}.profile must be 2 to 400 [radius, height] points, bottom to top.`);
  return profile.map((pt,i)=>{
    if(!Array.isArray(pt)||pt.length!==2||pt.some((x)=>typeof x!=='number'||!Number.isFinite(x)))throw new Error(`${where}.profile[${i}] must be [radius, height].`);
    return [Math.max(0,Math.min(1000,pt[0])),Math.max(-1000,Math.min(1000,pt[1]))];
  });
}
// A raw triangle mesh: flat positions (x,y,z,...) and optional triangle indices; normals are computed.
function checkMesh(l,where){
  const positions=l.positions;
  if(!Array.isArray(positions)||positions.length<9||positions.length%3||positions.length>MESH_LIMIT||positions.some((x)=>typeof x!=='number'||!Number.isFinite(x)))throw new Error(`${where}.positions must be 9 to ${MESH_LIMIT} numbers (x, y, z per vertex).`);
  const vertices=positions.length/3;
  let indices=null;
  if(l.indices!==undefined){
    if(!Array.isArray(l.indices)||l.indices.length<3||l.indices.length%3||l.indices.length>MESH_LIMIT*2||l.indices.some((i)=>!Number.isInteger(i)||i<0||i>=vertices))throw new Error(`${where}.indices must be triangles (3 whole numbers each) pointing at the ${vertices} vertices.`);
    indices=l.indices;
  }else if(vertices%3)throw new Error(`${where}: without indices, positions must be whole triangles (a multiple of 9 numbers).`);
  let uvs=null;
  if(l.uvs!==undefined){
    if(!Array.isArray(l.uvs)||l.uvs.length!==vertices*2||l.uvs.some((x)=>typeof x!=='number'))throw new Error(`${where}.uvs must be 2 numbers per vertex.`);
    uvs=l.uvs;
  }
  return {positions,indices,uvs,smooth:l.smooth!==false};
}
// A lit material instead of a shader: a real surface under the scene's lights, for sculpted pieces.
function checkLitMaterial(m,where){
  if(!m||typeof m!=='object')throw new Error(`${where}.material must be an object.`);
  return {color:color(m.color,`${where}.material.color`,'#cccccc'),roughness:num(m.roughness,`${where}.material.roughness`,0,1,0.6),metalness:num(m.metalness,`${where}.material.metalness`,0,1,0),
    emissive:color(m.emissive,`${where}.material.emissive`,'#000000'),emissiveIntensity:num(m.emissiveIntensity,`${where}.material.emissiveIntensity`,0,20,1),opacity:num(m.opacity,`${where}.material.opacity`,0,1,1),
    clearcoat:num(m.clearcoat,`${where}.material.clearcoat`,0,1,0),sheen:num(m.sheen,`${where}.material.sheen`,0,1,0),transmission:num(m.transmission,`${where}.material.transmission`,0,1,0),ior:num(m.ior,`${where}.material.ior`,1,2.333,1.5),
    flatShading:Boolean(m.flatShading),wireframe:Boolean(m.wireframe)};
}
const BLENDING=['normal','additive','multiply'];
const LIGHTS=['sun','point','ambient','hemisphere'];
const num=(v,name,min,max,fallback)=>{
  if(v===undefined||v===null)return fallback;
  if(typeof v!=='number'||!Number.isFinite(v))throw new Error(`${name} must be a number.`);
  return Math.max(min,Math.min(max,v));
};
const vec=(v,name,n,fallback)=>{
  if(v===undefined||v===null)return fallback;
  if(!Array.isArray(v)||v.length!==n||v.some((x)=>typeof x!=='number'||!Number.isFinite(x)))throw new Error(`${name} must be ${n} numbers.`);
  return v.map((x)=>Math.max(-10000,Math.min(10000,x)));
};
// The standard CSS colour names, so a scene can say "midnight blue" or "sienna" and mean it.
const CSS_COLORS={aliceblue:'#f0f8ff',antiquewhite:'#faebd7',aqua:'#00ffff',aquamarine:'#7fffd4',azure:'#f0ffff',beige:'#f5f5dc',bisque:'#ffe4c4',black:'#000000',blanchedalmond:'#ffebcd',blue:'#0000ff',blueviolet:'#8a2be2',brown:'#a52a2a',burlywood:'#deb887',cadetblue:'#5f9ea0',chartreuse:'#7fff00',chocolate:'#d2691e',coral:'#ff7f50',cornflowerblue:'#6495ed',cornsilk:'#fff8dc',crimson:'#dc143c',cyan:'#00ffff',darkblue:'#00008b',darkcyan:'#008b8b',darkgoldenrod:'#b8860b',darkgray:'#a9a9a9',darkgrey:'#a9a9a9',darkgreen:'#006400',darkkhaki:'#bdb76b',darkmagenta:'#8b008b',darkolivegreen:'#556b2f',darkorange:'#ff8c00',darkorchid:'#9932cc',darkred:'#8b0000',darksalmon:'#e9967a',darkseagreen:'#8fbc8f',darkslateblue:'#483d8b',darkslategray:'#2f4f4f',darkslategrey:'#2f4f4f',darkturquoise:'#00ced1',darkviolet:'#9400d3',deeppink:'#ff1493',deepskyblue:'#00bfff',dimgray:'#696969',dimgrey:'#696969',dodgerblue:'#1e90ff',firebrick:'#b22222',floralwhite:'#fffaf0',forestgreen:'#228b22',fuchsia:'#ff00ff',gainsboro:'#dcdcdc',ghostwhite:'#f8f8ff',gold:'#ffd700',goldenrod:'#daa520',gray:'#808080',grey:'#808080',green:'#008000',greenyellow:'#adff2f',honeydew:'#f0fff0',hotpink:'#ff69b4',indianred:'#cd5c5c',indigo:'#4b0082',ivory:'#fffff0',khaki:'#f0e68c',lavender:'#e6e6fa',lavenderblush:'#fff0f5',lawngreen:'#7cfc00',lemonchiffon:'#fffacd',lightblue:'#add8e6',lightcoral:'#f08080',lightcyan:'#e0ffff',lightgoldenrodyellow:'#fafad2',lightgray:'#d3d3d3',lightgrey:'#d3d3d3',lightgreen:'#90ee90',lightpink:'#ffb6c1',lightsalmon:'#ffa07a',lightseagreen:'#20b2aa',lightskyblue:'#87cefa',lightslategray:'#778899',lightslategrey:'#778899',lightsteelblue:'#b0c4de',lightyellow:'#ffffe0',lime:'#00ff00',limegreen:'#32cd32',linen:'#faf0e6',magenta:'#ff00ff',maroon:'#800000',mediumaquamarine:'#66cdaa',mediumblue:'#0000cd',mediumorchid:'#ba55d3',mediumpurple:'#9370db',mediumseagreen:'#3cb371',mediumslateblue:'#7b68ee',mediumspringgreen:'#00fa9a',mediumturquoise:'#48d1cc',mediumvioletred:'#c71585',midnightblue:'#191970',mintcream:'#f5fffa',mistyrose:'#ffe4e1',moccasin:'#ffe4b5',navajowhite:'#ffdead',navy:'#000080',oldlace:'#fdf5e6',olive:'#808000',olivedrab:'#6b8e23',orange:'#ffa500',orangered:'#ff4500',orchid:'#da70d6',palegoldenrod:'#eee8aa',palegreen:'#98fb98',paleturquoise:'#afeeee',palevioletred:'#db7093',papayawhip:'#ffefd5',peachpuff:'#ffdab9',peru:'#cd853f',pink:'#ffc0cb',plum:'#dda0dd',powderblue:'#b0e0e6',purple:'#800080',rebeccapurple:'#663399',red:'#ff0000',rosybrown:'#bc8f8f',royalblue:'#4169e1',saddlebrown:'#8b4513',salmon:'#fa8072',sandybrown:'#f4a460',seagreen:'#2e8b57',seashell:'#fff5ee',sienna:'#a0522d',silver:'#c0c0c0',skyblue:'#87ceeb',slateblue:'#6a5acd',slategray:'#708090',slategrey:'#708090',snow:'#fffafa',springgreen:'#00ff7f',steelblue:'#4682b4',tan:'#d2b48c',teal:'#008080',thistle:'#d8bfd8',tomato:'#ff6347',turquoise:'#40e0d0',violet:'#ee82ee',wheat:'#f5deb3',white:'#ffffff',whitesmoke:'#f5f5f5',yellow:'#ffff00',yellowgreen:'#9acd32',charcoal:'#36454f',terracotta:'#e2725b',cream:'#fffdd0',sand:'#c2b280',rust:'#b7410e',navyblue:'#000080',offwhite:'#faf9f6'};
// A colour: #RRGGBB, #RGB, a CSS colour name ("midnight blue", "sienna"), or a name from her appearance palette.
const color=(v,name,fallback)=>{
  if(v===undefined||v===null||v==='')return fallback;
  const clean=String(v).trim().toLowerCase();
  if(/^#[0-9a-f]{6}$/.test(clean))return clean;
  if(/^#[0-9a-f]{3}$/.test(clean))return '#'+[...clean.slice(1)].map((c)=>c+c).join('');
  const css=CSS_COLORS[clean.replace(/[\s_-]+/g,'')];
  if(css)return css;
  try{const out=colorValue(clean);if(out)return out;}catch{}
  throw new Error(`${name} must be a color like #RRGGBB or a known color name (got "${String(v).slice(0,30)}").`);
};
// Material code: surface() is required; displace() is optional. Same bans as a background shader.
function checkMaterial(code,where){
  const source=String(code??'');
  if(source.length>SHADER_LIMIT)throw new Error(`${where}: keep the shader under ${SHADER_LIMIT} characters.`);
  if(!/void\s+surface\s*\(\s*out\s+vec4\s+\w+\s*,\s*vec3\s+\w+\s*,\s*vec3\s+\w+\s*,\s*vec2\s+\w+\s*\)/.test(source))throw new Error(`${where}: define void surface(out vec4 color, vec3 world, vec3 normal, vec2 uv) that sets the pixel color.`);
  if(/#\s*(include|version|extension)/.test(source)||/\bgl_FragColor\b|\bgl_Position\b|\buniform\s+sampler|\bvoid\s+main\s*\(/.test(source))throw new Error(`${where}: material code may not use #include, #version, #extension, samplers, gl_FragColor, gl_Position or main().`);
  return source;
}
function checkSky(code){return checkShader(code);}
export function checkScene(input){
  let spec=input;
  if(typeof spec==='string'){
    if(spec.length>SCENE_LIMIT)throw new Error(`Keep the scene under ${SCENE_LIMIT} characters.`);
    try{spec=JSON.parse(spec);}catch(err){throw new Error(`The scene must be valid JSON: ${err.message}`);}
  }
  if(!spec||typeof spec!=='object'||Array.isArray(spec))throw new Error('A scene is a JSON object.');
  const out={name:String(spec.name??'scene').slice(0,80)};
  if(spec.sky!==undefined){
    const sky=spec.sky;
    if(typeof sky==='string')out.sky={shader:checkSky(sky)};
    else if(sky&&typeof sky==='object'&&typeof sky.shader==='string')out.sky={shader:checkSky(sky.shader)};
    else if(sky&&typeof sky==='object'&&Array.isArray(sky.gradient))out.sky={gradient:sky.gradient.slice(0,4).map((c,i)=>color(c,`sky.gradient[${i}]`))};
    else if(sky&&typeof sky==='object'&&sky.color!==undefined)out.sky={color:color(sky.color,'sky.color')};
    else throw new Error('sky must be a GLSL string (mainImage), { shader }, { gradient: [colors] } or { color }.');
  }
  if(spec.fog!==undefined){
    if(!spec.fog||typeof spec.fog!=='object')throw new Error('fog must be { color, near, far } or { color, density }.');
    out.fog={color:color(spec.fog.color,'fog.color','#000000'),...(spec.fog.density!==undefined?{density:num(spec.fog.density,'fog.density',0,1,0.02)}:{near:num(spec.fog.near,'fog.near',0,10000,10),far:num(spec.fog.far,'fog.far',0,10000,200)})};
  }
  const lights=Array.isArray(spec.lights)?spec.lights:[];
  if(lights.length>6)throw new Error('At most 6 lights.');
  out.lights=lights.map((l,i)=>{
    if(!l||typeof l!=='object'||!LIGHTS.includes(l.type))throw new Error(`lights[${i}].type must be one of ${LIGHTS.join(', ')}.`);
    return {type:l.type,color:color(l.color,`lights[${i}].color`,'#ffffff'),intensity:num(l.intensity,`lights[${i}].intensity`,0,50,1),position:vec(l.position,`lights[${i}].position`,3,[0,10,0]),...(l.type==='hemisphere'&&{ground:color(l.ground,`lights[${i}].ground`,'#222222')})};
  });
  const layers=Array.isArray(spec.layers)?spec.layers:[];
  if(layers.length>64)throw new Error('At most 64 layers.');
  out.layers=layers.map((l,i)=>{
    const where=`layers[${i}]${l?.name?` (${l.name})`:''}`;
    if(!l||typeof l!=='object')throw new Error(`${where} must be an object.`);
    if(l.geometry===undefined&&(l.type||l.shape))l={...l,geometry:l.type??l.shape}; // "type" and "shape" are what she reaches for
    if(!GEOMETRY.includes(l.geometry))throw new Error(`${where}.geometry must be one of ${GEOMETRY.join(', ')}.`);
    const code=typeof l.shader==='string'?l.shader:l.shader?.fragment;
    let material,lit=null;
    if(typeof code==='string'){
      material={fragment:checkMaterial(code,where)};
      if(l.shader&&typeof l.shader==='object'&&typeof l.shader.vertex==='string'){if(l.shader.vertex.length>SHADER_LIMIT)throw new Error(`${where}: keep the vertex code under ${SHADER_LIMIT} characters.`);material.vertex=l.shader.vertex;}
    }else if(l.material!==undefined)lit=checkLitMaterial(l.material,where);
    else throw new Error(`${where} needs a shader (GLSL with surface()) or a material ({ color, roughness, metalness, ... }).`);
    const shape={};
    if(l.geometry==='lathe')shape.profile=checkProfile(l.profile,where);
    if(l.geometry==='mesh')shape.mesh=checkMesh(l,where);
    if(l.geometry==='tube'){const path=l.path;if(!Array.isArray(path)||path.length<2||path.length>400||path.some((p)=>!Array.isArray(p)||p.length!==3||p.some((x)=>typeof x!=='number'||!Number.isFinite(x))))throw new Error(`${where}.path must be 2 to 400 [x, y, z] points for a tube.`);shape.path=path.map((p)=>p.map((x)=>Math.max(-10000,Math.min(10000,x))));}
    if(!l.blending||BLENDING.includes(l.blending)){}else throw new Error(`${where}.blending must be normal, additive or multiply.`);
    const uniforms={};
    for(const [k,v] of Object.entries(l.uniforms??{})){
      if(!/^u[A-Za-z0-9_]{0,30}$/.test(k))throw new Error(`${where}.uniforms: names start with "u" (uColor, uSpeed).`);
      if(typeof v==='number')uniforms[k]=v;else if(Array.isArray(v)&&v.length>=2&&v.length<=4&&v.every((x)=>typeof x==='number'))uniforms[k]=v;
      else throw new Error(`${where}.uniforms.${k} must be a number or 2 to 4 numbers.`);
      if(Object.keys(uniforms).length>12)throw new Error(`${where}: at most 12 uniforms.`);
    }
    return {name:String(l.name??`layer ${i+1}`).slice(0,60),geometry:l.geometry,size:vec(l.size,`${where}.size`,l.size?.length??3,[1,1,1]).slice(0,3),segments:vec(l.segments,`${where}.segments`,l.segments?.length??2,[1,1]).map((s)=>Math.max(1,Math.min(256,Math.round(s)))),
      position:vec(l.position,`${where}.position`,3,[0,0,-10]),rotation:vec(l.rotation,`${where}.rotation`,3,[0,0,0]),scale:vec(l.scale,`${where}.scale`,3,[1,1,1]),
      ...(material&&{material}),...(lit&&{lit}),...shape,uniforms,transparent:Boolean(l.transparent)||(lit?lit.opacity<1||lit.transmission>0:false),blending:l.blending??'normal',side:l.side==='back'||l.side==='double'?l.side:'front',depthWrite:l.depthWrite!==false,spin:vec(l.spin,`${where}.spin`,3,[0,0,0]),
      castShadow:Boolean(l.castShadow),receiveShadow:Boolean(l.receiveShadow)};
  });
  const particles=Array.isArray(spec.particles)?spec.particles:[];
  if(particles.length>4)throw new Error('At most 4 particle fields.');
  out.particles=particles.map((p,i)=>{
    const where=`particles[${i}]`;
    if(!p||typeof p!=='object')throw new Error(`${where} must be an object.`);
    const FOLLOW=['none','rain','storm','wind','snow','clouds'];
    if(p.follow!==undefined&&!FOLLOW.includes(p.follow))throw new Error(`${where}.follow must be one of ${FOLLOW.join(', ')} (which weather its visibility follows).`);
    return {count:Math.round(num(p.count,`${where}.count`,1,20000,500)),area:vec(p.area,`${where}.area`,3,[40,20,40]),center:vec(p.center,`${where}.center`,3,[0,5,-15]),size:num(p.size,`${where}.size`,0.01,50,0.15),color:color(p.color,`${where}.color`,'#ffffff'),opacity:num(p.opacity,`${where}.opacity`,0,1,0.8),drift:vec(p.drift,`${where}.drift`,3,[0,-0.3,0]),wobble:num(p.wobble,`${where}.wobble`,0,20,0.5),twinkle:num(p.twinkle,`${where}.twinkle`,0,10,0),additive:p.additive!==false,follow:p.follow??'none'};
  });
  out.camera={height:num(spec.camera?.height,'camera.height',-100,100,1.5),fov:num(spec.camera?.fov,'camera.fov',10,120,55),sway:num(spec.camera?.sway,'camera.sway',0,1,0.15),parallax:num(spec.camera?.parallax,'camera.parallax',0,1,0.3),look:vec(spec.camera?.look,'camera.look',3,[0,1.5,-10])};
  if(spec.post!==undefined){
    // One pass or a chain of them: each gets the previous result as iChannel0, so grading, bloom, lens
    // effects, rain on the glass and so on stack as separate shaders.
    const list=Array.isArray(spec.post)?spec.post:[spec.post];
    if(list.length>12)throw new Error('At most 12 post passes.');
    out.post=list.map((p,i)=>{const code=typeof p==='string'?p:p?.shader;if(typeof code!=='string')throw new Error(`post[${i}] must be GLSL (mainImage, with texture(iChannel0, uv) for the scene so far) or { shader }.`);return {shader:checkShader(code),name:String(p?.name??`post ${i+1}`).slice(0,40)};});
  }
  if(JSON.stringify(out).length>SCENE_LIMIT)throw new Error(`Keep the scene under ${SCENE_LIMIT} characters.`);
  return out;
}
export function backgroundScene(id){
  if(!/^[a-f0-9-]{36}$/.test(id))throw new Error('Invalid background scene ID.');
  return readFileSync(path.join(scenes,id+'.json'),'utf8');
}
export const backgroundState=()=>existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{type:'preset',value:'studio',revision:'default'};
export function imageMime(bytes){
  if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png';
  if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return 'image/jpeg';
  if(bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP')return 'image/webp';
  if(/^GIF8[79]a$/.test(bytes.subarray(0,6).toString()))return 'image/gif';
  throw new Error('Use a PNG, JPEG, WebP or GIF image file, not a web page.');
}
export async function changeBackground({action,value,url,path:source,code,spec},fetcher=fetch){
  if(action==='status')return {...backgroundState(),saved:readLibrary().map(({type,value:id,at,name})=>({type,value:id,at,...(name&&{name})})),browser:backgroundReport()};
  let next;
  if(action==='recall'){
    const entry=readLibrary().find((e)=>e.value===value);
    if(!entry)throw new Error('No saved background with that ID. Use status to list them.');
    next={type:entry.type,value:entry.value,...(entry.mime&&{mime:entry.mime}),...(entry.name&&{name:entry.name})};
  }else
  if(action==='preset'){
    if(!['studio','dusk','day'].includes(value))throw new Error('Choose studio, dusk or day.');
    next={type:'preset',value};
  }else if(action==='color'){
    if(!/^#[0-9a-f]{6}$/i.test(value||''))throw new Error('Give a color as #RRGGBB.');
    next={type:'color',value};
  }else if(action==='image'){
    let bytes;
    if(source)bytes=fileBytes(source).bytes;
    else{
      const address=new URL(url);
      if(address.protocol!=='https:')throw new Error('Use an HTTPS image URL or a local image path.');
      const response=await fetcher(address,{signal:AbortSignal.timeout(30000)});
      if(!response.ok)throw new Error(`Background download failed: HTTP ${response.status}`);
      if(response.url&&new URL(response.url).protocol!=='https:')throw new Error('Background download redirected away from HTTPS.');
      if(Number(response.headers.get('content-length'))>20*1024*1024)throw new Error('Background exceeds 20 MB.');
      const chunks=[];let size=0;
      for await(const chunk of response.body){size+=chunk.length;if(size>20*1024*1024)throw new Error('Background exceeds 20 MB.');chunks.push(chunk);}
      bytes=Buffer.concat(chunks);
    }
    if(bytes.length>20*1024*1024)throw new Error('Background exceeds 20 MB.');
    const mime=imageMime(bytes),id=randomUUID();
    mkdirSync(directory,{recursive:true});writeFileSync(path.join(directory,id),bytes);
    next={type:'image',value:id,mime};remember(next);
  }else if(action==='shader'){
    const id=randomUUID();
    mkdirSync(shaders,{recursive:true});writeFileSync(path.join(shaders,id),checkShader(code));
    next={type:'shader',value:id};remember(next);
  }else if(action==='scene'){
    const checked=checkScene(spec??code);
    const id=randomUUID();
    mkdirSync(scenes,{recursive:true});writeFileSync(path.join(scenes,id+'.json'),JSON.stringify(checked));
    next={type:'scene',value:id,name:checked.name};remember(next);
  }else if(action==='read'){
    const entry=readLibrary().find((e)=>e.value===value);
    if(!entry)throw new Error('No saved background with that ID. Use status to list them.');
    if(entry.type==='scene')return {type:'scene',value,spec:JSON.parse(backgroundScene(value))};
    if(entry.type==='shader')return {type:'shader',value,code:backgroundShader(value)};
    return {type:entry.type,value,note:'Only scenes and shaders have source to read.'};
  }else throw new Error('Use status, preset, color, image, shader, scene, read or recall.');
  mkdirSync(directory,{recursive:true});next.revision=randomUUID();
  writeFileSync(file+'.tmp',JSON.stringify(next));renameSync(file+'.tmp',file);
  bus.emit('avatar-background',next);return next;
}
export function backgroundImage(id){
  if(!/^[a-f0-9-]{36}$/.test(id))throw new Error('Invalid background image ID.');
  const bytes=readFileSync(path.join(directory,id));return {bytes,mime:imageMime(bytes)};
}
