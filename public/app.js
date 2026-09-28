// ---------- token ----------
const params = new URLSearchParams(location.search);
let TOKEN = params.get('t') || localStorage.getItem('ccw-token') || '';
if (params.get('t')) { localStorage.setItem('ccw-token', TOKEN); history.replaceState(null, '', location.pathname); }

const $ = s => document.querySelector(s);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const icon = name => { const t = document.createElement('template'); t.innerHTML = `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`; return t.content.firstChild; };
function toast(text, actionLabel, onAction) {
  const t = $('#toast'); t.innerHTML = ''; t.append(el('span', null, text));
  if (actionLabel) { const b = el('button', null, actionLabel); b.onclick = () => { t.hidden = true; onAction(); }; t.append(b); }
  t.hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => (t.hidden = true), actionLabel ? 6000 : 1800);
}
const api = async (url) => {
  const r = await fetch(url, { headers: { 'x-token': TOKEN } });
  if (r.status === 401) { askToken(); throw new Error('unauthorized'); }
  return r.json();
};
async function apiSend(method, url, body) {
  const r = await fetch(url, { method, headers: { 'x-token': TOKEN, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `${r.status}`);
  return data;
}
function askToken() {
  const t = prompt('Paste the access token printed by the server (the ?t=… part of its URL):');
  if (t) { TOKEN = t.trim(); localStorage.setItem('ccw-token', TOKEN); location.reload(); }
}

// ---------- state ----------
let ws, wsReady = false, reqId = 0;
const waiting = new Map();
let current = null;          // { liveId, sessionId, cwd, model, permissionMode, state } or { sessionId, stored:true }
let sessions = [], liveSessions = [];
let toolCards = new Map();   // tool_use_id -> <details>
let streamDiv = null;        // assistant text being streamed
let permCards = new Map();
let historyQueue = null;    // live events that arrived while a transcript was loading

function md(text) {
  if (window.marked && window.DOMPurify) return DOMPurify.sanitize(marked.parse(text || ''));
  const d = el('div'); d.textContent = text; return d.innerHTML;
}

// ---------- websocket ----------
function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?t=${encodeURIComponent(TOKEN)}`);
  ws.onopen = () => {
    wsReady = true;
    const liveId = current?.liveId || localStorage.getItem('ccw-live');
    if (liveId) call({ op: 'subscribe', liveId }).then(r => { if (!r.ok) localStorage.removeItem('ccw-live'); });
  };
  ws.onclose = e => {
    wsReady = false;
    if (e.code === 4001) return askToken();
    setTimeout(connect, 1500);
  };
  ws.onmessage = e => handle(JSON.parse(e.data));
}
function call(msg) {
  return new Promise(resolve => {
    if (!wsReady) return resolve({ error: 'not connected' });
    const id = ++reqId;
    waiting.set(id, resolve);
    ws.send(JSON.stringify({ ...msg, id, liveId: msg.liveId ?? current?.liveId }));
  });
}

function handle(e) {
  if (e.ev === 'reply') { const r = waiting.get(e.id); waiting.delete(e.id); return r?.(e); }
  if (e.ev === 'subscribed') return onSubscribed(e);
  if (e.ev === 'usage') { usage = e.usage; renderUsage(); return warnUsage(); }
  if (!current || e.liveId !== current.liveId) return;
  // While the transcript is loading, hold live events so they land after it, not above it.
  if (historyQueue) return historyQueue.push(e);
  dispatch(e);
}

function dispatch(e) {
  switch (e.ev) {
    case 'state': setState(e.state, e); break;
    case 'cli': renderCli(e.msg); break;
    case 'user_sent': addUserContent(e.content ?? e.text); break;
    case 'permission': addPermission(e.request_id, e.request); break;
    case 'permission_answered': case 'permission_cancel': closePermission(e.request_id, e.ev === 'permission_cancel' ? 'cancelled' : (e.allow ? 'allowed' : 'denied')); break;
    case 'restarted': current.initShown = false; note('Restarted — the CLI process was replaced and resumed this session.'); break;
    case 'stderr': current.stderr = ((current.stderr || '') + e.text).slice(-4000); break;
    case 'error': note(e.text, true); break;
    case 'info': break;
  }
}

async function onSubscribed(e) {
  const s = e.session;
  const same = current?.liveId === s.liveId;
  current = { ...s, stderr: '' };
  localStorage.setItem('ccw-live', s.liveId);
  if (!same) {
    clearMessages();
    historyQueue = [];
    // History comes from the session file; the backlog only matters when there's no file yet.
    const hist = await api(`/api/sessions/${s.sessionId}`).catch(() => null);
    if (hist && !hist.error) renderHistory(hist.messages);
    else for (const b of e.backlog) dispatch(b);
    actEmpty();
    const queued = historyQueue; historyQueue = null;
    for (const q of queued) dispatch(q);
  }
  for (const p of e.permissions) addPermission(p.request_id, p.request);
  showHeader();
  setState(current.state); // queued state events may have moved it on from s.state
  refreshSidebar();
}

// ---------- rendering ----------
const msgs = $('#messages');       // scroll container
const thread = $('#thread');       // centred column the messages live in
const atBottom = () => msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 80;
function append(node) {
  const stick = atBottom(); thread.append(node); if (stick) msgs.scrollTop = msgs.scrollHeight;
  if (!node.classList?.contains('tool-chip')) chip = null; // anything else in the chat ends the current tool group
  return node;
}

// Activity tab: tool calls, MCP calls and thinking live here, out of the chat.
const actScroll = $('#activity'), actList = $('#activity-list');
let chip = null;             // the chat's summary line for the current run of tool calls
let toolCount = 0;
function appendAct(node) {
  actList.querySelector('.act-empty')?.remove();
  const stick = actScroll.scrollHeight - actScroll.scrollTop - actScroll.clientHeight < 80;
  actList.append(node); if (stick) actScroll.scrollTop = actScroll.scrollHeight;
  return node;
}
function setActCount() { const c = $('#act-count'); c.textContent = toolCount; c.hidden = !toolCount; }
function actEmpty() { if (!actList.children.length) actList.append(el('div', 'act-empty', 'No tool activity in this session yet.')); }

function clearMessages() {
  thread.innerHTML = ''; actList.innerHTML = '';
  toolCards = new Map(); permCards = new Map(); streamDiv = null; chip = null; toolCount = 0;
  setActCount();
}
function note(text, err) { append(el('div', 'note' + (err ? ' err' : ''), text)); }
const isNoise = t => !t || /^\s*<(command-|local-command|system-reminder|bash-|task-notification)/.test(t) || t.startsWith('Caveat:');

// Non-image attachments are sent as a line Claude can act on; the UI shows them as chips.
const ATTACH_RE = /^\[Attached file: (.+)\]$/;
function addUser(text, images = []) {
  text = text || '';
  if (!images.length && isNoise(text)) {
    const m = /<command-name>([^<]+)<\/command-name>/.exec(text);
    if (m) note(`ran ${m[1]}`);
    return;
  }
  const files = [];
  const body = text.split('\n').filter(line => { const m = ATTACH_RE.exec(line.trim()); if (m) files.push(m[1]); return !m; }).join('\n').trim();
  const bubble = el('div', 'msg user');
  if (images.length) {
    const row = el('div', 'msg-images');
    for (const src of images) {
      const img = el('img'); img.src = src; img.alt = 'Attached image'; img.loading = 'lazy';
      img.onclick = () => openLightbox(src);
      row.append(img);
    }
    bubble.append(row);
  }
  if (body) bubble.append(document.createTextNode(body));
  if (files.length) {
    const row = el('div', 'msg-files');
    for (const f of files) { const c = el('span', 'file-chip'); c.title = f; c.append(icon('file'), el('span', null, f.split('/').pop().replace(/^[0-9a-f]{6}-/, ''))); row.append(c); }
    bubble.append(row);
  }
  append(bubble);
  const label = body.split('\n')[0] || (images.length ? `${images.length} image${images.length > 1 ? 's' : ''}` : files.map(f => f.split('/').pop()).join(', '));
  const turn = el('div', 'act-turn'); turn.append(icon('right'), el('span', null, label.slice(0, 140)));
  appendAct(turn);
}
// A user message's content: a string, or blocks of text / image / tool_result.
function addUserContent(content) {
  if (typeof content === 'string') return addUser(content);
  const texts = [], images = [];
  for (const b of content || []) {
    if (b.type === 'text') texts.push(b.text);
    else if (b.type === 'image' && b.source?.type === 'base64') images.push(`data:${b.source.media_type};base64,${b.source.data}`);
  }
  if (texts.length || images.length) addUser(texts.join('\n'), images);
}
function openLightbox(src) { $('#lightbox-img').src = src; $('#dlg-image').showModal(); }
$('#dlg-image').onclick = e => { if (e.target === $('#dlg-image') || e.target.tagName === 'IMG') $('#dlg-image').close(); };

function addAssistantText(text) {
  if (streamDiv) { streamDiv.className = 'msg assistant'; streamDiv.innerHTML = md(text); decorate(streamDiv); streamDiv = null; return; }
  const d = el('div', 'msg assistant'); d.innerHTML = md(text); decorate(d); append(d);
}

// ---------- copy ----------
// Fallback for pages that aren't a "secure context" (e.g. http://claude.test), where
// navigator.clipboard is unavailable: select hidden content and use the copy command.
function legacyCopy(plain, html) {
  const box = document.createElement(html ? 'div' : 'textarea');
  box.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;white-space:pre-wrap';
  if (html) box.innerHTML = html; else box.value = plain;
  document.body.append(box);
  if (html) { const r = document.createRange(); r.selectNodeContents(box); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); }
  else box.select();
  const ok = document.execCommand('copy');
  getSelection().removeAllRanges(); box.remove();
  if (!ok) throw new Error('the browser blocked copying');
}
async function copyToClipboard(plain, html) {
  if (!window.isSecureContext || !navigator.clipboard) return legacyCopy(plain, html);
  if (html && window.ClipboardItem) {
    // Rich + plain, so pasting into Gmail keeps formatting and a plain field gets clean text.
    await navigator.clipboard.write([new ClipboardItem({
      'text/plain': new Blob([plain], { type: 'text/plain' }),
      'text/html': new Blob([html], { type: 'text/html' }),
    })]);
  } else await navigator.clipboard.writeText(plain);
}
function copyButton(label, getContent) {
  const b = el('button', 'copy-btn'); b.type = 'button';
  const set = (ic, text) => { b.innerHTML = ''; b.append(icon(ic), el('span', null, text)); };
  set('copy', label);
  b.onclick = async e => {
    e.stopPropagation();
    try {
      const { plain, html } = getContent();
      await copyToClipboard(plain, html);
      b.classList.add('copied'); set('check', 'Copied');
      setTimeout(() => { b.classList.remove('copied'); set('copy', label); }, 1600);
    } catch (err) { toast(`Copy failed: ${err.message}`); }
  };
  return b;
}
// Turn ```draft blocks into draft cards, add Copy to code blocks and to the whole reply.
function decorate(msg) {
  // Links (e.g. a ticket's [Open]) go to a new tab, never replacing this page.
  for (const a of msg.querySelectorAll('a[href]')) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
  const drafts = [...msg.querySelectorAll('pre > code.language-draft')];
  drafts.forEach((code, i) => {
    const text = code.textContent.replace(/\n+$/, '');
    const card = el('div', 'draft');
    const head = el('div', 'draft-head');
    head.append(el('span', null, drafts.length > 1 ? `Draft ${i + 1}` : 'Draft'), copyButton('Copy', () => ({ plain: text })));
    card.append(head, el('div', 'draft-body', text));
    code.parentElement.replaceWith(card);
  });
  // Tables wrap to the column width and only scroll sideways when they truly can't fit.
  for (const t of msg.querySelectorAll('table')) { const w = el('div', 'table-wrap'); t.replaceWith(w); w.append(t); }
  for (const pre of msg.querySelectorAll('pre')) {
    const wrap = el('div', 'code-wrap');
    pre.replaceWith(wrap); wrap.append(pre, copyButton('Copy', () => ({ plain: pre.textContent.replace(/\n$/, '') })));
  }
  const actions = el('div', 'msg-actions');
  actions.append(copyButton('Copy reply', () => {
    const clone = msg.cloneNode(true);
    clone.querySelectorAll('.msg-actions, .copy-btn, .draft-head').forEach(n => n.remove());
    return { plain: clone.innerText.trim(), html: clone.innerHTML };
  }));
  msg.append(actions);
}

function toolSummary(name, input = {}) {
  const v = input.command || input.file_path || input.pattern || input.url || input.query || input.description || input.prompt || input.skill || '';
  return String(v).split('\n')[0].slice(0, 160);
}

// mcp__github__list_issues -> "github · list_issues"
function toolLabel(name) {
  const m = /^mcp__(.+?)__(.+)$/.exec(name || '');
  return m ? `${m[1].replace(/^plugin_[^_]+_/, '')} · ${m[2]}` : name;
}

function renderChip() {
  const names = [...new Set(chip.tools.map(t => toolLabel(t.name).split(' · ')[0]))];
  const fails = chip.tools.filter(t => t.error).length;
  const running = chip.tools.some(t => !t.done);
  chip.classList.toggle('running', running);
  chip.innerHTML = '';
  chip.append(icon('wrench'),
    el('span', 'names', `${chip.tools.length === 1 ? 'Used' : `Used ${chip.tools.length} tools ·`} ${names.slice(0, 3).join(', ')}${names.length > 3 ? ` +${names.length - 3}` : ''}`));
  if (fails) chip.append(el('span', 'fail', `${fails} failed`));
  chip.append(icon('right'));
  chip.lastChild.classList.add('go');
}
function addToolUse(block) {
  const d = el('details', 'tool');
  const s = el('summary');
  s.append(el('span', 'name', toolLabel(block.name)), el('span', 'arg', toolSummary(block.name, block.input)), el('span', 'st', 'running'));
  d.append(s, el('pre', null, JSON.stringify(block.input, null, 2)));
  toolCards.set(block.id, d);
  appendAct(d);
  toolCount++; setActCount();
  if (!chip) {
    const c = el('button', 'tool-chip'); c.type = 'button'; c.tools = [];
    c.onclick = () => { const first = toolCards.get(c.tools[0]?.id); showTab('activity'); if (first) { first.scrollIntoView({ block: 'center' }); first.classList.remove('flash'); void first.offsetWidth; first.classList.add('flash'); } };
    append(c); chip = c;
  }
  chip.tools.push({ id: block.id, name: block.name });
  d.chip = chip;
  renderChip();
  workLabel(`Running ${toolLabel(block.name)}${toolSummary(block.name, block.input) ? ': ' + toolSummary(block.name, block.input) : ''}`);
}

function addToolResult(block) {
  const d = toolCards.get(block.tool_use_id);
  let text = typeof block.content === 'string' ? block.content
    : Array.isArray(block.content) ? block.content.map(c => c.type === 'text' ? c.text : `[${c.type}]`).join('\n') : '';
  if (text.length > 20000) text = text.slice(0, 20000) + '\n… (truncated)';
  if (!d) return;
  d.classList.add(block.is_error ? 'err' : 'ok');
  const c = d.chip, t = c?.tools.find(x => x.id === block.tool_use_id);
  if (t) { t.done = true; t.error = !!block.is_error; const keep = chip; chip = c; renderChip(); chip = keep; }
  d.querySelector('.st').textContent = block.is_error ? 'error' : 'done';
  d.append(el('pre', null, text || '(no output)'));
  workLabel('Thinking…');
}

function renderBlocks(role, content) {
  if (typeof content === 'string') return role === 'user' ? addUser(content) : addAssistantText(content);
  if (role === 'user') addUserContent(content.filter(b => b.type !== 'tool_result'));
  for (const b of content || []) {
    if (b.type === 'text') { if (role !== 'user') addAssistantText(b.text); }
    else if (b.type === 'tool_use') addToolUse(b);
    else if (b.type === 'tool_result') addToolResult(b);
    else if (b.type === 'thinking' && b.thinking) {
      const d = el('details', 'thinking'); d.append(el('summary', null, 'Thinking'), el('div', null, b.thinking)); appendAct(d);
    }
  }
}

function renderHistory(list) {
  for (const m of list) renderBlocks(m.type, m.message.content);
  actEmpty();
  msgs.scrollTop = msgs.scrollHeight; actScroll.scrollTop = actScroll.scrollHeight;
}

function renderCli(m) {
  switch (m.type) {
    case 'system':
      if (m.subtype === 'init') {
        const first = !current.initShown;
        current.initShown = true;
        current.model = m.model; current.permissionMode = m.permissionMode; current.sessionId = m.session_id;
        showHeader();
        if (!first) break;
        const mcps = (m.mcp_servers || []);
        // Servers are usually still "pending" here; only failures are worth flagging.
        const bad = mcps.filter(x => x.status === 'failed' || x.status === 'needs-auth').map(x => x.name.replace(/^plugin:[^:]+:/, ''));
        // System detail, so it goes to Activity rather than the chat.
        appendAct(el('div', 'note', `Session started · ${modelLabel(m.model)} · ${modeLabel(m.permissionMode)} · ${mcps.length} MCP servers${bad.length ? ` · needs attention: ${bad.join(', ')}` : ''}`));
      } else if (m.subtype === 'compact_boundary') note('Conversation compacted');
      else if (m.subtype === 'api_retry' || m.subtype === 'status') {}
      break;
    case 'stream_event': {
      const ev = m.event;
      if (m.parent_tool_use_id) break; // subagent output stays in its tool card
      if (ev.type === 'content_block_start' && ev.content_block?.type === 'text') {
        streamDiv = append(el('div', 'msg assistant streaming'));
        workLabel('Writing…');
      } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && streamDiv) {
        const stick = atBottom(); streamDiv.textContent += ev.delta.text; if (stick) msgs.scrollTop = msgs.scrollHeight;
      } else if (ev.type === 'content_block_start' && ev.content_block?.type === 'thinking') workLabel('Thinking…');
      else if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') workLabel(`Preparing ${toolLabel(ev.content_block.name)}…`);
      break;
    }
    case 'assistant': if (!m.parent_tool_use_id) renderBlocks('assistant', m.message.content); break;
    case 'user': if (!m.parent_tool_use_id) renderBlocks('user', (m.message.content || []).filter(b => b.type === 'tool_result')); break;
    case 'result': {
      if (streamDiv) { streamDiv = null; }
      const secs = m.duration_ms ? (m.duration_ms / 1000).toFixed(1) + 's' : '';
      const cost = m.total_cost_usd ? ` · $${m.total_cost_usd.toFixed(4)}` : '';
      if (m.is_error) note(`Error: ${m.result || m.subtype}`, true);
      else note(`${secs}${cost}`);
      break;
    }
  }
}

// ---------- permissions ----------
function addPermission(id, req) {
  if (permCards.has(id)) return;
  const c = el('div', 'perm');
  const h = el('div', 'h'); h.append(icon('alert'), `Allow ${req.tool_name}?`);
  c.append(h);
  if (req.description) c.append(el('div', 'desc', req.description));
  const inp = req.input || {};
  c.append(el('pre', null, inp.command || (inp.file_path && (inp.old_string != null || inp.content != null)
    ? `${inp.file_path}\n\n${inp.old_string != null ? `- ${inp.old_string}\n+ ${inp.new_string}` : inp.content}`
    : JSON.stringify(inp, null, 2))));
  if (req.decision_reason) c.append(el('div', 'desc', req.decision_reason));
  const acts = el('div', 'acts');
  const answer = (allow, extra = {}) => call({ op: 'permission', request_id: id, allow, ...extra });
  const btn = (cls, text, fn) => { const b = el('button', `btn ${cls} btn-sm`, text); b.type = 'button'; b.onclick = fn; acts.append(b); return b; };
  btn('btn-primary', 'Allow', () => answer(true));
  if (req.permission_suggestions?.length) btn('btn-secondary', 'Always allow', () => answer(true, { updatedPermissions: req.permission_suggestions }));
  btn('btn-danger', 'Deny', () => answer(false));
  btn('btn-ghost', 'Deny with feedback…', () => { const t = prompt('Tell Claude what to do instead:'); if (t != null) answer(false, { message: t }); });
  c.append(acts);
  permCards.set(id, c);
  append(c);
  workLabel(`Waiting for your approval: ${req.tool_name}`);
  if (document.hidden && window.Notification?.permission === 'granted') new Notification('Claude needs permission', { body: req.tool_name });
}
function closePermission(id, label) {
  const c = permCards.get(id); if (!c) return;
  c.classList.add('done');
  c.querySelector('.acts').replaceWith(el('div', 'outcome', label[0].toUpperCase() + label.slice(1)));
  workLabel(label === 'allowed' ? 'Running…' : 'Thinking…');
}

// ---------- working indicator ----------
let workStart = 0, workTimer = null;
function working(on, label) {
  const w = $('#working');
  $('#act-live').hidden = !on;
  if (!on) { w.hidden = true; clearInterval(workTimer); workTimer = null; return; }
  if (w.hidden) {
    w.hidden = false; workStart = Date.now();
    clearInterval(workTimer);
    workTimer = setInterval(() => { $('#working-time').textContent = `${Math.floor((Date.now() - workStart) / 1000)}s`; }, 1000);
    $('#working-time').textContent = '0s';
  }
  if (label) $('#working-text').textContent = label;
  w.classList.toggle('waiting', permCards.size > 0 && [...permCards.values()].some(c => !c.classList.contains('done')));
}
const busy = () => current?.state === 'running' || current?.state === 'starting';
function workLabel(label) { if (busy()) working(true, label); }

// ---------- tabs ----------
function showTab(name) {
  const chat = name !== 'activity';
  $('#tab-chat').setAttribute('aria-selected', String(chat)); $('#tab-chat').tabIndex = chat ? 0 : -1;
  $('#tab-activity').setAttribute('aria-selected', String(!chat)); $('#tab-activity').tabIndex = chat ? -1 : 0;
  $('#messages').hidden = !chat; $('#activity').hidden = chat;
  try { localStorage.setItem('ccw-tab', chat ? 'chat' : 'activity'); } catch {}
}
$('#tab-chat').onclick = () => showTab('chat');
$('#tab-activity').onclick = () => { showTab('activity'); actScroll.scrollTop = actScroll.scrollHeight; };
$('.tabs').onkeydown = e => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  const next = document.activeElement.id === 'tab-chat' ? 'activity' : 'chat';
  showTab(next); $('#tab-' + next).focus();
};
showTab((() => { try { return localStorage.getItem('ccw-tab'); } catch {} })() || 'chat');

