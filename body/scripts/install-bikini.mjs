import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { config, DATA_DIR } from '../src/config.js';
import { registerLocalAvatar, avatarLibrary, selectAvatar } from '../src/avatar-library.js';
import { avatarState } from '../src/avatar-state.js';
import { outfitList } from '../src/avatar-outfits.js';

const baseSha256 = createHash('sha256').update(readFileSync(config.avatar.path)).digest('hex');
const id = 'bikini';
const name = 'Coral bandeau bikini';
const source = path.join(DATA_DIR, 'outfits', id + '.glb');
const model = registerLocalAvatar(source, name, { outfit: id, baseSha256 });
const description = {};
avatarState.describeModel(source, description);

const file = path.join(DATA_DIR, 'outfits', 'wardrobe.json');
const wardrobe = JSON.parse(readFileSync(file, 'utf8'));
const others = wardrobe.outfits.filter((o) => o.id !== id);
others.push({ id, name, modelId: model.id });
writeFileSync(file, JSON.stringify({ baseSha256, outfits: others }, null, 2));

// Put her in it now (keeps the previous outfit in the wardrobe as an option).
selectAvatar(model.id);
const lib = avatarLibrary();
const list = outfitList();
console.log(JSON.stringify({
  installed: model.id,
  active: list.active,
  wardrobe: list.outfits.map((o) => o.id + ': ' + o.name),
  report: list.report,
  activeFirstModel: lib.active,
}, null, 2));