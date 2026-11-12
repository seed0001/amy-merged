import {existsSync,readFileSync,writeFileSync,renameSync,statSync} from 'node:fs';
import path from 'node:path';
import {DATA_DIR} from './config.js';
import {activeAvatarPath} from './avatar-library.js';
import {bus} from './events.js';
import {FACE_PRESETS,MOTIONS,HAND_POSES,GAZES,QUICK,activeAnimation} from './dashboard/public/avatar-performance.js';
let cache;
export function availablePerformance(){
  try{
    const file=activeAvatarPath(),stamp=statSync(file).mtimeMs;
    if(cache?.file===file&&cache.stamp===stamp)return cache.value;
    const b=readFileSync(file),document=JSON.parse(b.toString('utf8',20,20+b.readUInt32LE(12)).trim());
    const shapes=[...new Set(document.meshes.flatMap(mesh=>mesh.extras?.targetNames||[]).map(name=>name.replace(/_L$/,'Left').replace(/_R$/,'Right')))];
    const bones=[...new Set((document.skins||[]).flatMap(skin=>skin.joints.map(index=>document.nodes[index].name?.replace(/^.*[:|]/,''))).filter(Boolean))];
    const value={shapes,bones};cache={file,stamp,value};return value;
  }catch{return {shapes:[],bones:[]};}
}
export function createPerformance({file=path.join(DATA_DIR,'avatar-performance.json'),now=Date.now,available=availablePerformance,emit=state=>bus.emit('avatar-performance',state)}={}){
  let preferences={gain:1,autonomous:true,gaze:'ambient',...(existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{})};
  let face=null,motion=null,hands=null,gazeHold=null;
  // A gaze she picks herself (through her tool) is a look, held for a few seconds, not a setting: a
  // saved "camera" would freeze her staring at the lens for good. Only the dashboard saves a gaze.
  const gaze=()=>gazeHold&&gazeHold.until>now()?gazeHold.mode:preferences.gaze;
  const state=()=>({...preferences,gaze:gaze(),face:activeAnimation(face,now())?face:null,motion:activeAnimation(motion,now())?motion:null,hands:activeAnimation(hands,now())?hands:null});
  function command(args,source='turn'){
    // Local models sometimes send numbers as strings ("-1", "0.5").
    args={...args};for(const k of ['strength','duration','gain'])if(typeof args[k]==='string'&&args[k].trim()!==''&&Number.isFinite(Number(args[k])))args[k]=Number(args[k]);
    if(args.action==='get')return {...state(),presets:Object.keys(FACE_PRESETS),gestures:MOTIONS,hand_poses:HAND_POSES,gazes:GAZES,...available()};
    const own=(s)=>s==='turn'||s==='tool';
    if(source==='background'&&(!preferences.autonomous||own(state().face?.source)||own(state().motion?.source)))return {skipped:true};
    if(args.action==='reset'){face=motion=hands=null;}
    else if(args.action==='hands'){
      // Her fingers: a named hand pose, held for the duration (0 holds it until reset), on both hands.
      const name=args.gesture||args.expression;
      if(!HAND_POSES.includes(name))throw new Error(`Choose a hand pose: ${HAND_POSES.join(', ')}.`);
      if(!available().bones.includes('RightHandIndex1'))throw new Error('This avatar has no finger bones, so its hands cannot pose.');
      const strength=args.strength===undefined||args.strength===-1?1:args.strength;
      if(!Number.isFinite(strength)||strength<0||strength>1)throw new Error('Strength must be between 0 and 1.');
      let duration=args.duration===undefined||args.duration===-1?6:args.duration;
      if(!Number.isFinite(duration)||duration<0||duration>120)throw new Error('Duration must be 0 (hold) to 120 seconds.');
      if(source==='background')duration=Math.max(.5,Math.min(duration||4,8));
      hands={name,strength,duration,at:now(),source};
    }
    else if(args.action==='settings'||args.action==='gaze'){
      const next={...preferences};
      if(args.gain!==undefined&&args.gain!==-1){if(!Number.isFinite(args.gain)||args.gain<0||args.gain>3)throw new Error('Expression gain must be 0 to 3.');next.gain=args.gain;}
      if(args.autonomous){if(!['on','off'].includes(args.autonomous))throw new Error('Use autonomous on or off.');next.autonomous=args.autonomous==='on';}
      if(args.gaze){
        if(!GAZES.includes(args.gaze))throw new Error('Use ambient, camera, left, right, up or down gaze.');
        if(source==='tool'){
          const seconds=Number.isFinite(args.duration)&&args.duration>0?Math.min(args.duration,20):6;
          gazeHold={mode:args.gaze,until:now()+seconds*1000};
          setTimeout(()=>emit(state()),seconds*1000+50).unref?.();
        }else next.gaze=args.gaze;
      }
      writeFileSync(file+'.tmp',JSON.stringify(next));renameSync(file+'.tmp',file);preferences=next;
      if(!next.autonomous){if(face?.source==='background')face=null;if(motion?.source==='background')motion=null;}
    }else if(args.action==='pose'||args.action==='gesture'){
      const strength=args.strength===undefined||args.strength===-1?1:args.strength;
      if(!Number.isFinite(strength)||strength<0||strength>1)throw new Error('Strength must be between 0 and 1.');
      const name=args.action==='pose'?args.expression:args.gesture;
      let duration=args.duration===undefined||args.duration===-1?(QUICK[name]??(name==='nod'?1.5:name==='shake'?1.7:args.action==='gesture'?3.5:5)):args.duration;
      if(!Number.isFinite(duration)||duration<0||duration>60||args.action==='gesture'&&duration===0)throw new Error('Duration must be 0 to 60 seconds; gestures need a positive duration.');
      if(source==='background')duration=Math.max(.2,Math.min(duration||5,8));
      const packet={name,strength,duration,at:now(),source};
      if(args.action==='pose'){
        const shapes=available().shapes;
        // Local models often fill the optional shapes list with placeholders ("", "none") or shapes this
        // avatar lacks. Those are dropped instead of failing the whole pose; with none left, the named
        // expression's preset is used.
        const custom=(args.shapes??[]).filter(item=>item?.name&&shapes.includes(item.name)&&Number.isFinite(item.value)&&item.value>=0&&item.value<=1);
        const requested=custom.length?Object.fromEntries(custom.map(item=>[item.name,item.value])):FACE_PRESETS[name];
        if(!requested)throw new Error('Choose a listed expression or provide named morph shapes.');
        packet.shapes=Object.fromEntries(Object.entries(requested).filter(([shape])=>shapes.includes(shape)));
        if(!Object.keys(packet.shapes).length)throw new Error('This avatar lacks the facial shapes for that expression.');
        face=packet;
      }else{
        if(!MOTIONS.includes(name))throw new Error('Choose a listed gesture.');
        if(name==='yawn'&&!available().shapes.includes('jawOpen'))throw new Error('This avatar lacks the jaw shape needed to yawn.');
        if(['wave','raise_hand','arms_open','stretch','point'].includes(name)&&!available().bones.includes('RightArm'))throw new Error('This avatar lacks the arm rig for that gesture.');
        motion=packet;
      }
    }else throw new Error('Use get, pose, gesture, hands, gaze, settings or reset.');
    const result=state();emit(result);return {...result,delivery:'Sent to connected avatar viewers; no audio or message was sent.'};
  }
  return {state,command};
}
export const avatarPerformance=createPerformance();
export function backgroundPerformance(data){
  try{
    if(data?.expression)avatarPerformance.command({action:'pose',expression:data.expression,strength:data.strength??.5,duration:5},'background');
    if(data?.gesture)avatarPerformance.command({action:'gesture',gesture:data.gesture,strength:data.strength??.5,duration:4},'background');
  }catch{}
}