// ---------- header & state ----------
const MODELS = [['', 'Default'], ['opus', 'Opus'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku'], ['fable', 'Fable']];
// The CLI reports "manual" as "default", so they are one entry here.
const MODES = [['default', 'Ask every time'], ['acceptEdits', 'Accept edits'], ['auto', 'Auto'], ['plan', 'Plan'], ['bypassPermissions', 'Bypass permissions']];
const modeLabel = m => (MODES.find(x => x[0] === m) || [m, m || 'default'])[1];
const modelLabel = m => { if (!m) return 'Default model'; const hit = MODELS.find(x => x[0] && m.includes(x[0])); return hit ? hit[1] : m; };

function showHeader() {
  const live = !!current?.liveId;
  $('#controls').hidden = !current;
  $('#tabs-bar').hidden = !current;
  $('#btn-restart').hidden = !live;
  if (!$('#title .rename-input')) $('#title').textContent = sessions.find(s => s.id === current?.sessionId)?.title || (live ? 'New session' : 'No session open');
  const canRename = sessions.some(s => s.id === current?.sessionId);
  $('#title').classList.toggle('renamable', canRename);
  $('#title').title = canRename ? 'Double-click to rename' : '';
  const presetName = current && (current.preset || sessions.find(s => s.id === current.sessionId)?.preset);
  $('#subtitle').textContent = current ? `${presetName ? presetName + ' · ' : ''}${shortPath(current.cwd || '')}` : '';
  $('#subtitle').title = current ? `${current.cwd || ''}\nSession ${current.sessionId}` : '';
  renderPickers();
  $('#composer-meta').textContent = current && !live ? 'Not running' : '';
  $('#composer-meta').title = current && !live ? 'Sending a message resumes this session' : '';
  $('#input').disabled = !current; $('#btn-attach').disabled = !current; updateSend();
  $('#input').placeholder = current ? 'Message Claude' : 'Start or open a session to begin';
}
function setState(state, e = {}) {
  if (!current) return;
  current.state = state;
  const live = !!current.liveId;
  const label = !live ? 'Not running' : { idle: 'Ready', running: 'Working', exited: 'Stopped', starting: 'Starting' }[state] || state;
  const p = $('#state'); p.className = 'status ' + (live ? state : ''); p.querySelector('span').textContent = label;
  if (state === 'running') working(true); else working(false);
  if (state === 'exited') {
    streamDiv = null;
    const tail = (current.stderr || '').trim().split('\n').slice(-6).join('\n');
    note(`CLI process exited${e.code != null ? ` (code ${e.code})` : ''}. Send a message or press Restart to resume.${tail ? '\n' + tail : ''}`, !!tail);
  }
  renderSessions();
}

// ---------- actions menu (WAI-ARIA menu button) ----------
const menu = $('#actions-menu'), menuBtn = $('#btn-actions');
function menuItem({ label, iconName, kbd, danger, disabled, checked, onSelect }) {
  const b = el('button', 'menu-item' + (danger ? ' danger' : ''));
  b.type = 'button'; b.tabIndex = -1;
  b.setAttribute('role', checked === undefined ? 'menuitem' : 'menuitemradio');
  if (checked !== undefined) b.setAttribute('aria-checked', String(checked));
  if (disabled) b.setAttribute('aria-disabled', 'true');
  if (iconName) b.append(icon(iconName));
  b.append(el('span', null, label));
  if (kbd) b.append(el('span', 'kbd', kbd));
  if (checked !== undefined) { const c = icon('check'); c.classList.add('check'); b.append(c); }
  b.onclick = () => { if (disabled) return; closeActions(); onSelect(); };
  return b;
}
function buildActions() {
  const live = !!current?.liveId && current.state !== 'exited';
  menu.innerHTML = '';
  menu.append(
    menuItem({ label: 'Interrupt', iconName: 'pause', kbd: 'Esc', disabled: current?.state !== 'running', onSelect: () => call({ op: 'interrupt' }) }),
    menuItem({ label: 'MCP servers', iconName: 'plug', onSelect: openMcp }),
    menuItem({ label: 'Rename session', iconName: 'pencil', disabled: !sessions.some(x => x.id === current?.sessionId), onSelect: () => startRename(current.sessionId, 'title') }),
    menuItem({ label: 'Copy session ID', iconName: 'copy', onSelect: () => navigator.clipboard.writeText(current.sessionId).then(() => toast('Session ID copied')) }));
  menu.append(el('div', 'menu-sep'),
    menuItem({ label: 'Stop session', iconName: 'power', disabled: !live, onSelect: () => { if (confirm('Stop the CLI process for this session? You can resume it later.')) call({ op: 'stop' }); } }),
    menuItem({ label: 'Delete session', iconName: 'trash', danger: true, disabled: !(sessions.some(x => x.id === current?.sessionId) || current?.liveId), onSelect: () => confirmDelete(current.sessionId) }));
  for (const sep of menu.querySelectorAll('.menu-sep, .menu-label')) sep.setAttribute('role', 'none');
}
const menuItems = () => [...menu.querySelectorAll('.menu-item:not([aria-disabled="true"])')];
function openActions(focusLast) {
  buildActions();
  menu.hidden = false; menuBtn.setAttribute('aria-expanded', 'true');
  const items = menuItems(); (focusLast ? items.at(-1) : items[0])?.focus();
}
function closeActions(refocus) {
  if (menu.hidden) return;
  menu.hidden = true; menuBtn.setAttribute('aria-expanded', 'false');
  if (refocus) menuBtn.focus();
}
menuBtn.onclick = () => (menu.hidden ? openActions() : closeActions());
menuBtn.onkeydown = e => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); openActions(e.key === 'ArrowUp'); } };
menu.onkeydown = e => {
  const items = menuItems(); const i = items.indexOf(document.activeElement);
  const go = n => { e.preventDefault(); items[(n + items.length) % items.length]?.focus(); };
  if (e.key === 'ArrowDown') go(i + 1);
  else if (e.key === 'ArrowUp') go(i - 1);
  else if (e.key === 'Home') go(0);
  else if (e.key === 'End') go(items.length - 1);
  else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeActions(true); }
  else if (e.key === 'Tab') closeActions();
};
document.addEventListener('pointerdown', e => { if (!menu.hidden && !e.target.closest('.menu-wrap')) closeActions(); });

