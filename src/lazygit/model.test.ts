import { describe, expect, it } from 'vitest';
import { LEVELS, type Level } from '../levels/levels';
import { fireEvents, isSolved, startLevel } from '../levels/runtime';
import type { World } from '../engine/types';
import { type Outcome, type Panel, type Pick, branchRows, commitRows, execStep, fileRows, hunkAt, onKey, resolveOutcome, stageLines, stagingOps, stashRows } from './model';

type Act = { panel: Panel; select?: string; key: string; answers?: string[] };

const labels = (w: World, p: Panel) =>
  p === 'files' ? fileRows(w).map((r) => r.path) : p === 'branches' ? branchRows(w).map((r) => r.name) : p === 'commits' ? commitRows(w).map((r) => r.message) : p === 'stash' ? stashRows(w).map((r) => r.message) : [''];

/** press keys like a learner: prompts get `answers` in order, confirms are accepted */
function drive(level: Level, acts: Act[], start?: World) {
  let w = start ?? startLevel(level).world;
  let copied: string[] = [];
  const fired = new Set<string>();
  const log: string[] = [];
  const errors: string[] = [];
  for (const act of acts) {
    const rows = labels(w, act.panel);
    const sel = act.select === undefined ? 0 : rows.findIndex((x) => x.includes(act.select!));
    if (sel < 0) throw new Error(`no row "${act.select}" in ${act.panel}: ${rows.join(' | ')}`);
    const answers = [...(act.answers ?? [])];
    let out: Outcome | undefined = onKey(w, { panel: act.panel, sel, copied }, act.key);
    while (out) {
      const o: Outcome = out;
      out = undefined;
      if (o.kind === 'run') {
        let ok = true;
        for (const s of o.steps) {
          const { res, label } = execStep(w, s);
          if (label) log.push(`$ ${label}`, ...res.lines.map((l) => `  ${l.text}`));
          w = fireEvents(level, res.world, label, fired).world;
          if (!res.ok) {
            ok = false;
            errors.push(label);
            break;
          }
        }
        if (ok && o.then) out = o.then(w);
      } else if (o.kind === 'prompt') out = o.then(answers.shift() ?? o.initial ?? '');
      else if (o.kind === 'confirm') out = o.then();
      else if (o.kind === 'menu') {
        const k = answers.shift();
        out = o.items.find((i) => i.key === k)!.then();
      }
      else if (o.kind === 'resolve') out = resolveOutcome(w, o.path, answers as Pick[]);
      else if (o.kind === 'stage') {
        const [mode, n] = (answers.shift() ?? 'hunk:0').split(':');
        const ops = stagingOps(w, o.path, 'unstaged');
        const starts = ops.map((x, i) => (x.t !== ' ' && (mode === 'line' || i === 0 || ops[i - 1].t === ' ') ? i : -1)).filter((i) => i >= 0);
        const at = starts[Number(n)];
        out = stageLines(w, o.path, 'unstaged', mode === 'hunk' ? hunkAt(ops, at) : [at]);
      } else if (o.kind === 'copy') copied = o.ids;
      else if (o.kind === 'error') errors.push(o.message);
    }
  }
  return { w, log: log.join('\n'), errors };
}

const byId = (id: string) => LEVELS.find((l) => l.id === id)!;
const SCRIPTS: Record<string, Act[]> = {
  'lg-staging': [
    { panel: 'files', select: 'app.js', key: 'space' },
    { panel: 'files', key: 'c', answers: ['Fix add()'] },
  ],
  'lg-stash': [
    { panel: 'files', key: 's', answers: ['multi-currency'] },
    { panel: 'files', key: 'p' },
    { panel: 'stash', key: 'g' },
  ],
  'lg-push-rejected': [
    { panel: 'files', key: 'P' },
    { panel: 'files', key: 'p' },
    { panel: 'files', key: 'P' },
  ],
  'lg-conflict': [
    { panel: 'files', key: 'p' },
    { panel: 'files', select: 'config.js', key: 'enter', answers: ['ours'] },
    { panel: 'files', key: 'P' },
  ],
  'lg-squash': [
    { panel: 'commits', select: 'fix typo', key: 'f' },
    { panel: 'commits', select: 'wip', key: 'f' },
    { panel: 'files', key: 'P' },
  ],
  'lg-reword': [{ panel: 'commits', select: 'asdf', key: 'r', answers: ['Apply coupons at checkout'] }],
  'lg-undo': [{ panel: 'files', key: 'z' }],
  'lg-partial': [
    { panel: 'files', select: 'cart.js', key: 'enter', answers: ['hunk:1'] },
    { panel: 'files', key: 'c', answers: ['Count item quantities in total'] },
  ],
  'lg-cherry-pick': [
    { panel: 'commits', select: 'Fix checkout crash', key: 'c' },
    { panel: 'branches', select: 'release/1.0', key: 'space' },
    { panel: 'commits', key: 'v' },
  ],
};

describe('lazygit tutorial levels can be solved with keys alone', () => {
  for (const level of LEVELS.filter((l) => l.chapter === 'lazygit')) {
    it(level.id, () => {
      const script = SCRIPTS[level.id];
      expect(script, `add a key script for ${level.id}`).toBeDefined();
      const { w, log } = drive(level, script);
      const failed = level.goals.filter((g) => !g.check(w)).map((g) => g.text);
      expect(failed, log).toEqual([]);
      expect(isSolved(level, w)).toBe(true);
    });
  }
});

