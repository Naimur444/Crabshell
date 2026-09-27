// Claude Code Web UI — a local browser front-end for the installed `claude` CLI.
// Every session is a real `claude -p --input-format stream-json` process, so it
// uses the CLI's own login, settings, MCP servers, skills and CLAUDE.md files.
import express from 'express';
import { WebSocketServer } from 'ws';
import { spawn, execFile } from 'child_process';
import { createServer } from 'http';
import { randomUUID, randomBytes } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 3456);
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const STATE_DIR = path.join(os.homedir(), '.claude-web-ui');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// A stable access token: anything on this machine that can reach the port
// could otherwise drive a shell through Claude.
fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
const TOKEN_FILE = path.join(STATE_DIR, 'token');
if (!fs.existsSync(TOKEN_FILE)) fs.writeFileSync(TOKEN_FILE, randomBytes(24).toString('hex'), { mode: 0o600 });
const TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim();

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', (req, res, next) => (req.get('x-token') === TOKEN ? next() : res.status(401).json({ error: 'bad token' })));

// Non-image attachments are saved here and handed to Claude by path, like a path given in the CLI.
const UPLOAD_DIR = path.join(STATE_DIR, 'uploads');
app.post('/api/upload', express.raw({ type: () => true, limit: '200mb' }), (req, res) => {
  const raw = decodeURIComponent(req.get('x-filename') || 'file');
  const name = path.basename(raw).replace(/[^\w.\- ()]+/g, '_').slice(-120) || 'file';
  const dir = path.join(UPLOAD_DIR, new Date().toISOString().slice(0, 10));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${randomBytes(3).toString('hex')}-${name}`);
  fs.writeFileSync(file, req.body);
  res.json({ path: file, size: req.body.length });
});

// ---------- session files on disk ----------

function readHead(file, bytes = 256 * 1024) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString('utf8');
  } finally { fs.closeSync(fd); }
}

function readTail(file, bytes = 64 * 1024) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(bytes, size);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } finally { fs.closeSync(fd); }
}

// Names set in this UI. The session file gets the CLI's own custom-title line too,
// but a CLI process that is still running can re-append its older title, so this wins.
const TITLES_FILE = path.join(STATE_DIR, 'titles.json');
const TRASH_DIR = path.join(STATE_DIR, 'trash');
const loadTitles = () => { try { return JSON.parse(fs.readFileSync(TITLES_FILE, 'utf8')); } catch { return {}; } };
const saveTitles = t => fs.writeFileSync(TITLES_FILE, JSON.stringify(t, null, 1), { mode: 0o600 });

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  return '';
}

const isNoise = t => !t || /^\s*<(command-|local-command|system-reminder|bash-|task-notification)/.test(t) || t.startsWith('Caveat:');

function sessionSummary(project, file, titles = {}) {
  const full = path.join(PROJECTS_DIR, project, file);
  const st = fs.statSync(full);
  const id = file.replace(/\.jsonl$/, '');
  let cwd = null, title = null, customTitle = null, aiTitle = null;
  // The CLI keeps title records near the end of the file; the last one wins, as in the CLI.
  for (const line of readTail(full).split('\n')) {
    if (line.includes('"type":"custom-title"')) { try { customTitle = JSON.parse(line).customTitle ?? customTitle; } catch {} }
    else if (line.includes('"type":"ai-title"')) { try { aiTitle = JSON.parse(line).aiTitle ?? aiTitle; } catch {} }
  }
  for (const line of readHead(full).split('\n')) {
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (!cwd && m.cwd) cwd = m.cwd;
    if (!title && m.type === 'user' && !m.isMeta && !m.isSidechain) {
      const t = textOf(m.message?.content).trim();
      if (!isNoise(t)) title = t.replace(/<\/?[\w-]+(\s[^>]*)?>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
    }
    if (cwd && title) break;
  }
  const named = titles[id] || customTitle;
  return { id, project, cwd, title: named || aiTitle || title || '(no prompt yet)', named: !!named, mtime: st.mtimeMs, size: st.size };
}

app.get('/api/sessions', (req, res) => {
  const out = [];
  const titles = loadTitles();
  let projects = [];
  try { projects = fs.readdirSync(PROJECTS_DIR); } catch {}
  for (const p of projects) {
    let files = [];
    try { files = fs.readdirSync(path.join(PROJECTS_DIR, p)).filter(f => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) { try { out.push(sessionSummary(p, f, titles)); } catch {} }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  const live = new Set([...live_sessions.values()].map(s => s.sessionId));
  const linked = readJson(SESSION_PRESETS_FILE, {});
  const names = Object.fromEntries(loadPresets().map(p => [p.id, p.name]));
  res.json(out.slice(0, Number(req.query.limit || 300)).map(s => ({ ...s, live: live.has(s.id), preset: names[linked[s.id]] || null })));
});

// Full transcript of a stored session, reduced to what the UI renders.
function findSessionFile(id) {
  let projects = [];
  try { projects = fs.readdirSync(PROJECTS_DIR); } catch {}
  for (const p of projects) {
    const f = path.join(PROJECTS_DIR, p, id + '.jsonl');
    if (fs.existsSync(f)) return { project: p, file: f };
  }
  return null;
}

// Rename: an empty title clears the name, as the CLI's own /rename does.
app.patch('/api/sessions/:id', (req, res) => {
  const { id } = req.params;
  if (!/^[\w-]+$/.test(id)) return res.status(400).end();
  const found = findSessionFile(id);
  if (!found) return res.status(404).json({ error: 'not found' });
  const title = String(req.body?.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  fs.appendFileSync(found.file, JSON.stringify({ type: 'custom-title', customTitle: title, sessionId: id }) + '\n');
  const titles = loadTitles();
  if (title) titles[id] = title; else delete titles[id];
  saveTitles(titles);
  res.json({ ok: true, title });
});

// Delete: stop any live process, then move the transcript (and its sidecar folder) to a
// trash folder so the UI can offer Undo. Nothing is erased here.
app.delete('/api/sessions/:id', async (req, res) => {
  const { id } = req.params;
  if (!/^[\w-]+$/.test(id)) return res.status(400).end();
  if (!findSessionFile(id)) return res.status(404).json({ error: 'not found' });
  // Stop first and wait: a CLI that exits after the move would recreate the file.
  for (const s of [...live_sessions.values()]) if (s.sessionId === id) { live_sessions.delete(s.liveId); await s.stop(); }
  const found = findSessionFile(id);
  if (!found) return res.status(404).json({ error: 'not found' });
  const dest = path.join(TRASH_DIR, found.project);
  fs.mkdirSync(dest, { recursive: true });
  fs.renameSync(found.file, path.join(dest, id + '.jsonl'));
  const side = path.join(PROJECTS_DIR, found.project, id);
  if (fs.existsSync(side)) fs.renameSync(side, path.join(dest, id));
  res.json({ ok: true });
});

app.post('/api/sessions/:id/restore', (req, res) => {
  const { id } = req.params;
  if (!/^[\w-]+$/.test(id)) return res.status(400).end();
  let projects = [];
  try { projects = fs.readdirSync(TRASH_DIR); } catch {}
  for (const p of projects) {
    const f = path.join(TRASH_DIR, p, id + '.jsonl');
    if (!fs.existsSync(f)) continue;
    fs.mkdirSync(path.join(PROJECTS_DIR, p), { recursive: true });
    fs.renameSync(f, path.join(PROJECTS_DIR, p, id + '.jsonl'));
    const side = path.join(TRASH_DIR, p, id);
    if (fs.existsSync(side)) fs.renameSync(side, path.join(PROJECTS_DIR, p, id));
    return res.json({ ok: true });
  }
  res.status(404).json({ error: 'not in trash' });
});

app.get('/api/sessions/:id', (req, res) => {
  const { id } = req.params;
  if (!/^[\w-]+$/.test(id)) return res.status(400).end();
  const found = findSessionFile(id);
  if (!found) return res.status(404).json({ error: 'not found' });
  const { project, file } = found;
  const msgs = [];
  let cwd = null;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (!cwd && m.cwd) cwd = m.cwd;
    if ((m.type === 'user' || m.type === 'assistant') && !m.isSidechain && m.message) {
      if (m.type === 'user' && m.isMeta) continue;
      msgs.push({ type: m.type, message: { role: m.message.role, content: m.message.content }, ts: m.timestamp });
    }
  }
  res.json({ id, project, cwd, messages: msgs });
});

// Directory suggestions for the "new session" picker.
app.get('/api/dirs', (req, res) => {
  const base = req.query.path ? String(req.query.path).replace(/^~/, os.homedir()) : os.homedir();
  try {
    const dirs = fs.readdirSync(base, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.'))
      .map(d => d.name).sort().slice(0, 300);
    res.json({ path: path.resolve(base), parent: path.dirname(path.resolve(base)), dirs, home: os.homedir() });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

function run(args, timeout = 60000) {
  return new Promise(resolve => execFile(CLAUDE_BIN, args, { timeout, env: childEnv(), maxBuffer: 10 << 20 },
    (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr), error: err?.message })));
}

// MCP config health check, independent of any running session.
app.get('/api/mcp', async (req, res) => res.json(await run(['mcp', 'list'], 120000)));
app.get('/api/auth', async (req, res) => {
  const r = await run(['auth', 'status'], 20000);
  try { res.json(JSON.parse(r.stdout)); } catch { res.json({ loggedIn: false, raw: r.stdout + r.stderr }); }
});

// ---------- live CLI processes ----------

function childEnv() {
  const env = { ...process.env };
  // Don't let a nested launch think it is running inside another Claude Code session.
  // Keep auth: CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`) is how the CLI logs in here.
  const keep = new Set(['CLAUDE_CODE_OAUTH_TOKEN']);
  for (const k of Object.keys(env)) if (k === 'CLAUDECODE' || (k.startsWith('CLAUDE_CODE_') && !keep.has(k))) delete env[k];
  return env;
}

