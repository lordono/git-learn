import { finishEdit, runGit } from './git';
import { runTests } from './tests';
import { Ctx, GitError, clone, firstLine, pathsOf, plural, reachable, short } from './repo';
import type { Line, World } from './types';

export type ShellAction = { type: 'edit'; path: string } | { type: 'clear' } | { type: 'hint' };

export interface RunResult {
  world: World;
  lines: Line[];
  ok: boolean;
  actions: ShellAction[];
}

type Tok = { t: 'w'; v: string } | { t: 'op'; v: string };

export function tokenize(line: string): Tok[] {
  const toks: Tok[] = [];
  let cur = '';
  let inWord = false;
  const flush = () => {
    if (inWord) toks.push({ t: 'w', v: cur });
    cur = '';
    inWord = false;
  };
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === ' ' || ch === '\t') {
      flush();
      i++;
    } else if (ch === '&' && line[i + 1] === '&') {
      flush();
      toks.push({ t: 'op', v: '&&' });
      i += 2;
    } else if (ch === ';' || ch === '|') {
      flush();
      toks.push({ t: 'op', v: ch });
      i++;
    } else if (ch === '>') {
      flush();
      const op = line[i + 1] === '>' ? '>>' : '>';
      toks.push({ t: 'op', v: op });
      i += op.length;
    } else if (ch === "'") {
      const end = line.indexOf("'", i + 1);
      if (end < 0) throw new GitError("zsh: unmatched '");
      cur += line.slice(i + 1, end);
      inWord = true;
      i = end + 1;
    } else if (ch === '"') {
      let j = i + 1;
      while (j < line.length && line[j] !== '"') {
        if (line[j] === '\\' && j + 1 < line.length && '"\\$`'.includes(line[j + 1])) {
          cur += line[j + 1];
          j += 2;
        } else cur += line[j++];
      }
      if (j >= line.length) throw new GitError('zsh: unmatched "');
      inWord = true;
      i = j + 1;
    } else if (ch === '\\' && i + 1 < line.length) {
      cur += line[i + 1];
      inWord = true;
      i += 2;
    } else {
      cur += ch;
      inWord = true;
      i++;
    }
  }
  flush();
  return toks;
}

const EDITORS = new Set(['nano', 'vim', 'vi', 'code', 'edit', 'open', 'emacs']);

