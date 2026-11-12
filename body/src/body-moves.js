// Her body's vocabulary for the body engine (body.js), kept free of imports so emotion.js and the
// engine can both read it. Fidgets are single moves played on her avatar page (GESTURE_DEFS in
// dashboard/public/avatar.js). Sequences are short orchestrations of moves played back to back: her
// moods fire them on their own, and she can name one in a [[do: ...]] tag.

export const FIDGETS = ['neck_stretch', 'neck_roll', 'shoulder_roll', 'settle', 'deep_breath', 'look_away', 'head_tilt', 'lip_press', 'chin_up'];

// Arm and whole-body moves that go through her performance controls instead (avatar-performance.js).
export const BODY_MOTIONS = ['yawn', 'stretch'];

export const SEQUENCES = {
  settle_in: ['deep_breath', 'shoulder_roll', 'neck_stretch'],
  restless: ['settle', 'look_away', 'shoulder_roll'],
  bored: ['sigh', 'look_away', 'yawn'],
  tense: ['lip_press', 'chin_up', 'deep_breath'],
  stretch_out: ['stretch', 'neck_roll'],
  curious: ['head_tilt', 'look_away', 'head_tilt'],
  uneasy: ['lip_press', 'look_away', 'deep_breath'],
  wake_up: ['yawn', 'stretch'], // waking: a big yawn, then a stretch (sleep.js)
};