// Changes apply now if the CLI is running; otherwise they're kept and used when it starts.
const isRunning = () => current?.liveId && current.state !== 'exited';
async function setModel(model) {
  if (!isRunning()) return setPending({ model });
  const r = await call({ op: 'set_model', model });
  if (r.subtype === 'error') return note(`Model change failed: ${r.error}`, true);
  current.model = model; showHeader(); note(`Model set to ${modelLabel(model)}`);
}
async function setMode(mode) {
  if (!isRunning()) return setPending({ permissionMode: mode });
  const r = await call({ op: 'set_mode', mode });
  if (r.subtype === 'error' && /dangerously-skip-permissions/.test(r.error || '')) {
    // A process started before bypass was allowed can't switch; restart it straight into the mode.
    if (current.state === 'running') return note('Bypass permissions needs a restart of this session. Try again when Claude has finished.', true);
    const rs = await call({ op: 'restart', permissionMode: mode });
    if (rs.session) Object.assign(current, rs.session);
    current.permissionMode = mode; showHeader();
    return note(`Restarted in ${modeLabel(mode)} mode. The conversation continues as before.`);
  }
  if (r.subtype === 'error') return note(`Permission mode change failed: ${r.error}`, true);
  current.permissionMode = mode; showHeader(); note(`Permission mode set to ${modeLabel(mode)}`);
}
function setPending(change) {
  current.pending = { ...current.pending, ...change };
  showHeader(); toast('Used when the session starts');
}