function runShell(c: Ctx, words: string[], actions: ShellAction[]) {
  const w = c.w;
  const [cmd, ...args] = words;
  switch (cmd) {
    case 'git':
      return runGit(c, args);
    case 'ls': {
      const all = args.includes('-a') || args.includes('-la') || args.includes('-al');
      const dir = args.find((x) => !x.startsWith('-'))?.replace(/\/$/, '');
      const names = new Set<string>();
      for (const p of Object.keys(w.files)) {
        if (dir) {
          if (!p.startsWith(dir + '/')) continue;
          const rest = p.slice(dir.length + 1);
          names.add(rest.includes('/') ? rest.split('/')[0] + '/' : rest);
        } else names.add(p.includes('/') ? p.split('/')[0] + '/' : p);
      }
      if (dir && !names.size) throw new GitError(`ls: ${dir}: No such file or directory`);
      const list = [...(all && w.repo && !dir ? ['.git/'] : []), ...[...names].sort()];
      if (list.length) c.out(list.join('   '));
      return;
    }
    case 'cat': {
      if (!args.length) throw new GitError('cat: missing file operand');
      for (const p of args) {
        if (!(p in w.files)) throw new GitError(`cat: ${p}: No such file or directory`);
        const text = w.files[p];
        for (const l of text.replace(/\n$/, '').split('\n')) c.print(/^(<{7}|={7}|>{7})/.test(l) ? 'hint' : 'out', l);
      }
      return;
    }
    case 'echo': {
      const noNl = args[0] === '-n';
      const text = (noNl ? args.slice(1) : args).join(' ').replace(/\\n/g, '\n').replace(/\\t/g, '\t');
      c.print('out', text + (noNl ? '' : '\n'));
      return;
    }
    case 'touch':
      for (const p of args) if (!(p in w.files)) w.files[p] = '';
      return;
    case 'rm': {
      const flags = args.filter((x) => x.startsWith('-')).join('');
      const recursive = flags.includes('r');
      const targets = args.filter((x) => !x.startsWith('-'));
      if (!targets.length) throw new GitError('usage: rm [-rf] file ...');
      for (const t of targets.map((x) => x.replace(/\/$/, ''))) {
        if (t === '.git') {
          if (!recursive) throw new GitError('rm: .git: is a directory');
          if (!w.repo) throw new GitError('rm: .git: No such file or directory');
          w.repo = null;
          c.warn('You deleted .git: every local commit, branch, stash and the reflog are gone. Only what was pushed to origin survives (you would re-clone). Use ⏪ Rewind to undo. Real life has no rewind button!');
          continue;
        }
        if (t in w.files) {
          delete w.files[t];
          continue;
        }
        const inDir = Object.keys(w.files).filter((p) => p.startsWith(t + '/'));
        if (inDir.length) {
          if (!recursive) throw new GitError(`rm: ${t}: is a directory`);
          inDir.forEach((p) => delete w.files[p]);
          continue;
        }
        if (!flags.includes('f')) throw new GitError(`rm: ${t}: No such file or directory`);
      }
      return;
    }
    case 'mv': {
      const [from, to] = args;
      if (!from || !to) throw new GitError('usage: mv source target');
      if (!(from in w.files)) throw new GitError(`mv: rename ${from} to ${to}: No such file or directory`);
      w.files[to] = w.files[from];
      delete w.files[from];
      return;
    }
    case 'pwd':
      c.out('/home/you/project');
      return;
    case 'cd':
      c.explain('This sandbox has a single project folder, so there is nowhere to cd to.');
      return;
    case 'clear':
      actions.push({ type: 'clear' });
      return;
    case 'hint':
      actions.push({ type: 'hint' });
      return;
    case 'npm': {
      if (args[0] !== 'test' && !(args[0] === 'run' && args[1] === 'test')) throw new GitError(`npm error the sandbox only knows "npm test"`);
      const t = runTests(c.w);
      t.lines.forEach((l) => l.text.split('\n').forEach((text) => c.print(l.kind, text)));
      if (!t.ok) c.ok = false;
      return;
    }
    case 'help':
      c.out('Shell: ls, cat <file>, echo "text" > file, echo "more" >> file, nano <file>, touch, rm, mv, clear, npm test, hint');
      c.out('Git:   git help, or git <command> -h');
      c.out('Tips:  ↑/↓ history · Tab completes · && chains commands');
      return;
    default:
      if (EDITORS.has(cmd)) {
        const p = args[0];
        if (!p) throw new GitError(`usage: ${cmd} <file>`);
        actions.push({ type: 'edit', path: p });
        return;
      }
      throw new GitError(`zsh: command not found: ${cmd}`);
  }
}

/** Committed or stashed content we can still reach (for "did we just lose work?" checks). */
function savedContents(w: World): Set<string> {
  const s = new Set<string>();
  for (const cm of Object.values(w.objects)) for (const v of Object.values(cm.tree)) s.add(v);
  for (const st of [...(w.repo?.stash ?? []), ...(w.repo?.lostStashes ?? [])]) {
    Object.values(st.worktree).forEach((v) => s.add(v));
    Object.values(st.index).forEach((v) => s.add(v));
  }
  return s;
}

function safetyNotes(before: World, after: World, c: Ctx) {
  if (!before.repo || !after.repo) return;
  // 1. uncommitted work thrown away?
  const saved = savedContents(after);
  const lostFiles: string[] = [];
  for (const p of pathsOf(before.files, before.repo.index)) {
    // a conflicted file's <<<<<<< markers can be regenerated, so replacing them isn't a loss
    if (before.repo.conflicts.includes(p)) continue;
    const candidates = [before.files[p], before.repo.index[p]].filter((v): v is string => v !== undefined);
    for (const v of candidates) {
      if (saved.has(v) || after.files[p] === v || after.repo.index[p] === v) continue;
      if (Object.values(after.files).includes(v)) continue;
      lostFiles.push(p);
      break;
    }
  }
  if (lostFiles.length) {
    c.warn(`Uncommitted changes in ${lostFiles.join(', ')} were thrown away. They were never committed or stashed, so not even reflog can bring them back.`);
  }
  // 2. commits that fell off every branch?
  const a = reachable(after);
  const lost = [...reachable(before)]
    .filter((id) => !a.has(id))
    .map((id) => after.objects[id])
    .sort((x, y) => y.seq - x.seq);
  if (lost.length) {
    const list = lost.slice(0, 3).map((cm) => `${short(cm.id)} "${firstLine(cm.message)}"`).join(', ');
    c.explain(`${plural(lost.length, 'commit')} no longer on any branch: ${list}${lost.length > 3 ? ', …' : ''}. Not deleted! git reflog lists them, and git branch <name> ${short(lost[0].id)} saves them.`);
  }
}

