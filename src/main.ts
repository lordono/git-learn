import './style.css';
import { runLine, saveEditor } from './engine/shell';
import { clone } from './engine/repo';
import type { Line, World } from './engine/types';
import { LEVELS, type Level } from './levels/levels';
import { EDITOR, fireEvents, isSolved, safeCheck, startLevel } from './levels/runtime';
import { renderGraph } from './ui/graph';
import { esc, renderRemote, renderTrees } from './ui/panels';
import { cmdHtml, complete, lineHtml, promptParts } from './ui/terminal';

// ───── persistence (per-viewer convenience only) ─────
const STORE_KEY = 'git-learn:completed';
function loadCompleted(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(STORE_KEY) ?? '[]'));
  } catch {
    return new Set();
  }
}
function saveCompleted(s: Set<string>) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify([...s]));
  } catch {
    /* storage unavailable: progress just isn't remembered */
  }
}

// ───── state ─────
interface State {
  level: Level;
  world: World;
  history: World[];
  fired: Set<string>;
  hintsShown: number;
  solved: boolean;
  showSolution: boolean;
  cmdHistory: string[];
  histPos: number;
}

const completed = loadCompleted();
let S: State;

// ───── DOM skeleton ─────
const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
<header class="top">
  <div class="logo"><span class="dot">⎇</span> git-learn</div>
  <div class="level-title" id="levelTitle"></div>
  <div class="toolbar">
    <button class="btn" id="rewindBtn" title="Undo the last command (simulator safety net)">⏪ Rewind</button>
    <button class="btn" id="restartBtn" title="Start this level over">↺ Restart</button>
    <button class="btn" id="hintBtn">💡 Hint</button>
    <button class="btn" id="solutionBtn">Show solution</button>
  </div>
