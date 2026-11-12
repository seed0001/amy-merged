// Phone app accounts (src/phone-link.js), made on this computer only. The password is typed here, hidden, twice;
// it is never passed as an argument (it would sit in the shell history) and never stored as typed.
//
//   node scripts/phone-account.mjs <username>              make the account, or set a new password (ends its phones' sign-ins)
//   node scripts/phone-account.mjs --list                  accounts and the phones signed in to each
//   node scripts/phone-account.mjs --remove <username>     delete the account and every phone signed in with it
//   node scripts/phone-account.mjs --revoke-tokens <username>   sign every phone out; the password stays
//
// Changes take effect at once, the companion running or not: tokens are checked against the file on each request.
import { createAccounts, accountsFile, usernameProblem, MIN_PASSWORD } from '../src/phone-accounts.js';
import { DATA_DIR } from '../src/config.js';

const accounts = createAccounts({ file: accountsFile(DATA_DIR) });
const [first, second] = process.argv.slice(2);
const usage = 'Usage: node scripts/phone-account.mjs <username> | --list | --remove <username> | --revoke-tokens <username>';
const fail = (msg) => { console.error(msg); process.exit(1); };

// One line from the terminal with nothing echoed.
function askHidden(prompt) {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    if (!input.isTTY) return reject(new Error('This needs a real terminal to type the password into (hidden). Run it in a terminal window, not through a pipe.'));
    process.stdout.write(prompt);
    input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');
    let value = '';
    const done = (err) => {
      input.setRawMode(false);
      input.pause();
      input.off('data', onData);
      process.stdout.write('\n');
      err ? reject(err) : resolve(value);
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done();
        if (ch === '\u0003') return done(new Error('Cancelled; nothing was changed.'));
        if (ch === '\u007f' || ch === '\b') { value = value.slice(0, -1); continue; }
        if (ch >= ' ') value += ch;
      }
    };
    input.on('data', onData);
  });
}

try {
  if (!first) fail(usage);
  if (first === '--list') {
    const all = accounts.list();
    if (!all.length) console.log(`No phone accounts yet. Make one with: node scripts/phone-account.mjs <username>`);
    for (const a of all) {
      console.log(`${a.username} (made ${a.created}): ${a.tokens.length} phone(s) signed in`);
      for (const t of a.tokens) console.log(`  - ${t.device || 'phone'}: signed in ${t.created}, last used ${t.lastUsed}`);
    }
  } else if (first === '--remove') {
    if (!second) fail('Say which account: node scripts/phone-account.mjs --remove <username>');
    console.log(accounts.remove(second) ? `Removed "${second}" and signed out every phone that used it.` : `There's no phone account "${second}"; see --list.`);
  } else if (first === '--revoke-tokens') {
    if (!second) fail('Say which account: node scripts/phone-account.mjs --revoke-tokens <username>');
    const n = accounts.revokeTokens(second);
    console.log(n === null ? `There's no phone account "${second}"; see --list.` : `Signed out ${n} phone(s) from "${second}". The password is unchanged; they log in again with it.`);
  } else if (first.startsWith('-')) {
    fail(usage);
  } else {
    if (second) fail('Only the username goes on the command line; the password is typed when asked, hidden.');
    const problem = usernameProblem(first);
    if (problem) fail(problem);
    const existing = accounts.list().some((a) => a.username === first.toLowerCase());
    const pw = await askHidden(`${existing ? 'New password' : 'Password'} for "${first}" (at least ${MIN_PASSWORD} characters): `);
    if (pw.length < MIN_PASSWORD) fail(`That's shorter than ${MIN_PASSWORD} characters; nothing was changed. Run it again.`);
    const again = await askHidden('Type it again: ');
    if (again !== pw) fail('The two didn\'t match; nothing was changed. Run it again.');
    const { replaced } = await accounts.add(first, pw);
    console.log(replaced
      ? `Password changed for "${first}". Phones signed in with the old one are signed out and log in again.`
      : `Made phone account "${first}". In the app, log in with it over Tailscale; it acts as the owner.`);
  }
} catch (err) {
  fail(err.message);
}
process.exit(0);
