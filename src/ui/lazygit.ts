import { currentBranch, short } from '../engine/repo';
import type { Line, World } from '../engine/types';
import {
  KEYS,
  PANELS,
  type Chunk,
  type Outcome,
  type Panel,
  type Pick,
  type Step,
  branchRows,
  commitRows,
  fileRows,
  mainView,
  onKey,
  parseConflicts,
  resolveOutcome,
  rowCount,
  stageLines,
  stagingOps,
  hunkAt,
  stashRows,
} from '../lazygit/model';
import { esc } from './panels';

export interface LogEntry {
  text: string;
  kind: 'cmd' | 'err' | 'event';
}

/** what the app does for the view: run steps through the normal pipeline (history, events, goals) */
export interface LazyHost {
  world(): World;
  run(steps: Step[]): { ok: boolean; log: LogEntry[]; errLines: Line[] };
}

type Popup =
  | { kind: 'prompt'; title: string; value: string; then: (t: string) => Outcome }
  | { kind: 'confirm'; title: string; body: string; then: () => Outcome }
  | { kind: 'menu'; title: string; items: { key: string; label: string; then: () => Outcome }[]; sel: number }
  | { kind: 'error'; title: string; lines: Line[] }
  | { kind: 'resolve'; path: string; chunks: Chunk[]; picks: (Pick | null)[]; cur: number; side: 'ours' | 'theirs' }
  | { kind: 'help' }
  | { kind: 'stage'; path: string; side: 'unstaged' | 'staged'; cur: number; hunk: boolean };

const TITLES: Record<Panel, string> = { status: 'Status', files: 'Files', branches: 'Local branches', commits: 'Commits', stash: 'Stash' };

export class LazyGitView {
  panel: Panel = 'files';
  sel: Record<Panel, number> = { status: 0, files: 0, branches: 0, commits: 0, stash: 0 };
  copied: string[] = [];
  popup: Popup | null = null;
  log: LogEntry[] = [];

  constructor(
    public root: HTMLElement,
    private host: LazyHost,
  ) {
    root.tabIndex = 0;
    root.addEventListener('keydown', (e) => this.onKeyDown(e));
    root.addEventListener('click', (e) => this.onClick(e));
  }

  reset() {
    this.panel = 'files';
    this.sel = { status: 0, files: 0, branches: 0, commits: 0, stash: 0 };
    this.copied = [];
    this.popup = null;
    this.log = [{ text: 'lazygit mode: every key runs real git commands. They show up here.', kind: 'event' }];
  }

  focus() {
    this.root.focus({ preventScroll: true });
  }

  // ───── rendering ─────

