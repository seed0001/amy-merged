// Loaded before the test runner (npm test): every test gets a throwaway data folder, so a test run
// never writes into the live bot's logs, settings, database or activity feed.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.CHAMP_DATA_DIR ||= mkdtempSync(path.join(tmpdir(), 'champ-test-data-'));
// Tests never reach the live Ollama: a call with different settings hangs and reloads the model she's using.
process.env.OLLAMA_HOST = 'http://127.0.0.1:1';
// Nor any paid service: blank keys are set before config.js loads .env, and dotenv never overrides a
// variable that's already set, so a test can't spend the owner's credits or post to Discord.
for (const key of ['OPENROUTER_API_KEY', 'GROQ_API_KEY', 'TAVILY_API_KEY', 'MISTRAL_API_KEY', 'FISH_API_KEY', 'HF_TOKEN', 'DISCORD_TOKEN']) process.env[key] = '';

process.env.CONVERSATION_BUDGET_FILE ||= path.join(process.env.CHAMP_DATA_DIR, 'conversation-budget.db');
// Nor the real orchestra (FluidSynth and its 1.4 GB of sound sets, orchestra.js): an empty folder, so rendering uses the
// old recordings and tests stay fast. A test that wants the orchestra points SOUNDFONTS_DIR somewhere itself.
process.env.SOUNDFONTS_DIR ||= path.join(process.env.CHAMP_DATA_DIR, 'no-soundfonts');
