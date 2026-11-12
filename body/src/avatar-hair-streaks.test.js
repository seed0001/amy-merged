import test from 'node:test';
import assert from 'node:assert/strict';
import {avatarState} from './avatar-state.js';
import {enabledTools,runTool} from './tools.js';

test('hair streak color and amount are independent of the base hair and can be removed',async()=>{
  const ctx={perms:{owner:true},speaker:{id:'dashboard'},userText:'Add and adjust my hair streaks',character:{id:'main',main:true}};
  const schema=enabledTools(ctx).find(t=>t.function.name==='avatar_appearance').function.parameters.properties;
  assert.ok(schema.hair_streak);assert.match(schema.hair_streak_amount.description,/Use -1 when not needed/);
  await runTool('avatar_appearance',{action:'set',hair:'brown',hair_streak:'pink',hair_streak_amount:.3},ctx);
  assert.equal(avatarState.get().hair,'#754b32');assert.equal(avatarState.get().hairStreak,'#dc709d');assert.equal(avatarState.get().hairStreakAmount,.3);
  await runTool('avatar_appearance',{action:'set',hair_streak_amount:.8},ctx);
  assert.equal(avatarState.get().hairStreakAmount,.8);assert.equal(avatarState.get().hairStreak,'#dc709d');
  await runTool('avatar_appearance',{action:'set',hair_streak:'purple',hair_streak_amount:-1},ctx);
  assert.equal(avatarState.get().hairStreakAmount,.8);assert.equal(avatarState.get().hair,'#754b32');
  await runTool('avatar_appearance',{action:'set',hair_streak_amount:0},ctx);assert.equal(avatarState.get().hairStreakAmount,0);
  const result=await runTool('avatar_appearance',{action:'set',hair_streak_amount:2},ctx);
  assert.match(result,/Hair streak amount must be between/);assert.equal(avatarState.get().hairStreakAmount,0);
  await runTool('avatar_appearance',{action:'set',hair_streak:'none'},ctx);
  assert.equal(avatarState.get().hairStreak,null);assert.equal(avatarState.get().hair,'#754b32');
  await runTool('avatar_appearance',{action:'reset'},ctx);assert.equal(avatarState.get().hairStreak,null);assert.equal(avatarState.get().hairStreakAmount,.35);
});
