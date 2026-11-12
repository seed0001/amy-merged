import { config } from './config.js';
import { listContacts } from './memory.js';

// What her prompts call her owner. Taken from the contact record for the owner's Discord ID, so it's
// only known once she's actually met him; until then (or after a wipe) it's "your owner", never a name
// that was written into the code.
export function ownerDisplayName() {
  try {
    const owner = listContacts().find((c) => (config.ownerIds ?? []).map(String).includes(String(c.user_id)));
    return owner?.name || 'your owner';
  } catch {
    return 'your owner';
  }
}
