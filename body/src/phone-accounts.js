// Phone app accounts (phone-link.js). data/phone-accounts.json holds, per username, the password as a scrypt hash
// with its salt, when the account was made, and the tokens issued to phones: only their sha256 hashes, with the
// device name, when issued and when last used. No password or token is ever stored as it was typed or sent.
// Accounts are made on this computer only (scripts/phone-account.mjs); the phone can only log in.
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { randomBytes, scrypt, createHash, timingSafeEqual } from 'node:crypto';
import path from 'node:path';

const KEYLEN = 64;
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const USERNAME = /^[A-Za-z0-9._-]{1,40}$/;
export const MIN_PASSWORD = 8;
const LAST_USED_EVERY_MS = 60_000; // lastUsed is written at most this often per token

const hashKey = (password, salt) => new Promise((resolve, reject) =>
  scrypt(String(password).normalize('NFKC'), Buffer.from(salt, 'hex'), KEYLEN, SCRYPT, (err, key) => (err ? reject(err) : resolve(key))));
export const tokenHash = (token) => createHash('sha256').update(String(token)).digest('hex');

export function usernameProblem(username) {
  return USERNAME.test(String(username ?? '')) ? null : 'A username is 1 to 40 letters, numbers, dots, dashes or underscores.';
}

export function createAccounts({ file, now = Date.now } = {}) {
  if (!file) throw new Error('createAccounts needs the accounts file path');
  const read = () => {
    if (!existsSync(file)) return {};
    try { return JSON.parse(readFileSync(file, 'utf8')) ?? {}; }
    catch (err) { throw new Error(`${file} couldn't be read (${err.message}); fix or delete it and make the account again with scripts/phone-account.mjs`); }
  };
  const write = (all) => {
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(all, null, 2));
    renameSync(tmp, file);
  };
  const key = (username) => String(username ?? '').trim().toLowerCase();

  return {
    file,
    async add(username, password) {
      const problem = usernameProblem(username);
      if (problem) throw new Error(problem);
      if (String(password ?? '').length < MIN_PASSWORD) throw new Error(`The password must be at least ${MIN_PASSWORD} characters.`);
      const all = read();
      const salt = randomBytes(16).toString('hex');
      const hash = (await hashKey(password, salt)).toString('hex');
      const had = all[key(username)];
      // A new password ends every phone signed in with the old one.
      all[key(username)] = { salt, hash, created: had?.created ?? new Date(now()).toISOString(), changed: had ? new Date(now()).toISOString() : undefined, tokens: [] };
      write(all);
      return { replaced: Boolean(had) };
    },
    async verify(username, password) {
      const acct = read()[key(username)];
      // An unknown name costs the same as a wrong password, so the timing doesn't say which names exist.
      const salt = acct?.salt ?? '00'.repeat(16);
      const got = await hashKey(password ?? '', salt);
      if (!acct) return false;
      const want = Buffer.from(acct.hash, 'hex');
      return want.length === got.length && timingSafeEqual(want, got);
    },
    issueToken(username, device = '') {
      const all = read();
      const acct = all[key(username)];
      if (!acct) throw new Error(`There's no phone account "${username}".`);
      const token = randomBytes(32).toString('base64url');
      const at = new Date(now()).toISOString();
      (acct.tokens ??= []).push({ hash: tokenHash(token), device: String(device ?? '').slice(0, 60), created: at, lastUsed: at });
      write(all);
      return token;
    },
    // { username, device } for a token that was issued and not revoked, else null.
    checkToken(token) {
      if (!token) return null;
      const h = Buffer.from(tokenHash(token), 'hex');
      const all = read();
      for (const [username, acct] of Object.entries(all)) {
        for (const t of acct.tokens ?? []) {
          const stored = Buffer.from(t.hash, 'hex');
          if (stored.length === h.length && timingSafeEqual(stored, h)) {
            if (now() - Date.parse(t.lastUsed || 0) > LAST_USED_EVERY_MS) { t.lastUsed = new Date(now()).toISOString(); try { write(all); } catch {} }
            return { username, device: t.device };
          }
        }
      }
      return null;
    },
    list() {
      return Object.entries(read()).map(([username, a]) => ({ username, created: a.created, tokens: (a.tokens ?? []).map(({ device, created, lastUsed }) => ({ device, created, lastUsed })) }));
    },
    remove(username) {
      const all = read();
      if (!all[key(username)]) return false;
      delete all[key(username)];
      write(all);
      return true;
    },
    revokeTokens(username) {
      const all = read();
      const acct = all[key(username)];
      if (!acct) return null;
      const n = (acct.tokens ?? []).length;
      acct.tokens = [];
      write(all);
      return n;
    },
  };
}

export const accountsFile = (dataDir) => path.join(dataDir, 'phone-accounts.json');