const live_sessions = new Map(); // liveId -> LiveSession

// ---------- quick-start presets ----------
// A preset starts a session with its own folder, model, mode and extra instructions.
// Sessions remember their preset, so a restart or resume keeps the instructions.
const PRESETS_FILE = path.join(STATE_DIR, 'presets.json');
const SESSION_PRESETS_FILE = path.join(STATE_DIR, 'session-presets.json');
const DEFAULT_PRESETS = [{
  id: 'review',
  name: 'Code review',
  icon: 'zap',
  cwd: os.homedir(),
  model: '',
  permissionMode: 'plan',
  instructions: `This is a code review session.

Review the changes in this folder's git repository (uncommitted work, or the current branch against its base). Look for real bugs first: wrong logic, unhandled errors, security problems, race conditions. Then mention anything confusing or needlessly complex.

Report findings as a short list, most serious first, each with the file and line and a one-line suggested fix. Don't change any files unless asked.`,
  starter: 'Review my current changes.',
}];
const readJson = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; } };
const writeJson = (f, v) => fs.writeFileSync(f, JSON.stringify(v, null, 2), { mode: 0o600 });
if (!fs.existsSync(PRESETS_FILE)) writeJson(PRESETS_FILE, DEFAULT_PRESETS);
const loadPresets = () => readJson(PRESETS_FILE, DEFAULT_PRESETS);
const presetForSession = id => { const pid = readJson(SESSION_PRESETS_FILE, {})[id]; return pid ? loadPresets().find(p => p.id === pid) : null; };
function linkSessionPreset(sessionId, presetId) {
  const map = readJson(SESSION_PRESETS_FILE, {});
  map[sessionId] = presetId; writeJson(SESSION_PRESETS_FILE, map);
}

