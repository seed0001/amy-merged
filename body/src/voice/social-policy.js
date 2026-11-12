// Automatic speech: only a companion waking after a process restart announces itself.
// Arrivals and channel joins/reconnections never trigger greetings. Conversation is unaffected.
export function automaticSpeech(kind, voice) {
  if (kind === 'taskProgress') return voice.taskProgress !== false;
  if (kind === 'voiceLearned') return voice.voiceLearned !== false;
  if (kind === 'overheardTask') return voice.overheardTasks !== false;
  return kind === 'restart';
}