  render() {
    const w = this.host.world();
    for (const p of PANELS) this.sel[p] = Math.max(0, Math.min(this.sel[p], rowCount(w, p) - 1));
    const box = (p: Panel, n: number, body: string) =>
      `<section class="lg-box lg-${p} ${this.panel === p ? 'on' : ''}" data-panel="${p}"><h4>[${n}] ${TITLES[p]}</h4><div class="lg-list">${body || '<div class="lg-empty">empty</div>'}</div></section>`;
    const row = (p: Panel, i: number, html: string) => `<div class="lg-row ${this.sel[p] === i && this.panel === p ? 'sel' : this.sel[p] === i ? 'sel-dim' : ''}" data-panel="${p}" data-i="${i}">${html}</div>`;

    const r = w.repo;
    const br = r ? currentBranch(w) ?? `(HEAD detached at ${short(r.head.kind === 'detached' ? r.head.id : '')})` : '(no repo)';
    const me = branchRows(w).find((b) => b.current);
    const op = r?.op ? ` <span class="lg-warn">(${r.op.kind === 'rebase' ? 'rebasing' : r.op.kind === 'merge' ? 'merging' : r.op.kind + 'ing'})</span>` : '';
    const status = `<div class="lg-row">${me?.upstream ? `<span class="lg-dim">${me.ahead ? `↑${me.ahead}` : ''}${me.behind ? `↓${me.behind}` : ''}${!me.ahead && !me.behind ? '✓' : ''}</span> ` : ''}project → <b>${esc(br)}</b>${op}</div>`;

    const files = fileRows(w)
      .map((f, i) => row('files', i, `<span class="${f.conflict ? 'lg-red' : f.x !== ' ' && !f.untracked ? 'lg-green' : 'lg-red'}">${esc(f.x)}</span><span class="lg-red">${esc(f.y)}</span> ${esc(f.path)}`))
      .join('');
    const branches = branchRows(w)
      .map((b, i) => row('branches', i, `${b.current ? '<span class="lg-green">*</span> ' : '  '}<span class="${b.current ? 'lg-green' : ''}">${esc(b.name)}</span>${b.upstream ? ` <span class="lg-dim">${b.gone ? 'upstream gone' : `${b.ahead ? `↑${b.ahead}` : ''}${b.behind ? `↓${b.behind}` : ''}${!b.ahead && !b.behind ? '✓' : ''}`}</span>` : ''}`))
      .join('');
    const commits = commitRows(w)
      .map((c, i) => {
        const initials = c.author.split(/\s+/).map((x) => x[0]).join('').slice(0, 2).toUpperCase();
        const copied = this.copied.includes(c.id);
        return row('commits', i, `<span class="${copied ? 'lg-cyan' : c.pushed ? 'lg-yellow' : 'lg-red'}" title="${c.pushed ? 'pushed' : 'not pushed yet'}">${short(c.id)}</span> <span class="lg-dim">${esc(initials)}</span> ${copied ? '<span class="lg-cyan">✂ </span>' : ''}${esc(c.message)}`);
      })
      .join('');
    const stash = stashRows(w)
      .map((s, i) => row('stash', i, `<span class="lg-dim">${s.i}</span> ${esc(s.message)}`))
      .join('');

    const main = mainView(w, this.panel, this.sel[this.panel]);
    const keys = [...KEYS[this.panel], ...KEYS.global];

    this.root.innerHTML = `
      <div class="lg-grid">
        <div class="lg-side">
          ${box('status', 1, status)}${box('files', 2, files)}${box('branches', 3, branches)}${box('commits', 4, commits)}${box('stash', 5, stash)}
        </div>
        <div class="lg-mainc">
          <section class="lg-box lg-main"><h4>${esc(main.title)}</h4><div class="lg-list lg-pre">${main.lines.map((l) => `<div class="k-${l.kind}">${esc(l.text) || '&nbsp;'}</div>`).join('')}</div></section>
          <section class="lg-box lg-log"><h4>Command log</h4><div class="lg-list lg-pre">${this.log
            .slice(-40)
            .map((e) => `<div class="lg-log-${e.kind}">${e.kind === 'cmd' ? '<span class="lg-dim">❯</span> ' : ''}${esc(e.text)}</div>`)
            .join('')}</div></section>
        </div>
      </div>
      <div class="lg-keys">${keys.map(([k, what]) => `<button class="lg-key" data-key="${esc(k === 'ctrl+j/k' ? 'ctrl+j' : k === '1-5' ? '' : k)}"><b>${esc(k)}</b> ${esc(what)}</button>`).join('')}</div>
      ${this.popup ? `<div class="lg-pop-back">${this.popupHtml()}</div>` : ''}`;
    this.root.querySelectorAll<HTMLElement>('.lg-row.sel, .lg-row.sel-dim').forEach((el) => el.scrollIntoView({ block: 'nearest' }));
    const logEl = this.root.querySelector('.lg-log .lg-list');
    if (logEl) logEl.scrollTop = logEl.scrollHeight;
    const inp = this.root.querySelector<HTMLInputElement>('.lg-pop input');
    if (inp) {
      inp.focus();
      inp.setSelectionRange(inp.value.length, inp.value.length);
    }
  }