</header>
<main class="layout">
  <section class="panel left">
    <nav class="levels" id="levels"></nav>
    <div class="brief" id="brief"></div>
  </section>
  <section class="panel terminal">
    <div class="panel-head"><div class="lights"><i></i><i></i><i></i></div><h3>terminal · sandbox</h3><span></span></div>
    <div class="term-body" id="termBody">
      <div id="termOut"></div>
      <div class="input-line"><span class="p" id="prompt"></span><input id="termInput" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Terminal input" /></div>
    </div>
    <div class="chips" id="chips"></div>
  </section>
  <aside class="right">
    <section class="panel">
      <div class="panel-head"><h3>Commit graph</h3><span class="tag" id="graphNote"></span></div>
      <div class="graph-wrap" id="graph"></div>
      <div class="legend">
        <span><i style="background:var(--accent)"></i>HEAD / branch</span>
        <span><i style="background:var(--warn-soft);border:1px solid var(--remote)"></i>origin/* (last fetch)</span>
        <span><i style="background:var(--bad-soft);border:1px solid var(--bad)"></i>only in reflog</span>
      </div>
    </section>
    <section class="panel">
      <div class="panel-head"><h3>The three trees</h3></div>
      <div class="scroll" id="trees"></div>
    </section>
    <section class="panel">
      <div class="panel-head"><h3>origin (the server)</h3></div>
      <div id="remote"></div>
    </section>
  </aside>
</main>`;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const termOut = $('termOut');
const termBody = $('termBody');
const input = $<HTMLInputElement>('termInput');

// ───── rendering ─────
function print(lines: Line[]) {
  termOut.insertAdjacentHTML('beforeend', lines.map(lineHtml).join(''));
}

function renderPrompt() {
  const { dir, branch } = promptParts(S.world);
  $('prompt').innerHTML = `you@laptop ${dir}${branch ? ` <span class="b">(${esc(branch)})</span>` : ''} %`;
}

function renderLevels() {
  let html = '';
  let chapter = '';
  LEVELS.forEach((l, i) => {
    if (l.chapter !== chapter) {
      chapter = l.chapter;
      html += `<div class="chapter">${esc(chapter)}</div>`;
    }
    html += `<button class="level-item ${l.id === S.level.id ? 'active' : ''}" data-i="${i}"><span class="tick">${completed.has(l.id) ? '✓' : i + 1}</span>${esc(l.title)}</button>`;
  });
  $('levels').innerHTML = html;
}

function renderBrief() {
  const l = S.level;
  const goals = l.goals.map((g) => {
    const done = safeCheck(g.check, S.world);
    return `<li class="${done ? 'done' : ''}"><span class="box">${done ? '✓' : ''}</span><span>${esc(g.text)}</span></li>`;
  });
  const hints = l.hints.slice(0, S.hintsShown).map((h, i) => `<div class="hint"><b>Hint ${i + 1}.</b> ${esc(h)}</div>`);
  const idx = LEVELS.indexOf(l);
  const next = LEVELS[idx + 1];
  $('brief').innerHTML = `
    <div class="chapter" style="margin:0 0 4px">${esc(l.chapter)} · level ${idx + 1}/${LEVELS.length}</div>
    <h2>${esc(l.title)}</h2>
    <div class="story">${l.story}</div>
    <h3 style="font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin:14px 0 0">Goals</h3>
    <ul class="goals">${goals.join('')}</ul>
    ${S.solved ? `<div class="win"><h4>🎉 Level complete</h4><p>${esc(l.lesson)}</p>${next ? `<button class="btn primary" id="nextBtn">Next: ${esc(next.title)} →</button>` : '<p><b>You finished every level!</b> More scenarios are coming.</p>'}</div>` : ''}
    <div class="hints">${hints.join('')}</div>
    ${S.showSolution ? `<div class="solution">${l.solution
      .map((c) => (c.startsWith(EDITOR) ? `✎ in the editor, save:\n${c.slice(EDITOR.length).replace(/^/gm, '    ')}` : '$ ' + c))
      .map(esc)
      .join('\n')}</div>` : ''}`;
  $('nextBtn')?.addEventListener('click', () => loadLevel(idx + 1));
  $<HTMLButtonElement>('hintBtn').disabled = S.hintsShown >= l.hints.length;
  $<HTMLButtonElement>('rewindBtn').disabled = S.history.length === 0;
  $('levelTitle').innerHTML = `<b>${esc(l.title)}</b> · ${esc(l.chapter)}`;
}

function renderState() {
  const g = $('graph');
  g.innerHTML = renderGraph(S.world);
  g.scrollLeft = g.scrollWidth;
  $('trees').innerHTML = renderTrees(S.world);
  $('remote').innerHTML = renderRemote(S.world);
  const op = S.world.repo?.op;
  $('graphNote').textContent = op ? `${op.kind} in progress` : '';
  renderPrompt();
  renderBrief();
}

function renderChips() {
  const chips = ['git status', 'git log --oneline --all', 'git reflog', 'git diff', 'hint', 'help'];
  $('chips').innerHTML = chips.map((c) => `<button class="chip" data-cmd="${esc(c)}">${esc(c)}</button>`).join('');
}

const scrollTerm = () => requestAnimationFrame(() => (termBody.scrollTop = termBody.scrollHeight));

// ───── actions ─────
function loadLevel(i: number) {
  const level = LEVELS[Math.max(0, Math.min(LEVELS.length - 1, i))];
  const { world, transcript } = startLevel(level);
  S = { level, world, history: [], fired: new Set(), hintsShown: 0, solved: false, showSolution: false, cmdHistory: S?.cmdHistory ?? [], histPos: -1 };
  try {
    history.replaceState(null, '', `#${level.id}`);
  } catch {
    /* ignore */
  }
  termOut.innerHTML = '';
  print([
    { kind: 'info', text: `Level ${i + 1}: ${level.title}` },
    { kind: 'info', text: 'This is a sandbox: nothing here touches your real files. ⏪ Rewind undoes any command, so go ahead and break things.' },
  ]);
  if (transcript.length) {
    print([{ kind: 'info', text: '── earlier, you typed: ──' }]);
    for (const t of transcript) {
      termOut.insertAdjacentHTML('beforeend', cmdHtml(t.cmd, t.before));
      print(t.lines);
    }
    print([{ kind: 'info', text: '── your turn ──' }]);
  }
  renderLevels();
  renderState();
  input.focus({ preventScroll: true });
  scrollTerm();
  openGitEditorIfWaiting();
}

function commitWorld(next: World) {
  S.history.push(S.world);
  if (S.history.length > 200) S.history.shift();
  S.world = next;
}