// ---------- model / mode pickers in the chat box ----------
const MODE_HINTS = {
  default: 'Asks before edits and commands', acceptEdits: 'Edits files without asking', auto: 'Decides what needs asking',
  plan: 'Plans only, changes nothing', bypassPermissions: 'Never asks. Use with care',
};
const effective = key => current?.pending?.[key] ?? current?.[key] ?? '';
function renderPickers() {
  $('#cf-pickers').hidden = !current;
  if (!current) return;
  const m = $('#pick-model'), p = $('#pick-mode');
  m.querySelector('span').textContent = modelLabel(effective('model'));
  p.querySelector('span').textContent = modeLabel(effective('permissionMode') || 'default');
  m.classList.toggle('pending', current.pending?.model !== undefined);
  p.classList.toggle('pending', current.pending?.permissionMode !== undefined);
  p.classList.toggle('risky', effective('permissionMode') === 'bypassPermissions');
  m.title = current.pending?.model !== undefined ? 'Model (used when the session starts)' : 'Model';
  p.title = current.pending?.permissionMode !== undefined ? 'Permission mode (used when the session starts)' : 'Permission mode';
}
function openPicker(anchor, kind) {
  closeCtx();
  ctxAnchor = anchor; anchor.setAttribute('aria-expanded', 'true');
  ctx.innerHTML = ''; ctx.classList.add('popup');
  ctx.append(el('div', 'menu-label', kind === 'model' ? 'Model' : 'Permission mode'));
  if (kind === 'model') {
    const cur = effective('model'); const known = MODELS.some(([v]) => v && cur.includes(v));
    for (const [v, l] of MODELS) ctx.append(menuItem({ label: l, checked: v ? cur.includes(v) : !known, onSelect: () => { closeCtx(); setModel(v); } }));
  } else {
    const cur = effective('permissionMode') || 'default';
    for (const [v, l] of MODES) {
      const item = menuItem({ label: l, checked: cur === v, onSelect: () => { closeCtx(); setMode(v); } });
      item.classList.add('two-line'); item.querySelector('span').append(el('span', 'desc', MODE_HINTS[v] || ''));
      ctx.append(item);
    }
  }
  ctx.querySelector('.menu-label').setAttribute('role', 'none');
  ctx.hidden = false;
  // Open upward from the chat box.
  const r = anchor.getBoundingClientRect();
  ctx.style.left = `${Math.max(8, Math.min(r.left, innerWidth - ctx.offsetWidth - 8))}px`;
  ctx.style.top = `${Math.max(8, r.top - ctx.offsetHeight - 6)}px`;
  ctx.querySelector('.menu-item[aria-checked="true"]')?.focus() || ctx.querySelector('.menu-item')?.focus();
}
$('#pick-model').onclick = e => (ctxAnchor === e.currentTarget && !ctx.hidden ? closeCtx() : openPicker(e.currentTarget, 'model'));
$('#pick-mode').onclick = e => (ctxAnchor === e.currentTarget && !ctx.hidden ? closeCtx() : openPicker(e.currentTarget, 'mode'));