  private popupHtml(): string {
    const p = this.popup!;
    const foot = (s: string) => `<div class="lg-pop-foot">${s}</div>`;
    switch (p.kind) {
      case 'prompt':
        return `<div class="lg-pop"><h4>${esc(p.title)}</h4><input class="lg-input" value="${esc(p.value)}" spellcheck="false" />${foot('<kbd>enter</kbd> confirm · <kbd>esc</kbd> cancel')}</div>`;
      case 'confirm':
        return `<div class="lg-pop"><h4>${esc(p.title)}</h4><p>${esc(p.body)}</p>${foot('<button class="lg-key" data-pop="yes"><b>enter</b> confirm</button> <button class="lg-key" data-pop="no"><b>esc</b> cancel</button>')}</div>`;
      case 'menu':
        return `<div class="lg-pop"><h4>${esc(p.title)}</h4>${p.items.map((it, i) => `<div class="lg-row ${i === p.sel ? 'sel' : ''}" data-item="${i}"><b class="lg-cyan">${esc(it.key)}</b> ${esc(it.label)}</div>`).join('')}${foot('<kbd>enter</kbd> or the key · <kbd>esc</kbd> cancel')}</div>`;
      case 'error':
        return `<div class="lg-pop lg-pop-err"><h4>${esc(p.title)}</h4><div class="lg-pre">${p.lines.map((l) => `<div class="k-${l.kind}">${esc(l.text) || '&nbsp;'}</div>`).join('')}</div>${foot('<button class="lg-key" data-pop="no"><b>esc</b> close</button>')}</div>`;
      case 'help':
        return `<div class="lg-pop"><h4>Keybindings</h4><div class="lg-pre">${(['global', 'files', 'branches', 'commits', 'stash'] as const)
          .map((sec) => `<div class="lg-cyan">${sec}</div>${KEYS[sec].map(([k, what]) => `<div>  <b>${esc(k.padEnd(9))}</b> ${esc(what)}</div>`).join('')}`)
          .join('')}<div class="lg-cyan">moving</div><div>  <b>j k ↑ ↓  </b> move · <b>tab h l</b> switch panel · <b>esc</b> close</div></div>${foot('<button class="lg-key" data-pop="no"><b>esc</b> close</button>')}</div>`;
      case 'stage': {
        const w = this.host.world();
        const pane = (side: 'unstaged' | 'staged') => {
          const ops = stagingOps(w, p.path, side);
          const on = p.side === side;
          const marked = on ? new Set(p.hunk ? hunkAt(ops, p.cur) : [p.cur]) : new Set<number>();
          const body = ops.some((o) => o.t !== ' ')
            ? ops
                .map((o, i) => `<div class="lg-sl ${o.t === '+' ? 'k-diff-add' : o.t === '-' ? 'k-diff-del' : 'lg-dim'} ${marked.has(i) ? 'pick' : ''}">${o.t}${esc(o.line) || '&nbsp;'}</div>`)
                .join('')
            : '<div class="lg-empty">no changes</div>';
          return `<div class="lg-stage-pane ${on ? 'on' : ''}" data-side="${side}"><div class="lg-hunk-label">${side === 'unstaged' ? 'Unstaged changes' : 'Staged changes'}</div><div class="lg-pre">${body}</div></div>`;
        };
        return `<div class="lg-pop lg-pop-wide"><h4>Staging: ${esc(p.path)} · selecting ${p.hunk ? 'whole hunks' : 'single lines'}</h4><div class="lg-stage">${pane('unstaged')}${pane('staged')}</div>${foot(
          `<button class="lg-key" data-st="space"><b>space</b> ${p.side === 'unstaged' ? 'stage' : 'unstage'} ${p.hunk ? 'hunk' : 'line'}</button> <button class="lg-key" data-st="a"><b>a</b> toggle line / hunk</button> <button class="lg-key" data-st="tab"><b>tab</b> switch side</button> <button class="lg-key" data-st="j"><b>j k</b> move</button> <button class="lg-key" data-pop="no"><b>esc</b> back</button>`,
        )}</div>`;
      }
      case 'resolve': {
        let n = -1;
        const body = p.chunks
          .map((c) => {
            if (c.kind === 'text') return c.lines.map((l) => `<div class="lg-dim">${esc(l) || '&nbsp;'}</div>`).join('');
            n++;
            const i = n;
            const pick = p.picks[i];
            const active = i === p.cur;
            const side = (s: 'ours' | 'theirs', lines: string[], label: string) => {
              const chosen = pick === s || pick === 'both';
              const dropped = pick && !chosen;
              return `<div class="lg-hunk ${active && p.side === s && !pick ? 'focus' : ''} ${chosen ? 'chosen' : ''} ${dropped ? 'dropped' : ''}"><div class="lg-hunk-label">${s === 'ours' ? '◀' : '▶'} ${esc(label)} ${chosen ? '✓' : ''}</div>${lines.map((l) => `<div>${esc(l) || '&nbsp;'}</div>`).join('')}</div>`;
            };
            return `<div class="lg-conflict ${active ? 'active' : ''}">${side('ours', c.ours, c.oursLabel + ' (ours)')}${side('theirs', c.theirs, c.theirsLabel + ' (theirs)')}</div>`;
          })
          .join('');
        return `<div class="lg-pop lg-pop-wide"><h4>Merge conflicts: ${esc(p.path)} (${p.picks.filter((x) => x).length}/${p.picks.length} picked)</h4><div class="lg-pre">${body}</div>${foot(
          '<button class="lg-key" data-res="ours"><b>←</b> ours</button> <button class="lg-key" data-res="theirs"><b>→</b> theirs</button> <button class="lg-key" data-res="pick"><b>space</b> pick</button> <button class="lg-key" data-res="both"><b>b</b> both</button> <button class="lg-key" data-pop="no"><b>esc</b> close</button>',
        )}</div>`;
      }
    }
  }