describe('lazygit actions', () => {
  it('the first push asks for an upstream', () => {
    const { w, log } = drive(byId('first-push'), [{ panel: 'files', key: 'P', answers: ['origin search'] }]);
    expect(log).toContain('git push -u origin search');
    expect(w.repo!.upstream.search).toBe('origin/search');
  });
  it('a rejected push reports the error and does not force', () => {
    const { log, errors } = drive(byId('lg-push-rejected'), [{ panel: 'files', key: 'P' }]);
    expect(errors).toEqual(['git push']);
    expect(log.split('\n').filter((l) => l.startsWith('$ ') && l.includes('--force'))).toEqual([]);
  });
  it('squash into the root commit is refused with a clear message', () => {
    const { errors } = drive(byId('squash-wip'), [{ panel: 'commits', select: 'Initial commit', key: 's' }]);
    expect(errors[0]).toContain('no commit below');
  });
  it('drop, move and reset from the commits panel', () => {
    const drop = drive(byId('rebase-i-drop'), [{ panel: 'commits', select: 'TEMP', key: 'd' }]);
    expect(isSolved(byId('rebase-i-drop'), drop.w)).toBe(true);
    const moved = drive(byId('rebase-i-drop'), [{ panel: 'commits', select: 'Break score ties', key: 'ctrl+j' }]);
    expect(commitRows(moved.w).map((c) => c.message).slice(0, 2)).toEqual(['TEMP: debug logging (do not ship)', 'Break score ties by name']);
    const reset = drive(byId('squash-wip'), [{ panel: 'commits', select: 'Initial commit', key: 'g', answers: ['s'] }]);
    expect(reset.log).toContain('git reset --soft');
  });
  it('rewriting with a dirty working tree asks you to stash first', () => {
    const level = byId('rebase-i-drop');
    const dirty = startLevel(level).world;
    dirty.files['rank.js'] += '// wip\n';
    const { errors } = drive(level, [{ panel: 'commits', select: 'Rank results', key: 'r', answers: ['Rank by score'] }], dirty);
    expect(errors.join()).toContain('stash');
  });
  it('m offers continue/abort during a merge', () => {
    const { w } = drive(byId('lg-conflict'), [
      { panel: 'files', key: 'p' },
      { panel: 'files', key: 'm', answers: ['a'] },
    ]);
    expect(w.repo!.op).toBeUndefined();
  });

  it('z undoes step by step through the reflog, Z redoes', () => {
    const level = byId('lg-undo');
    const once = drive(level, [{ panel: 'files', key: 'z' }]);
    expect(once.log).toContain('git reset --hard');
    expect(once.w.repo!.reflog.at(-1)!.msg).toMatch(/^\[lazygit undo\]/);
    const twice = drive(level, [{ panel: 'files', key: 'z' }, { panel: 'files', key: 'z' }]);
    expect(commitRows(twice.w)[0].message).toBe('Add about page');
    const redone = drive(level, [{ panel: 'files', key: 'z' }, { panel: 'files', key: 'z' }, { panel: 'files', key: 'Z' }]);
    expect(commitRows(redone.w)[0].message).toBe('Add contact page');
  });
  it('z undoes a whole rebase at once', () => {
    const level = byId('rebase-i-drop');
    const start = startLevel(level).world;
    const dropped = drive(level, [{ panel: 'commits', select: 'TEMP', key: 'd' }]).w;
    const { w } = drive(level, [{ panel: 'files', key: 'z' }], dropped);
    expect(w.repo!.branches.ranking).toBe(start.repo!.branches.ranking);
  });
  it('z undoes a checkout by switching back', () => {
    const level = byId('hotfix');
    const moved = drive(level, [{ panel: 'branches', select: 'release/1.0', key: 'space' }]).w;
    const { w, log } = drive(level, [{ panel: 'files', key: 'z' }], moved);
    expect(log).toContain('git checkout main');
    expect(w.repo!.head).toEqual({ kind: 'branch', name: 'main' });
  });
  it('z refuses with uncommitted changes', () => {
    const level = byId('rebase-i-drop');
    const dirty = startLevel(level).world;
    dirty.files['rank.js'] += '// wip\n';
    const { errors } = drive(level, [{ panel: 'files', key: 'z' }], dirty);
    expect(errors.join()).toContain('uncommitted');
  });
  it('line staging stages one line, and unstaging puts it back', () => {
    const level = byId('lg-partial');
    const { w } = drive(level, [{ panel: 'files', select: 'cart.js', key: 'enter', answers: ['line:0'] }]);
    expect(w.repo!.index['cart.js']).toContain('DEBUG');
    expect(w.repo!.index['cart.js']).not.toContain('qty');
    const back = stageLines(w, 'cart.js', 'staged', [hunkAt(stagingOps(w, 'cart.js', 'staged'), 1)[0]]);
    expect(back.kind).toBe('run');
    if (back.kind === 'run') expect(execStep(w, back.steps[0]).res.world.repo!.index['cart.js']).not.toContain('DEBUG');
  });
  it('enter on a new file asks you to stage it whole', () => {
    const level = byId('staging');
    const w = startLevel(level).world;
    w.files['new.txt'] = 'x\n';
    const { errors } = drive(level, [{ panel: 'files', select: 'new.txt', key: 'enter' }], w);
    expect(errors[0]).toContain('new file');
  });
});

