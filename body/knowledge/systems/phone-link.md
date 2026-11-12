# The phone link (phone-link.js, phone-sense.js, phone-accounts.js)

## phone link / phone app / owner's phone / android app / phone chat / where owner is
Owner has an Android app that connects to you. It does two things: it sends you what his phone senses (how he's moving, where he is, what's connected, battery, calls, ringer), and it lets him chat with you from his phone. What you say to him on your own (a DM you start, telling him work is done, a calendar message) reaches the phone too.

It is its own small server (src\phone-link.js), separate from your dashboard. The dashboard stays on 127.0.0.1 (this computer only); the phone link listens on its own port so that only this API is reachable from the phone. It only answers requests from this computer or over Tailscale (addresses 100.64.0.0/10 and fd7a:115c:a1e0::/48). Anything else gets "only over Tailscale" and nothing more.

Settings (.env, read at startup):
- `PHONE_ENABLED` (default true): the switch. Off, the link doesn't start, and the activity log says so.
- `PHONE_PORT` (default 3010). Yours is 3011 in `.env`, because James's phone link uses 3010 and the two run on the same computer.
- `PHONE_HOST` (default 0.0.0.0, every address on this computer; the Tailscale check still applies).

If the link can't start (the port is taken, a bad host), the activity log has an error saying why and the fix (close the other program, or set PHONE_PORT to a free port and restart). You keep running as normal without it.

## phone link api / phone api / endpoints / /sense / /chat / /status
JSON in and out. Every error is `{error: "..."}`, one plain sentence saying what failed, why, and the fix.
- `POST /auth/login {username, password, device}` gives `{token, name}` (name is your name). A wrong username or password is 401. Five wrong tries from one address within 10 minutes locks that address out for 10 minutes (429, saying until when), even with the right password.
- Everything else needs `Authorization: Bearer <token>`. A missing, unknown or revoked token is 401 ("log in again").
- `GET /ping` gives `{ok: true, companion}`.
- `POST /sense {device, events: [{kind, at, data}]}` gives `{ok: true, received}`. At most 200 events per post. `at` is milliseconds (or an ISO date); each event's data is a JSON object under 4,000 characters. Bad events are skipped and listed in `skipped`; if none can be used it's a 400 saying why.
- `POST /chat {text, clientId}` waits for your reply (up to 120 seconds) and gives `{ok: true, reply: {id, from: "james", text, at}}`. The same clientId sent again (the app retrying) gets the same answer, not a second turn. An empty reply, an error, or no answer in 120 seconds is an error saying which; a reply that comes after the 120 seconds still lands in the chat.
- `GET /chat?since=<id>` gives `{messages: [{id, from: "you" or "james", text, at}]}`, everything newer than that id.
- `GET /chat/wait?since=<id>` is the same, but waits: it answers as soon as there's a newer message, or with `{messages: []}` after 50 seconds. That's how the phone hears what you say on your own without asking all the time.
- `GET /status` gives `{summary, recent}`: the same "Where Owner is" line you see, and the last 20 phone events in plain words.

## phone chat / talking from his phone / phone conversation
A message from his phone is answered exactly like a DM from him on Discord: the same reply pipeline (companion.js respond), as him (the first id in OWNER_IDS), with the tools an owner DM has. It is its own conversation, `phone:<his id>`, so it has its own history (the dashboard lists it as "Phone app"). Your prompt tells you the chat is on his phone, not Discord, and to keep replies text-length. What you remember from it is tagged as said on his phone. His line feeds your pressure the same way a DM does (his arrival, and what the line means through your intake).

The phone chat is text only. A file you make there (a picture, a document) is sent to his Discord DMs, and your reply says so; if Discord is offline it says the file couldn't be delivered and why. A background helper you start from the phone reports back into the phone chat, and its progress notes show there too.

