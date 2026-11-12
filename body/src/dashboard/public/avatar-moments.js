// Her emotional outbursts: many distinct ways to laugh, cry and get frustrated. Each style is a
// recipe (face, rhythm, head, shoulders, breath, eyes, tears) played by one performer, so every style
// moves differently: a snicker puffs through the nose with the mouth shut, a cackle throws the head
// back with the mouth wide, a wheeze shakes silently with the eyes squeezed shut, a sniffle twitches
// the nose and catches the breath, a huff puffs the cheeks and drops the shoulders.
//
// Shared by the server (to choose) and the avatar page (to perform). Degrees: +pitch is chin down.
// Fields:
//   family   laugh | cry | frustrated        ms       how long it lasts
//   attack / release   fraction of the time spent easing in / out
//   face     shapes held through it (scaled by the envelope)
//   pulse    the rhythm: rate (bursts per second), sharp (higher = snappier bursts), shapes added on
//            each burst, jaw (mouth opening per burst), bob (head bob per burst, deg), shoulders,
//            breath, irregular (0..1 how uneven the bursts are), fade (bursts die away over time)
//   jaw      mouth held open      head     { pattern, amount, roll, yaw } (see headPose)
//   gaze     [x, y] eyes (-1..1)  blink    blink-rate multiplier
//   tears    none | teary | cry | sob (real tears)      roll   eye roll (0..1)
//   sigh     a big exhale at this point in time (0..1), with the shoulders dropping
export const STYLES = {
  // ---------------- laughs, small to huge ----------------
  snicker: { family: 'laugh', ms: 1300, attack: 0.15, release: 0.35, face: { mouthSmileLeft: 0.5, mouthSmileRight: 0.3, mouthPressLeft: 0.3, mouthPressRight: 0.3, cheekSquintLeft: 0.3, eyeSquintLeft: 0.25, eyeSquintRight: 0.15 },
    pulse: { rate: 5, sharp: 2, shapes: { noseSneerLeft: 0.35, noseSneerRight: 0.25 }, jaw: 0, bob: 1.5, shoulders: 0.15, breath: 1 }, head: { pattern: 'duck', amount: 5, roll: 4 }, gaze: [0.2, 0.3] },
  giggle: { family: 'laugh', ms: 1600, attack: 0.18, release: 0.3, face: { mouthSmileLeft: 0.55, mouthSmileRight: 0.55, cheekSquintLeft: 0.5, cheekSquintRight: 0.5, eyeSquintLeft: 0.45, eyeSquintRight: 0.45, mouthPressLeft: 0.15, mouthPressRight: 0.15, browInnerUp: 0.15 },
    pulse: { rate: 6.5, sharp: 0.7, jaw: 0.04, bob: 1.5, shoulders: 0.25, breath: 1.5 }, jaw: 0.04, head: { pattern: 'duck', amount: 7, roll: 7 }, gaze: [0, 0.25] },
  shy_giggle: { family: 'laugh', ms: 2000, attack: 0.2, release: 0.35, face: { mouthSmileLeft: 0.45, mouthSmileRight: 0.4, mouthPressLeft: 0.25, mouthPressRight: 0.25, cheekSquintLeft: 0.4, cheekSquintRight: 0.4, eyeSquintLeft: 0.3, eyeSquintRight: 0.3, browInnerUp: 0.3, eyeBlinkLeft: 0.2, eyeBlinkRight: 0.2 },
    pulse: { rate: 5.5, sharp: 0.8, jaw: 0.02, bob: 1, shoulders: 0.3, breath: 1 }, head: { pattern: 'turn', amount: 10, roll: 6, yaw: 14 }, gaze: [-0.5, 0.45], blink: 1.5 },
  titter: { family: 'laugh', ms: 1400, attack: 0.12, release: 0.3, face: { mouthSmileLeft: 0.6, mouthSmileRight: 0.6, cheekSquintLeft: 0.45, cheekSquintRight: 0.45, eyeSquintLeft: 0.35, eyeSquintRight: 0.35, browOuterUpLeft: 0.2, browOuterUpRight: 0.2 },
    pulse: { rate: 9, sharp: 0.9, jaw: 0.06, bob: 1, shoulders: 0.35, breath: 1 }, jaw: 0.05, head: { pattern: 'lift', amount: 3, roll: -4 } },
  chuckle: { family: 'laugh', ms: 1800, attack: 0.2, release: 0.35, face: { mouthSmileLeft: 0.5, mouthSmileRight: 0.45, cheekSquintLeft: 0.35, cheekSquintRight: 0.35, eyeSquintLeft: 0.3, eyeSquintRight: 0.3, mouthDimpleLeft: 0.2, mouthDimpleRight: 0.2 },
    pulse: { rate: 3.2, sharp: 1.2, jaw: 0.08, bob: 3, shoulders: 0.25, breath: 2 }, jaw: 0.04, head: { pattern: 'nods', amount: 4, roll: 2 } },
  scoff_laugh: { family: 'laugh', ms: 1500, attack: 0.1, release: 0.45, face: { mouthSmileLeft: 0.55, mouthSmileRight: 0.2, cheekPuff: 0.3, browOuterUpLeft: 0.35, eyeSquintRight: 0.25, noseSneerLeft: 0.2 },
    pulse: { rate: 1.4, sharp: 3, shapes: { cheekPuff: 0.4, mouthFunnel: 0.15 }, jaw: 0.05, bob: 4, shoulders: 0.3, breath: 3, fade: 0.8 }, head: { pattern: 'lift', amount: 6, roll: -5, yaw: 8 }, roll: 0.5 },
  laugh: { family: 'laugh', ms: 2200, attack: 0.18, release: 0.3, face: { mouthSmileLeft: 0.75, mouthSmileRight: 0.75, cheekSquintLeft: 0.6, cheekSquintRight: 0.6, eyeSquintLeft: 0.55, eyeSquintRight: 0.55, mouthDimpleLeft: 0.25, mouthDimpleRight: 0.25 },
    pulse: { rate: 4.6, sharp: 0.7, jaw: 0.14, bob: 3, shoulders: 0.45, breath: 2.5 }, jaw: 0.2, head: { pattern: 'lift', amount: 9, roll: 4 }, gaze: [0, -0.15] },
  surprised_laugh: { family: 'laugh', ms: 2300, attack: 0.08, release: 0.3, face: { mouthSmileLeft: 0.7, mouthSmileRight: 0.7, cheekSquintLeft: 0.5, cheekSquintRight: 0.5, eyeSquintLeft: 0.35, eyeSquintRight: 0.35 },
    open: { browInnerUp: 0.7, browOuterUpLeft: 0.6, browOuterUpRight: 0.6, eyeWideLeft: 0.5, eyeWideRight: 0.5, jawOpen: 0.3 },
    pulse: { rate: 4.4, sharp: 0.7, jaw: 0.14, bob: 3, shoulders: 0.45, breath: 2.5 }, jaw: 0.18, head: { pattern: 'back', amount: 12, roll: 3 } },
  belly_laugh: { family: 'laugh', ms: 3200, attack: 0.15, release: 0.3, face: { mouthSmileLeft: 0.85, mouthSmileRight: 0.85, cheekSquintLeft: 0.7, cheekSquintRight: 0.7, eyeSquintLeft: 0.7, eyeSquintRight: 0.7, eyeBlinkLeft: 0.25, eyeBlinkRight: 0.25 },
    pulse: { rate: 2.8, sharp: 0.9, jaw: 0.2, bob: 5, shoulders: 0.75, breath: 4 }, jaw: 0.3, head: { pattern: 'forward', amount: 10, roll: 3 } },
  head_back_laugh: { family: 'laugh', ms: 3200, attack: 0.12, release: 0.3, face: { mouthSmileLeft: 0.85, mouthSmileRight: 0.85, cheekSquintLeft: 0.7, cheekSquintRight: 0.7, eyeSquintLeft: 0.75, eyeSquintRight: 0.75, eyeBlinkLeft: 0.35, eyeBlinkRight: 0.35, browInnerUp: 0.25 },
    pulse: { rate: 4, sharp: 0.7, jaw: 0.2, bob: 4, shoulders: 0.7, breath: 3.5 }, jaw: 0.32, head: { pattern: 'back', amount: 24, roll: 5 } },
  cackle: { family: 'laugh', ms: 2800, attack: 0.1, release: 0.3, face: { mouthSmileLeft: 0.9, mouthSmileRight: 0.8, cheekSquintLeft: 0.6, cheekSquintRight: 0.6, eyeSquintLeft: 0.4, eyeSquintRight: 0.4, browDownLeft: 0.3, browOuterUpRight: 0.4, mouthStretchLeft: 0.2, mouthStretchRight: 0.2 },
    pulse: { rate: 7, sharp: 0.6, jaw: 0.22, bob: 2.5, shoulders: 0.55, breath: 3 }, jaw: 0.38, head: { pattern: 'back', amount: 18, roll: -6, yaw: 6 } },
  wheeze: { family: 'laugh', ms: 3000, attack: 0.15, release: 0.3, face: { mouthSmileLeft: 0.8, mouthSmileRight: 0.8, cheekSquintLeft: 0.75, cheekSquintRight: 0.75, eyeSquintLeft: 0.8, eyeSquintRight: 0.8, eyeBlinkLeft: 0.6, eyeBlinkRight: 0.6, browInnerUp: 0.4, mouthStretchLeft: 0.25, mouthStretchRight: 0.25 },
    pulse: { rate: 8, sharp: 0.5, jaw: 0.03, bob: 1.2, shoulders: 0.6, breath: 2, irregular: 0.4 }, jaw: 0.35, head: { pattern: 'forward', amount: 14, roll: 4 }, gaze: [0, 0.3] },
  doubled_over: { family: 'laugh', ms: 3400, attack: 0.15, release: 0.3, face: { mouthSmileLeft: 0.85, mouthSmileRight: 0.85, cheekSquintLeft: 0.7, cheekSquintRight: 0.7, eyeSquintLeft: 0.7, eyeSquintRight: 0.7, eyeBlinkLeft: 0.45, eyeBlinkRight: 0.45 },
    pulse: { rate: 3.6, sharp: 0.8, jaw: 0.2, bob: 4, shoulders: 0.8, breath: 4 }, jaw: 0.28, head: { pattern: 'forward', amount: 26, roll: 2 }, gaze: [0, 0.6] },
  snort_laugh: { family: 'laugh', ms: 2400, attack: 0.12, release: 0.3, face: { mouthSmileLeft: 0.75, mouthSmileRight: 0.75, cheekSquintLeft: 0.6, cheekSquintRight: 0.6, eyeSquintLeft: 0.5, eyeSquintRight: 0.5 },
    pulse: { rate: 4.5, sharp: 0.8, jaw: 0.12, bob: 3, shoulders: 0.45, breath: 2.5, snort: 0.3 }, jaw: 0.15, head: { pattern: 'lift', amount: 7, roll: 3 } },
  laugh_to_tears: { family: 'laugh', ms: 3600, attack: 0.12, release: 0.3, face: { mouthSmileLeft: 0.85, mouthSmileRight: 0.85, cheekSquintLeft: 0.75, cheekSquintRight: 0.75, eyeSquintLeft: 0.8, eyeSquintRight: 0.8, eyeBlinkLeft: 0.4, eyeBlinkRight: 0.4, browInnerUp: 0.45 },
    pulse: { rate: 4, sharp: 0.7, jaw: 0.18, bob: 3.5, shoulders: 0.65, breath: 3.5 }, jaw: 0.3, head: { pattern: 'back', amount: 15, roll: 6 }, tears: 'teary' },
  trailing_laugh: { family: 'laugh', ms: 2800, attack: 0.12, release: 0.45, face: { mouthSmileLeft: 0.7, mouthSmileRight: 0.7, cheekSquintLeft: 0.5, cheekSquintRight: 0.5, eyeSquintLeft: 0.45, eyeSquintRight: 0.45 },
    pulse: { rate: 4.2, sharp: 0.8, jaw: 0.16, bob: 3, shoulders: 0.45, breath: 2.5, fade: 0.9 }, jaw: 0.14, head: { pattern: 'lift', amount: 7, roll: 5 }, sigh: 0.8 },

  // ---------------- crying, holding it in to sobbing ----------------
  lip_tremble: { family: 'cry', ms: 2600, attack: 0.25, release: 0.3, face: { browInnerUp: 0.6, mouthPressLeft: 0.45, mouthPressRight: 0.45, mouthFrownLeft: 0.3, mouthFrownRight: 0.3, mouthShrugLower: 0.35, eyeSquintLeft: 0.15, eyeSquintRight: 0.15 },
    pulse: { rate: 9, sharp: 0.6, shapes: { mouthShrugLower: 0.15, mouthRollLower: 0.1 }, irregular: 0.5 }, head: { pattern: 'duck', amount: 6, roll: 2 }, gaze: [0.2, 0.35], blink: 1.6 },
  sniffle: { family: 'cry', ms: 2200, attack: 0.2, release: 0.3, face: { browInnerUp: 0.55, mouthFrownLeft: 0.25, mouthFrownRight: 0.25, eyeSquintLeft: 0.2, eyeSquintRight: 0.2, eyeBlinkLeft: 0.15, eyeBlinkRight: 0.15 },
    pulse: { rate: 1.6, sharp: 4, shapes: { noseSneerLeft: 0.45, noseSneerRight: 0.45, mouthPressLeft: 0.2, mouthPressRight: 0.2 }, bob: -2, breath: 3, irregular: 0.3 }, head: { pattern: 'duck', amount: 7, roll: 3 }, gaze: [0, 0.4], blink: 1.4 },
  welling_up: { family: 'cry', ms: 3000, attack: 0.25, release: 0.3, face: { browInnerUp: 0.7, mouthFrownLeft: 0.35, mouthFrownRight: 0.35, mouthPressLeft: 0.3, mouthPressRight: 0.3, mouthShrugLower: 0.3, eyeSquintLeft: 0.2, eyeSquintRight: 0.2, eyeBlinkLeft: 0.25, eyeBlinkRight: 0.25 },
    pulse: { rate: 7, sharp: 0.6, shapes: { mouthShrugLower: 0.12 } }, head: { pattern: 'duck', amount: 8, roll: 3 }, gaze: [0, 0.4], blink: 1.8, tears: 'teary' },
  silent_tears: { family: 'cry', ms: 4200, attack: 0.3, release: 0.3, face: { browInnerUp: 0.55, mouthFrownLeft: 0.2, mouthFrownRight: 0.2, mouthPressLeft: 0.35, mouthPressRight: 0.35, eyeBlinkLeft: 0.3, eyeBlinkRight: 0.3 },
    pulse: { rate: 0.6, sharp: 2, breath: 1.5 }, head: { pattern: 'still', amount: 3 }, gaze: [0.35, 0.2], blink: 0.6, tears: 'cry' },
  hurt_turn_away: { family: 'cry', ms: 3400, attack: 0.25, release: 0.3, face: { browInnerUp: 0.8, mouthFrownLeft: 0.45, mouthFrownRight: 0.45, mouthPressLeft: 0.3, mouthPressRight: 0.3, eyeBlinkLeft: 0.55, eyeBlinkRight: 0.55, eyeSquintLeft: 0.3, eyeSquintRight: 0.3 },
    pulse: { rate: 6, sharp: 0.6, shapes: { mouthShrugLower: 0.12 }, breath: 1.5 }, head: { pattern: 'turn', amount: 12, roll: 5, yaw: 26 }, gaze: [-0.6, 0.4], tears: 'teary' },
  cry: { family: 'cry', ms: 4000, attack: 0.2, release: 0.3, face: { browInnerUp: 0.9, browDownLeft: 0.2, browDownRight: 0.2, mouthFrownLeft: 0.55, mouthFrownRight: 0.55, mouthStretchLeft: 0.3, mouthStretchRight: 0.3, mouthShrugLower: 0.35, eyeSquintLeft: 0.4, eyeSquintRight: 0.4, eyeBlinkLeft: 0.4, eyeBlinkRight: 0.4, cheekSquintLeft: 0.25, cheekSquintRight: 0.25 },
    pulse: { rate: 1.5, sharp: 2.2, shapes: { mouthShrugLower: 0.12 }, jaw: 0.08, bob: -3, shoulders: 0.3, breath: 2 }, jaw: 0.06, head: { pattern: 'duck', amount: 16, roll: 4 }, gaze: [0, 0.5], blink: 2.2, tears: 'cry' },
  ugly_cry: { family: 'cry', ms: 4600, attack: 0.15, release: 0.3, face: { browInnerUp: 1, browDownLeft: 0.35, browDownRight: 0.35, mouthFrownLeft: 0.7, mouthFrownRight: 0.7, mouthStretchLeft: 0.6, mouthStretchRight: 0.6, mouthShrugLower: 0.4, eyeSquintLeft: 0.6, eyeSquintRight: 0.6, eyeBlinkLeft: 0.55, eyeBlinkRight: 0.55, cheekSquintLeft: 0.4, cheekSquintRight: 0.4, noseSneerLeft: 0.3, noseSneerRight: 0.3 },
    pulse: { rate: 1.8, sharp: 2, jaw: 0.14, bob: -4, shoulders: 0.5, breath: 3, irregular: 0.35 }, jaw: 0.2, head: { pattern: 'lift', amount: 6, roll: 6 }, blink: 1.2, tears: 'sob' },
  sob: { family: 'cry', ms: 5500, attack: 0.2, release: 0.3, face: { browInnerUp: 1, browDownLeft: 0.3, browDownRight: 0.3, mouthFrownLeft: 0.65, mouthFrownRight: 0.65, mouthStretchLeft: 0.45, mouthStretchRight: 0.45, mouthShrugLower: 0.4, eyeSquintLeft: 0.5, eyeSquintRight: 0.5, eyeBlinkLeft: 0.65, eyeBlinkRight: 0.65, cheekSquintLeft: 0.35, cheekSquintRight: 0.35 },
    pulse: { rate: 1.7, sharp: 2.2, jaw: 0.14, bob: -5, shoulders: 0.55, breath: 3, irregular: 0.25 }, jaw: 0.1, head: { pattern: 'forward', amount: 27, roll: 6 }, gaze: [0, 0.7], blink: 1.4, tears: 'sob' },

  // ---------------- sympathy: a listener's reaction to someone else's trouble ----------------
  // Not her own pain: soft brows, a tilt toward them, leaning in. Tears only for someone close.
  aww: { family: 'sympathy', ms: 2200, attack: 0.25, release: 0.35, face: { browInnerUp: 0.55, mouthFrownLeft: 0.15, mouthFrownRight: 0.15, mouthPucker: 0.15, mouthSmileLeft: 0.12, mouthSmileRight: 0.12, eyeSquintLeft: 0.1, eyeSquintRight: 0.1 },
    pulse: { rate: 0.5, sharp: 2, breath: 1 }, head: { pattern: 'duck', amount: 4, roll: 9 }, blink: 0.8 },
  concerned: { family: 'sympathy', ms: 2600, attack: 0.25, release: 0.35, face: { browInnerUp: 0.6, browDownLeft: 0.15, browDownRight: 0.15, mouthPressLeft: 0.2, mouthPressRight: 0.2, mouthFrownLeft: 0.15, mouthFrownRight: 0.15, eyeWideLeft: 0.1, eyeWideRight: 0.1 },
    pulse: { rate: 0.4, sharp: 2 }, head: { pattern: 'duck', amount: 3, roll: 6 }, gaze: [0, 0.05], blink: 0.7 },
  wince: { family: 'sympathy', ms: 1800, attack: 0.12, release: 0.4, face: { eyeSquintLeft: 0.5, eyeSquintRight: 0.5, mouthStretchLeft: 0.35, mouthStretchRight: 0.35, browInnerUp: 0.4, browDownLeft: 0.2, browDownRight: 0.2, noseSneerLeft: 0.15, noseSneerRight: 0.15 },
    pulse: { rate: 0.5, sharp: 3 }, head: { pattern: 'lift', amount: 4, roll: -4 } },
  heartfelt: { family: 'sympathy', ms: 3400, attack: 0.3, release: 0.35, face: { browInnerUp: 0.75, mouthFrownLeft: 0.25, mouthFrownRight: 0.25, mouthPressLeft: 0.2, mouthPressRight: 0.2, eyeBlinkLeft: 0.2, eyeBlinkRight: 0.2, eyeSquintLeft: 0.1, eyeSquintRight: 0.1 },
    pulse: { rate: 0.4, sharp: 2, breath: 1.5 }, head: { pattern: 'duck', amount: 6, roll: 8 }, blink: 1.4, tears: 'teary' },

  // ---------------- frustration ----------------
  huff: { family: 'frustrated', ms: 1800, attack: 0.15, release: 0.4, face: { browDownLeft: 0.4, browDownRight: 0.4, mouthPressLeft: 0.35, mouthPressRight: 0.35, eyeSquintLeft: 0.2, eyeSquintRight: 0.2 },
    pulse: { rate: 0.6, sharp: 3, shapes: { cheekPuff: 0.6, mouthFunnel: 0.2 }, breath: 3 }, head: { pattern: 'duck', amount: 4 }, sigh: 0.5 },
  groan: { family: 'frustrated', ms: 2400, attack: 0.2, release: 0.35, face: { browInnerUp: 0.4, browDownLeft: 0.2, browDownRight: 0.2, mouthFrownLeft: 0.35, mouthFrownRight: 0.35, mouthStretchLeft: 0.25, mouthStretchRight: 0.25, eyeBlinkLeft: 0.45, eyeBlinkRight: 0.45 },
    pulse: { rate: 0.5, sharp: 1.5, jaw: 0.1 }, jaw: 0.12, head: { pattern: 'back', amount: 16, roll: -3 }, roll: 0.6, sigh: 0.6 },
  eye_roll_sigh: { family: 'frustrated', ms: 2200, attack: 0.15, release: 0.35, face: { browOuterUpLeft: 0.3, browOuterUpRight: 0.3, mouthPressLeft: 0.3, mouthLeft: 0.2, eyeSquintLeft: 0.15 },
    pulse: { rate: 0.5, sharp: 2 }, head: { pattern: 'lift', amount: 6, roll: 5, yaw: -6 }, roll: 1, sigh: 0.65 },
  jaw_clench: { family: 'frustrated', ms: 2200, attack: 0.15, release: 0.35, face: { browDownLeft: 0.6, browDownRight: 0.6, mouthPressLeft: 0.6, mouthPressRight: 0.6, jawForward: 0.25, noseSneerLeft: 0.25, noseSneerRight: 0.25, eyeSquintLeft: 0.4, eyeSquintRight: 0.4, mouthRollLower: 0.2 },
    pulse: { rate: 2.5, sharp: 3, shapes: { jawForward: 0.1, mouthPressLeft: 0.1, mouthPressRight: 0.1 }, irregular: 0.4 }, head: { pattern: 'duck', amount: 5 }, gaze: [0.3, 0] },
  disbelief_shake: { family: 'frustrated', ms: 2600, attack: 0.15, release: 0.35, face: { browInnerUp: 0.35, browDownLeft: 0.3, mouthPressLeft: 0.3, mouthPressRight: 0.3, mouthSmileLeft: 0.1, eyeBlinkLeft: 0.3, eyeBlinkRight: 0.3 },
    pulse: { rate: 0.5, sharp: 1.5 }, head: { pattern: 'slow_shake', amount: 16, roll: 2 }, sigh: 0.7 },
  exasperated: { family: 'frustrated', ms: 3000, attack: 0.2, release: 0.35, face: { browInnerUp: 0.5, browDownLeft: 0.3, browDownRight: 0.3, eyeBlinkLeft: 0.7, eyeBlinkRight: 0.7, mouthPressLeft: 0.35, mouthPressRight: 0.35, mouthFrownLeft: 0.2, mouthFrownRight: 0.2 },
    pulse: { rate: 0.4, sharp: 2, breath: 2 }, head: { pattern: 'drop', amount: 18, roll: 3 }, sigh: 0.45 },
  glare: { family: 'frustrated', ms: 2600, attack: 0.2, release: 0.35, face: { browDownLeft: 0.75, browDownRight: 0.75, eyeSquintLeft: 0.55, eyeSquintRight: 0.55, mouthPressLeft: 0.4, mouthPressRight: 0.4, noseSneerLeft: 0.2, noseSneerRight: 0.2 },
    pulse: { rate: 0.3, sharp: 2 }, head: { pattern: 'duck', amount: 8 }, gaze: [0, -0.1], blink: 0.3 },
  ugh: { family: 'frustrated', ms: 1900, attack: 0.1, release: 0.4, face: { noseSneerLeft: 0.5, noseSneerRight: 0.5, mouthUpperUpLeft: 0.4, mouthUpperUpRight: 0.4, browDownLeft: 0.45, browDownRight: 0.45, eyeSquintLeft: 0.4, eyeSquintRight: 0.4, mouthFrownLeft: 0.25, mouthFrownRight: 0.25 },
    pulse: { rate: 0.5, sharp: 2, jaw: 0.08 }, head: { pattern: 'back', amount: 10, roll: -4, yaw: 5 } },
};