app.get('/api/presets', (req, res) => res.json(loadPresets()));
app.put('/api/presets', (req, res) => {
  if (!Array.isArray(req.body)) return res.status(400).json({ error: 'expected a list' });
  const clean = req.body.map(p => ({
    id: String(p.id || randomUUID()).replace(/[^\w-]/g, '').slice(0, 64) || randomUUID(),
    name: String(p.name || 'Untitled').slice(0, 60),
    icon: ['headset', 'zap'].includes(p.icon) ? p.icon : 'zap',
    cwd: String(p.cwd || '~').slice(0, 1000),
    model: String(p.model || '').slice(0, 80),
    permissionMode: String(p.permissionMode || '').slice(0, 40),
    instructions: String(p.instructions || '').slice(0, 20000),
    starter: String(p.starter || '').slice(0, 5000),
  }));
  writeJson(PRESETS_FILE, clean);
  res.json(clean);
});

// The UI renders ```draft blocks as cards with a Copy button, so ask Claude to put drafts there.
const UI_PROMPT = `This session runs in a web UI that shows a Copy button on drafts. This rule only changes how draft text is displayed in your chat reply.

When you show the user text they will send or paste somewhere themselves (an email, a chat or support reply, a message, a post, a note), for example when they ask you to draft, write, rewrite, rephrase, shorten or polish something, put each finished version in its own fenced code block with the language tag "draft":

\`\`\`draft
Hi Sam, thanks for getting back to me...
\`\`\`

Inside the block put only the text to send: no labels, no commentary, no surrounding quotes. Keep explanations outside the blocks. Never use draft blocks for code.

This never replaces a tool action. If the user or a skill asks for a draft to be created somewhere (a helpdesk, Slack, Gmail, a file, or any other tool), do exactly that with the tool as you normally would, and pass the plain text to the tool, never with the fences. Skill and tool instructions about drafts take priority over this rule; you may also show the same text in a draft block in chat if that helps the user review it.`;