// ---------- sidebar ----------
// Shorten the server's home folder to ~ (works for macOS, Linux and custom homes).
let HOME_DIRS = []; // the home folder as given, and resolved (they differ when it sits behind a symlink)
const shortPath = p => {
  p = p || '';
  for (const h of HOME_DIRS) if (p === h || p.startsWith(h + '/')) return '~' + p.slice(h.length);
  return p.replace(/^\/(Users|home)\/[^/]+/, '~');
};
function when(t) {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return `${s / 60 | 0}m`;
  if (s < 86400) return `${s / 3600 | 0}h`;
  if (s < 7 * 86400) return `${s / 86400 | 0}d`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function groupOf(t) {
  const d = new Date(t), now = new Date();
  const day = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86400000);
  if (diff <= 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff < 7) return 'Previous 7 days';
  if (diff < 30) return 'Previous 30 days';
  return 'Older';
}

async function refreshSidebar() {
  [sessions, liveSessions] = await Promise.all([api('/api/sessions'), api('/api/live')]).catch(() => [sessions, liveSessions]);
  renderSessions();
  if (current && !$('#title .rename-input')) $('#title').textContent = sessions.find(s => s.id === current.sessionId)?.title || $('#title').textContent;
}
const renderLive = () => renderSessions();
function sbItem({ id, title, time, dotState, active, tip, onClick, preset }) {
  // A div with role=button so the nested ⋯ button stays valid HTML.
  const b = el('div', 'sb-item'); b.setAttribute('role', 'button'); b.tabIndex = 0;
  if (id) b.dataset.id = id;
  if (active) b.setAttribute('aria-current', 'true');
  if (dotState) b.append(el('span', 'dot ' + dotState));
  if (preset) { const t = icon(presets.find(p => p.name === preset)?.icon || 'zap'); t.classList.add('tag'); b.append(t); }
  b.append(el('span', 't', title));
  if (time) b.append(el('span', 'when', time));
  b.title = tip || title;
  const go = () => { if (b.querySelector('.rename-input')) return; onClick(); if (matchMedia('(max-width: 900px)').matches) setSidebar(false); };
  b.onclick = e => { if (!e.target.closest('.more')) go(); };
  b.onkeydown = e => { if ((e.key === 'Enter' || e.key === ' ') && e.target === b) { e.preventDefault(); go(); } };
  if (id) {
    const more = el('button', 'more'); more.type = 'button';
    more.setAttribute('aria-label', 'Session options'); more.setAttribute('aria-haspopup', 'menu'); more.setAttribute('aria-expanded', 'false');
    more.append(icon('more'));
    more.onclick = e => { e.stopPropagation(); openCtx(more, id); };
    b.append(more);
  }
  return b;
}
function renderSessions() {
  // Don't rebuild the list under an open ⋯ menu or a rename in progress.
  if (!$('#ctx-menu').hidden || $('#session-nav .rename-input')) return;
  const q = $('#search').value.trim().toLowerCase();
  const nav = $('#session-nav'); nav.innerHTML = '';
  const match = s => !q || `${s.title} ${s.cwd} ${s.id}`.toLowerCase().includes(q);
  const liveIds = new Set(liveSessions.map(l => l.sessionId));

  const live = liveSessions.filter(l => match({ title: sessions.find(s => s.id === l.sessionId)?.title || 'New session', cwd: l.cwd, id: l.sessionId }));
  if (live.length) {
    nav.append(el('div', 'sb-group', 'Active'));
    for (const l of live) {
      const state = l.liveId === current?.liveId ? current.state : l.state;
      const title = sessions.find(s => s.id === l.sessionId)?.title || 'New session';
      nav.append(sbItem({ id: l.sessionId, title, dotState: state, preset: l.preset, active: l.liveId === current?.liveId, tip: `${title}\n${shortPath(l.cwd)} · ${state}`,
        onClick: () => call({ op: 'subscribe', liveId: l.liveId }) }));
    }
  }
  let group = null, shown = 0;
  for (const s of sessions) {
    if (liveIds.has(s.id) || !match(s)) continue;
    const g = groupOf(s.mtime);
    if (g !== group) { nav.append(el('div', 'sb-group', g)); group = g; }
    nav.append(sbItem({ id: s.id, title: s.title, time: when(s.mtime), preset: s.preset, active: s.id === current?.sessionId && !current?.liveId,
      tip: `${s.title}\n${s.preset ? s.preset + ' · ' : ''}${shortPath(s.cwd)}`, onClick: () => openStored(s) }));
    shown++;
  }
  if (!shown && !live.length) nav.append(el('div', 'sb-empty', q ? 'No sessions match your search.' : 'No sessions yet.'));
}

// Sidebar collapse + theme
function setSidebar(open) {
  document.documentElement.classList.toggle('sb-closed', !open);
  $('#sb-backdrop').hidden = !(open && matchMedia('(max-width: 900px)').matches);
  try { if (!matchMedia('(max-width: 900px)').matches) localStorage.setItem('ccw-sidebar', open ? 'open' : 'closed'); } catch {}
}
$('#btn-sb-close').onclick = () => setSidebar(false);
$('#btn-sb-open').onclick = () => setSidebar(true);
$('#sb-backdrop').onclick = () => setSidebar(false);
if (matchMedia('(max-width: 900px)').matches) setSidebar(false);
document.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') { e.preventDefault(); setSidebar(document.documentElement.classList.contains('sb-closed')); }
});
function applyTheme(t) {
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  for (const b of document.querySelectorAll('[data-theme-set]')) b.setAttribute('aria-checked', String(b.dataset.themeSet === t));
  try { localStorage.setItem('ccw-theme', t); } catch {}
}
for (const b of document.querySelectorAll('[data-theme-set]')) b.onclick = () => applyTheme(b.dataset.themeSet);
applyTheme((() => { try { return localStorage.getItem('ccw-theme') || 'system'; } catch { return 'system'; } })());

async function openStored(s) {
  const live = liveSessions.find(l => l.sessionId === s.id && l.state !== 'exited');
  if (live) return call({ op: 'subscribe', liveId: live.liveId });
  // Show the transcript without starting a process; the first message resumes it.
  localStorage.removeItem('ccw-live');
  current = { sessionId: s.id, cwd: s.cwd, stored: true };
  clearMessages();
  const hist = await api(`/api/sessions/${s.id}`);
  renderHistory(hist.messages || []);
  showHeader(); setState('idle');
  msgs.scrollTop = msgs.scrollHeight;
}

