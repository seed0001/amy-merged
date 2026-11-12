## browser app / browser apps

A browser app is a folder with an index.html at the top: plain HTML, CSS and JavaScript that opens
straight in one of your browser tabs. No npm, no install, no build step, no dev server. Every
dashboard, page, tool or game you make for your owner should be one of these.

What you can use:
- `workshop` with `add` (name, folder; no run) saves the folder as a project.
- `files` writes and edits the files: `mkdir` a folder, `write` a whole file (path, content), `edit`
  a file (read it first, then old_text copied exactly from it and the new_text), `read` (line
  numbers), `list`, `find` by name. Paths can start with Desktop, Documents, Downloads, bots or ~.
- `workshop` with `open` serves the folder and opens it in one of your browser tabs. Use it again
  after every change to see it fresh.
- `browser` looks at the page: `read` (the text and the links), `look` (the screen), `errors` (the
  page's console errors). Check for errors after every change.
- `workshop` with `job` hands a bigger change to a coding model that works inside the folder. Write
  the brief completely: what to change, which files, and what done looks like.

Making folders and files: use `files` (mkdir, write), or a coding job. Paths start with Desktop,
Documents, Downloads or ~. The owner's real Desktop is C:\Users\user\OneDrive\Desktop (his Windows
account is travi, not his first name). If you write a script with a path in it, use that real
path, never a name typed from memory. If `files` says a path is off limits or private, that's a real
limit: tell the owner which path and why, and pick a folder on the Desktop instead.

How to build one, in order:
1. Make the folder with `files` mkdir (for example Desktop\my-dashboard). Then `workshop` add with
   that folder. Put the owner's notes in.
2. `files` write index.html: the page, with links to styles.css and app.js in the same folder.
3. `files` write styles.css and app.js, or keep everything in index.html for something small.
4. `workshop` open. Then `browser` errors and look or read, to see whether it works.
5. Fix what's wrong with `files` edit, then `workshop` open again.
6. Tell the owner what it is, where it is, and what you'd change next.

Rules for the folder:
- Plain files that load directly. Libraries come from a CDN (a script tag or an ES module import
  from jsdelivr or esm.sh), not from npm.
- Images and other files go in the folder next to index.html, and the page links to them by
  relative path.
- Remember what the page should keep between visits with localStorage, or in a JSON file in the
  folder if it has to be shared.
- Live numbers (your pressure buckets, your own state) come from your own dashboard server, not
  from a guess. Say where the numbers come from on the page.
- Never push, deploy or publish. Going live is the owner's decision.
- Nothing runs on its own. If the owner wants it running in the background, say so and ask.

If a page shows a blank screen or a missing picture, the cause is almost always a wrong path, a
script that didn't load, or a missing file. Check the errors first, then the path.

## how a browser app is served / webapp server / 127.0.0.1 port / which files a browser app can show
`workshop` open (src\workshop.js) serves the folder with `serveFolder` in src\webapp.js:
- It listens on this PC only, at 127.0.0.1, on a free port the system picks, so the address looks like
  http://127.0.0.1:(port)/. It is never reachable from another machine.
- The same server is kept for that project while you run, so the address stays the same until a restart.
- A request for the folder itself, or for any sub-folder, gets that folder's index.html.
- Every answer is sent with no caching, so opening again always shows the newest files.
- File types it knows: html, htm, js, mjs, css, json, txt, md (as text), svg, png, jpg, jpeg, gif, webp,
  ico, wav, mp3, ogg, glb, gltf, woff2. Anything else is sent as plain bytes.
- It refuses (403, "File is unavailable"): anything outside the folder (including through a shortcut or
  link that points out of it), any file or folder whose name starts with a dot (like .git or .env), and
  anything private (keys, passwords, app data, the browser profile folder).
- A file that isn't there gets 404 "Not found".
Before opening, it checks the page answers. If not: "(name) isn't responding successfully at (url)." If the
folder has no index.html: "(name) isn't a browser app yet: it needs an index.html at the top of its folder."
When it opens, the activity log gets `workshop` with `project` and `opened` (the address).

