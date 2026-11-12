export const FACE_PRESETS={
  smile:{mouthSmileLeft:.8,mouthSmileRight:.8,cheekSquintLeft:.25,cheekSquintRight:.25},
  grin:{mouthSmileLeft:1,mouthSmileRight:1,cheekSquintLeft:.6,cheekSquintRight:.6},
  frown:{mouthFrownLeft:.8,mouthFrownRight:.8,browInnerUp:.5},
  blink:{eyeBlinkLeft:1,eyeBlinkRight:1},
  // A real wink is the whole side of the face: the eye shuts, that cheek lifts into it, the mouth
  // corner pulls up into a half smile (with a dimple), the brow comes down a little, the nose
  // wrinkles on that side, and the open eye narrows slightly.
  wink_left:{eyeBlinkLeft:1,eyeBlinkRight:0,cheekSquintLeft:.7,mouthSmileLeft:.6,mouthSmileRight:.15,mouthDimpleLeft:.35,mouthLeft:.12,browDownLeft:.35,noseSneerLeft:.2,eyeSquintRight:.2},
  wink_right:{eyeBlinkRight:1,eyeBlinkLeft:0,cheekSquintRight:.7,mouthSmileRight:.6,mouthSmileLeft:.15,mouthDimpleRight:.35,mouthRight:.12,browDownRight:.35,noseSneerRight:.2,eyeSquintLeft:.2},
  // Little quirks.
  nose_scrunch:{noseSneerLeft:.85,noseSneerRight:.85,cheekSquintLeft:.55,cheekSquintRight:.55,eyeSquintLeft:.45,eyeSquintRight:.45,mouthUpperUpLeft:.35,mouthUpperUpRight:.35,browDownLeft:.35,browDownRight:.35,mouthSmileLeft:.2,mouthSmileRight:.2},
  smirk_left:{mouthSmileLeft:.7,mouthLeft:.2,cheekSquintLeft:.35,mouthDimpleLeft:.3,mouthPressRight:.25,eyeSquintLeft:.2,browOuterUpRight:.25},
  smirk_right:{mouthSmileRight:.7,mouthRight:.2,cheekSquintRight:.35,mouthDimpleRight:.3,mouthPressLeft:.25,eyeSquintRight:.2,browOuterUpLeft:.25},
  one_brow_up:{browOuterUpLeft:.9,browInnerUp:.25,browDownRight:.35,eyeSquintRight:.2,eyeWideLeft:.15,mouthPressLeft:.15},
  tongue_out:{tongueOut:.9,jawOpen:.3,mouthSmileLeft:.25,mouthSmileRight:.25,eyeSquintLeft:.3,eyeSquintRight:.3,noseSneerLeft:.25,noseSneerRight:.25},
  puff_cheeks:{cheekPuff:1,mouthClose:.6,mouthPucker:.25,eyeWideLeft:.2,eyeWideRight:.2,browInnerUp:.3},
  pout:{mouthPucker:.45,mouthShrugLower:.6,mouthShrugUpper:.25,mouthFrownLeft:.3,mouthFrownRight:.3,browInnerUp:.55,eyeSquintLeft:.1,eyeSquintRight:.1},
  lip_bite:{mouthRollLower:.75,mouthSmileLeft:.35,mouthSmileRight:.2,jawOpen:.06,eyeSquintLeft:.25,eyeSquintRight:.25,browInnerUp:.15},
  sneer:{noseSneerLeft:.7,mouthUpperUpLeft:.6,mouthLeft:.15,browDownLeft:.45,eyeSquintLeft:.35,cheekSquintLeft:.25},
  duck_face:{mouthPucker:1,mouthFunnel:.3,cheekSuck:.4,eyeWideLeft:.15,eyeWideRight:.15,browInnerUp:.2},
  eyes_closed:{eyeBlinkLeft:1,eyeBlinkRight:1},mouth_open:{jawOpen:.85},mouth_closed:{jawOpen:0,mouthClose:1},
  pucker:{mouthPucker:.9},surprised:{browInnerUp:.8,browOuterUpLeft:.8,browOuterUpRight:.8,eyeWideLeft:.6,eyeWideRight:.6,jawOpen:.4},
  brows_up:{browInnerUp:.9,browOuterUpLeft:.7,browOuterUpRight:.7},squint:{eyeSquintLeft:.8,eyeSquintRight:.8},
  crosseyed:{eyeLookInLeft:1,eyeLookInRight:1},
  thoughtful:{browDownLeft:.4,browOuterUpRight:.35,mouthPressLeft:.25,mouthPressRight:.25},
};
export const PULSED=['wink_left','wink_right','nose_scrunch','tongue_out','one_brow_up'];
// How long each quick quirk lasts by default (seconds).
export const QUICK={blink:.38,wink_left:.9,wink_right:.9,nose_scrunch:1.1,tongue_out:1.4,one_brow_up:1.6};
// The head moves with them: a wink tips the head toward the winking side and dips the chin.
// Degrees; +pitch is chin down, +roll tips toward her left.
export const FACE_HEAD={wink_left:{roll:6,pitch:3,yaw:3},wink_right:{roll:-6,pitch:3,yaw:-3},nose_scrunch:{pitch:-2,roll:0,yaw:0},smirk_left:{roll:3,pitch:-1,yaw:2},smirk_right:{roll:-3,pitch:-1,yaw:-2},one_brow_up:{roll:-4,pitch:-2,yaw:0},tongue_out:{roll:4,pitch:-2,yaw:0},pout:{roll:0,pitch:3,yaw:0},sneer:{roll:2,pitch:-2,yaw:4}};
export const MOTIONS=['wave','raise_hand','arms_open','stretch','point','nod','shake','tilt','shrug','yawn'];
// Hand poses (avatar-hands.js drives the finger bones): held for the duration, blended over her resting hand.
export const HAND_POSES=['relaxed','open','splay','fist','point','peace','thumbs_up','ok_sign','pinch','rock_on','wiggle','cup'];
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
    // Quick ones come and go in one smooth movement; a wink and a nose scrunch hold briefly at the peak.
    const pulse=pose.name==='blink'?Math.sin(pose.t*Math.PI):PULSED.includes(pose.name)?Math.min(1,Math.sin(pose.t*Math.PI)*1.6):pose.envelope;
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
