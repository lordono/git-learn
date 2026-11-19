/**
 * A lazygit-style front end for the simulator.
 *
 * Every key press turns into the same git commands a learner could type
 * (shown in the command log), so lazygit mode teaches what lazygit does under the hood.
 * Key bindings follow lazygit's defaults.
 */
import { diffLines } from '../engine/merge';
import { ancestors, currentBranch, firstLine, headId, headTree, isAncestor, short } from '../engine/repo';
import { type RunResult, runLine, saveEditor } from '../engine/shell';
import type { Commit, Line, World } from '../engine/types';
import { computeStatus } from '../engine/worktree';

export type Panel = 'status' | 'files' | 'branches' | 'commits' | 'stash';
export const PANELS: Panel[] = ['status', 'files', 'branches', 'commits', 'stash'];

/** something lazygit runs: a git/shell command, an editor save, or writing a file (merge view) */
export type Step = string | { editor: string } | { editorKeep: true } | { write: string; text: string };

export type Outcome =
  | { kind: 'run'; steps: Step[]; then?: (w: World) => Outcome }
  | { kind: 'prompt'; title: string; initial?: string; then: (text: string) => Outcome }
  | { kind: 'confirm'; title: string; body: string; then: () => Outcome }
  | { kind: 'menu'; title: string; items: { key: string; label: string; then: () => Outcome }[] }
  | { kind: 'error'; message: string }
  | { kind: 'resolve'; path: string }
  | { kind: 'copy'; ids: string[] }
  | { kind: 'none' };

const q = (s: string) => (/^[\w./@{}~^:-]+$/.test(s) ? s : JSON.stringify(s));
const run = (...steps: Step[]): Outcome => ({ kind: 'run', steps });
const err = (message: string): Outcome => ({ kind: 'error', message });

// ───────────────────────────── rows shown in each panel ─────────────────────────────