  // ───── input ─────

  private onClick(e: MouseEvent) {
    const t = e.target as HTMLElement;
    const pop = t.closest<HTMLElement>('[data-pop]')?.dataset.pop;
    if (pop) return this.popKey(pop === 'yes' ? 'enter' : 'escape');
    const item = t.closest<HTMLElement>('[data-item]')?.dataset.item;
    if (item !== undefined && this.popup?.kind === 'menu') {
      this.popup.sel = Number(item);
      return this.popKey('enter');
    }
    const st = t.closest<HTMLElement>('[data-st]')?.dataset.st;
    if (st) return this.popKey(st === 'space' ? ' ' : st);
    const sideEl = t.closest<HTMLElement>('[data-side]');
    if (sideEl && this.popup?.kind === 'stage' && this.popup.side !== sideEl.dataset.side) return this.popKey('tab');
    const res = t.closest<HTMLElement>('[data-res]')?.dataset.res;
    if (res) return this.popKey(res === 'ours' ? 'arrowleft' : res === 'theirs' ? 'arrowright' : res === 'pick' ? ' ' : 'b');
    if (this.popup) return;
    const key = t.closest<HTMLElement>('[data-key]')?.dataset.key;
    if (key !== undefined) {
      if (key === '?') this.popup = { kind: 'help' };
      else if (key) this.press(key);
      this.render();
      return this.focus();
    }
    const rowEl = t.closest<HTMLElement>('.lg-row[data-i]');
    const boxEl = t.closest<HTMLElement>('[data-panel]');
    if (boxEl) this.panel = boxEl.dataset.panel as Panel;
    if (rowEl) this.sel[this.panel] = Number(rowEl.dataset.i);
    this.render();
    this.focus();
  }