// For choosing: each family's styles from mildest to strongest. A strength of 0..1 picks a band,
// and a style within it (not the same one twice in a row).
export const LADDER = {
  laugh: [['snicker', 'giggle', 'shy_giggle', 'titter'], ['chuckle', 'scoff_laugh', 'snort_laugh', 'trailing_laugh'], ['laugh', 'surprised_laugh', 'cackle'], ['head_back_laugh', 'belly_laugh', 'wheeze', 'doubled_over', 'laugh_to_tears']],
  sympathy: [['aww', 'concerned'], ['wince', 'concerned'], ['aww'], ['heartfelt']],
  cry: [['lip_tremble', 'sniffle'], ['welling_up', 'silent_tears', 'hurt_turn_away'], ['cry'], ['sob', 'ugly_cry']],
  frustrated: [['huff', 'eye_roll_sigh'], ['jaw_clench', 'ugh', 'glare'], ['groan', 'disbelief_shake'], ['exasperated']],
};
// The original moment names map onto styles.
export const ALIASES = { big_laugh: 'head_back_laugh', teary: 'welling_up' };

// ---- the performer (avatar page) ----
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const sstep = (t) => { t = clamp01(t); return t * t * (3 - 2 * t); };
const envelope = (t, a, r) => (t < a ? sstep(t / a) : t > 1 - r ? sstep((1 - t) / r) : 1);
// Deterministic unevenness for a burst, so irregular rhythms look human but don't flicker.
const jitter = (n) => { const x = Math.sin(n * 91.7 + 13.1) * 43758.5453; return x - Math.floor(x); };