// ---------- plan usage ----------
let usage = null;                       // latest { status, binding, windows: { five_hour: { utilization, resetsAt } }, updatedAt }
const USAGE_LABELS = { five_hour: '5-hour', seven_day: 'Weekly', seven_day_opus: 'Opus wk', seven_day_sonnet: 'Sonnet wk' };
const USAGE_ORDER = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet'];
const pctOf = u => Math.round((u <= 1.5 ? u * 100 : u) || 0);  // CLI sends a 0..1 fraction
function ago(ms) { const s = (Date.now() - ms) / 1000; return s < 60 ? 'just now' : s < 3600 ? `${s / 60 | 0}m ago` : `${s / 3600 | 0}h ago`; }
function until(sec) {
  const s = sec - Date.now() / 1000;
  if (s <= 0) return 'now';
  const h = s / 3600 | 0, m = Math.ceil((s % 3600) / 60);
  return h >= 24 ? `${h / 24 | 0}d ${h % 24}h` : h ? `${h}h ${m}m` : `${m}m`;
}
function resetText(sec) {
  const d = new Date(sec * 1000), soon = sec - Date.now() / 1000 < 86400;
  const t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return soon ? `resets ${t} · in ${until(sec)}` : `resets ${d.toLocaleDateString([], { weekday: 'short' })} ${t}`;
}
function renderUsage() {
  const box = $('#usage'), rows = $('#usage-rows');
  if (usage?.unavailable) { box.hidden = true; return; }
  box.hidden = false; rows.innerHTML = '';
  const w = usage?.windows || {};
  const keys = Object.keys(w).sort((a, b) => (USAGE_ORDER.indexOf(a) + 1 || 99) - (USAGE_ORDER.indexOf(b) + 1 || 99));
  $('#usage-updated').textContent = usage?.updatedAt ? ago(usage.updatedAt) : '';
  $('#usage-updated').title = usage?.updatedAt ? `Last updated ${new Date(usage.updatedAt).toLocaleString()}` : '';
  if (!keys.length) { rows.append(el('div', 'usage-empty', 'No data yet. Send a message or press refresh.')); return; }
  for (const k of keys) {
    const { utilization, resetsAt } = w[k];
    const stale = resetsAt && resetsAt * 1000 < Date.now();   // window has reset since we last heard
    const pct = stale ? 0 : pctOf(utilization);
    const isBinding = k === usage.binding;
    const full = !stale && (pct >= 100 || (isBinding && usage.status === 'rejected'));
    const warn = !stale && !full && (pct >= 75 || (isBinding && usage.status === 'allowed_warning'));
    const row = el('div', 'usage-row' + (full ? ' full' : warn ? ' warn' : '') + (stale ? ' stale' : ''));
    const bar = el('div', 'bar'); const fill = el('i'); fill.style.width = `${Math.min(100, pct)}%`; bar.append(fill);
    row.append(el('span', 'lbl', USAGE_LABELS[k] || k.replace(/_/g, ' ')), bar, el('span', 'pct', stale ? '—' : `${pct}%`),
      el('span', 'reset', stale ? 'Reset since last update · refresh' : resetsAt ? resetText(resetsAt) : ''));
    row.title = stale ? 'This window has reset. Refresh to see current usage.'
      : `${USAGE_LABELS[k] || k}: ${pct}% used${resetsAt ? `\nResets ${new Date(resetsAt * 1000).toLocaleString()}` : ''}`;
    rows.append(row);
  }
}
// One note in the chat when a window crosses 75%, and a clear one when the limit is hit.
function warnUsage() {
  if (!usage?.windows || !current?.liveId) return;
  let seen; try { seen = JSON.parse(localStorage.getItem('ccw-usage-warned') || '{}'); } catch { seen = {}; }
  for (const [k, { utilization, resetsAt }] of Object.entries(usage.windows)) {
    const pct = pctOf(utilization), name = (USAGE_LABELS[k] || k).toLowerCase(), key = `${k}:${resetsAt}`;
    const hit = pct >= 100 || (k === usage.binding && usage.status === 'rejected');
    if (hit && seen[key] !== 'full') { note(`Plan limit reached for your ${name} window. It resets ${resetsAt ? `at ${new Date(resetsAt * 1000).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}` : 'soon'}.`, true); seen[key] = 'full'; }
    else if (!hit && pct >= 75 && !seen[key]) { note(`${pct}% of your ${name} limit used · ${resetsAt ? resetText(resetsAt) : ''}`); seen[key] = 'warn'; }
  }
  try { localStorage.setItem('ccw-usage-warned', JSON.stringify(seen)); } catch {}
}
$('#usage-refresh').onclick = async () => {
  const box = $('#usage'); if (box.classList.contains('loading')) return;
  box.classList.add('loading');
  try { usage = await apiSend('POST', '/api/usage/refresh'); renderUsage(); }
  catch (e) { toast(e.message); }
  finally { box.classList.remove('loading'); }
};
setInterval(() => usage && renderUsage(), 30000);

// ---------- quick starts ----------
let presets = [];
async function loadPresets() { presets = await api('/api/presets').catch(() => presets); renderPresets(); renderSessions(); }
function renderPresets() {
  const box = $('#preset-list'); box.innerHTML = '';
  for (const p of presets) {
    const b = el('button', 'sb-item preset-item'); b.type = 'button';
    b.append(icon(p.icon || 'zap'), el('span', 't', p.name));
    b.title = `Start a new ${p.name.toLowerCase()} in ${shortPath(p.cwd)}`;
    b.onclick = () => { startPreset(p); if (matchMedia('(max-width: 900px)').matches) setSidebar(false); };
    box.append(b);
  }
  if (!presets.length) box.append(el('div', 'sb-empty', 'No quick starts. Use the gear to add one.'));
}
async function startPreset(p) {
  current = null;
  const r = await call({ op: 'open', presetId: p.id, cwd: p.cwd, model: p.model, permissionMode: p.permissionMode });
  if (r.error) return toast(r.error);
  note(`${p.name} started in ${shortPath(r.session?.cwd || p.cwd)}`);
  if (p.starter) { $('#input').value = p.starter; autosize(); updateSend(); }
  $('#input').focus();
}

// Editor: works on a copy, saved as a whole.
let presetDraft = [], presetIdx = 0;
function fillPresetForm() {
  const p = presetDraft[presetIdx];
  const pick = $('#preset-pick'); pick.innerHTML = '';
  presetDraft.forEach((x, i) => pick.append(new Option(x.name || 'Untitled', i)));
  pick.value = presetIdx;
  const on = !!p;
  for (const id of ['pf-name', 'pf-icon', 'pf-cwd', 'pf-model', 'pf-mode', 'pf-instructions', 'pf-starter', 'preset-del', 'preset-pick']) $('#' + id).disabled = !on;
  if (!on) return;
  $('#pf-name').value = p.name; $('#pf-icon').value = p.icon || 'zap'; $('#pf-cwd').value = p.cwd;
  $('#pf-model').value = p.model || ''; $('#pf-mode').value = p.permissionMode || '';
  $('#pf-instructions').value = p.instructions || ''; $('#pf-starter').value = p.starter || '';
}
function readPresetForm() {
  const p = presetDraft[presetIdx]; if (!p) return;
  Object.assign(p, { name: $('#pf-name').value.trim() || 'Untitled', icon: $('#pf-icon').value, cwd: $('#pf-cwd').value.trim() || '~',
    model: $('#pf-model').value, permissionMode: $('#pf-mode').value, instructions: $('#pf-instructions').value, starter: $('#pf-starter').value });
}
function openPresetEditor() {
  presetDraft = structuredClone(presets); presetIdx = 0;
  fillPresetForm(); $('#dlg-presets').showModal();
}
$('#btn-presets').onclick = openPresetEditor;
$('#preset-pick').onchange = e => { readPresetForm(); presetIdx = +e.target.value; fillPresetForm(); };
$('#pf-name').oninput = () => { readPresetForm(); $('#preset-pick').options[presetIdx].text = presetDraft[presetIdx].name; };
$('#preset-add').onclick = () => {
  readPresetForm();
  presetDraft.push({ id: `p${Date.now().toString(36)}`, name: 'New quick start', icon: 'zap', cwd: current?.cwd || '~', model: '', permissionMode: '', instructions: '', starter: '' });
  presetIdx = presetDraft.length - 1; fillPresetForm(); $('#pf-name').select();
};
$('#preset-del').onclick = () => {
  const p = presetDraft[presetIdx]; if (!p || !confirm(`Delete the “${p.name}” quick start? Sessions already started from it keep their history.`)) return;
  presetDraft.splice(presetIdx, 1); presetIdx = Math.max(0, presetIdx - 1); fillPresetForm();
};
$('#presets-close').onclick = $('#presets-cancel').onclick = () => $('#dlg-presets').close();
$('#preset-form').onsubmit = async e => {
  e.preventDefault(); readPresetForm();
  try {
    presets = await apiSend('PUT', '/api/presets', presetDraft);
    renderPresets(); renderSessions(); $('#dlg-presets').close(); toast('Quick starts saved');
  } catch (err) { toast(`Save failed: ${err.message}`); }
};

// ---------- rename & delete ----------
const EMPTY_HTML = thread.innerHTML;
function resetView() {
  current = null; localStorage.removeItem('ccw-live');
  clearMessages(); thread.innerHTML = EMPTY_HTML;
  working(false); showHeader(); renderSessions();
}