class LiveSession {
  constructor({ cwd, resume, model, permissionMode, presetId }) {
    this.liveId = randomUUID();
    this.cwd = cwd;
    this.model = model || '';
    this.permissionMode = permissionMode || '';
    this.sessionId = resume || randomUUID();
    this.isNew = !resume;
    if (presetId) linkSessionPreset(this.sessionId, presetId); // before spawn(), which reads it
    this.clients = new Set();
    this.backlog = [];          // events since the last spawn, replayed to late subscribers
    this.pending = new Map();   // control request_id -> resolve
    this.permissions = new Map(); // request_id -> can_use_tool request awaiting the browser
    this.state = 'starting';
    this.info = null;
    this.spawn();
  }

  args() {
    const a = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--include-partial-messages', '--permission-prompt-tool', 'stdio'];
    if (this.isNew) a.push('--session-id', this.sessionId); else a.push('--resume', this.sessionId);
    if (this.model) a.push('--model', this.model);
    if (this.permissionMode) a.push('--permission-mode', this.permissionMode);
    // Lets the chat box switch to "Bypass permissions" later. It does not turn bypass on:
    // sessions still start in the chosen mode until the user picks Bypass.
    a.push('--allow-dangerously-skip-permissions');
    // Read the preset at every spawn, so edits apply on the next restart or resume.
    const preset = presetForSession(this.sessionId);
    a.push('--append-system-prompt', preset?.instructions ? `${UI_PROMPT}\n\n${preset.instructions}` : UI_PROMPT);
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    a.push('--add-dir', UPLOAD_DIR); // attached files can be read without a permission prompt
    return a;
  }