  private onKeyDown(e: KeyboardEvent) {
    const k = e.key.length === 1 ? e.key : e.key.toLowerCase();
    if (this.popup) {
      if (this.popup.kind === 'prompt' && k !== 'enter' && k !== 'escape') {
        // typing in the prompt input
        this.popup.value = (e.target as HTMLInputElement).value ?? this.popup.value;
        return;
      }
      e.preventDefault();
      this.popKey(k, e);
      return;
    }
    if (e.metaKey || e.altKey) return;
    let handled = true;
    const n = rowCount(this.host.world(), this.panel);
    if (/^[1-5]$/.test(k)) this.panel = PANELS[Number(k) - 1];
    else if (k === 'tab' || k === 'l' || k === 'arrowright' || k === 'h' || k === 'arrowleft') {
      const back = (k === 'tab' && e.shiftKey) || k === 'h' || k === 'arrowleft';
      this.panel = PANELS[(PANELS.indexOf(this.panel) + (back ? 4 : 1)) % 5];
    } else if ((k === 'j' && !e.ctrlKey) || k === 'arrowdown') this.sel[this.panel] = Math.min(n - 1, this.sel[this.panel] + 1);
    else if ((k === 'k' && !e.ctrlKey) || k === 'arrowup') this.sel[this.panel] = Math.max(0, this.sel[this.panel] - 1);
    else if (k === '?') this.popup = { kind: 'help' };
    else if (e.ctrlKey && (k === 'j' || k === 'k')) this.press(`ctrl+${k}`);
    else if (e.ctrlKey) handled = false;
    else if (k === ' ') this.press('space');
    else if (k === 'enter') this.press('enter');
    else if (k.length === 1) this.press(k);
    else handled = false;
    if (handled) {
      e.preventDefault();
      this.render();
    }
  }

  private press(key: string) {
    const w = this.host.world();
    this.handle(onKey(w, { panel: this.panel, sel: this.sel[this.panel], copied: this.copied }, key));
  }

  private popKey(k: string, e?: KeyboardEvent) {
    const p = this.popup!;
    if (k === 'escape' || k === 'esc' || k === 'q') {
      this.popup = null;
      this.render();
      return this.focus();
    }
    if (p.kind === 'prompt' && k === 'enter') {
      const v = this.root.querySelector<HTMLInputElement>('.lg-pop input')?.value ?? p.value;
      this.popup = null;
      this.handle(p.then(v));
    } else if (p.kind === 'confirm' && (k === 'enter' || k === 'y')) {
      this.popup = null;
      this.handle(p.then());
    } else if (p.kind === 'menu') {
      const byKey = p.items.findIndex((it) => it.key === k);
      if (k === 'j' || k === 'arrowdown') p.sel = Math.min(p.items.length - 1, p.sel + 1);
      else if (k === 'k' || k === 'arrowup') p.sel = Math.max(0, p.sel - 1);
      else if (k === 'enter' || byKey >= 0) {
        const it = p.items[byKey >= 0 ? byKey : p.sel];
        this.popup = null;
        this.handle(it.then());
      }
    } else if (p.kind === 'resolve') {
      if (k === 'arrowleft' || k === 'h') p.side = 'ours';
      else if (k === 'arrowright' || k === 'l') p.side = 'theirs';
      else if (k === 'arrowdown' || k === 'j') p.cur = Math.min(p.picks.length - 1, p.cur + 1);
      else if (k === 'arrowup' || k === 'k') p.cur = Math.max(0, p.cur - 1);
      else if (k === ' ' || k === 'b') {
        p.picks[p.cur] = k === 'b' ? 'both' : p.side;
        const next = p.picks.findIndex((x) => !x);
        if (next < 0) {
          this.popup = null;
          this.handle(resolveOutcome(this.host.world(), p.path, p.picks as Pick[]));
          return this.focus();
        }
        p.cur = next;
      }
    } else if (p.kind === 'stage') {
      const w = this.host.world();
      const ops = stagingOps(w, p.path, p.side);
      const changes = ops.map((o, i) => (o.t === ' ' ? -1 : i)).filter((i) => i >= 0);
      const step = (dir: 1 | -1) => {
        // move to the next change line (or the next hunk in hunk mode)
        const skip = p.hunk ? hunkAt(ops, p.cur) : [p.cur];
        const from = dir > 0 ? Math.max(...skip) : Math.min(...skip);
        const next = dir > 0 ? changes.find((i) => i > from) : [...changes].reverse().find((i) => i < from);
        if (next !== undefined) p.cur = next;
      };
      if (k === 'j' || k === 'arrowdown') step(1);
      else if (k === 'k' || k === 'arrowup') step(-1);
      else if (k === 'a') p.hunk = !p.hunk;
      else if (k === 'tab' || k === 'arrowleft' || k === 'arrowright' || k === 'h' || k === 'l') {
        p.side = p.side === 'unstaged' ? 'staged' : 'unstaged';
        p.cur = stagingOps(w, p.path, p.side).findIndex((o) => o.t !== ' ');
      } else if (k === ' ' || k === 'enter') {
        const picked = p.hunk ? hunkAt(ops, p.cur) : [p.cur];
        this.handle(stageLines(w, p.path, p.side, picked));
        if (this.popup !== p) return;
        const after = stagingOps(this.host.world(), p.path, p.side);
        const left = after.map((o, i) => (o.t === ' ' ? -1 : i)).filter((i) => i >= 0);
        if (!left.length) {
          const other = p.side === 'unstaged' ? 'staged' : 'unstaged';
          if (!stagingOps(this.host.world(), p.path, other).some((o) => o.t !== ' ')) this.popup = null;
          else {
            p.side = other;
            p.cur = stagingOps(this.host.world(), p.path, other).findIndex((o) => o.t !== ' ');
          }
        } else p.cur = left.find((i) => i >= p.cur) ?? left[left.length - 1];
      }
    } else if ((p.kind === 'error' || p.kind === 'help') && k === 'enter') this.popup = null;
    e?.preventDefault();
    this.render();
    this.focus();
  }