function headPose(h, t, b, side) {
  const A = h?.amount ?? 0;
  switch (h?.pattern) {
    case 'duck': return { pitch: A * b, yaw: (h.yaw ?? 0) * side * b };
    case 'lift': return { pitch: -A * b, yaw: (h.yaw ?? 0) * side * b };
    case 'forward': return { pitch: A * b, yaw: 0 };
    case 'drop': return { pitch: A * sstep(t / 0.35) * b, yaw: 0 }; // falls and stays down
    case 'turn': return { pitch: A * 0.6 * b, yaw: (h.yaw ?? A) * side * b };
    case 'still': return { pitch: A * b, yaw: 0 };
    case 'nods': return { pitch: A * 0.3 * b, yaw: 0 };
    case 'slow_shake': return { pitch: 3 * b, yaw: A * Math.sin(Math.PI * 2 * 2 * t) * b };
    case 'back': { // throws the head back, then comes forward to recover
      const up = sstep(t / 0.25) * (t > 0.72 ? sstep((1 - t) / 0.28) : 1);
      const recover = sstep((t - 0.72) / 0.18) * sstep((1 - t) / 0.1);
      return { pitch: -A * up + A * 0.28 * recover, yaw: (h.yaw ?? 0) * side * b };
    }
    default: return { pitch: 0, yaw: 0 };
  }
}