  spawn() {
    this.backlog = [];
    this.buf = '';
    this.stderr = '';
    const proc = spawn(CLAUDE_BIN, this.args(), { cwd: this.cwd, env: childEnv() });
    this.proc = proc;
    this.setState('idle');
    proc.stdout.on('data', d => {
      this.buf += d;
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1);
        if (!line.trim()) continue;
        let msg; try { msg = JSON.parse(line); } catch { this.emit({ ev: 'log', text: line }); continue; }
        this.onMessage(msg);
      }
    });
    proc.stderr.on('data', d => { this.stderr = (this.stderr + d).slice(-8000); this.emit({ ev: 'stderr', text: String(d) }); });
    proc.on('error', e => this.emit({ ev: 'error', text: `Could not start ${CLAUDE_BIN}: ${e.message}` }));
    proc.on('exit', (code, sig) => {
      if (proc !== this.proc) return; // an old process from before a restart
      for (const r of this.pending.values()) r({ error: 'process exited' });
      this.pending.clear();
      this.permissions.clear();
      this.setState('exited', { code, signal: sig });
    });
    this.control({ subtype: 'initialize' }).then(r => { this.info = r.response || null; this.emit({ ev: 'info', info: this.info }); });
  }

  onMessage(msg) {
    if (msg.type === 'control_response') {
      const id = msg.response?.request_id;
      const r = this.pending.get(id);
      if (r) { this.pending.delete(id); r(msg.response); }
      return;
    }
    if (msg.type === 'control_request' && msg.request?.subtype === 'can_use_tool') {
      this.permissions.set(msg.request_id, msg.request);
      this.emit({ ev: 'permission', request_id: msg.request_id, request: msg.request });
      return;
    }
    if (msg.type === 'control_request') {
      // Requests we don't handle (hooks, MCP messages for SDK servers): answer so the CLI doesn't hang.
      this.write({ type: 'control_response', response: { subtype: 'error', request_id: msg.request_id, error: `web UI does not handle ${msg.request?.subtype}` } });
      return;
    }
    if (msg.type === 'control_cancel_request') {
      this.permissions.delete(msg.request_id);
      this.emit({ ev: 'permission_cancel', request_id: msg.request_id });
      return;
    }
    if (msg.type === 'system' && msg.subtype === 'init') {
      this.sessionId = msg.session_id || this.sessionId;
      this.isNew = false; // from now on a restart resumes
      if (msg.model) this.model = msg.model;
      if (msg.permissionMode) this.permissionMode = msg.permissionMode;
    }
    if (msg.type === 'result') this.setState('idle');
    this.emit({ ev: 'cli', msg });
  }

  write(obj) { if (this.proc?.stdin.writable) this.proc.stdin.write(JSON.stringify(obj) + '\n'); }

  control(request, timeout = 30000) {
    const request_id = randomUUID();
    return new Promise(resolve => {
      this.pending.set(request_id, resolve);
      this.write({ type: 'control_request', request_id, request });
      setTimeout(() => { if (this.pending.delete(request_id)) resolve({ subtype: 'error', error: 'timed out' }); }, timeout);
    });
  }

  // content is a string, or an array of text/image blocks (pasted images).
  send(content) {
    if (this.state === 'exited') this.restart();
    this.setState('running');
    this.write({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: this.sessionId });
    this.emit({ ev: 'user_sent', content });
  }

  answerPermission(request_id, { allow, message, updatedInput, updatedPermissions }) {
    const req = this.permissions.get(request_id);
    if (!req) return;
    this.permissions.delete(request_id);
    const response = allow
      ? { behavior: 'allow', updatedInput: updatedInput ?? req.input, ...(updatedPermissions ? { updatedPermissions } : {}) }
      : { behavior: 'deny', message: message || 'The user denied this in the web UI.' };
    this.write({ type: 'control_response', response: { subtype: 'success', request_id, response } });
    this.emit({ ev: 'permission_answered', request_id, allow });
  }

  restart(opts = {}) {
    if (opts.model !== undefined) this.model = opts.model;
    if (opts.permissionMode !== undefined) this.permissionMode = opts.permissionMode;
    const old = this.proc;
    this.proc = null;
    if (old && old.exitCode === null) { old.stdin.end(); old.kill('SIGTERM'); setTimeout(() => old.exitCode === null && old.kill('SIGKILL'), 3000); }
    this.emit({ ev: 'restarted' });
    this.spawn();
  }

  // Resolves once the process has fully exited (it may write to its transcript on the way out).
  stop() {
    const p = this.proc;
    if (!p || p.exitCode !== null || p.signalCode !== null) return Promise.resolve();
    return new Promise(resolve => {
      p.once('exit', () => resolve());
      p.stdin.end(); p.kill('SIGTERM');
      setTimeout(() => { if (p.exitCode === null && p.signalCode === null) p.kill('SIGKILL'); }, 3000);
    });
  }

  setState(state, extra = {}) { this.state = state; this.emit({ ev: 'state', state, ...extra }); }

  emit(e) {
    const ev = { ...e, liveId: this.liveId, sessionId: this.sessionId };
    if (e.ev !== 'state') this.backlog.push(ev);
    if (this.backlog.length > 5000) this.backlog.splice(0, 1000);
    const s = JSON.stringify(ev);
    for (const c of this.clients) if (c.readyState === 1) c.send(s);
  }

  describe() {
    return { preset: presetForSession(this.sessionId)?.name || null, liveId: this.liveId, sessionId: this.sessionId, cwd: this.cwd, model: this.model, permissionMode: this.permissionMode, state: this.state, pid: this.proc?.pid };
  }
}