  /** act on what a key press asked for */
  handle(o: Outcome): void {
    switch (o.kind) {
      case 'run': {
        const res = this.host.run(o.steps);
        this.log.push(...res.log);
        if (!res.ok) {
          const shown = res.errLines.filter((l) => l.kind !== 'cmd');
          this.popup = { kind: 'error', title: 'Error', lines: shown.length ? shown : [{ kind: 'err', text: 'The command failed.' }] };
        } else if (o.then) return this.handle(o.then(this.host.world()));
        break;
      }
      case 'prompt':
        this.popup = { kind: 'prompt', title: o.title, value: o.initial ?? '', then: o.then };
        break;
      case 'confirm':
        this.popup = { kind: 'confirm', title: o.title, body: o.body, then: o.then };
        break;
      case 'menu':
        this.popup = { kind: 'menu', title: o.title, items: o.items, sel: 0 };
        break;
      case 'error':
        this.popup = { kind: 'error', title: 'Hmm', lines: [{ kind: 'err', text: o.message }] };
        break;
      case 'resolve': {
        const chunks = parseConflicts(this.host.world().files[o.path] ?? '');
        const n = chunks.filter((c) => c.kind === 'conflict').length;
        if (!n) {
          this.popup = { kind: 'error', title: 'No markers', lines: [{ kind: 'out', text: `${o.path} has no <<<<<<< markers left. Stage it with space.` }] };
          break;
        }
        this.popup = { kind: 'resolve', path: o.path, chunks, picks: new Array(n).fill(null), cur: 0, side: 'ours' };
        break;
      }
      case 'stage': {
        const w = this.host.world();
        const side = stagingOps(w, o.path, 'unstaged').some((x) => x.t !== ' ') ? 'unstaged' : 'staged';
        this.popup = { kind: 'stage', path: o.path, side, cur: stagingOps(w, o.path, side).findIndex((x) => x.t !== ' '), hunk: false };
        break;
      }
      case 'copy':
        this.copied = o.ids;
        this.log.push({ kind: 'event', text: `copied ${o.ids.length} commit(s) for cherry-pick: go to another branch and press v` });
        break;
      case 'none':
        break;
    }
    this.render();
    this.focus();
  }
}
