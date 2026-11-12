import test from 'node:test';
import assert from 'node:assert/strict';
import { moodVector, weatherFor, weatherWord, moodWeather } from './mood-weather.js';

test('happy and relaxed is a sunny, clear sky', () => {
  const w = weatherFor(moodVector({ joy: 0.7, calm: 0.5, fond: 0.3 }, { irritation: 0, unease: 0 }));
  assert.ok(w.sun > 0.6, `sun ${w.sun}`);
  assert.ok(w.storm < 0.1 && w.rain < 0.1 && w.clouds < 0.2);
  assert.equal(weatherWord(w), 'sunny');
});

test('angry means a storm with lightning, and the sun goes', () => {
  const w = weatherFor(moodVector({ angry: 0.6, frustrated: 0.5 }, { irritation: 0.7 }));
  assert.ok(w.storm > 0.8, `storm ${w.storm}`);
  assert.ok(w.clouds > 0.6);
  assert.equal(w.sun, 0);
  assert.equal(weatherWord(w), 'stormy');
});

test('sad is rain without much lightning', () => {
  const w = weatherFor(moodVector({ sad: 0.7, tired: 0.2 }, {}));
  assert.ok(w.rain > 0.6, `rain ${w.rain}`);
  assert.ok(w.storm < 0.3, `storm ${w.storm}`);
  assert.equal(weatherWord(w), 'rainy');
});

test('worry brings clouds; restlessness brings wind; missing someone weighs like sadness', () => {
  assert.ok(weatherFor(moodVector({ worried: 0.7 }, { unease: 0.5 })).clouds > 0.5);
  assert.ok(weatherFor(moodVector({ determined: 0.5 }, { restlessness: 0.9 })).wind > 0.5);
  assert.ok(moodVector({}, { loneliness: { a: { value: 0.8 } } }).sadness > 0.3);
});

test('the good pressures bring the sun as surely as the bad ones bring the storm, whatever the face shows', () => {
  const glad = weatherFor(moodVector({}, { joy: 0.8, thrill: 0.6, growth: 0.5, unease: 0.1 }));
  assert.ok(glad.sun > 0.6, `sun ${glad.sun}`);
  assert.ok(glad.storm < 0.1 && glad.rain < 0.1, `storm ${glad.storm} rain ${glad.rain}`);
  assert.equal(weatherWord(glad), 'sunny');
  // A little grumbling on the face doesn't black out a good day the pressure says he's having.
  const grumbly = weatherFor(moodVector({ annoyed: 0.3 }, { joy: 0.8, thrill: 0.7, irritation: 0.1 }));
  assert.ok(grumbly.sun > grumbly.clouds && grumbly.storm < 0.3, `sun ${grumbly.sun} clouds ${grumbly.clouds} storm ${grumbly.storm}`);
  // And it still goes the other way: high irritation with no joy is a storm.
  assert.equal(weatherWord(weatherFor(moodVector({}, { irritation: 0.9, unease: 0.6 }))), 'stormy');
});

test('nothing at all is a quiet, clear day, and every number stays in 0..1', () => {
  const { mood, weather, word } = moodWeather({}, {});
  for (const v of [...Object.values(mood), ...Object.values(weather)]) assert.ok(v >= 0 && v <= 1);
  assert.ok(['clear', 'sunny', 'misty'].includes(word));
  const wild = moodWeather({ joy: 9, angry: 9, sad: -3 }, { irritation: 5 });
  for (const v of [...Object.values(wild.mood), ...Object.values(wild.weather)]) assert.ok(v >= 0 && v <= 1);
});