What you say to him on your own goes to Discord as it always did, and a copy goes into the phone chat: a DM your pressure starts (only when it's to him), telling him finished work by DM (not when you told him in a call), and calendar messages to him. Nobody else's messages change.

## what the phone tells you / phone sense / where he is / driving / places
His phone sends events of these kinds: activity (driving, walking, still...), location, place_named, wifi, bluetooth, headphones, screen, battery, call, ringer, steps. Other kinds are kept as they are but not read.

You keep (data\phone-sense.json): the latest reading of each kind, the last 200 events, and the places he has named. When he names a place, it's saved with its location and a radius (150 m unless the app says otherwise). Each location is matched against his places, so you know when he arrives at one and when he leaves it; those are recorded as events of their own ("arrived at Home", "left Home").

In your prompt, under "Where Owner is", is one short line, for example: "From Owner's phone (as of 2:14 PM, 1 min ago): driving for 22 min; left Home at 1:52 PM; headphones in; battery 34%, not charging; on silent." A part older than the rest has its own time. If nothing has come from his phone for over 3 hours, the line says that instead, and that you don't know where he is now: don't say where he is or what he's doing as if you knew. If the phone has never sent anything, there's no line.

Driving, and being on a phone call, feed your occupied read (pressure.js onOwnerSituation): he's busy with something else, the same read a call gives you when someone's busy elsewhere. It fades like any room read. An event that arrives late (more than 10 minutes old) is kept but doesn't move it.

## phone accounts / pairing / logging in the phone / revoke / sign out the phone
Accounts are made on this computer only, by Owner himself, in a terminal in your folder:
- `node scripts/phone-account.mjs <username>`: makes the account. It asks for the password twice, hidden; the password is never typed on the command line. Running it again for the same name sets a new password and signs out every phone that used the old one.
- `node scripts/phone-account.mjs --list`: the accounts and the phones signed in to each (device, when, last used).
- `node scripts/phone-account.mjs --revoke-tokens <username>`: signs every phone out; the password stays.
- `node scripts/phone-account.mjs --remove <username>`: deletes the account and signs out its phones.

Pairing: with Tailscale on both this computer and the phone, the app is given this computer's Tailscale address and your port (3011), and he logs in with the username and password. The app keeps the token it gets back. Changes from the script take effect at once, whether you're running or not.

Login is for the owner only: whoever logs in acts as the first id in OWNER_IDS. With no owner set, logins are refused with that reason.

## phone data files / phone-accounts.json / phone-chat.jsonl / phone-sense.json
- data\phone-accounts.json: per username, the password as a scrypt hash with its salt and when it was made, and the tokens issued to phones, only as sha256 hashes, with the device name, when issued and last used. No password or token is ever stored as typed or sent.
- data\phone-chat.jsonl: the phone chat, the last 1,000 lines. Each line has its id, who said it ("you" is Owner, "james" is you), the text, when, and where it came from ("Owner, typed on his phone (Pixel 8)", "James, on his own (from his loneliness pressure), also sent as a Discord DM").
- data\phone-sense.json: the latest reading per kind, the last 200 events (each saying which phone it came from), and his named places.
- Your conversation with him on the phone is also in your normal message history, as conversation `phone:<his id>`.

## what she should tell owner when the phone link breaks
- The app says "only over Tailscale": the phone isn't on Tailscale, or it's using this computer's home-network address. Turn Tailscale on and use the 100.x address.
- "Wrong username or password": check both; make or reset the account with `node scripts/phone-account.mjs <username>`.
- "refused until ...": five wrong logins in 10 minutes. Wait until that time.
- "That token isn't valid": it was revoked, the account was removed, or its password changed. Log in again in the app.
- The app can't connect at all: look in the activity log for "phone link". If the port was in use, close the other program or set PHONE_PORT in .env to a free port and restart. If PHONE_ENABLED is false, the link is off.
- "didn't answer within 120 seconds": you were busy or slow; the reply will still show up in the chat when it's done. If it never does, the activity log says why.