function afterChange(line: string) {
  // scripted teammate events
  const ev = fireEvents(S.level, S.world, line, S.fired);
  S.world = ev.world;
  print(ev.messages.map((text) => ({ kind: 'event', text })));
  if (!S.solved && isSolved(S.level, S.world)) {
    S.solved = true;
    completed.add(S.level.id);
    saveCompleted(completed);
    print([{ kind: 'success', text: '🎉 All goals complete! See the lesson on the left.' }]);
    renderLevels();
  }
  renderState();
  scrollTerm();
}

function runCommand(raw: string) {
  const line = raw.trim();
  termOut.insertAdjacentHTML('beforeend', cmdHtml(raw, S.world));
  if (!line) return scrollTerm();
  S.cmdHistory.push(line);
  S.histPos = -1;
  const res = runLine(S.world, line);
  print(res.lines);
  if (res.world !== S.world) commitWorld(res.world);
  for (const a of res.actions) {
    if (a.type === 'clear') termOut.innerHTML = '';
    if (a.type === 'hint') showHint();
    if (a.type === 'edit') openEditor(a.path);
  }
  afterChange(line);
  openGitEditorIfWaiting();
}

function showHint() {
  const l = S.level;
  if (S.hintsShown < l.hints.length) {
    S.hintsShown++;
    print([{ kind: 'hint', text: `hint ${S.hintsShown}: ${l.hints[S.hintsShown - 1]}` }]);
  } else print([{ kind: 'info', text: 'No more hints. Try "Show solution" at the top.' }]);
  renderBrief();
  scrollTerm();
}

function rewind() {
  const prev = S.history.pop();
  if (!prev) return;
  S.world = prev;
  print([{ kind: 'info', text: '⏪ Rewound one step. (This is the simulator\'s safety net. Real git has reflog, revert and --abort instead.)' }]);
  S.solved = isSolved(S.level, S.world);
  renderState();
  scrollTerm();
  openGitEditorIfWaiting();
}

// ───── editor modal ─────
let gitEditorOpen = false;

