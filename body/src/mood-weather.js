// Her mood as weather. What she feels (emotion.js, the blend behind her face) and the pressure she's
// under (pressure.js buckets) become a handful of numbers, 0 to 1, that every shader in her scene
// receives as uniforms: a sunny day when she's happy, clouds rolling in as she gets worried, a storm
// with lightning when she's angry, rain when she's sad, wind when she's restless. She writes the
// shaders; this decides the weather. Pure: it takes the state and returns numbers.

const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));
const pick = (f, names) => names.reduce((sum, n) => sum + clamp01(f[n]), 0);

// feelings: { joy: 0.6, worried: 0.2, ... } (any of EMOTIONS); buckets: pressure buckets 0..1.
export function moodVector(feelings = {}, buckets = {}) {
  const f = feelings ?? {}, b = buckets ?? {};
  // Both directions come from the pressure system (Owner, 2026-11-10: "I've never seen anything positive"). The
  // dark side always read irritation, unease and loneliness straight from the buckets; the bright side read only
  // her face. Her joy, thrill and growth pressures now bring the sun the same way.
  const joy = clamp01(pick(f, ['joy', 'amused', 'excited', 'playful', 'flirty', 'fond', 'confident', 'smug']) * 0.8 + clamp01(f.calm) * 0.2
    + clamp01(b.joy) * 0.7 + clamp01(b.thrill) * 0.3 + clamp01(b.growth) * 0.2);
  const anger = clamp01(pick(f, ['angry', 'frustrated', 'annoyed', 'disgusted']) * 0.9 + clamp01(b.irritation) * 0.6);
  const sadness = clamp01(pick(f, ['sad', 'embarrassed', 'tired']) * 0.9 + Math.max(0, ...Object.values(b.loneliness ?? {}).map((p) => clamp01(p?.value ?? p))) * 0.5);
  const tension = clamp01(pick(f, ['worried', 'scared', 'confused', 'skeptical', 'surprised']) * 0.8 + clamp01(b.unease) * 0.6 + anger * 0.4);
  const energy = clamp01(pick(f, ['excited', 'determined', 'playful', 'curious']) * 0.6 + clamp01(b.restlessness) * 0.5 + clamp01(b.curiosity) * 0.3 + clamp01(b.thrill) * 0.3 - clamp01(f.tired) * 0.5 - clamp01(b.boredom) * 0.3 + 0.3);
  const calm = clamp01(1 - Math.max(anger, tension, sadness * 0.7) + clamp01(f.calm) * 0.3 + clamp01(f.pensive) * 0.2 - energy * 0.2);
  return { joy, calm, anger, sadness, tension, energy };
}

// The sky that mood makes. Each 0..1; they overlap on purpose (a sad storm is rain and lightning).
export function weatherFor(mood) {
  const m = mood;
  const storm = clamp01(m.anger * 1.1 + m.tension * 0.5 - m.joy * 0.4);
  const rain = clamp01(m.sadness * 1.1 + storm * 0.6 - m.joy * 0.3);
  const clouds = clamp01(m.tension * 0.8 + m.sadness * 0.6 + storm * 0.7 - m.joy * 0.5 - m.calm * 0.2);
  const wind = clamp01(m.energy * 0.6 + storm * 0.6 + m.anger * 0.3);
  const sun = clamp01(m.joy * 1.0 + m.calm * 0.5 - clouds * 0.8);
  const haze = clamp01(m.calm * 0.4 + m.sadness * 0.3 - m.energy * 0.3); // soft, still, misty
  return { storm, rain, clouds, wind, sun, haze };
}

// One word for the log and for her ("stormy", "sunny"), from the weather.
export function weatherWord(w) {
  if (w.storm > 0.55) return 'stormy';
  if (w.rain > 0.5) return 'rainy';
  if (w.clouds > 0.6) return 'overcast';
  if (w.wind > 0.6) return 'windy';
  if (w.haze > 0.5) return 'misty';
  if (w.sun > 0.55) return 'sunny';
  return 'clear';
}

export function moodWeather(feelings, buckets) {
  const mood = moodVector(feelings, buckets);
  const weather = weatherFor(mood);
  return { mood, weather, word: weatherWord(weather), at: Date.now() };
}