app.get('/api/live', (req, res) => res.json([...live_sessions.values()].map(s => s.describe())));

// ---------- websocket ----------

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  const origin = req.headers.origin || '';
  const okOrigin = !origin || new URL(origin).host === req.headers.host;
  if (url.searchParams.get('t') !== TOKEN || !okOrigin) return ws.close(4001, 'unauthorized');

  const reply = (id, data) => ws.send(JSON.stringify({ ev: 'reply', id, ...data }));
  const subscribe = s => {
    for (const other of live_sessions.values()) other.clients.delete(ws);
    s.clients.add(ws);
    ws.send(JSON.stringify({ ev: 'subscribed', session: s.describe(), info: s.info, backlog: s.backlog,
      permissions: [...s.permissions].map(([request_id, request]) => ({ request_id, request })) }));
  };

  ws.on('message', async raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    const s = m.liveId ? live_sessions.get(m.liveId) : null;
    try {
      switch (m.op) {
        case 'open': { // start a new session, or resume a stored one
          let cwd = (m.cwd || os.homedir()).replace(/^~/, os.homedir());
          const existing = m.resume && [...live_sessions.values()].find(x => x.sessionId === m.resume && x.state !== 'exited');
          const preset = m.presetId && loadPresets().find(p => p.id === m.presetId);
          if (m.presetId && !preset) return reply(m.id, { error: 'That quick start no longer exists.' });
          if (preset) cwd = preset.cwd.replace(/^~/, os.homedir()); // the saved preset wins over a stale page
          if (!fs.existsSync(cwd)) return reply(m.id, { error: `No such directory: ${cwd}` });
          const ls = existing || new LiveSession({ cwd, resume: m.resume, model: preset ? preset.model : m.model, permissionMode: preset ? preset.permissionMode : m.permissionMode, presetId: preset?.id });
          live_sessions.set(ls.liveId, ls);
          subscribe(ls);
          return reply(m.id, { session: ls.describe() });
        }
        case 'subscribe': if (s) subscribe(s); return reply(m.id, { ok: !!s });
        case 'send': s?.send(m.content ?? m.text); return reply(m.id, { ok: !!s });
        case 'interrupt': return reply(m.id, s ? await s.control({ subtype: 'interrupt' }) : { error: 'no session' });
        case 'permission': s?.answerPermission(m.request_id, m); return reply(m.id, { ok: true });
        case 'restart': s?.restart({ model: m.model, permissionMode: m.permissionMode }); return reply(m.id, { session: s?.describe() });
        case 'stop': s?.stop(); return reply(m.id, { ok: true });
        case 'close': if (s) { s.stop(); live_sessions.delete(s.liveId); } return reply(m.id, { ok: true });
        case 'set_model': s.model = m.model; return reply(m.id, await s.control({ subtype: 'set_model', model: m.model || undefined }));
        case 'set_mode': s.permissionMode = m.mode; return reply(m.id, await s.control({ subtype: 'set_permission_mode', mode: m.mode }));
        case 'mcp_status': return reply(m.id, await s.control({ subtype: 'mcp_status' }, 60000));
        case 'mcp_reconnect': return reply(m.id, await s.control({ subtype: 'mcp_reconnect', serverName: m.name }, 60000));
        case 'mcp_toggle': return reply(m.id, await s.control({ subtype: 'mcp_toggle', serverName: m.name, enabled: m.enabled }, 60000));
        default: return reply(m.id, { error: 'unknown op ' + m.op });
      }
    } catch (e) { reply(m.id, { error: e.message }); }
  });
  ws.on('close', () => { for (const s of live_sessions.values()) s.clients.delete(ws); });
});

server.listen(PORT, HOST, () => {
  console.log(`Claude Code Web UI → http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}/?t=${TOKEN}`);
});

const shutdown = () => { for (const s of live_sessions.values()) s.stop(); setTimeout(() => process.exit(0), 500); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