function startRename(id, where) {
  const s = sessions.find(x => x.id === id); if (!s) return;
  let host;
  if (where === 'title') host = $('#title');
  else {
    if (document.documentElement.classList.contains('sb-closed')) setSidebar(true);
    host = document.querySelector(`.sb-item[data-id="${id}"] .t`);
  }
  if (!host || host.querySelector('.rename-input')) return;
  const before = host.textContent;
  const input = el('input', 'rename-input'); input.value = s.named ? s.title : before;
  input.setAttribute('aria-label', 'Session name'); input.maxLength = 200;
  host.textContent = ''; host.append(input); input.focus(); input.select();
  let done = false;
  const finish = async save => {
    if (done) return; done = true;
    const title = input.value.trim();
    host.textContent = save && title ? title : before;
    if (!save || title === before) return renderSessions();
    try {
      await apiSend('PATCH', `/api/sessions/${id}`, { title });
      s.title = title || s.title; s.named = !!title;
      if (!title) await refreshSidebar(); else { renderSessions(); showHeader(); }
      toast(title ? 'Session renamed' : 'Name cleared');
    } catch (e) { host.textContent = before; toast(`Rename failed: ${e.message}`); }
  };
  input.onkeydown = e => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); finish(true); } else if (e.key === 'Escape') { e.preventDefault(); finish(false); } };
  input.onblur = () => finish(true);
  input.onclick = e => e.stopPropagation();
}
$('#title').ondblclick = () => { if (sessions.some(s => s.id === current?.sessionId)) startRename(current.sessionId, 'title'); };

function confirmDelete(id) {
  const s = sessions.find(x => x.id === id);
  const live = liveSessions.find(l => l.sessionId === id) || (current?.sessionId === id && current.liveId ? current : null);
  if (!s && !live) return;
  const dlg = $('#dlg-delete');
  $('#delete-name').textContent = `“${s?.title || 'New session'}”`;
  $('#delete-live').hidden = !live || live.state === 'exited';
  $('#delete-undo').hidden = !s; // an unsaved session has nothing to restore
  dlg.returnValue = '';
  dlg.onclose = async () => {
    if (dlg.returnValue !== 'delete') return;
    if (!s) {
      // Nothing was saved yet: just end the process and drop it from the list.
      await call({ op: 'close', liveId: live.liveId });
      if (current?.sessionId === id) resetView();
      await refreshSidebar();
      return toast('Session deleted');
    }
    try {
      await apiSend('DELETE', `/api/sessions/${id}`);
      if (current?.sessionId === id) resetView();
      await refreshSidebar();
      toast('Session deleted', 'Undo', async () => {
        try { await apiSend('POST', `/api/sessions/${id}/restore`); await refreshSidebar(); toast('Session restored'); }
        catch (e) { toast(`Restore failed: ${e.message}`); }
      });
    } catch (e) { toast(`Delete failed: ${e.message}`); }
  };
  dlg.showModal();
}

// Per-session ⋯ menu in the sidebar
const ctx = $('#ctx-menu');
let ctxAnchor = null;
function openCtx(anchor, id) {
  closeCtx();
  ctxAnchor = anchor;
  anchor.setAttribute('aria-expanded', 'true'); anchor.closest('.sb-item').classList.add('menu-open');
  ctx.innerHTML = '';
  const saved = sessions.some(x => x.id === id); // a new session has no file until its first message
  ctx.append(
    menuItem({ label: 'Rename', iconName: 'pencil', disabled: !saved, onSelect: () => { closeCtx(); startRename(id, 'sidebar'); } }),
    menuItem({ label: 'Copy session ID', iconName: 'copy', onSelect: () => { closeCtx(); navigator.clipboard.writeText(id).then(() => toast('Session ID copied')); } }),
    el('div', 'menu-sep'),
    menuItem({ label: 'Delete', iconName: 'trash', danger: true, onSelect: () => { closeCtx(); confirmDelete(id); } }));
  ctx.querySelector('.menu-sep').setAttribute('role', 'none');
  ctx.hidden = false;
  const r = anchor.getBoundingClientRect();
  const top = Math.min(r.bottom + 4, innerHeight - ctx.offsetHeight - 8);
  ctx.style.top = `${top}px`; ctx.style.left = `${Math.max(8, Math.min(r.left, innerWidth - ctx.offsetWidth - 8))}px`;
  ctx.querySelector('.menu-item')?.focus();
}
function closeCtx(refocus) {
  if (ctx.hidden) return;
  ctx.hidden = true; ctx.classList.remove('popup');
  if (ctxAnchor) { ctxAnchor.setAttribute('aria-expanded', 'false'); ctxAnchor.closest('.sb-item')?.classList.remove('menu-open'); if (refocus) ctxAnchor.focus(); }
  ctxAnchor = null;
}
ctx.onkeydown = e => {
  const items = [...ctx.querySelectorAll('.menu-item')]; const i = items.indexOf(document.activeElement);
  const go = n => { e.preventDefault(); items[(n + items.length) % items.length]?.focus(); };
  if (e.key === 'ArrowDown') go(i + 1);
  else if (e.key === 'ArrowUp') go(i - 1);
  else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeCtx(true); }
  else if (e.key === 'Tab') closeCtx();
};
document.addEventListener('pointerdown', e => { if (!ctx.hidden && !e.target.closest('#ctx-menu, .more, .cf-pick')) closeCtx(); });
$('#session-nav').addEventListener('scroll', () => closeCtx());

// ---------- actions ----------
// ---------- attachments ----------
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const MAX_IMAGE_BYTES = 3.5 * 1024 * 1024; // stays under the API's 5 MB image limit once base64-encoded
const MAX_IMAGE_SIDE = 2000;
let attachments = [];     // { id, kind: 'image'|'file', name, size, url?, mediaType?, data?, path?, upload?: Promise, failed? }

const fmtSize = n => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`;
const blobToBase64 = blob => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(blob); });

// Shrink big images in the browser, as the API rejects very large ones.
async function prepareImage(file) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(bmp.width, bmp.height));
  if (scale === 1 && file.size <= MAX_IMAGE_BYTES) { bmp.close?.(); return { blob: file, mediaType: file.type }; }
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale); canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height); bmp.close?.();
  const toBlob = (type, q) => new Promise(r => canvas.toBlob(r, type, q));
  let blob = await toBlob('image/png');
  if (blob.size > MAX_IMAGE_BYTES) blob = await toBlob('image/jpeg', 0.86);
  return { blob, mediaType: blob.type };
}

async function addFiles(fileList) {
  if (!current) return toast('Open or start a session first');
  for (const file of fileList) {
    const a = { id: Math.random().toString(36).slice(2), name: file.name || 'pasted-image.png', size: file.size };
    if (IMAGE_TYPES.includes(file.type)) {
      a.kind = 'image'; a.url = URL.createObjectURL(file);
      a.upload = prepareImage(file).then(async ({ blob, mediaType }) => { a.mediaType = mediaType; a.data = await blobToBase64(blob); })
        .catch(err => { a.failed = true; toast(`Couldn't read ${a.name}: ${err.message}`); });
    } else {
      a.kind = 'file';
      a.upload = fetch('/api/upload', { method: 'POST', headers: { 'x-token': TOKEN, 'x-filename': encodeURIComponent(a.name), 'content-type': 'application/octet-stream' }, body: file })
        .then(r => r.ok ? r.json() : Promise.reject(new Error(`upload failed (${r.status})`)))
        .then(r => { a.path = r.path; })
        .catch(err => { a.failed = true; toast(`${a.name}: ${err.message}`); })
        .finally(renderAttachments);
    }
    attachments.push(a);
  }
  renderAttachments();
}
function renderAttachments() {
  const box = $('#attachments'); box.innerHTML = '';
  box.hidden = !attachments.length;
  for (const a of attachments) {
    const item = el('div', `att ${a.kind === 'image' ? 'img' : 'file'}${a.failed ? ' failed' : ''}${a.kind === 'file' && !a.path && !a.failed ? ' uploading' : ''}`);
    item.title = a.name;
    if (a.kind === 'image') { const img = el('img'); img.src = a.url; img.alt = a.name; item.append(img); }
    else { const meta = el('div', 'meta'); meta.append(el('b', null, a.name), el('span', null, a.failed ? 'Upload failed' : a.path ? fmtSize(a.size) : 'Uploading…')); item.append(icon('file'), meta); }
    const rm = el('button', 'rm'); rm.type = 'button'; rm.setAttribute('aria-label', `Remove ${a.name}`); rm.append(icon('x'));
    rm.onclick = () => { attachments = attachments.filter(x => x !== a); if (a.url) URL.revokeObjectURL(a.url); renderAttachments(); };
    item.append(rm); box.append(item);
  }
  updateSend();
}
function updateSend() { $('#btn-send').disabled = !current || (!$('#input').value.trim() && !attachments.length); }