/** The learner saved (or closed) the editor git opened: hand the text back to git. Never throws. */
export function saveEditor(world: World, text: string): RunResult {
  const next = clone(world);
  const c = new Ctx(next);
  try {
    finishEdit(c, text);
    safetyNotes(world, next, c);
  } catch (e) {
    if (e instanceof GitError) e.lines.forEach((l) => c.err(l));
    else c.err(`simulator bug: ${(e as Error).message}`);
    return { world, lines: c.lines, ok: false, actions: [] };
  }
  const lines = c.lines.flatMap((l) => (l.kind === 'out' && l.text.includes('\n') ? l.text.split('\n').map((t) => ({ kind: 'out' as const, text: t })) : [l]));
  return { world: next, lines, ok: c.ok, actions: [] };
}

/** Run one line typed into the terminal. Never throws. */
export function runLine(world: World, line: string): RunResult {
  const lines: Line[] = [];
  const actions: ShellAction[] = [];
  let toks: Tok[];
  try {
    toks = tokenize(line);
  } catch (e) {
    return { world, lines: [{ kind: 'err', text: (e as GitError).message }], ok: false, actions };
  }
  // split into segments by && and ;
  type Seg = { words: string[]; redirect?: { path: string; append: boolean }; joiner: string };
  const segs: Seg[] = [];
  let cur: Seg = { words: [], joiner: '' };
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.t === 'w') cur.words.push(t.v);
    else if (t.v === '&&' || t.v === ';') {
      segs.push(cur);
      cur = { words: [], joiner: t.v };
    } else if (t.v === '|') {
      return { world, lines: [{ kind: 'err', text: 'zsh: pipes are not supported in this sandbox' }], ok: false, actions };
    } else {
      const next = toks[i + 1];
      if (!next || next.t !== 'w') return { world, lines: [{ kind: 'err', text: 'zsh: parse error near `\\n\'' }], ok: false, actions };
      cur.redirect = { path: next.v, append: t.v === '>>' };
      i++;
    }
  }
  segs.push(cur);

  let w = world;
  let ok = true;
  for (const seg of segs) {
    if (!seg.words.length) continue;
    if (seg.joiner === '&&' && !ok) break;
    const next = clone(w);
    const c = new Ctx(next);
    let segOk = true;
    try {
      runShell(c, seg.words, actions);
      segOk = c.ok;
      if (seg.words[0] === 'git') safetyNotes(w, next, c);
      w = next;
    } catch (e) {
      if (!(e instanceof GitError)) {
        console.error(e);
        c.err(`simulator bug: ${(e as Error).message}`);
      } else e.lines.forEach((l) => c.err(l));
      segOk = false;
    }
    if (seg.redirect) {
      const isData = (k: string) => k === 'out' || k.startsWith('diff');
      const text = c.lines.filter((l) => isData(l.kind)).map((l) => l.text.replace(/\n$/, '')).join('\n');
      const content = text === '' ? '' : text + '\n';
      const p = seg.redirect.path;
      if (segOk || c.lines.some((l) => isData(l.kind))) {
        w = w === next ? w : clone(w);
        w.files[p] = seg.redirect.append ? (w.files[p] ?? '') + content : content;
      }
      lines.push(...c.lines.filter((l) => !isData(l.kind)));
    } else {
      for (const l of c.lines) {
        if (l.kind === 'out' && l.text.includes('\n')) {
          l.text.replace(/\n$/, '').split('\n').forEach((t) => lines.push({ kind: 'out', text: t }));
        } else lines.push(l);
      }
    }
    ok = segOk;
  }
  return { world: w, lines, ok, actions };
}