/** git (rebase -i, reword, squash, commit without -m) is waiting for $EDITOR: show it */
function openGitEditorIfWaiting() {
  const pe = S.world.repo?.pendingEdit;
  if (!pe || gitEditorOpen) return;
  gitEditorOpen = true;
  const isTodo = pe.purpose === 'todo';
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `<div class="modal" role="dialog" aria-label="Edit ${esc(pe.file)}">
    <div class="panel-head"><h3>nano · ${esc(pe.file)}</h3><span class="tag accent">git is waiting</span></div>
    ${
      isTodo
        ? `<div class="todo-help">Change <code>pick</code> to: <button class="chip" data-cmd="reword">reword</button><button class="chip" data-cmd="edit">edit</button><button class="chip" data-cmd="squash">squash</button><button class="chip" data-cmd="fixup">fixup</button><button class="chip" data-cmd="drop">drop</button><button class="chip" data-cmd="pick">pick</button> <span>(click a line first) · reorder by moving lines · runs top to bottom</span></div>`
        : `<div class="todo-help">Lines starting with <code>#</code> are ignored. An empty message aborts.</div>`
    }
    <textarea spellcheck="false"></textarea>
    <div class="foot"><span><kbd>Ctrl/⌘ S</kbd> save &amp; close · <kbd>Esc</kbd> close without changes</span><span><button class="btn" data-x="cancel">Close without changes</button> <button class="btn primary" data-x="save">Save &amp; close</button></span></div>
  </div>`;
  const ta = back.querySelector('textarea')!;
  ta.value = pe.text;
  const finish = (text: string) => {
    back.remove();
    gitEditorOpen = false;
    print([{ kind: 'info', text: `(editor closed: ${pe.file})` }]);
    const res = saveEditor(S.world, text);
    print(res.lines);
    if (res.world !== S.world) commitWorld(res.world);
    afterChange('(editor)');
    input.focus();
    openGitEditorIfWaiting();
  };
  /** replace the command word on the line under the cursor */
  const setCmd = (cmd: string) => {
    const pos = ta.selectionStart;
    const start = ta.value.lastIndexOf('\n', pos - 1) + 1;
    let end = ta.value.indexOf('\n', pos);
    if (end < 0) end = ta.value.length;
    const line = ta.value.slice(start, end);
    if (!line.trim() || line.startsWith('#')) return;
    const next = line.replace(/^\s*\S+/, cmd);
    ta.value = ta.value.slice(0, start) + next + ta.value.slice(end);
    // move to the next line so several lines can be changed quickly
    const after = ta.value.indexOf('\n', start) + 1 || ta.value.length;
    ta.focus();
    ta.setSelectionRange(after, after);
  };
  back.addEventListener('mousedown', (e) => {
    if ((e.target as HTMLElement).dataset.cmd) e.preventDefault(); // keep the textarea cursor
  });
  back.addEventListener('click', (e) => {
    const el = e.target as HTMLElement;
    if (el.dataset.cmd) setCmd(el.dataset.cmd);
    if (el.dataset.x === 'save') finish(ta.value);
    if (el.dataset.x === 'cancel') finish(pe.text);
  });
  ta.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      finish(ta.value);
    }
    if (e.key === 'Escape') finish(pe.text);
  });
  document.body.appendChild(back);
  ta.focus();
  ta.setSelectionRange(0, 0);
}

function openEditor(path: string) {
  const back = document.createElement('div');
  back.className = 'modal-back';
  const existing = S.world.files[path];
  back.innerHTML = `<div class="modal" role="dialog" aria-label="Edit ${esc(path)}">
    <div class="panel-head"><h3>nano · ${esc(path)}${existing === undefined ? ' (new file)' : ''}</h3><span class="tag accent">sandbox editor</span></div>
    <textarea spellcheck="false"></textarea>
    <div class="foot"><span><kbd>Ctrl/⌘ S</kbd> save · <kbd>Esc</kbd> cancel</span><span><button class="btn" data-x="cancel">Cancel</button> <button class="btn primary" data-x="save">Save</button></span></div>
  </div>`;
  const ta = back.querySelector('textarea')!;
  ta.value = existing ?? '';
  const close = () => {
    back.remove();
    input.focus();
  };
  const save = () => {
    let v = ta.value;
    if (v && !v.endsWith('\n')) v += '\n';
    if (v !== existing) {
      const w = clone(S.world);
      w.files[path] = v;
      commitWorld(w);
      print([{ kind: 'info', text: `(saved ${path})` }]);
      afterChange(`nano ${path}`);
    }
    close();
  };
  back.addEventListener('click', (e) => {
    const x = (e.target as HTMLElement).dataset.x;
    if (x === 'save') save();
    if (x === 'cancel' || e.target === back) close();
  });
  ta.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      save();
    }
    if (e.key === 'Escape') close();
  });
  document.body.appendChild(back);
  ta.focus();
}

// ───── wiring ─────
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const v = input.value;
    input.value = '';
    runCommand(v);
  } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    const h = S.cmdHistory;
    if (!h.length) return;
    e.preventDefault();
    if (e.key === 'ArrowUp') S.histPos = S.histPos < 0 ? h.length - 1 : Math.max(0, S.histPos - 1);
    else S.histPos = S.histPos < 0 ? -1 : S.histPos + 1 >= h.length ? -1 : S.histPos + 1;
    input.value = S.histPos < 0 ? '' : h[S.histPos];
  } else if (e.key === 'Tab') {
    e.preventDefault();
    const res = complete(input.value, S.world);
    input.value = res.line;
    if (res.options.length) {
      print([{ kind: 'info', text: res.options.join('   ') }]);
      scrollTerm();
    }
  } else if (e.key === 'l' && e.ctrlKey) {
    e.preventDefault();
    termOut.innerHTML = '';
  }
});
termBody.addEventListener('click', () => {
  if (!window.getSelection()?.toString()) input.focus();
});
$('levels').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-i]');
  if (b) loadLevel(Number(b.dataset.i));
});
$('chips').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-cmd]');
  if (b) runCommand(b.dataset.cmd!);
  input.focus();
});
$('rewindBtn').addEventListener('click', rewind);
$('restartBtn').addEventListener('click', () => loadLevel(LEVELS.indexOf(S.level)));
$('hintBtn').addEventListener('click', showHint);
$('solutionBtn').addEventListener('click', () => {
  S.showSolution = !S.showSolution;
  renderBrief();
});

window.addEventListener('hashchange', () => {
  const i = LEVELS.findIndex((l) => `#${l.id}` === location.hash);
  if (i >= 0 && LEVELS[i] !== S.level) loadLevel(i);
});

renderChips();
const fromHash = LEVELS.findIndex((l) => `#${l.id}` === location.hash);
loadLevel(fromHash >= 0 ? fromHash : Math.max(0, LEVELS.findIndex((l) => !completed.has(l.id))));