$('#btn-attach').onclick = () => $('#file-input').click();
$('#file-input').onchange = e => { addFiles([...e.target.files]); e.target.value = ''; };
$('#input').addEventListener('paste', e => {
  const files = [...(e.clipboardData?.files || [])];
  if (!files.length) return;           // plain text paste behaves normally
  e.preventDefault(); addFiles(files);
});
{
  // Drag and drop anywhere over the main pane.
  let depth = 0;
  const main = $('#main'), box = document.querySelector('.composer-box');
  const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
  main.addEventListener('dragenter', e => { if (!hasFiles(e) || !current) return; e.preventDefault(); if (depth++ === 0) { box.classList.add('dragging'); $('#drop-hint').hidden = false; } });
  main.addEventListener('dragover', e => { if (hasFiles(e) && current) e.preventDefault(); });
  main.addEventListener('dragleave', () => { if (depth && --depth === 0) { box.classList.remove('dragging'); $('#drop-hint').hidden = true; } });
  main.addEventListener('drop', e => {
    if (!hasFiles(e)) return; e.preventDefault(); depth = 0;
    box.classList.remove('dragging'); $('#drop-hint').hidden = true;
    addFiles([...e.dataTransfer.files]);
  });
}

$('#composer').onsubmit = async e => {
  e.preventDefault();
  let text = $('#input').value.trim();
  if ((!text && !attachments.length) || !current) return;
  const sending = attachments; attachments = []; renderAttachments();
  $('#input').value = ''; autosize();
  await Promise.all(sending.map(a => a.upload));
  const ok = sending.filter(a => !a.failed);
  const files = ok.filter(a => a.kind === 'file');
  if (files.length) text = [text, ...files.map(a => `[Attached file: ${a.path}]`)].filter(Boolean).join('\n');
  const images = ok.filter(a => a.kind === 'image');
  const content = images.length
    ? [...images.map(a => ({ type: 'image', source: { type: 'base64', media_type: a.mediaType, data: a.data } })), ...(text ? [{ type: 'text', text }] : [])]
    : text;
  sending.forEach(a => a.url && URL.revokeObjectURL(a.url));
  if (!content || (Array.isArray(content) && !content.length)) return;
  showTab('chat');
  working(true, 'Thinking…');
  if (!current.liveId) {
    const r = await call({ op: 'open', cwd: current.cwd, resume: current.sessionId, model: current.pending?.model, permissionMode: current.pending?.permissionMode });
    if (r.error) { working(false); return note(r.error, true); }
  } else if (current.state === 'exited' && current.pending) {
    // Stopped process: restart it with the model / mode picked while it was stopped.
    await call({ op: 'restart', model: current.pending.model, permissionMode: current.pending.permissionMode });
    current.pending = null;
  }
  call({ op: 'send', content });
};
$('#input').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#composer').requestSubmit(); }
});
function autosize() { const i = $('#input'); i.style.height = 'auto'; i.style.height = Math.min(i.scrollHeight, innerHeight * .4) + 'px'; }
$('#input').addEventListener('input', () => { autosize(); updateSend(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && current?.state === 'running' && menu.hidden && !document.querySelector('dialog[open]')) call({ op: 'interrupt' }); });

$('#working-stop').onclick = () => call({ op: 'interrupt' });
$('#btn-restart').onclick = async () => { const r = await call({ op: 'restart' }); if (r.session) Object.assign(current, r.session); };
$('#search').oninput = renderSessions;

// New session dialog with a small directory browser
async function browse(p) {
  const r = await api('/api/dirs' + (p ? `?path=${encodeURIComponent(p)}` : ''));
  if (r.error) return;
  $('#new-cwd').value = r.path; $('#new-up').dataset.parent = r.parent;
  const list = $('#dir-list'); list.innerHTML = '';
  for (const d of r.dirs) {
    const row = el('button'); row.type = 'button'; row.append(icon('folder'), el('span', null, d));
    row.onclick = () => browse(r.path.replace(/\/$/, '') + '/' + d); list.append(row);
  }
  if (!r.dirs.length) list.append(el('div', 'none', 'No subfolders.'));
}
$('#btn-new').onclick = () => { browse(current?.cwd || localStorage.getItem('ccw-last-cwd') || ''); $('#dlg-new').showModal(); if (matchMedia('(max-width: 900px)').matches) setSidebar(false); };
$('#new-up').onclick = () => browse($('#new-up').dataset.parent);
$('#new-cwd').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); browse($('#new-cwd').value); } };
$('#dlg-new').onclose = async () => {
  if ($('#dlg-new').returnValue !== 'start') return;
  const cwd = $('#new-cwd').value;
  localStorage.setItem('ccw-last-cwd', cwd);
  current = null;
  const r = await call({ op: 'open', cwd, model: $('#new-model').value, permissionMode: $('#new-mode').value });
  if (r.error) return alert(r.error);
  note(`New session in ${shortPath(cwd)}`);
  $('#input').focus();
};

// MCP dialog
function openMcp() { $('#dlg-mcp').showModal(); loadMcp(); }
async function loadMcp() {
  const list = $('#mcp-list'); list.innerHTML = '';
  list.append(el('div', 'loading', 'Loading…'));
  if (!current?.liveId || current.state === 'exited') {
    $('#mcp-note').textContent = 'No running session. Showing the CLI configuration check.';
    return mcpCheck();
  }
  $('#mcp-note').textContent = 'Live status in this session.';
  const r = await call({ op: 'mcp_status' });
  list.innerHTML = '';
  if (r.subtype === 'error' || r.error) return list.append(el('div', 'note err', r.error));
  for (const s of r.response?.mcpServers || []) {
    const row = el('div', 'mcp');
    const n = el('div', 'n');
    n.append(el('b', null, s.name.replace(/^plugin:[^:]+:/, '')), el('span', null, s.config?.url || [s.config?.command, ...(s.config?.args || [])].filter(Boolean).join(' ') || s.scope || ''));
    const badge = el('span', 'badge ' + s.status, s.status.replace('-', ' '));
    if (s.error) badge.title = s.error;
    const disabled = s.status === 'disabled';
    const act = async (b, msg) => { b.disabled = true; const x = await call(msg); if (x.subtype === 'error') toast(x.error); loadMcp(); };
    const reconnect = el('button', 'btn btn-secondary btn-xs', 'Reconnect'); reconnect.onclick = () => act(reconnect, { op: 'mcp_reconnect', name: s.name });
    const toggle = el('button', 'btn btn-ghost btn-xs', disabled ? 'Enable' : 'Disable'); toggle.onclick = () => act(toggle, { op: 'mcp_toggle', name: s.name, enabled: disabled });
    row.append(n, badge, reconnect, toggle);
    list.append(row);
  }
  if (!list.children.length) list.append(el('div', 'loading', 'No MCP servers configured.'));
}
async function mcpCheck() {
  const list = $('#mcp-list'); list.innerHTML = '';
  list.append(el('div', 'loading', 'Checking every configured server. This can take a moment…'));
  const r = await api('/api/mcp');
  list.innerHTML = ''; list.append(el('pre', null, ((r.stdout || '') + (r.stderr || '')).trim() || r.error));
}
$('#btn-mcp-global').onclick = openMcp;
$('#mcp-refresh').onclick = loadMcp;
$('#mcp-check').onclick = mcpCheck;
$('#mcp-close').onclick = () => $('#dlg-mcp').close();

// ---------- boot ----------
async function checkAuth() {
  const a = await api('/api/auth').catch(() => null);
  const b = $('#auth-banner');
  if (a && !a.loggedIn) {
    b.hidden = false;
    b.innerHTML = '';
    b.append(icon('alert'));
    const t = el('span'); t.innerHTML = 'The <code>claude</code> CLI isn’t logged in for this server, so sessions will fail. Start the server from a terminal where <code>claude</code> works, then reload.';
    b.append(t);
  } else b.hidden = true;
}
if (!TOKEN) askToken();
connect();
refreshSidebar();
loadPresets();
api('/api/usage').then(u => { usage = u; renderUsage(); }).catch(() => {});
api('/api/dirs').then(r => {
  HOME_DIRS = [...new Set([r.home, r.homeReal].filter(Boolean).map(h => h.replace(/\/$/, '')))];
  renderSessions(); renderPresets(); if (current) showHeader();
}).catch(() => {});
checkAuth();
setInterval(refreshSidebar, 15000);
if (window.Notification && Notification.permission === 'default') document.addEventListener('click', () => Notification.requestPermission(), { once: true });