export interface FileRow {
  path: string;
  /** two-letter status like `git status -s`: staged column, unstaged column */
  x: string;
  y: string;
  conflict: boolean;
  untracked: boolean;
  hasUnstaged: boolean;
}
export function fileRows(w: World): FileRow[] {
  if (!w.repo) return [];
  const st = computeStatus(w);
  const letter = (k: string) => (k === 'new file' ? 'A' : k === 'deleted' ? 'D' : 'M');
  const rows = new Map<string, FileRow>();
  const get = (path: string) => rows.get(path) ?? rows.set(path, { path, x: ' ', y: ' ', conflict: false, untracked: false, hasUnstaged: false }).get(path)!;
  for (const s of st.staged) get(s.path).x = letter(s.kind);
  for (const s of st.unstaged) Object.assign(get(s.path), { y: letter(s.kind), hasUnstaged: true });
  for (const p of st.untracked) Object.assign(get(p), { x: '?', y: '?', untracked: true, hasUnstaged: true });
  for (const p of st.conflicts) Object.assign(get(p), { x: 'U', y: 'U', conflict: true, hasUnstaged: true });
  return [...rows.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export interface BranchRow {
  name: string;
  current: boolean;
  upstream?: string;
  ahead: number;
  behind: number;
  gone: boolean;
}
const countOnly = (w: World, a: string, b: string) => {
  const ex = ancestors(w, b);
  return [...ancestors(w, a)].filter((id) => !ex.has(id)).length;
};
export function branchRows(w: World): BranchRow[] {
  const r = w.repo;
  if (!r) return [];
  const cur = currentBranch(w);
  return Object.keys(r.branches)
    .sort((a, b) => Number(b === cur) - Number(a === cur) || a.localeCompare(b))
    .map((name) => {
      const up = r.upstream[name];
      const tip = r.branches[name];
      const remote = up ? r.remoteBranches[up] : undefined;
      return { name, current: name === cur, upstream: up, gone: !!up && !remote, ahead: remote ? countOnly(w, tip, remote) : 0, behind: remote ? countOnly(w, remote, tip) : 0 };
    });
}

export interface CommitRow {
  id: string;
  message: string;
  author: string;
  pushed: boolean;
  merge: boolean;
}
export function commitRows(w: World, limit = 60): CommitRow[] {
  const h = headId(w);
  if (!h || !w.repo) return [];
  const remote = new Set<string>();
  for (const tip of Object.values(w.repo.remoteBranches)) for (const id of ancestors(w, tip)) remote.add(id);
  return [...ancestors(w, h)]
    .map((id) => w.objects[id])
    .sort((a, b) => b.seq - a.seq)
    .slice(0, limit)
    .map((c) => ({ id: c.id, message: firstLine(c.message), author: c.author, pushed: remote.has(c.id), merge: c.parents.length > 1 }));
}

export const stashRows = (w: World) => (w.repo?.stash ?? []).map((s, i) => ({ i, message: s.message }));

export function rowCount(w: World, p: Panel): number {
  return p === 'files' ? fileRows(w).length : p === 'branches' ? branchRows(w).length : p === 'commits' ? commitRows(w).length : p === 'stash' ? stashRows(w).length : 1;
}

// ───────────────────────────── the main (right-hand) view ─────────────────────────────

function fileDiff(a: string | undefined, b: string | undefined, title: string): Line[] {
  const out: Line[] = [{ kind: 'diff-meta', text: title }];
  if (a === b) return out;
  for (const d of diffLines(a ?? '', b ?? '')) {
    out.push({ kind: d.t === '+' ? 'diff-add' : d.t === '-' ? 'diff-del' : 'out', text: `${d.t === ' ' ? ' ' : d.t}${d.line}` });
  }
  return out;
}

export function mainView(w: World, panel: Panel, sel: number): { title: string; lines: Line[] } {
  const r = w.repo;
  if (!r) return { title: 'No repository', lines: [{ kind: 'out', text: 'There is no git repository here. Switch to the terminal and run git init.' }] };
  if (panel === 'files') {
    const f = fileRows(w)[sel];
    if (!f) return { title: 'Diff', lines: [{ kind: 'out', text: 'Working tree clean. Nothing to stage.' }] };
    const head = headTree(w)[f.path];
    if (f.conflict) return { title: `Merge conflict: ${f.path}`, lines: [{ kind: 'warn', text: 'Press enter to resolve this conflict hunk by hunk.' }, ...(w.files[f.path] ?? '').split('\n').map((text) => ({ kind: (text.startsWith('<<<<<<<') || text.startsWith('>>>>>>>') || text === '=======' ? 'hint' : 'out') as Line['kind'], text }))] };
    const lines: Line[] = [];
    if (f.x !== ' ' && !f.untracked) lines.push(...fileDiff(head, r.index[f.path], 'Staged changes (git diff --staged)'), { kind: 'out', text: '' });
    if (f.hasUnstaged) lines.push(...fileDiff(f.untracked ? undefined : r.index[f.path], w.files[f.path], f.untracked ? 'New file (untracked)' : 'Unstaged changes (git diff)'));
    return { title: `Diff: ${f.path}`, lines };
  }
  const show = (cmd: string) => runLine(w, cmd).lines.filter((l) => l.kind !== 'explain');
  if (panel === 'commits') {
    const c = commitRows(w)[sel];
    return c ? { title: `Commit ${short(c.id)}`, lines: show(`git show ${c.id}`) } : { title: 'Commits', lines: [{ kind: 'out', text: 'No commits yet.' }] };
  }
  if (panel === 'branches') {
    const b = branchRows(w)[sel];
    return b ? { title: `Log: ${b.name}`, lines: show(`git log --oneline -n 20 ${b.name}`) } : { title: 'Branches', lines: [] };
  }
  if (panel === 'stash') {
    const s = stashRows(w)[sel];
    return s ? { title: `stash@{${s.i}}`, lines: show(`git stash show stash@{${s.i}}`) } : { title: 'Stash', lines: [{ kind: 'out', text: 'No stash entries.' }] };
  }
  return { title: 'Status', lines: show('git status') };
}

// ───────────────────────────── conflicts (the merge view) ─────────────────────────────

export type Chunk = { kind: 'text'; lines: string[] } | { kind: 'conflict'; ours: string[]; theirs: string[]; oursLabel: string; theirsLabel: string };

export function parseConflicts(text: string): Chunk[] {
  const chunks: Chunk[] = [];
  let plain: string[] = [];
  let cur: Extract<Chunk, { kind: 'conflict' }> | null = null;
  let side: 'ours' | 'theirs' = 'ours';
  for (const line of text.replace(/\n$/, '').split('\n')) {
    if (line.startsWith('<<<<<<<') && !cur) {
      if (plain.length) chunks.push({ kind: 'text', lines: plain });
      plain = [];
      cur = { kind: 'conflict', ours: [], theirs: [], oursLabel: line.slice(8), theirsLabel: '' };
      side = 'ours';
    } else if (line === '=======' && cur) side = 'theirs';
    else if (line.startsWith('>>>>>>>') && cur) {
      cur.theirsLabel = line.slice(8);
      chunks.push(cur);
      cur = null;
    } else if (cur) cur[side].push(line);
    else plain.push(line);
  }
  if (plain.length) chunks.push({ kind: 'text', lines: plain });
  return chunks;
}

export type Pick = 'ours' | 'theirs' | 'both';

function continueOutcome(w: World): Outcome {
  const op = w.repo?.op;
  if (!op || w.repo!.conflicts.length) return { kind: 'none' };
  const cont: Step = op.kind === 'merge' ? 'git commit --no-edit' : `git ${op.kind} --continue`;
  return { kind: 'confirm', title: 'Continue', body: `All merge conflicts resolved. Continue the ${op.kind}? (lazygit runs: ${cont})`, then: () => run(cont, { editorKeep: true }) };
}

/** write the picked hunks, stage the file, and offer to continue */
export function resolveOutcome(w: World, path: string, picks: Pick[]): Outcome {
  const chunks = parseConflicts(w.files[path] ?? '');
  let i = 0;
  const out: string[] = [];
  for (const c of chunks) {
    if (c.kind === 'text') out.push(...c.lines);
    else {
      const p = picks[i++] ?? 'ours';
      if (p !== 'theirs') out.push(...c.ours);
      if (p !== 'ours') out.push(...c.theirs);
    }
  }
  return { kind: 'run', steps: [{ write: path, text: out.length ? out.join('\n') + '\n' : '' }, `git add ${q(path)}`], then: continueOutcome };
}

// ───────────────────────────── running steps ─────────────────────────────

export function execStep(w: World, step: Step): { res: RunResult; label: string } {
  if (typeof step === 'string') return { res: runLine(w, step), label: step };
  if ('write' in step) {
    const next = structuredClone(w);
    next.files[step.write] = step.text;
    return { res: { world: next, lines: [], ok: true, actions: [] }, label: `(merge view) wrote the resolved ${step.write}` };
  }
  const pe = w.repo?.pendingEdit;
  if ('editorKeep' in step) {
    if (!pe) return { res: { world: w, lines: [], ok: true, actions: [] }, label: '' };
    return { res: saveEditor(w, pe.text), label: `(editor) kept the suggested message for ${pe.file}` };
  }
  return { res: saveEditor(w, step.editor), label: `(editor) saved ${pe?.file ?? 'the editor'}: ${firstLine(step.editor)}${step.editor.trim().includes('\n') ? ' …' : ''}` };
}

// ───────────────────────────── key handling ─────────────────────────────

export interface Ctx {
  panel: Panel;
  sel: number;
  copied: string[];
}

const busy = (w: World): Outcome | null => {
  const op = w.repo?.op;
  if (!op) return null;
  return err(`A ${op.kind} is in progress. Press m to continue or abort it first.`);
};

/** rewrite history with an interactive rebase, like lazygit does behind the scenes */
function rewrite(w: World, base: string | undefined, edit: (todo: { cmd: string; id: string }[]) => void, after: Step[] = []): Outcome {
  if (!base) return err("That would rewrite the very first commit, which needs git rebase --root (not in the sandbox).");
  const b = busy(w);
  if (b) return b;
  const st = computeStatus(w);
  if (st.staged.length || st.unstaged.length) return err('You have uncommitted changes. (Real lazygit would --autostash them; here, stash them with s or commit first.)');
  const head = headId(w)!;
  const chain: Commit[] = [];
  for (let id: string | undefined = head; id && id !== base; id = w.objects[id].parents[0]) {
    if (w.objects[id].parents.length > 1) return err("Can't rewrite across a merge commit in the sandbox.");
    chain.push(w.objects[id]);
  }
  const todo = chain.reverse().map((c) => ({ cmd: 'pick', id: c.id }));
  edit(todo);
  const text = todo.map((t) => `${t.cmd} ${short(t.id)} ${firstLine(w.objects[t.id].message)}`).join('\n') + '\n';
  return run(`git rebase -i ${short(base)}`, { editor: text }, ...after);
}

export function onKey(w: World, ctx: Ctx, key: string): Outcome {
  const r = w.repo;
  if (!r) return err('No repository here. Use the terminal: git init');
  // global keys
  if (key === 'P') return push(w);
  if (key === 'p') {
    const br = currentBranch(w);
    if (!br || !r.upstream[br]) return err(`No upstream for ${br ?? 'detached HEAD'}. Push with P first, or set one in the branches panel (u).`);
    return busy(w) ?? run('git pull');
  }
  if (key === 'm') return opMenu(w);
  if (key === ':') return { kind: 'prompt', title: 'Shell command', then: (t) => (t.trim() ? run(t.trim()) : { kind: 'none' }) };
  switch (ctx.panel) {
    case 'files':
      return filesKey(w, ctx, key);
    case 'branches':
      return branchesKey(w, ctx, key);
    case 'commits':
      return commitsKey(w, ctx, key);
    case 'stash':
      return stashKey(w, ctx, key);
    default:
      return { kind: 'none' };
  }
}

function push(w: World): Outcome {
  const r = w.repo!;
  const br = currentBranch(w);
  if (!br) return err('You are on a detached HEAD: check out a branch first.');
  const up = r.upstream[br];
  if (!up) {
    return {
      kind: 'prompt',
      title: "Enter upstream as '<remote> <branchname>'",
      initial: `origin ${br}`,
      then: (t) => {
        const [rem, dst] = t.trim().split(/\s+/);
        if (!rem || !dst) return err('Expected something like: origin my-branch');
        return run(`git push -u ${rem} ${dst === br ? br : `${br}:${dst}`}`);
      },
    };
  }
  const remoteTip = r.remoteBranches[up];
  const local = r.branches[br];
  if (remoteTip && !isAncestor(w, remoteTip, local) && !isAncestor(w, local, remoteTip)) {
    return {
      kind: 'confirm',
      title: 'Force push',
      body: `Your branch has diverged from ${up}. Force push? lazygit uses git push --force-with-lease, which still refuses if someone pushed since your last fetch. Only do this on a branch nobody else uses.`,
      then: () => run('git push --force-with-lease'),
    };
  }
  return run('git push');
}

function opMenu(w: World): Outcome {
  const op = w.repo!.op;
  if (!op) return err('Nothing in progress: m is for continuing or aborting a merge / rebase / cherry-pick.');
  const k = op.kind;
  const items = [
    { key: 'c', label: `continue    git ${k === 'merge' ? 'commit --no-edit' : `${k} --continue`}`, then: () => run(k === 'merge' ? 'git commit --no-edit' : `git ${k} --continue`, { editorKeep: true }) },
    { key: 'a', label: `abort       git ${k} --abort`, then: () => run(`git ${k} --abort`) },
  ];
  if (k === 'rebase') items.push({ key: 's', label: 'skip        git rebase --skip', then: () => run('git rebase --skip') });
  return { kind: 'menu', title: `${k} options`, items };
}

function filesKey(w: World, ctx: Ctx, key: string): Outcome {
  const rows = fileRows(w);
  const f = rows[ctx.sel];
  const staged = rows.some((x) => x.x !== ' ' && !x.untracked && !x.conflict);
  switch (key) {
    case 'space':
      if (!f) return { kind: 'none' };
      if (f.conflict) return { kind: 'resolve', path: f.path };
      return f.hasUnstaged ? run(`git add ${q(f.path)}`) : run(`git restore --staged ${q(f.path)}`);
    case 'enter':
      if (f?.conflict) return { kind: 'resolve', path: f.path };
      return err('Staging single lines/hunks is not in the sandbox yet: space stages the whole file.');
    case 'a':
      return rows.some((x) => x.hasUnstaged) ? run('git add -A') : rows.length ? run('git reset') : { kind: 'none' };
    case 'c': {
      const commit: Outcome = { kind: 'prompt', title: 'Commit summary', then: (m) => (m.trim() ? run(`git commit -m ${JSON.stringify(m.trim())}`) : err('Empty commit message: nothing committed.')) };
      if (r(w).conflicts.length) return err('Resolve the merge conflicts first (enter on the UU file).');
      if (staged) return commit;
      if (!rows.length) return err('Nothing to commit.');
      return { kind: 'confirm', title: 'No files staged', body: 'You have not staged any files. Stage all files and commit? (git add -A)', then: () => ({ kind: 'run', steps: ['git add -A'], then: () => commit }) };
    }
    case 'A':
      if (!headId(w)) return err('There is no commit to amend yet.');
      return { kind: 'confirm', title: 'Amend last commit', body: `Add your staged changes to "${firstLine(w.objects[headId(w)!].message)}"? (git commit --amend --no-edit) Don't do this to a pushed commit.`, then: () => run('git commit --amend --no-edit') };
    case 'd':
      if (!f) return { kind: 'none' };
      if (f.conflict) return err('Resolve the conflict with enter instead.');
      return {
        kind: 'confirm',
        title: 'Discard changes',
        body: `Throw away ALL changes to ${f.path}? Uncommitted work can't be recovered.`,
        then: () => (f.untracked ? run(`rm ${q(f.path)}`) : f.x === 'A' ? run(`git rm -f ${q(f.path)}`) : run(`git restore --source=HEAD --staged --worktree ${q(f.path)}`)),
      };
    case 's':
      if (!rows.length) return err('Nothing to stash.');
      return { kind: 'prompt', title: 'Stash changes (name)', then: (m) => run(m.trim() ? `git stash push -m ${JSON.stringify(m.trim())}` : 'git stash') };
    case 'i':
      if (!f?.untracked) return err('Only untracked files can be ignored here.');
      return run(`echo ${q(f.path)} >> .gitignore`);
    case 'f':
      return run('git fetch');
    default:
      return { kind: 'none' };
  }
}
const r = (w: World) => w.repo!;

function branchesKey(w: World, ctx: Ctx, key: string): Outcome {
  const b = branchRows(w)[ctx.sel];
  const cur = currentBranch(w);
  if (!b && key !== 'n') return { kind: 'none' };
  switch (key) {
    case 'space':
      return b.current ? { kind: 'none' } : run(`git switch ${q(b.name)}`);
    case 'n':
      return { kind: 'prompt', title: `New branch name (branch is off of '${b?.name ?? 'HEAD'}')`, then: (n) => (n.trim() ? run(`git switch -c ${q(n.trim())}${b && !b.current ? ` ${q(b.name)}` : ''}`) : { kind: 'none' }) };
    case 'd': {
      if (b.current) return err('You cannot delete the checked out branch!');
      const h = headId(w)!;
      const tip = r(w).branches[b.name];
      const up = b.upstream && r(w).remoteBranches[b.upstream];
      const merged = isAncestor(w, tip, h) || (!!up && isAncestor(w, tip, up));
      return merged
        ? { kind: 'confirm', title: 'Delete branch', body: `Delete branch '${b.name}'? (git branch -d)`, then: () => run(`git branch -d ${q(b.name)}`) }
        : { kind: 'confirm', title: 'Force delete branch', body: `'${b.name}' is not fully merged. Force delete it? Its commits will only be reachable through the reflog. (git branch -D)`, then: () => run(`git branch -D ${q(b.name)}`) };
    }
    case 'M':
      if (b.current) return err('Select another branch to merge into the current one.');
      return busy(w) ?? { kind: 'confirm', title: 'Merge', body: `Merge '${b.name}' into '${cur}'? (git merge ${b.name})`, then: () => run(`git merge ${q(b.name)}`) };
    case 'r':
      if (b.current) return err('Select the branch to rebase the current branch onto.');
      return busy(w) ?? { kind: 'confirm', title: 'Rebase', body: `Rebase '${cur}' onto '${b.name}'? (git rebase ${b.name})`, then: () => run(`git rebase ${q(b.name)}`) };
    case 'R':
      return { kind: 'prompt', title: 'Rename branch', initial: b.name, then: (n) => (n.trim() && n.trim() !== b.name ? run(`git branch -m ${q(b.name)} ${q(n.trim())}`) : { kind: 'none' }) };
    case 'u': {
      const guess = `origin/${b.name}`;
      if (!(guess in r(w).remoteBranches)) return err(`There is no ${guess}. Fetch first (f in the files panel), or push the branch with P.`);
      return run(`git branch -u ${guess} ${q(b.name)}`);
    }
    case 'f':
      if (!b.upstream) return err(`'${b.name}' has no upstream to fast-forward from.`);
      return b.current ? run('git pull --ff-only') : run(`git branch -f ${q(b.name)} ${q(b.upstream)}`);
    default:
      return { kind: 'none' };
  }
}

function commitsKey(w: World, ctx: Ctx, key: string): Outcome {
  const rows = commitRows(w);
  const c = rows[ctx.sel];
  if (!c) return { kind: 'none' };
  const cm = w.objects[c.id];
  const parent = cm.parents[0];
  const grand = parent ? w.objects[parent].parents[0] : undefined;
  const isHead = c.id === headId(w);
  const set = (id: string, cmd: string) => (todo: { cmd: string; id: string }[]) => {
    const t = todo.find((x) => x.id === id);
    if (t) t.cmd = cmd;
  };
  switch (key) {
    case 's':
    case 'f':
      if (!parent) return err('There is no commit below this one to squash into.');
      return {
        kind: 'confirm',
        title: key === 's' ? 'Squash' : 'Fixup',
        body: key === 's' ? `Squash "${c.message}" into the commit below it, keeping both messages?` : `Fold "${c.message}" into the commit below it, keeping only that commit's message?`,
        then: () => rewrite(w, grand, set(c.id, key === 's' ? 'squash' : 'fixup'), [{ editorKeep: true }]),
      };
    case 'd':
      return { kind: 'confirm', title: 'Drop commit', body: `Remove "${c.message}" from history? (Its changes disappear from this branch.)`, then: () => rewrite(w, parent, set(c.id, 'drop')) };
    case 'e':
      return rewrite(w, parent, set(c.id, 'edit'));
    case 'r':
      return {
        kind: 'prompt',
        title: 'Reword commit',
        initial: cm.message,
        then: (m) => {
          const msg = m.trim();
          if (!msg || msg === cm.message) return { kind: 'none' };
          if (isHead) return computeStatus(w).staged.length ? err('You have staged changes; amending now would add them. Unstage or commit them first.') : run(`git commit --amend -m ${JSON.stringify(msg)}`);
          return rewrite(w, parent, set(c.id, 'reword'), [{ editor: msg + '\n' }]);
        },
      };
    case 'ctrl+j': // move down (older)
      if (!parent) return err('Already the oldest commit.');
      return rewrite(w, grand, (todo) => {
        const i = todo.findIndex((t) => t.id === c.id);
        [todo[i - 1], todo[i]] = [todo[i], todo[i - 1]];
      });
    case 'ctrl+k': {
      // move up (newer)
      if (isHead) return err('Already the newest commit.');
      return rewrite(w, parent, (todo) => {
        const i = todo.findIndex((t) => t.id === c.id);
        [todo[i + 1], todo[i]] = [todo[i], todo[i + 1]];
      });
    }
    case 't':
      return { kind: 'confirm', title: 'Revert commit', body: `Add a new commit that undoes "${c.message}"? Safe on shared branches.`, then: () => run(`git revert ${c.merge ? '-m 1 ' : ''}${short(c.id)}`) };
    case 'g':
      return {
        kind: 'menu',
        title: `Reset ${currentBranch(w) ?? 'HEAD'} to ${short(c.id)}`,
        items: (['soft', 'mixed', 'hard'] as const).map((m, i) => ({
          key: 'smh'[i],
          label: `${m.padEnd(6)} ${m === 'soft' ? 'keep changes staged' : m === 'mixed' ? 'keep changes unstaged' : 'DISCARD all changes ⚠️'}`,
          then: () => run(`git reset --${m} ${short(c.id)}`),
        })),
      };
    case 'space':
      return run(`git checkout ${short(c.id)}`);
    case 'T':
      return { kind: 'prompt', title: `Tag ${short(c.id)}`, then: (n) => (n.trim() ? run(`git tag ${q(n.trim())} ${short(c.id)}`) : { kind: 'none' }) };
    case 'c':
      return { kind: 'copy', ids: ctx.copied.includes(c.id) ? ctx.copied.filter((x) => x !== c.id) : [...ctx.copied, c.id] };
    case 'v': {
      if (!ctx.copied.length) return err('Nothing copied. Press c on commits first (in any branch), then v here.');
      const ids = [...ctx.copied].sort((a, b) => w.objects[a].seq - w.objects[b].seq);
      return { kind: 'confirm', title: 'Cherry-pick', body: `Paste ${ids.length} copied commit(s) onto '${currentBranch(w) ?? 'HEAD'}'? (git cherry-pick)`, then: () => run(...ids.map((id) => `git cherry-pick ${short(id)}`)) };
    }
    case 'A':
      if (!isHead) return err('The sandbox can only amend the latest commit (select the top one).');
      return { kind: 'confirm', title: 'Amend commit', body: 'Add your staged changes to this commit? (git commit --amend --no-edit)', then: () => run('git commit --amend --no-edit') };
    default:
      return { kind: 'none' };
  }
}

function stashKey(w: World, ctx: Ctx, key: string): Outcome {
  const s = stashRows(w)[ctx.sel];
  if (!s) return { kind: 'none' };
  const ref = `stash@{${s.i}}`;
  if (key === 'space') return run(`git stash apply ${ref}`);
  if (key === 'g') return run(`git stash pop ${ref}`);
  if (key === 'd') return { kind: 'confirm', title: 'Drop stash', body: `Drop ${ref} "${s.message}"?`, then: () => run(`git stash drop ${ref}`) };
  return { kind: 'none' };
}

/** the key hints shown at the bottom (and in the ? help) for a panel */
export const KEYS: Record<Panel | 'global', [string, string][]> = {
  global: [['p', 'pull'], ['P', 'push'], ['m', 'merge/rebase options'], [':', 'shell command'], ['1-5', 'jump to panel'], ['?', 'keybindings']],
  status: [],
  files: [['space', 'stage/unstage'], ['a', 'stage all'], ['c', 'commit'], ['A', 'amend'], ['d', 'discard'], ['s', 'stash'], ['i', 'ignore'], ['f', 'fetch'], ['enter', 'resolve conflict']],
  branches: [['space', 'checkout'], ['n', 'new branch'], ['M', 'merge into current'], ['r', 'rebase onto'], ['d', 'delete'], ['R', 'rename'], ['u', 'set upstream'], ['f', 'fast-forward']],
  commits: [['s', 'squash down'], ['f', 'fixup'], ['r', 'reword'], ['d', 'drop'], ['e', 'edit'], ['ctrl+j/k', 'move'], ['t', 'revert'], ['g', 'reset'], ['c', 'copy'], ['v', 'paste'], ['T', 'tag'], ['space', 'checkout']],
  stash: [['space', 'apply'], ['g', 'pop'], ['d', 'drop']],
};