// One frame of a style at t (0..1). add(shape, weight) writes face shapes; o is the body (fx) state.
// side is +1 or -1, picked per outburst, so lopsided styles don't always lean the same way.
export function perform(style, t, add, o, side = 1) {
  const s = STYLES[style];
  if (!s) return;
  const b = envelope(t, s.attack ?? 0.18, s.release ?? 0.3);
  const p = s.pulse ?? {};
  const seconds = (s.ms ?? 2000) / 1000;
  const phase = (p.rate ?? 0) * seconds * t; // bursts so far
  const n = Math.floor(phase);
  const uneven = 1 - (p.irregular ?? 0) * jitter(n);
  const fade = 1 - (p.fade ?? 0) * t;
  const burst = p.rate ? Math.pow(Math.abs(Math.sin(Math.PI * phase)), p.sharp ?? 1) * b * uneven * fade : 0;
  for (const [k, v] of Object.entries(s.face ?? {})) add(k, v * b);
  for (const [k, v] of Object.entries(p.shapes ?? {})) add(k, v * burst);
  // A surprised start: wide eyes and brows that give way to the laugh.
  if (s.open) { const k = (1 - sstep(t / 0.3)) * b; for (const [x, v] of Object.entries(s.open)) add(x, v * k); }
  if (p.snort && jitter(n + 7) > 0.65) { const k = burst * p.snort * 3; add('noseSneerLeft', k); add('noseSneerRight', k); }
  add('jawOpen', (s.jaw ?? 0) * b + (p.jaw ?? 0) * burst);
  const head = headPose(s.head, t, b, side);
  o.neckPitch += head.pitch + (p.bob ?? 0) * burst + (s.head?.pattern === 'nods' ? (s.head.amount ?? 0) * burst : 0);
  o.neckYaw += head.yaw;
  o.roll += (s.head?.roll ?? 0) * side * b;
  o.shoulders += (p.shoulders ?? 0) * burst;
  o.breath += (p.breath ?? 0) * b * 0.5 + (p.breath ?? 0) * burst * 0.5;
  if (s.sigh != null) { const k = Math.exp(-((t - s.sigh) ** 2) / 0.012); o.breath += 5 * k; o.shoulders -= 0.25 * k; o.neckPitch += 4 * k; }
  if (s.gaze) { o.gx += s.gaze[0] * side * b; o.gy += s.gaze[1] * b; }
  if (s.roll) { const r = clamp01((t - 0.1) / 0.6); o.gaze = { x: Math.cos(Math.PI * (1 - r)) * 0.8 * s.roll * b, y: -0.95 * s.roll * Math.sin(Math.PI * r) * b }; }
  if (s.blink) o.blink *= 1 + (s.blink - 1) * b;
  o.yesNo = 1; // neck and shoulders follow closely so the rhythm keeps its life
}
