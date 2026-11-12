export const FACE_PRESETS={
  smile:{mouthSmileLeft:.8,mouthSmileRight:.8,cheekSquintLeft:.25,cheekSquintRight:.25},
  grin:{mouthSmileLeft:1,mouthSmileRight:1,cheekSquintLeft:.6,cheekSquintRight:.6},
  frown:{mouthFrownLeft:.8,mouthFrownRight:.8,browInnerUp:.5},
  blink:{eyeBlinkLeft:1,eyeBlinkRight:1},wink_left:{eyeBlinkLeft:1,eyeBlinkRight:0},wink_right:{eyeBlinkRight:1,eyeBlinkLeft:0},
  eyes_closed:{eyeBlinkLeft:1,eyeBlinkRight:1},mouth_open:{jawOpen:.85},mouth_closed:{jawOpen:0,mouthClose:1},
  pucker:{mouthPucker:.9},surprised:{browInnerUp:.8,browOuterUpLeft:.8,browOuterUpRight:.8,eyeWideLeft:.6,eyeWideRight:.6,jawOpen:.4},
  brows_up:{browInnerUp:.9,browOuterUpLeft:.7,browOuterUpRight:.7},squint:{eyeSquintLeft:.8,eyeSquintRight:.8},
  thoughtful:{browDownLeft:.4,browOuterUpRight:.35,mouthPressLeft:.25,mouthPressRight:.25},
};
export const MOTIONS=['wave','raise_hand','arms_open','stretch','point','nod','shake','tilt','shrug','yawn'];
export const GAZES=['ambient','camera','left','right','up','down'];
export function activeAnimation(packet,now=Date.now()){
  if(!packet||packet.duration>0&&now>=packet.at+packet.duration*1000)return null;
  const elapsed=Math.max(0,(now-packet.at)/1000),t=packet.duration?Math.min(1,elapsed/packet.duration):0;
  const envelope=packet.duration?Math.min(1,elapsed/.18,(packet.duration-elapsed)/.25):Math.min(1,elapsed/.18);
  return {...packet,t,envelope:Math.max(0,envelope)};
}
export function applyFacePerformance(weights,state,now=Date.now(),speech={}){
  const gain=state?.gain??1;
  for(const [name,value]of weights)if(!/^(viseme_|jawOpen|mouthOpen)/.test(name))weights.set(name,Math.min(1,value*gain));
  const pose=activeAnimation(state?.face,now),motion=activeAnimation(state?.motion,now);
  if(pose){
    if(['mouth_open','mouth_closed'].includes(pose.name))for(const name of weights.keys())if(/^(mouth|jaw|viseme_)/.test(name))weights.set(name,0);
    const pulse=['blink','wink_left','wink_right'].includes(pose.name)?Math.sin(pose.t*Math.PI):pose.envelope;
    for(const [name,value]of Object.entries(pose.shapes)){
      const speechBlend=speech.active&&/^mouth/.test(name)&&!['mouth_open','mouth_closed'].includes(pose.name)?1-.65*(speech.closure||.25):1;
      weights.set(name,Math.min(1,value*pose.strength*gain*pulse)*speechBlend);
    }
  }
  if(motion?.name==='yawn'&&!['mouth_open','mouth_closed'].includes(pose?.name)){
    const level=Math.sin(motion.t*Math.PI)*motion.strength;
    weights.set('jawOpen',Math.min(1,.85*level));weights.set('eyeBlinkLeft',.55*level);weights.set('eyeBlinkRight',.55*level);
  }
}
