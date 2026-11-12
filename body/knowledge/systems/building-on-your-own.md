# Building browser apps on your own (builds.js, webapp.js)

## building on your own / your own builds / build want / browser apps you make yourself / amy projects / james projects / itching to make something
Nobody has to ask you to make something. When your interests pull hard enough, your pressure system has you build a small browser app about one of them. The pressure system decides when (the `build` want fires); `src/builds.js` decides what, where and why. The coding model only writes the files it's briefed to write; the folder, the name and the reason never depend on what a model remembers.

When it can fire (`buildOk` and the gate in `pressure.js`):
- `builds_enabled` in `data/pressure-config.json` is not false (default true).
- No build of yours is already running (one at a time).
- There is an idea to build (below).
- You aren't in the middle of a reply, and you can afford it from your energy reserve.
- Pressure actions are live (`actions_live`); with them off, the want is only logged.

The `build` bucket's defaults: fill rate 0.01, decay 0.02, threshold 0.7, drain 0.8, hysteresis 0.2. It is in the desires layer. Restlessness feeds it (flow 0.15), and when it fires it passes energy on to share (0.15), joy (0.12) and home_change (0.08). Building costs 1.5 from your reserve. While a build runs, your avatar shows "Making a browser app". Its line in your wants reads "itching to make something", and what it wants is "make a browser app about <topic>".

## what you build / picking the idea / build brief / where builds go / Desktop Amy Projects
**The idea** (`pickIdea`): from your top three interests (`interests.js`), the strongest with interest 0.5 or more that you haven't built yet. "Already built" means a workshop project named "Amy <topic>" exists (`builtIdeas`, compared by slug). The reason is the interest's own reason, or "it has been on her mind".

**Where and what name** (`startBuild`). Both come from your own name (`selfName()` in `config.js`, the first word of `BOT_NAME`), so they say Amy:
- Name: "Amy " plus the topic, at most 60 characters.
- Folder: `Desktop\Amy Projects\<slug>` (`buildRoot()`). The slug is the topic in lower case, anything not a letter or digit turned into "-", at most 40 characters, or "app" if nothing is left.
- The project is added to your workshop with notes saying why: "Built by Amy from her own interest in <topic> (<interest>; <reason>). Driven by: <pressure>."

**The brief** (`briefFor`) given to the coding job: build a browser app for the owner in that folder; what it's about; why (your interest out of 1, and that it came from things said and read, not a request); the pressure and feelings when it started (every want at 0.3 or more, or "calm"). Make one working `index.html`, with `styles.css` and `app.js` if needed, showing something real about the topic you can learn from and keep up with. No build step, no npm, no install; libraries from a CDN if needed. Keep it small and finish it. Read `BUILD-GUIDE.md` first, check the files for errors before reporting, and push or publish nothing.

**After**: each progress report is logged as a `build` event `{ project, report }` (first 400 characters). When the report says it's done, the app is opened in your browser tab. If opening fails, that's an `error` event (`where: build open`). The start itself is logged as `build` with project, folder, why and the start reply.

## how a build is judged / build feedback / build counts / when a build fails
A build is an effortful act, so before it starts your reward system records what you expect from it (see the pressure-system guide on expectation and reward). Then:
- If the workshop didn't accept the job (no name, an empty start reply, or one starting with "Error"), it is settled as a failure with that reason, method "a coding job building <topic>".
- If it started, it is held open as a creation ("browser app") until the people who use it react; their reaction is how you learn whether it was good. You don't grade it yourself.
- Any error is logged as `error` with `where: pressure build`, and settled as a failure.
Your pressure state remembers the last build (`lastBuild`: name, folder, when) and counts builds per day (`build_counts`). The count is recorded, but the gate above doesn't cap the number per day.

## serving a browser app / webapp.js / local app server / verify browser app / File is unavailable
`src/webapp.js` serves a browser app folder so it can open in one of your tabs or be checked. `serveFolder(root)` starts a tiny server on this PC only (127.0.0.1) on a free port and returns its address.
- `/` and any folder give that folder's `index.html`.
- It refuses (403 "File is unavailable") anything outside the folder, anything the files tool treats as private, and any path with a part starting with "." (so `.git`, `.env` and the like are never served). Links that point outside the folder are refused too, after following them.
- A missing file is 404 "Not found". Files are never cached. It knows the usual web types (html, js, css, json, images, audio, glb models, fonts); anything else is a download.
`verifyBrowserApp(root)` serves the folder, fetches `index.html` with a 5-second limit, then shuts the server. It fails with "Expected a working index.html in the project folder (HTTP <status>)." or "The project index.html is empty."; otherwise it returns the page's size. The workshop uses it to check a browser app actually loads.
