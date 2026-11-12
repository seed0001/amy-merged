import { DatabaseSync } from 'node:sqlite';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { resolve as resolveFolder } from './files.js';
import { buildRoot, slugOf } from './builds.js';
import { BUILD_GUIDE } from './workshop.js';

export const projectConfirmation = (text) => /^(?:yes|yeah|yep|yup|sure|confirm(?:ed)?|go ahead|do it|build it|start it|ok(?:ay)?)\b/i.test(String(text || '').trim()) &&
  !/\b(no|not|don't|do not|cancel|wait|hold|stop|but|unless|instead)\b/i.test(text);

export function createProjects(db, now = Date.now) {
  db.exec(`CREATE TABLE IF NOT EXISTS project_proposals (id INTEGER PRIMARY KEY, owner TEXT NOT NULL,
    conversation TEXT NOT NULL, turn TEXT NOT NULL, at INTEGER NOT NULL, title TEXT NOT NULL,
    brief TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', task_id INTEGER)`);
  if (!db.prepare('PRAGMA table_info(project_proposals)').all().some((column) => column.name === 'goal_id')) db.exec('ALTER TABLE project_proposals ADD COLUMN goal_id INTEGER');
  if (!db.prepare('PRAGMA table_info(project_proposals)').all().some((column) => column.name === 'workspace')) db.exec('ALTER TABLE project_proposals ADD COLUMN workspace TEXT');
  if (!db.prepare('PRAGMA table_info(project_proposals)').all().some((column) => column.name === 'browser_app')) db.exec('ALTER TABLE project_proposals ADD COLUMN browser_app INTEGER NOT NULL DEFAULT 0');
  const owner = (ctx) => {
    if (!ctx.perms?.owner || ctx.helper || !ctx.speaker?.id || !ctx.conversation || !ctx.turn || !ctx.userText?.trim()) throw new Error('Project control requires a current owner conversation.');
    return ctx.speaker.id;
  };
  return {
    list(ctx) { return db.prepare('SELECT * FROM project_proposals WHERE owner = ? ORDER BY id DESC LIMIT 30').all(owner(ctx)); },
    show(id, ctx) {
      const proposal = db.prepare('SELECT * FROM project_proposals WHERE id = ? AND owner = ?').get(id, owner(ctx));
      if (!proposal) throw new Error('No project proposal with that ID.');
      return proposal;
    },
    propose({ title, brief, goal_id, workspace, browser_app = false }, ctx) {
      const who = owner(ctx);
      if (!title?.trim() || !brief?.trim() || brief.length > 16000) throw new Error('Give a project title and a concrete brief up to 16000 characters.');
      // Reserve a new folder without creating files or touching an existing project before approval.
      const folder = workspace?.trim() ? workspace.trim() : `${buildRoot()}\\${slugOf(title)}`;
      const full = resolveFolder(folder), reserved = db.prepare("SELECT workspace FROM project_proposals WHERE status IN ('starting','running') OR (status = 'pending' AND at >= ?)").all(now() - 86400000);
      const unavailable = (candidate) => reserved.some((row) => row.workspace && !path.relative(row.workspace, candidate)) ||
        (existsSync(candidate) && (!statSync(candidate).isDirectory() || readdirSync(candidate).some((name) => name !== BUILD_GUIDE && name !== 'AMY-BUILD-GUIDE.md')));
      let selected = full;
      for (let suffix = 2; unavailable(selected); suffix++) {
        if (workspace?.trim()) throw new Error('That workspace is occupied or reserved. Give the new project a separate empty folder, or use workshop to edit an existing project.');
        selected = `${full}-${suffix}`;
      }
      const result = db.prepare('INSERT INTO project_proposals (owner, conversation, turn, at, title, brief, goal_id, workspace, browser_app) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(who, ctx.conversation, ctx.turn, now(), title.trim().slice(0, 160), brief.trim(), Number.isSafeInteger(goal_id) ? goal_id : null, selected, browser_app === true ? 1 : 0);
      return db.prepare('SELECT * FROM project_proposals WHERE id = ?').get(Number(result.lastInsertRowid));
    },
    start(id, ctx, start) {
      const who = owner(ctx);
      const proposal = db.prepare('SELECT * FROM project_proposals WHERE id = ? AND owner = ? AND conversation = ?').get(id, who, ctx.conversation);
      if (!proposal || proposal.status !== 'pending') throw new Error(`No pending project proposal #${id} in this conversation${proposal ? ` (it is ${proposal.status})` : ''}. Fix: call project with list to see the pending IDs here, or propose it first and start it with the ID that comes back.`);
      if (proposal.turn === ctx.turn || now() - proposal.at > 86400000 || !projectConfirmation(ctx.userText)) throw new Error('Show the exact project brief and wait for the owner to confirm it in a later message.');
      db.prepare("UPDATE project_proposals SET status = 'starting' WHERE id = ?").run(id);
      try {
        const task = start(proposal);
        db.prepare("UPDATE project_proposals SET status = 'running', task_id = ? WHERE id = ?").run(task.id, id);
        return task;
      } catch (error) {
        db.prepare("UPDATE project_proposals SET status = 'pending' WHERE id = ?").run(id);
        throw error;
      }
    },
    finish(id, status) { db.prepare('UPDATE project_proposals SET status = ? WHERE id = ?').run(status, id); },
    cancel(id, ctx) {
      return db.prepare("UPDATE project_proposals SET status = 'cancelled' WHERE id = ? AND owner = ? AND status = 'pending'").run(id, owner(ctx)).changes > 0;
    },
  };
}
let shared;
export const projects = () => (shared ??= createProjects(new DatabaseSync(path.join(DATA_DIR, 'companion.db'))));