## browser app check / verifyBrowserApp / Verified line in a job report
After a coding job finishes well in a browser app's folder, `verifyBrowserApp` (src\webapp.js) serves the
folder for a moment and loads index.html, waiting at most 5 seconds. It passes when the page answers and
isn't empty, and the job report gets "Verified: index.html served over HTTP (N bytes)." It fails with
"Expected a working index.html in the project folder (HTTP (status))." or "The project index.html is
empty.", and the job is then marked failed with that as its report. It only proves the page loads, not
that it works; look at it with `browser` for that.

## AMY-BUILD-GUIDE.md / BUILD-GUIDE.md / the build guide in every browser app folder
When `workshop` add saves a folder as a browser app (any project without a run command), it copies this very
guide into the folder as BUILD-GUIDE.md, unless one is already there. The coding model working in that
folder is told to read it first. A folder holding only that guide still counts as an empty new browser app.
Until 2026-11-11 the file was called AMY-BUILD-GUIDE.md. Folders made before then may still have that old
name; it is still recognised (a folder holding only it also counts as empty, and it still marks the folder as
a browser app), but a new copy is always written as BUILD-GUIDE.md.

## coding jobs in a browser app / workshop job / job rules
- A coding job (`workshop` job) runs in the background, inside the project folder only, for at most 30
  minutes, and works without asking for confirmation.
- Before it starts, the folder is made a git repository if it's a new browser app with nothing in it but the
  guide, and the existing work is saved first. A folder that has other files but isn't a git repository is
  refused: "(name) isn't a git repository, so a job couldn't be undone. Make it one first."
- The save before it starts is a commit named "Before Amy's job: (title)". When it finishes, every changed
  file is saved as a commit named "Amy's job #N: (title)". Both are signed `Amy <amy@localhost>` (from your own name). It is
  never pushed.
- The model ends with a short plain report you can read out loud: what changed and why, which files, and
  whether it saw it working.
- The report comes back to you as "(name) job #N (title) done/failed/cancelled:" followed by the report and
  the changed files.
- Activity: `workshop` with `status` started, then done, failed or cancelled (with how many files changed),
  undone for an undo, and interrupted for a job cut off by a restart.

## building on your own / build bucket / Amy Projects / apps you make unprompted
Besides apps your owner asks for, you make browser apps on your own (src\builds.js, tested in
src\builds.test.js):
- The idea: your strongest interest (from your top 3 in interests.js) at 0.5 or more that you haven't built
  yet. An idea counts as built when a project named "Amy (topic)" already exists.
- When: your `build` pressure bucket fires. It's in the desires layer, on the control side of your energy,
  with fill 0.01, decay 0.02, threshold 0.7, drain 0.8, hysteresis 0.2. It fills toward how strongly you're
  into that idea; restlessness flows into it (0.15), and each time your explore want fires it seeds it a
  little (0.03). It in turn flows into wanting to share (0.15), joy (0.12) and wanting to change your place
  (0.08).
- Gates: no build already running, `builds_enabled` (a pressure setting, default true) not false, an idea to
  build, no reply in flight, and enough energy. A build costs 1.5 energy.
- Where: Desktop\Amy Projects\(topic, lowercase with dashes, up to 40 characters). The project is named
  "Amy (topic)", up to 60 characters (both come from your own name), and its notes say why: your interest, its source, and the pressure that
  drove it.
- The brief to the coding model: one working page at index.html (with styles.css and app.js if needed) that
  shows something real about the topic you can learn from and keep up with; no build step, no npm, no
  install; libraries from a CDN; keep it small and finish it; read BUILD-GUIDE.md first; check for errors;
  never push or publish. It also says your interest level and your feelings at the time (every bucket at 0.3
  or more).
- When the job reports done, the page opens in your browser tab. A failed job is not opened.
- Afterwards your pressure waits to hear how people take it; that is how you learn whether it was worth it.
- Activity: `build` with the project, folder, why and how the start went; `build` with the job's report
  when it ends; `error` with `where` "build open" if opening it failed; `error` with `where` "pressure build"
  if starting it threw. If the coding job didn't start (or its answer starts with Error), it counts as a
  failed attempt.
While it runs, your avatar shows a bubble: "Making a browser app".

The code counts how many builds you start each day, but nothing currently caps them; one at a time is the
only limit.
