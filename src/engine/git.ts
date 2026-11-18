import { COMMAND_DOCS } from './docs';
import { diffLines, hasConflictMarkers, merge3, mergeTrees } from './merge';
import {
  Ctx,
  GitError,
  ancestors,
  cfg,
  createCommit,
  currentBranch,
  decorations,
  exclusive,
  firstLine,
  formatDate,
  headId,
  headTree,
  identity,
  isAncestor,
  makeId,
  mergeBase,
  moveHead,
  newRepo,
  pathsOf,
  plural,
  resolveRev,
  sameTree,
  short,
  treeOf,
  tryResolve,
} from './repo';
import type { Commit, FileMap, RemoteRepo, World } from './types';
import { carryTo, computeStatus, hardReset, ignoreMatcher, matchPaths, statLines } from './worktree';

// ───────────────────────────── argument helper ─────────────────────────────

export class Args {
  constructor(public rest: string[]) {}
  flag(...names: string[]): boolean {
    let found = false;
    this.rest = this.rest.filter((a) => {
      if (names.includes(a)) {
        found = true;
        return false;
      }
      return true;
    });
    return found;
  }
  opt(...names: string[]): string | undefined {
    for (let i = 0; i < this.rest.length; i++) {
      const a = this.rest[i];
      for (const n of names) {
        if (a === n) {
          const v = this.rest[i + 1];
          if (v === undefined) throw new GitError(`error: option \`${n.replace(/^-+/, '')}' requires a value`);
          this.rest.splice(i, 2);
          return v;
        }
        if (n.startsWith('--') && a.startsWith(n + '=')) {
          this.rest.splice(i, 1);
          return a.slice(n.length + 1);
        }
      }
    }
    return undefined;
  }
  opts(...names: string[]): string[] {
    const r: string[] = [];
    let v: string | undefined;
    while ((v = this.opt(...names)) !== undefined) r.push(v);
    return r;
  }
  dashdash(): string[] | null {
    const i = this.rest.indexOf('--');
    if (i < 0) return null;
    const after = this.rest.slice(i + 1);
    this.rest = this.rest.slice(0, i);
    return after;
  }
  noUnknownFlags(cmd: string) {
    const bad = this.rest.find((a) => a.startsWith('-') && a !== '-');
    if (bad) {
      throw new GitError(
        `error: unknown option \`${bad.replace(/^-+/, '')}'`,
        `hint: the simulator supports a subset of flags. Try: git ${cmd} -h`,
      );
    }
  }
}

// ───────────────────────────── shared helpers ─────────────────────────────

const R = (c: Ctx) => c.repo;

function needHead(c: Ctx): string {
  const h = headId(c.w);
  if (!h) {
    throw new GitError(
      `fatal: your current branch '${currentBranch(c.w) ?? 'HEAD'}' does not have any commits yet`,
    );
  }
  return h;
}

function validateBranchName(name: string) {
  if (!name || /[\s~^:?*[\\]|\.\.|^-|\/$|\.lock$|@\{/.test(name) || name === 'HEAD') {
    throw new GitError(`fatal: '${name}' is not a valid branch name`);
  }
}

function trackingLines(w: World, branch: string): string[] {
  const r = w.repo!;
  const up = r.upstream[branch];
  if (!up) return [];
  const tip = r.branches[branch];
  const ut = r.remoteBranches[up];
  if (!ut) return [`Your branch is based on '${up}', but the upstream is gone.`, '  (use "git branch --unset-upstream" to fixup)'];
  if (!tip) return [];
  const ahead = exclusive(w, tip, ut).length;
  const behind = exclusive(w, ut, tip).length;
  if (!ahead && !behind) return [`Your branch is up to date with '${up}'.`];
  if (ahead && !behind) return [`Your branch is ahead of '${up}' by ${plural(ahead, 'commit')}.`, '  (use "git push" to publish your local commits)'];
  if (!ahead && behind) return [`Your branch is behind '${up}' by ${plural(behind, 'commit')}, and can be fast-forwarded.`, '  (use "git pull" to update your local branch)'];
  return [
    `Your branch and '${up}' have diverged,`,
    `and have ${ahead} and ${behind} different commits each, respectively.`,
    '  (use "git pull" if you want to integrate the remote branch with yours)',
  ];
}

/** The simulator "knows" what's on the server; nudge when local info is stale. */
function staleNote(c: Ctx, branch: string) {
  const r = R(c);
  const up = r.upstream[branch];
  if (!up || !c.w.remote) return;
  const [remoteName] = up.split('/');
  if (r.remotes[remoteName] !== c.w.remote.url) return;
  const real = c.w.remote.branches[up.slice(remoteName.length + 1)];
  if (real && real !== r.remoteBranches[up]) {
    c.explain(`Psst: origin has new commits you haven't fetched. Status only compares with your LAST fetch. Try git fetch.`);
  }
}

function getRemote(c: Ctx, name = 'origin'): RemoteRepo {
  const url = R(c).remotes[name];
  if (!url) {
    throw new GitError(
      `fatal: '${name}' does not appear to be a git repository`,
      'fatal: Could not read from remote repository.',
      '',
      'Please make sure you have the correct access rights',
      'and the repository exists.',
    );
  }
  const rem = c.w.remote;
  if (!rem || rem.url !== url) throw new GitError(`fatal: repository '${url}' not found`);
  return rem;
}

function guardOp(c: Ctx) {
  const r = R(c);
  if (!r.op && !r.conflicts.length) return;
  if (r.op?.kind === 'rebase') {
    throw new GitError(
      'fatal: cannot switch branch while rebasing',
      'Consider "git rebase --quit" or "git worktree add".',
      'hint: finish the rebase (git rebase --continue) or cancel it (git rebase --abort) first',
    );
  }
  if (r.conflicts.length) {
    throw new GitError('error: you need to resolve your current index first', ...r.conflicts.map((p) => `${p}: needs merge`));
  }
  throw new GitError('fatal: You have not concluded your merge (MERGE_HEAD exists).', 'hint: commit it (git commit) or cancel it (git merge --abort) first');
}

function applyMergeResult(w: World, ours: FileMap, theirs: FileMap, res: { tree: FileMap; conflicts: string[] }) {
  const r = w.repo!;
  for (const p of pathsOf(ours, res.tree)) {
    const v = res.tree[p];
    if (v === undefined) {
      delete r.index[p];
      delete w.files[p];
      continue;
    }
    w.files[p] = v;
    r.index[p] = res.conflicts.includes(p) ? (ours[p] ?? theirs[p]) : v;
  }
}

function blockIfDirtyPaths(c: Ctx, paths: string[], opName: string) {
  const st = computeStatus(c.w);
  const dirty = new Set([...st.staged, ...st.unstaged].map((s) => s.path));
  const blocked = paths.filter((p) => dirty.has(p));
  if (blocked.length) {
    throw new GitError(
      `error: Your local changes to the following files would be overwritten by ${opName}:`,
      ...blocked.map((p) => `\t${p}`),
      `Please commit your changes or stash them before you ${opName}.`,
      'Aborting',
    );
  }
}

function conflictExplain(c: Ctx, cont: string, abort: string) {
  c.explain(
    `Conflict! Open the file (cat or nano <file>), keep the lines you want and delete the <<<<<<< ======= >>>>>>> markers. Then git add <file> and ${cont}. Want out? ${abort} puts everything back.`,
  );
}

function fastForward(c: Ctx, target: string, reflogMsg: string) {
  const w = c.w;
  const head = needHead(c);
  const before = headTree(w);
  carryTo(w, treeOf(w, target), 'merge', 'merge');
  moveHead(w, target, reflogMsg);
  c.out(`Updating ${short(head)}..${short(target)}`);
  c.out('Fast-forward');
  statLines(before, treeOf(w, target)).forEach((l) => c.out(l));
}

function doMerge(c: Ctx, theirs: string, message: string, theirsLabel: string) {
  const w = c.w;
  const r = R(c);
  const head = needHead(c);
  const base = mergeBase(w, head, theirs);
  const ours = headTree(w);
  const th = treeOf(w, theirs);
  const res = mergeTrees(treeOf(w, base), ours, th, 'HEAD', theirsLabel);
  blockIfDirtyPaths(c, pathsOf(ours, res.tree).filter((p) => ours[p] !== res.tree[p]), 'merge');
  const untrackedHit = Object.keys(res.tree).filter((p) => !(p in ours) && !(p in r.index) && p in w.files && w.files[p] !== res.tree[p]);
  if (untrackedHit.length) {
    throw new GitError('error: The following untracked working tree files would be overwritten by merge:', ...untrackedHit.map((p) => `\t${p}`), 'Please move or remove them before you merge.', 'Aborting');
  }
  r.origHead = head;
  applyMergeResult(w, ours, th, res);
  if (res.conflicts.length) {
    for (const p of res.conflicts) {
      c.out(`Auto-merging ${p}`);
      c.out(`CONFLICT (content): Merge conflict in ${p}`);
    }
    c.out('Automatic merge failed; fix conflicts and then commit the result.');
    r.op = { kind: 'merge', theirs, message, origHead: head };
    r.conflicts = res.conflicts;
    c.ok = false;
    conflictExplain(c, 'git commit', 'git merge --abort');
    return;
  }
  const id = createCommit(w, { parents: [head, theirs], message, tree: res.tree });
  moveHead(w, id, `merge ${theirsLabel}: Merge made by the 'ort' strategy.`);
  c.out("Merge made by the 'ort' strategy.");
  statLines(ours, res.tree).forEach((l) => c.out(l));
  c.explain(`Both sides had new commits, so git made a merge commit (${short(id)}) with two parents. History now shows both lines of work joining.`);
}

// ───────────────────────────── commands ─────────────────────────────

function init(c: Ctx, a: Args) {
  const branch = a.opt('-b', '--initial-branch');
  a.noUnknownFlags('init');
  if (c.w.repo) {
    c.out('Reinitialized existing Git repository in ~/project/.git/');
    return;
  }
  c.w.repo = newRepo(branch ?? cfg(c.w, 'init.defaultbranch') ?? 'main');
  c.out('Initialized empty Git repository in ~/project/.git/');
  c.explain('A hidden .git folder now holds all history. Your files are untracked until you git add them.');
}

function config(c: Ctx, a: Args) {
  const global = a.flag('--global');
  a.flag('--local');
  const list = a.flag('--list', '-l');
  const unset = a.flag('--unset');
  a.flag('--get');
  a.noUnknownFlags('config');
  const store = global ? c.w.globalConfig : R(c).config;
  const where = global ? '~/.gitconfig (global: every repo on this machine)' : '.git/config (this repo only)';
  if (list) {
    const merged = { ...c.w.globalConfig, ...(c.w.repo?.config ?? {}) };
    const src = global ? c.w.globalConfig : merged;
    const entries = Object.entries(src);
    if (!entries.length) c.explain('No settings yet.');
    entries.forEach(([k, v]) => c.out(`${k}=${v}`));
    return;
  }
  const [key, ...vals] = a.rest;
  if (!key) throw new GitError('error: missing key', 'usage: git config [--global] <key> [<value>]');
  if (!key.includes('.')) throw new GitError(`error: key does not contain a section: ${key}`);
  const k = key.toLowerCase();
  if (unset) {
    delete store[k];
    return;
  }
  if (!vals.length) {
    const v = global ? c.w.globalConfig[k] : cfg(c.w, k);
    if (v === undefined) c.ok = false;
    else c.out(v);
    return;
  }
  store[k] = vals.join(' ');
  c.explain(`Saved ${k} = "${store[k]}" in ${where}.`);
}

function status(c: Ctx, a: Args) {
  const shortFmt = a.flag('-s', '--short');
  a.noUnknownFlags('status');
  const w = c.w;
  const r = R(c);
  const st = computeStatus(w);
  if (shortFmt) {
    const rows = new Map<string, [string, string]>();
    for (const s of st.staged) rows.set(s.path, [s.kind === 'new file' ? 'A' : s.kind === 'deleted' ? 'D' : 'M', ' ']);
    for (const s of st.unstaged) rows.set(s.path, [rows.get(s.path)?.[0] ?? ' ', s.kind === 'deleted' ? 'D' : 'M']);
    for (const p of st.conflicts) rows.set(p, ['U', 'U']);
    for (const [p, [x, y]] of [...rows].sort()) c.out(`${x}${y} ${p}`);
    for (const p of st.untracked) c.out(`?? ${p}`);
    return;
  }
  const br = currentBranch(w);
  const op = r.op;
  if (op?.kind === 'rebase') {
    c.out(`rebase in progress; onto ${short(op.onto)}`);
    c.out(`You are currently rebasing${op.branch ? ` branch '${op.branch}'` : ''} on '${short(op.onto)}'.`);
    c.out(st.conflicts.length ? '  (fix conflicts and then run "git rebase --continue")' : '  (all conflicts fixed: run "git rebase --continue")');
    c.out('  (use "git rebase --skip" to skip this patch)');
    c.out('  (use "git rebase --abort" to check out the original branch)');
    c.out('');
  } else if (br) {
    c.out(`On branch ${br}`);
    trackingLines(w, br).forEach((l) => c.out(l));
  } else {
    c.out(`HEAD detached at ${short(headId(w)!)}`);
  }
  if (!headId(w)) c.out('\nNo commits yet');
  if (op?.kind === 'merge') {
    if (st.conflicts.length) c.out('\nYou have unmerged paths.\n  (fix conflicts and run "git commit")\n  (use "git merge --abort" to abort the merge)');
    else c.out('\nAll conflicts fixed but you are still merging.\n  (use "git commit" to conclude merge)');
  } else if (op?.kind === 'cherry-pick' || op?.kind === 'revert') {
    c.out(`\nYou are currently ${op.kind === 'revert' ? 'reverting' : 'cherry-picking'} commit ${short(op.commit)}.`);
    c.out(st.conflicts.length ? `  (fix conflicts and run "git ${op.kind} --continue")` : `  (all conflicts fixed: run "git ${op.kind} --continue")`);
    c.out(`  (use "git ${op.kind} --abort" to cancel the ${op.kind} operation)`);
  }
  if (st.staged.length) {
    c.out('\nChanges to be committed:\n  (use "git restore --staged <file>..." to unstage)');
    st.staged.forEach((s) => c.print('diff-add', `\t${(s.kind + ':').padEnd(12)}${s.path}`));
  }
  if (st.conflicts.length) {
    c.out('\nUnmerged paths:\n  (use "git add <file>..." to mark resolution)');
    st.conflicts.forEach((p) => c.print('diff-del', `\tboth modified:   ${p}`));
  }
  if (st.unstaged.length) {
    c.out('\nChanges not staged for commit:\n  (use "git add <file>..." to update what will be committed)\n  (use "git restore <file>..." to discard changes in working directory)');
    st.unstaged.forEach((s) => c.print('diff-del', `\t${(s.kind + ':').padEnd(12)}${s.path}`));
  }
  if (st.untracked.length) {
    c.out('\nUntracked files:\n  (use "git add <file>..." to include in what will be committed)');
    st.untracked.forEach((p) => c.print('diff-del', `\t${p}`));
  }
  if (!st.staged.length && !st.unstaged.length && !st.conflicts.length) {
    if (st.untracked.length) c.out('\nnothing added to commit but untracked files present (use "git add" to track)');
    else if (!headId(w)) c.out('\nnothing to commit (create/copy files and use "git add" to track)');
    else c.out('\nnothing to commit, working tree clean');
  } else if (!st.staged.length && !op) {
    c.out('\nno changes added to commit (use "git add" and/or "git commit -a")');
  }
  if (br) staleNote(c, br);
}

function add(c: Ctx, a: Args) {
  const all = a.flag('-A', '--all');
  const update = a.flag('-u', '--update');
  const forceAdd = a.flag('-f', '--force');
  a.flag('-v');
  a.noUnknownFlags('add');
  const w = c.w;
  const r = R(c);
  let specs = a.rest;
  if (!specs.length && (all || update)) specs = ['.'];
  if (!specs.length) throw new GitError('Nothing specified, nothing added.', "hint: Maybe you wanted to say 'git add .'?");
  const ignored = ignoreMatcher(w);
  const explicitIgnored = specs.filter((s) => !forceAdd && s in w.files && !(s in r.index) && ignored(s));
  if (explicitIgnored.length) {
    throw new GitError('The following paths are ignored by one of your .gitignore files:', ...explicitIgnored, 'hint: Use -f if you really want to add them.');
  }
  const universe = update ? pathsOf(r.index) : pathsOf(w.files, r.index).filter((p) => forceAdd || p in r.index || !ignored(p));
  const paths = matchPaths(specs, universe, (s) => new GitError(`fatal: pathspec '${s}' did not match any files`));
  for (const p of paths) {
    if (p in w.files) r.index[p] = w.files[p];
    else delete r.index[p];
    if (r.conflicts.includes(p)) {
      r.conflicts = r.conflicts.filter((x) => x !== p);
      if (hasConflictMarkers(w.files[p])) c.warn(`${p} still contains conflict markers (<<<<<<< ======= >>>>>>>). Git lets you add it anyway, so double-check before committing!`);
      else c.explain(`Marked ${p} as resolved.`);
    }
  }
}

function rm(c: Ctx, a: Args) {
  const cached = a.flag('--cached');
  a.flag('-r', '-f', '-rf');
  a.noUnknownFlags('rm');
  const w = c.w;
  const r = R(c);
  if (!a.rest.length) throw new GitError('usage: git rm [--cached] <file>...');
  const paths = matchPaths(a.rest, pathsOf(r.index), (s) => new GitError(`fatal: pathspec '${s}' did not match any files`));
  for (const p of paths) {
    delete r.index[p];
    if (!cached) delete w.files[p];
    c.out(`rm '${p}'`);
  }
  if (cached) c.explain('Removed from the staging area only: the file is still on disk, now untracked. Add it to .gitignore so it does not get re-added.');
}

function commit(c: Ctx, a: Args) {
  const w = c.w;
  const r = R(c);
  const msgs = a.opts('-m', '--message');
  const all = a.flag('-a', '--all');
  const amend = a.flag('--amend');
  a.flag('--no-edit');
  const allowEmpty = a.flag('--allow-empty');
  a.noUnknownFlags('commit');
  if (a.rest.length) {
    throw new GitError(`error: the simulator doesn't support 'git commit <path>'.`, 'hint: stage with git add <path>, then git commit -m "..."');
  }
  if (r.conflicts.length) {
    throw new GitError(
      'error: Committing is not possible because you have unmerged files.',
      "hint: Fix them up in the work tree, and then use 'git add/rm <file>'",
      'hint: as appropriate to mark resolution and make a commit.',
      'fatal: Exiting because of an unresolved conflict.',
    );
  }
  if (all) for (const p of Object.keys(r.index)) {
    if (p in w.files) r.index[p] = w.files[p];
    else delete r.index[p];
  }
  const head = headId(w);
  const op = r.op;
  let message = msgs.join('\n\n');
  let parents: string[];
  if (amend) {
    if (!head) throw new GitError('fatal: You have nothing to amend.');
    if (op && op.kind !== 'rebase') throw new GitError('fatal: You are in the middle of a merge -- cannot amend.');
    parents = w.objects[head].parents;
    if (!message) message = w.objects[head].message;
  } else if (op?.kind === 'merge') {
    parents = [head!, op.theirs];
    message ||= op.message;
  } else if (op?.kind === 'cherry-pick' || op?.kind === 'revert') {
    parents = [head!];
    message ||= op.message;
  } else parents = head ? [head] : [];
  if (!message) {
    throw new GitError('error: no commit message given (the simulator has no text editor)', 'hint: git commit -m "describe what you changed"');
  }
  if (!amend && !allowEmpty && op?.kind !== 'merge' && sameTree(r.index, headTree(w))) {
    const st = computeStatus(w);
    const br = currentBranch(w);
    if (br) c.out(`On branch ${br}`);
    if (st.unstaged.length || st.untracked.length) {
      c.out('no changes added to commit (use "git add" and/or "git commit -a")');
      c.explain('Nothing is staged. git commit only saves what is in the staging area. Use git add <file> first.');
    } else c.out('nothing to commit, working tree clean');
    c.ok = false;
    return;
  }
  const id = createCommit(w, { parents, message, tree: r.index });
  const kind = amend ? 'commit (amend)' : op?.kind === 'merge' ? 'commit (merge)' : !head ? 'commit (initial)' : 'commit';
  moveHead(w, id, `${kind}: ${firstLine(message)}`);
  if (op && op.kind !== 'rebase') r.op = undefined;
  const br = currentBranch(w) ?? 'detached HEAD';
  c.out(`[${br}${!head ? ' (root-commit)' : ''} ${short(id)}] ${firstLine(message)}`);
  const stat = statLines(treeOf(w, parents[0]), r.index);
  if (stat.length) c.out(stat[stat.length - 1]);
  if (amend) {
    c.explain(`--amend doesn't edit a commit. It made a NEW commit ${short(id)} that replaces ${short(head!)} on ${br}.`);
    const pushed = Object.entries(r.remoteBranches).find(([, tip]) => isAncestor(w, head!, tip));
    if (pushed) c.warn(`${short(head!)} was already pushed (it's on ${pushed[0]}). Your branch has now diverged from it, so a normal push will be rejected. Only force-push (--force-with-lease) if nobody else uses this branch.`);
  } else if (op?.kind === 'merge') {
    c.explain(`Merge concluded: ${short(id)} has two parents.`);
  } else if (!head) {
    c.explain(`Your first commit! ${br} now points to ${short(id)}.`);
  } else {
    c.explain(`Snapshot of the staging area saved as ${short(id)}. ${br === 'detached HEAD' ? 'HEAD' : br} moved forward to it.`);
  }
  if (currentBranch(w) === null && op?.kind !== 'rebase') {
    c.warn("You committed on a detached HEAD: no branch points here. Before switching away, save it: git switch -c <new-branch>");
  }
}

function collectLog(w: World, includes: string[], excludes: string[]): Commit[] {
  const ex = new Set<string>();
  for (const e of excludes) for (const id of ancestors(w, e)) ex.add(id);
  const inc = new Set<string>();
  for (const i of includes) for (const id of ancestors(w, i)) if (!ex.has(id)) inc.add(id);
  return [...inc].map((id) => w.objects[id]).sort((a, b) => b.seq - a.seq);
}

function log(c: Ctx, a: Args) {
  const w = c.w;
  const r = R(c);
  const oneline = a.flag('--oneline');
  const all = a.flag('--all');
  const graph = a.flag('--graph');
  a.flag('--decorate');
  let n = Number(a.opt('-n', '--max-count') ?? Infinity);
  const numFlag = a.rest.find((x) => /^-\d+$/.test(x));
  if (numFlag) {
    n = Number(numFlag.slice(1));
    a.rest = a.rest.filter((x) => x !== numFlag);
  }
  a.dashdash();
  a.noUnknownFlags('log');
  const includes: string[] = [];
  const excludes: string[] = [];
  for (const arg of a.rest) {
    if (arg.includes('..')) {
      const [x, y] = arg.split('..');
      excludes.push(resolveRev(w, x || 'HEAD'));
      includes.push(resolveRev(w, y || 'HEAD'));
    } else if (arg.startsWith('^')) excludes.push(resolveRev(w, arg.slice(1)));
    else includes.push(resolveRev(w, arg));
  }
  if (all) includes.push(...Object.values(r.branches), ...Object.values(r.remoteBranches));
  if (!includes.length) includes.push(needHead(c));
  const commits = collectLog(w, includes, excludes).slice(0, n);
  const deco = decorations(w);
  const g = graph ? '* ' : '';
  for (const cm of commits) {
    const d = deco.get(cm.id);
    const dec = d ? ` (${d.join(', ')})` : '';
    if (oneline) {
      c.out(`${g}${short(cm.id)}${dec} ${firstLine(cm.message)}`);
    } else {
      c.out(`${g}commit ${cm.id}${dec}`);
      if (cm.parents.length > 1) c.out(`Merge: ${cm.parents.map(short).join(' ')}`);
      c.out(`Author: ${cm.author} <${cm.email}>`);
      c.out(`Date:   ${formatDate(cm.time)}`);
      c.out('');
      cm.message.split('\n').forEach((l) => c.out(`    ${l}`));
      c.out('');
    }
  }
  if (!commits.length && excludes.length) c.explain('No commits in that range.');
  if (graph) c.explain('The graph panel on the right draws the real shape of history.');
}

function reflog(c: Ctx, a: Args) {
  if (a.rest[0] === 'show') a.rest.shift();
  a.noUnknownFlags('reflog');
  const w = c.w;
  const r = R(c);
  const deco = decorations(w);
  const entries = [...r.reflog].reverse();
  entries.forEach((e, i) => {
    const d = deco.get(e.id);
    c.out(`${short(e.id)}${d ? ` (${d.join(', ')})` : ''} HEAD@{${i}}: ${e.msg}`);
  });
  if (entries.length) {
    c.explain('This is your local diary of where HEAD has been, newest first. Any line here can be restored: git reset --hard HEAD@{n}, or keep it safe with git branch <name> HEAD@{n}.');
  }
}

function createBranch(c: Ctx, name: string, start: string, force: boolean): string {
  const w = c.w;
  const r = R(c);
  validateBranchName(name);
  if (r.branches[name] && !force) throw new GitError(`fatal: a branch named '${name}' already exists`);
  if (force && currentBranch(w) === name) throw new GitError(`fatal: cannot force update the branch '${name}' used by worktree at '~/project'`);
  if (!headId(w) && start === 'HEAD') throw new GitError(`fatal: not a valid object name: '${currentBranch(w)}'`, '(make a first commit before creating branches)');
  const id = resolveRev(w, start);
  r.branches[name] = id;
  if (r.remoteBranches[start]) {
    r.upstream[name] = start;
    c.out(`branch '${name}' set up to track '${start}'.`);
  }
  return id;
}

function branch(c: Ctx, a: Args) {
  const w = c.w;
  const r = R(c);
  const del = a.flag('-d', '--delete');
  const DEL = a.flag('-D');
  const move = a.flag('-m', '--move', '-M');
  const force = a.flag('-f', '--force');
  const showAll = a.flag('-a', '--all');
  const remotes = a.flag('-r', '--remotes');
  const vv = a.flag('-vv');
  const v = a.flag('-v', '--verbose');
  const showCurrent = a.flag('--show-current');
  const unsetUp = a.flag('--unset-upstream');
  const setUp = a.opt('-u', '--set-upstream-to');
  a.flag('--list');
  a.noUnknownFlags('branch');
  const cur = currentBranch(w);
  if (showCurrent) {
    if (cur) c.out(cur);
    return;
  }
  if (setUp !== undefined) {
    const b = a.rest[0] ?? cur;
    if (!b) throw new GitError('fatal: could not set upstream of HEAD when it does not point to any branch.');
    if (!r.remoteBranches[setUp]) throw new GitError(`error: the requested upstream branch '${setUp}' does not exist`, "hint: did you forget to git fetch, or push it first with git push -u?");
    r.upstream[b] = setUp;
    c.out(`branch '${b}' set up to track '${setUp}'.`);
    return;
  }
  if (unsetUp) {
    if (cur) delete r.upstream[cur];
    return;
  }
  if (del || DEL) {
    if (!a.rest.length) throw new GitError('fatal: branch name required');
    for (const name of a.rest) {
      const tip = r.branches[name];
      if (!tip) throw new GitError(`error: branch '${name}' not found`);
      if (name === cur) throw new GitError(`error: Cannot delete branch '${name}' checked out at '~/project'`);
      const h = headId(w);
      const up = r.upstream[name] ? r.remoteBranches[r.upstream[name]] : undefined;
      const merged = (h && isAncestor(w, tip, h)) || (up && isAncestor(w, tip, up));
      if (!DEL && !merged) {
        throw new GitError(`error: the branch '${name}' is not fully merged`, `hint: If you are sure you want to delete it, run 'git branch -D ${name}'`);
      }
      if (!DEL && !(h && isAncestor(w, tip, h))) {
        c.out(`warning: deleting branch '${name}' that has been merged to\n         'refs/remotes/${r.upstream[name]}', but not yet merged to HEAD`);
      }
      delete r.branches[name];
      delete r.upstream[name];
      c.out(`Deleted branch ${name} (was ${short(tip)}).`);
    }
    return;
  }
  if (move) {
    const [x, y] = a.rest;
    const [oldName, newName] = y ? [x, y] : [cur, x];
    if (!oldName || !newName) throw new GitError('fatal: branch name required');
    validateBranchName(newName);
    if (r.branches[newName]) throw new GitError(`fatal: a branch named '${newName}' already exists`);
    if (!r.branches[oldName] && !(oldName === cur && !headId(w))) throw new GitError(`error: refname refs/heads/${oldName} not found`);
    if (r.branches[oldName]) r.branches[newName] = r.branches[oldName];
    delete r.branches[oldName];
    if (r.upstream[oldName]) {
      r.upstream[newName] = r.upstream[oldName];
      delete r.upstream[oldName];
    }
    if (cur === oldName) r.head = { kind: 'branch', name: newName };
    c.explain(`Renamed ${oldName} → ${newName}. Note: the branch on origin keeps its old name until you push the new one.`);
    return;
  }
  if (a.rest.length) {
    const [name, start = 'HEAD'] = a.rest;
    const id = createBranch(c, name, start, force);
    c.explain(`Created branch ${name} at ${short(id)}. You're still on ${cur ?? 'a detached HEAD'}. Use git switch ${name} to move onto it.`);
    return;
  }
  const deco = (name: string, id: string) => {
    if (!v && !vv) return '';
    const up = r.upstream[name];
    let info = '';
    if (vv && up) {
      const ut = r.remoteBranches[up];
      if (!ut) info = ` [${up}: gone]`;
      else {
        const ah = exclusive(w, id, ut).length;
        const be = exclusive(w, ut, id).length;
        const parts = [ah ? `ahead ${ah}` : '', be ? `behind ${be}` : ''].filter(Boolean).join(', ');
        info = ` [${up}${parts ? `: ${parts}` : ''}]`;
      }
    }
    return ` ${short(id)}${info} ${firstLine(w.objects[id].message)}`;
  };
  if (!remotes) {
    if (!cur && headId(w)) c.out(`* (HEAD detached at ${short(headId(w)!)})`);
    for (const name of Object.keys(r.branches).sort()) {
      c.print(name === cur ? 'success' : 'out', `${name === cur ? '* ' : '  '}${name}${deco(name, r.branches[name])}`);
    }
  }
  if (remotes || showAll) {
    for (const name of Object.keys(r.remoteBranches).sort()) c.print('diff-del', `  ${showAll ? 'remotes/' : ''}${name}`);
  }
}

function leavingDetached(c: Ctx, target: string | undefined) {
  const w = c.w;
  const r = R(c);
  if (r.head.kind !== 'detached') return;
  const h = r.head.id;
  const safe = new Set<string>();
  for (const t of [...Object.values(r.branches), ...Object.values(r.remoteBranches), ...(target ? [target] : [])]) {
    for (const id of ancestors(w, t)) safe.add(id);
  }
  const left = [...ancestors(w, h)].filter((id) => !safe.has(id)).map((id) => w.objects[id]);
  if (!left.length) return;
  c.out(`Warning: you are leaving ${plural(left.length, 'commit')} behind, not connected to\nany of your branches:\n`);
  left.sort((x, y) => y.seq - x.seq).forEach((cm) => c.out(`  ${short(cm.id)} ${firstLine(cm.message)}`));
  c.out(`\nIf you want to keep ${left.length === 1 ? 'it' : 'them'} by creating a new branch, this may be a good time\nto do so with:\n\n git branch <new-branch-name> ${short(h)}\n`);
}

function switchToBranch(c: Ctx, name: string, isNew = false) {
  const w = c.w;
  const r = R(c);
  const cur = currentBranch(w);
  if (cur === name) {
    c.out(`Already on '${name}'`);
    trackingLines(w, name).forEach((l) => c.out(l));
    return;
  }
  const target = r.branches[name];
  const fromLabel = cur ?? short(headId(w) ?? '0000000');
  leavingDetached(c, target);
  const carried = target ? carryTo(w, treeOf(w, target), 'checkout', 'switch branches') : [];
  if (cur) r.prevBranch = cur;
  r.head = { kind: 'branch', name };
  if (target) r.reflog.push({ id: target, msg: `checkout: moving from ${fromLabel} to ${name}` });
  carried.forEach((p) => c.out(`M\t${p}`));
  c.out(isNew ? `Switched to a new branch '${name}'` : `Switched to branch '${name}'`);
  trackingLines(w, name).forEach((l) => c.out(l));
  if (carried.length) c.explain('Your uncommitted changes came along. They live in the working directory, not on any branch, until you commit them.');
}

function detachTo(c: Ctx, id: string, label: string, verbose: boolean) {
  const w = c.w;
  const r = R(c);
  const cur = currentBranch(w);
  const fromLabel = cur ?? short(headId(w)!);
  leavingDetached(c, id);
  carryTo(w, treeOf(w, id), 'checkout', 'switch branches');
  if (cur) r.prevBranch = cur;
  r.head = { kind: 'detached', id };
  r.reflog.push({ id, msg: `checkout: moving from ${fromLabel} to ${label}` });
  if (verbose) {
    c.out(`Note: switching to '${label}'.\n\nYou are in 'detached HEAD' state. You can look around, make experimental\nchanges and commit them, and you can discard any commits you make in this\nstate without impacting any branches by switching back to a branch.\n\nIf you want to create a new branch to retain commits you create, you may\ndo so (now or later) by using -c with the switch command. Example:\n\n  git switch -c <new-branch-name>\n\nOr undo this operation with:\n\n  git switch -\n`);
  }
  c.out(`HEAD is now at ${short(id)} ${firstLine(w.objects[id].message)}`);
  c.explain('Detached HEAD = HEAD points straight at a commit instead of a branch. Fine for looking around. Commits made here belong to no branch.');
}

function trackRemote(c: Ctx, name: string) {
  const r = R(c);
  r.branches[name] = r.remoteBranches[`origin/${name}`];
  r.upstream[name] = `origin/${name}`;
  c.out(`branch '${name}' set up to track 'origin/${name}'.`);
  switchToBranch(c, name, true);
}

function switchCmd(c: Ctx, a: Args) {
  const w = c.w;
  const r = R(c);
  const create = a.opt('-c', '--create');
  const forceCreate = a.opt('-C', '--force-create');
  const detach = a.flag('--detach', '-d');
  a.noUnknownFlags('switch');
  guardOp(c);
  const newName = create ?? forceCreate;
  if (newName) {
    if (!headId(w)) {
      validateBranchName(newName);
      r.head = { kind: 'branch', name: newName };
      c.out(`Switched to a new branch '${newName}'`);
      return;
    }
    createBranch(c, newName, a.rest[0] ?? 'HEAD', !!forceCreate);
    switchToBranch(c, newName, true);
    return;
  }
  const [target] = a.rest;
  if (!target) throw new GitError('fatal: missing branch or commit argument');
  if (target === '-') {
    if (!r.prevBranch || !r.branches[r.prevBranch]) throw new GitError('fatal: invalid reference: @{-1}');
    return switchToBranch(c, r.prevBranch);
  }
  if (detach) return detachTo(c, resolveRev(w, target), target, false);
  if (r.branches[target]) return switchToBranch(c, target);
  if (r.remoteBranches[`origin/${target}`]) return trackRemote(c, target);
  if (tryResolve(w, target)) {
    throw new GitError(`fatal: a branch is expected, got commit '${target}'`, 'hint: If you want to detach HEAD at the commit, try again with the --detach option.');
  }
  throw new GitError(`fatal: invalid reference: ${target}`, ...(Object.keys(r.remoteBranches).length ? [] : ["hint: if it's a teammate's branch, git fetch first"]));
}

function restorePaths(c: Ctx, specs: string[], opts: { source?: FileMap; staged: boolean; worktree: boolean }) {
  const w = c.w;
  const r = R(c);
  const head = headTree(w);
  const universe = pathsOf(r.index, head, w.files, opts.source ?? {});
  const paths = matchPaths(specs, universe, (s) => new GitError(`error: pathspec '${s}' did not match any file(s) known to git`));
  for (const p of paths) {
    if (opts.staged) {
      const src = opts.source ?? head;
      if (p in src) r.index[p] = src[p];
      else delete r.index[p];
    }
    if (opts.worktree) {
      const src = opts.source ?? (opts.staged ? head : r.index);
      if (!(p in src) && !(p in r.index) && !opts.source) continue; // untracked file: leave it
      if (p in src) w.files[p] = src[p];
      else delete w.files[p];
      r.conflicts = r.conflicts.filter((x) => x !== p);
    }
  }
  return paths;
}

function checkout(c: Ctx, a: Args) {
  const w = c.w;
  const r = R(c);
  const b = a.opt('-b');
  const B = a.opt('-B');
  const detach = a.flag('--detach');
  const paths = a.dashdash();
  a.noUnknownFlags('checkout');
  if (paths) {
    const src = a.rest[0];
    restorePaths(c, paths, { source: src ? treeOf(w, resolveRev(w, src)) : undefined, staged: !!src, worktree: true });
    c.explain('checkout -- <file> overwrote the file in your working directory. The modern, clearer spelling is git restore <file>.');
    return;
  }
  const newName = b ?? B;
  if (newName) {
    guardOp(c);
    createBranch(c, newName, a.rest[0] ?? 'HEAD', !!B);
    switchToBranch(c, newName, true);
    return;
  }
  const [t, ...more] = a.rest;
  if (!t) throw new GitError('error: you must specify a branch, commit or file');
  if (!more.length) {
    if (t === '-') {
      guardOp(c);
      if (!r.prevBranch) throw new GitError("error: pathspec '-' did not match any file(s) known to git");
      return switchToBranch(c, r.prevBranch);
    }
    if (r.branches[t] && !detach) {
      guardOp(c);
      return switchToBranch(c, t);
    }
    if (r.remoteBranches[`origin/${t}`] && !detach) {
      guardOp(c);
      return trackRemote(c, t);
    }
    const id = tryResolve(w, t);
    if (id && !(t in r.index) && !(t in w.files)) {
      guardOp(c);
      return detachTo(c, id, t, true);
    }
  }
  restorePaths(c, [t, ...more], { staged: false, worktree: true });
  c.explain('checkout <file> overwrote the file with its staged version. The modern spelling is git restore <file>.');
}

function restore(c: Ctx, a: Args) {
  const w = c.w;
  const staged = a.flag('--staged', '-S');
  const worktree = a.flag('--worktree', '-W');
  const source = a.opt('--source', '-s');
  a.dashdash();
  a.noUnknownFlags('restore');
  if (!a.rest.length) throw new GitError('fatal: you must specify path(s) to restore');
  restorePaths(c, a.rest, {
    source: source ? treeOf(w, resolveRev(w, source)) : undefined,
    staged,
    worktree: worktree || !staged,
  });
  if (staged && !worktree) c.explain('Unstaged. The file content on disk is unchanged. Only the staging area was reset to the last commit.');
}

function reset(c: Ctx, a: Args) {
  const w = c.w;
  const r = R(c);
  const soft = a.flag('--soft');
  const hard = a.flag('--hard');
  const mixed = a.flag('--mixed');
  a.flag('-q', '--quiet');
  const dd = a.dashdash();
  a.noUnknownFlags('reset');
  if ([soft, hard, mixed].filter(Boolean).length > 1) throw new GitError('fatal: options --soft, --mixed and --hard cannot be used together');
  let rev = 'HEAD';
  let specs = dd ?? [];
  if (a.rest.length) {
    const first = a.rest[0];
    const known = pathsOf(w.files, r.index, headTree(w));
    const isPath = first === '.' || known.some((p) => p === first || p.startsWith(first + '/'));
    if (!dd && isPath && tryResolve(w, first) === null) {
      specs = [...a.rest]; // `git reset <file>` → unstage
    } else {
      rev = first;
      specs = [...a.rest.slice(1), ...specs];
    }
  }
  if (specs.length) {
    if (soft || hard) throw new GitError(`fatal: Cannot do ${soft ? 'soft' : 'hard'} reset with paths.`);
    const src = headId(w) ? treeOf(w, resolveRev(w, rev)) : {};
    const paths = matchPaths(specs, pathsOf(r.index, src), (s) => new GitError(`error: pathspec '${s}' did not match any file(s) known to git`));
    for (const p of paths) {
      if (p in src) r.index[p] = src[p];
      else delete r.index[p];
    }
    const st = computeStatus(w);
    if (st.unstaged.length) {
      c.out('Unstaged changes after reset:');
      st.unstaged.forEach((s) => c.out(`${s.kind === 'deleted' ? 'D' : 'M'}\t${s.path}`));
    }
    c.explain('git reset <file> only unstages. Your file on disk is untouched. (Modern spelling: git restore --staged <file>.)');
    return;
  }
  const target = resolveRev(w, rev);
  const old = needHead(c);
  const label = currentBranch(w) ?? 'HEAD';
  const mode = soft ? 'soft' : hard ? 'hard' : 'mixed';
  if (r.op && r.op.kind !== 'rebase' && mode !== 'soft') r.op = undefined;
  if (mode !== 'soft') r.conflicts = [];
  r.origHead = old;
  if (mode === 'hard') hardReset(w, treeOf(w, target));
  else if (mode === 'mixed') r.index = { ...treeOf(w, target) };
  moveHead(w, target, `reset: moving to ${rev}`);
  if (mode === 'hard') c.out(`HEAD is now at ${short(target)} ${firstLine(w.objects[target].message)}`);
  if (mode === 'mixed') {
    const st = computeStatus(w);
    if (st.unstaged.length) {
      c.out('Unstaged changes after reset:');
      st.unstaged.forEach((s) => c.out(`${s.kind === 'deleted' ? 'D' : 'M'}\t${s.path}`));
    }
  }
  const moved = old === target ? `${label} stayed at ${short(target)}` : `${label} moved from ${short(old)} to ${short(target)}`;
  if (mode === 'soft') c.explain(`--soft: ${moved}. Staging area and files untouched, so the changes from the commits you stepped back over are now staged, ready to commit again.`);
  if (mode === 'mixed') c.explain(`--mixed (the default): ${moved} and the staging area was reset to match. Your files still have every change, just unstaged.`);
  if (mode === 'hard') c.explain(`--hard: ${moved}, and the staging area AND your working files were overwritten to match. It's the only reset mode that touches your files.`);
  const br = currentBranch(w);
  const up = br && r.upstream[br] ? r.remoteBranches[r.upstream[br]] : undefined;
  if (up && old !== target && isAncestor(w, old, up) && !isAncestor(w, old, target)) {
    c.warn(`You moved ${br} behind commits that are already on ${r.upstream[br!]}. A normal push will now be rejected, and forcing it rewrites history teammates may have pulled. For shared branches, git revert is the safer undo.`);
  }
}

function merge(c: Ctx, a: Args) {
  const w = c.w;
  const r = R(c);
  const abort = a.flag('--abort');
  const cont = a.flag('--continue');
  const noFF = a.flag('--no-ff');
  const ffOnly = a.flag('--ff-only');
  a.flag('--no-edit');
  const msg = a.opt('-m');
  a.noUnknownFlags('merge');
  if (abort) {
    if (r.op?.kind !== 'merge') throw new GitError('fatal: There is no merge to abort (MERGE_HEAD missing).');
    hardReset(w, treeOf(w, r.op.origHead));
    r.op = undefined;
    r.conflicts = [];
    c.explain('Merge aborted. Your branch, staging area and files are exactly as before the merge.');
    return;
  }
  if (cont) {
    if (r.op?.kind !== 'merge') throw new GitError('fatal: There is no merge in progress (MERGE_HEAD missing).');
    return commit(c, new Args([]));
  }
  if (r.op) guardOp(c);
  const [rev] = a.rest;
  if (!rev) throw new GitError('fatal: No remote for the current branch.', 'hint: usage: git merge <branch>');
  const theirs = resolveRev(w, rev);
  const head = needHead(c);
  if (isAncestor(w, theirs, head)) {
    c.out('Already up to date.');
    c.explain(`Everything in ${rev} is already in your branch.`);
    return;
  }
  if (isAncestor(w, head, theirs) && !noFF) {
    r.origHead = head;
    fastForward(c, theirs, `merge ${rev}: Fast-forward`);
    c.explain(`Fast-forward: your branch had no commits of its own since ${rev} split off, so git just slid the label forward to ${short(theirs)}. No merge commit needed.`);
    return;
  }
  if (ffOnly) throw new GitError('fatal: Not possible to fast-forward, aborting.');
  const isRemote = !!r.remoteBranches[rev];
  doMerge(c, theirs, msg ?? (isRemote ? `Merge remote-tracking branch '${rev}'` : `Merge branch '${rev}'`), rev);
}

// ─── rebase ───

function startRebase(c: Ctx, upstream: string, ontoName: string, prefix = 'rebase') {
  const w = c.w;
  const r = R(c);
  const head = needHead(c);
  const br = currentBranch(w);
  if (isAncestor(w, upstream, head)) {
    c.out(`Current branch ${br ?? 'HEAD'} is up to date.`);
    return;
  }
  const st = computeStatus(w);
  if (st.staged.length || st.unstaged.length) {
    throw new GitError('error: cannot rebase: You have unstaged changes.', 'error: Please commit or stash them.');
  }
  const todo = exclusive(w, head, upstream)
    .filter((cm) => cm.parents.length === 1)
    .reverse()
    .map((cm) => cm.id);
  r.origHead = head;
  r.op = { kind: 'rebase', onto: upstream, ontoName, origHead: head, branch: br, todo, current: null };
  hardReset(w, treeOf(w, upstream));
  r.head = { kind: 'detached', id: upstream };
  r.reflog.push({ id: upstream, msg: `${prefix} (start): checkout ${ontoName}` });
  runRebase(c);
}

function runRebase(c: Ctx) {
  const w = c.w;
  const r = R(c);
  const op = r.op;
  if (op?.kind !== 'rebase') return;
  while (op.todo.length) {
    const cid = op.todo.shift()!;
    const cm = w.objects[cid];
    const cur = headTree(w);
    const label = `${short(cid)} (${firstLine(cm.message)})`;
    const res = mergeTrees(treeOf(w, cm.parents[0]), cur, cm.tree, 'HEAD', label);
    if (res.conflicts.length) {
      applyMergeResult(w, cur, cm.tree, res);
      op.current = cid;
      r.conflicts = res.conflicts;
      for (const p of res.conflicts) {
        c.out(`Auto-merging ${p}`);
        c.out(`CONFLICT (content): Merge conflict in ${p}`);
      }
      c.err(`error: could not apply ${short(cid)}... ${firstLine(cm.message)}`);
      c.err('hint: Resolve all conflicts manually, mark them as resolved with\nhint: "git add/rm <conflicted_files>", then run "git rebase --continue".\nhint: You can instead skip this commit: run "git rebase --skip".\nhint: To abort and get back to the state before "git rebase", run "git rebase --abort".');
      c.out(`Could not apply ${short(cid)}... ${firstLine(cm.message)}`);
      c.ok = false;
      c.explain(`Rebase paused while replaying "${firstLine(cm.message)}". In the conflict, HEAD (top) is ${op.ontoName} + commits replayed so far, and the bottom part is YOUR commit.`);
      conflictExplain(c, 'git rebase --continue', 'git rebase --abort');
      return;
    }
    if (sameTree(res.tree, cur)) {
      c.out(`dropping ${short(cid)} ${firstLine(cm.message)} -- patch contents already upstream`);
      continue;
    }
    const id = createCommit(w, { parents: [headId(w)!], message: cm.message, tree: res.tree, author: { name: cm.author, email: cm.email } });
    hardReset(w, res.tree);
    moveHead(w, id, `rebase (pick): ${firstLine(cm.message)}`);
  }
  const tip = headId(w)!;
  if (op.branch) {
    r.branches[op.branch] = tip;
    r.head = { kind: 'branch', name: op.branch };
    r.reflog.push({ id: tip, msg: `rebase (finish): returning to refs/heads/${op.branch}` });
  }
  r.op = undefined;
  r.conflicts = [];
  c.out(`Successfully rebased and updated ${op.branch ? `refs/heads/${op.branch}` : 'detached HEAD'}.`);
  const replayed = exclusive(w, tip, op.onto).length;
  if (replayed) {
    c.explain(`Your ${plural(replayed, 'commit')} ${replayed === 1 ? 'was' : 'were'} replayed on top of ${op.ontoName} as brand-new commits (new ids!). If the old ones were already pushed, a normal push will be rejected and you'd need git push --force-with-lease.`);
  } else c.explain(`${op.branch ?? 'HEAD'} now simply points at ${op.ontoName}.`);
}

function rebase(c: Ctx, a: Args) {
  const w = c.w;
  const r = R(c);
  const cont = a.flag('--continue');
  const abort = a.flag('--abort');
  const skip = a.flag('--skip');
  const quit = a.flag('--quit');
  if (a.flag('-i', '--interactive')) throw new GitError('error: interactive rebase (-i) is not in the simulator yet.', 'hint: coming in a later level pack!');
  a.noUnknownFlags('rebase');
  const op = r.op;
  if (cont || abort || skip || quit) {
    if (op?.kind !== 'rebase') throw new GitError('fatal: No rebase in progress?');
    if (abort || quit) {
      if (abort) {
        hardReset(w, treeOf(w, op.origHead));
        if (op.branch) {
          r.branches[op.branch] = op.origHead;
          r.head = { kind: 'branch', name: op.branch };
        } else r.head = { kind: 'detached', id: op.origHead };
        r.reflog.push({ id: op.origHead, msg: `rebase (abort): returning to ${op.branch ? `refs/heads/${op.branch}` : short(op.origHead)}` });
        c.explain('Rebase aborted. Your branch is exactly where it was before you started. Nothing was lost.');
      } else c.explain('Rebase quit: HEAD stays where it is (detached), and the rebase is forgotten.');
      r.op = undefined;
      r.conflicts = [];
      return;
    }
    if (skip) {
      hardReset(w, headTree(w));
      r.conflicts = [];
      if (op.current) c.explain(`Skipped ${short(op.current)}: that commit's changes will NOT be in the result.`);
      op.current = null;
      return runRebase(c);
    }
    if (r.conflicts.length) {
      throw new GitError(...r.conflicts.map((p) => `${p}: needs merge`), 'You must edit all merge conflicts and then', 'mark them as resolved using git add');
    }
    if (computeStatus(w).unstaged.length) throw new GitError('error: cannot rebase: You have unstaged changes.', 'error: Please commit or stash them.', 'hint: git add the files you fixed');
    if (op.current) {
      const cm = w.objects[op.current];
      if (!sameTree(r.index, headTree(w))) {
        const id = createCommit(w, { parents: [headId(w)!], message: cm.message, tree: r.index, author: { name: cm.author, email: cm.email } });
        moveHead(w, id, `rebase (continue): ${firstLine(cm.message)}`);
        c.out(`[detached HEAD ${short(id)}] ${firstLine(cm.message)}`);
      }
      op.current = null;
    }
    return runRebase(c);
  }
  if (op) guardOp(c);
  let [rev] = a.rest;
  if (!rev) {
    const br = currentBranch(w);
    rev = br ? r.upstream[br] : '';
    if (!rev) throw new GitError('There is no tracking information for the current branch.', 'Please specify which branch you want to rebase against.', '', '    git rebase <branch>');
  }
  startRebase(c, resolveRev(w, rev), rev);
}

// ─── cherry-pick / revert ───

function pickLike(c: Ctx, a: Args, kind: 'cherry-pick' | 'revert') {
  const w = c.w;
  const r = R(c);
  const cont = a.flag('--continue');
  const abort = a.flag('--abort');
  a.flag('--no-edit');
  a.noUnknownFlags(kind);
  if (cont || abort) {
    if (r.op?.kind !== kind) throw new GitError(`error: no ${kind} in progress`);
    if (abort) {
      hardReset(w, treeOf(w, r.op.origHead));
      r.op = undefined;
      r.conflicts = [];
      c.explain(`${kind} aborted. Back to how things were.`);
      return;
    }
    return commit(c, new Args([]));
  }
  if (r.op) guardOp(c);
  const [rev] = a.rest;
  if (!rev) throw new GitError(`usage: git ${kind} <commit>`);
  const id = resolveRev(w, rev);
  const cm = w.objects[id];
  const head = needHead(c);
  if (cm.parents.length > 1) throw new GitError(`error: commit ${id} is a merge but no -m option was given.`, `fatal: ${kind} failed`);
  if (computeStatus(w).staged.length || computeStatus(w).unstaged.length) {
    throw new GitError(`error: your local changes would be overwritten by ${kind}.`, 'hint: commit your changes or stash them to proceed.', `fatal: ${kind} failed`);
  }
  const parentTree = treeOf(w, cm.parents[0]);
  const ours = headTree(w);
  const [base, theirs] = kind === 'cherry-pick' ? [parentTree, cm.tree] : [cm.tree, parentTree];
  const message = kind === 'cherry-pick' ? cm.message : `Revert "${firstLine(cm.message)}"\n\nThis reverts commit ${cm.id}.`;
  const label = `${kind === 'revert' ? 'parent of ' : ''}${short(id)} (${firstLine(cm.message)})`;
  const res = mergeTrees(base, ours, theirs, 'HEAD', label);
  if (res.conflicts.length) {
    applyMergeResult(w, ours, theirs, res);
    r.op = { kind, commit: id, message, origHead: head };
    r.conflicts = res.conflicts;
    res.conflicts.forEach((p) => c.out(`CONFLICT (content): Merge conflict in ${p}`));
    c.err(`error: could not ${kind === 'revert' ? 'revert' : 'apply'} ${short(id)}... ${firstLine(cm.message)}`);
    c.err(`hint: After resolving the conflicts, mark them with\nhint: "git add/rm <pathspec>", then run\nhint: "git ${kind} --continue".\nhint: To abort and get back to the state before "git ${kind}",\nhint: run "git ${kind} --abort".`);
    c.ok = false;
    conflictExplain(c, `git ${kind} --continue`, `git ${kind} --abort`);
    return;
  }
  if (sameTree(res.tree, ours)) {
    c.out(`On branch ${currentBranch(w)}\nnothing to commit, working tree clean`);
    c.explain(`Those changes are already in your branch, so there's nothing to ${kind}.`);
    c.ok = false;
    return;
  }
  const newId = createCommit(w, {
    parents: [head],
    message,
    tree: res.tree,
    author: kind === 'cherry-pick' ? { name: cm.author, email: cm.email } : identity(w),
  });
  hardReset(w, res.tree);
  moveHead(w, newId, `${kind}: ${firstLine(message)}`);
  c.out(`[${currentBranch(w) ?? 'detached HEAD'} ${short(newId)}] ${firstLine(message)}`);
  const stat = statLines(ours, res.tree);
  if (stat.length) c.out(stat[stat.length - 1]);
  if (kind === 'revert') {
    c.explain(`revert added a NEW commit ${short(newId)} that undoes ${short(id)}. History isn't rewritten, so it's safe on shared branches. A normal git push works.`);
  } else {
    c.explain(`Copied the changes of ${short(id)} into a new commit ${short(newId)} on your branch. The original commit is untouched.`);
  }
}

// ─── stash ───

function stash(c: Ctx, a: Args) {
  const w = c.w;
  const r = R(c);
  const sub = a.rest[0] && !a.rest[0].startsWith('-') ? a.rest.shift()! : 'push';
  const pickIndex = () => {
    const ref = a.rest[0] ?? 'stash@{0}';
    const m = ref.match(/^(?:stash@\{)?(\d+)\}?$/);
    const idx = m ? Number(m[1]) : NaN;
    if (!r.stash.length) throw new GitError('No stash entries found.');
    if (!(idx in r.stash)) throw new GitError(`error: ${ref} is not a valid reference`);
    return idx;
  };
  switch (sub) {
    case 'push':
    case 'save': {
      const msg = a.opt('-m', '--message') ?? (sub === 'save' ? a.rest.join(' ') || undefined : undefined);
      const u = a.flag('-u', '--include-untracked');
      if (sub === 'push') a.noUnknownFlags('stash');
      const head = needHead(c);
      const st = computeStatus(w);
      if (!st.staged.length && !st.unstaged.length && !(u && st.untracked.length)) {
        c.out('No local changes to save');
        if (st.untracked.length) c.explain('Untracked files are not stashed by default. Use git stash -u to include them.');
        return;
      }
      const worktree: FileMap = {};
      for (const p of pathsOf(r.index, headTree(w))) if (p in w.files) worktree[p] = w.files[p];
      if (u) for (const p of st.untracked) worktree[p] = w.files[p];
      const br = currentBranch(w) ?? '(no branch)';
      const message = msg ? `On ${br}: ${msg}` : `WIP on ${br}: ${short(head)} ${firstLine(w.objects[head].message)}`;
      const id = makeId(`stash|${w.seq}|${message}|${r.stash.length}`);
      r.stash.unshift({ id, base: head, index: { ...r.index }, worktree, message });
      hardReset(w, headTree(w));
      if (u) for (const p of st.untracked) delete w.files[p];
      c.out(`Saved working directory and index state ${message}`);
      c.explain(`Changes tucked away on the stash stack (stash@{0}) and your working tree is clean again.${!u && st.untracked.length ? ` Untracked files (${st.untracked.join(', ')}) were NOT stashed, use -u for those.` : ''} Bring them back with git stash pop.`);
      return;
    }
    case 'list':
      r.stash.forEach((s, i) => c.out(`stash@{${i}}: ${s.message}`));
      return;
    case 'show': {
      const s = r.stash[pickIndex()];
      statLines(treeOf(w, s.base), s.worktree).forEach((l) => c.out(l));
      return;
    }
    case 'drop': {
      const i = pickIndex();
      const [s] = r.stash.splice(i, 1);
      c.out(`Dropped stash@{${i}} (${s.id})`);
      return;
    }
    case 'clear':
      r.stash = [];
      return;
    case 'pop':
    case 'apply': {
      const i = pickIndex();
      const s = r.stash[i];
      const baseTree = treeOf(w, s.base);
      const cur = headTree(w);
      const touched = pathsOf(baseTree, s.worktree).filter((p) => s.worktree[p] !== baseTree[p]);
      blockIfDirtyPaths(c, touched, 'merge');
      const clash = touched.filter((p) => !(p in r.index) && !(p in cur) && p in w.files && w.files[p] !== s.worktree[p]);
      if (clash.length) throw new GitError(...clash.map((p) => `${p} already exists, no checkout`), 'error: could not restore untracked files from stash');
      const conflicts: string[] = [];
      for (const p of touched) {
        const sv = s.worktree[p];
        const b = baseTree[p];
        const h = cur[p];
        if (h === b) {
          if (sv === undefined) delete w.files[p];
          else {
            w.files[p] = sv;
            if (!(p in r.index) && p in s.index) r.index[p] = s.index[p];
          }
        } else if (h !== sv) {
          const m = merge3(b ?? '', h ?? '', sv ?? '', 'Updated upstream', 'Stashed changes');
          w.files[p] = m.text;
          if (m.conflict) conflicts.push(p);
        }
      }
      if (conflicts.length) {
        conflicts.forEach((p) => c.out(`Auto-merging ${p}\nCONFLICT (content): Merge conflict in ${p}`));
        r.conflicts = [...new Set([...r.conflicts, ...conflicts])];
        c.out('The stash entry is kept in case you need it again.');
        c.ok = false;
        c.explain('Your stashed edits clash with what changed since. Resolve the markers, then git add <file>. Then drop the stash yourself with git stash drop.');
        return;
      }
      const st = computeStatus(w);
      [...st.staged, ...st.unstaged].forEach((x) => c.out(`\t${x.kind}:   ${x.path}`));
      if (sub === 'pop') {
        r.stash.splice(i, 1);
        c.out(`Dropped refs/stash@{${i}} (${s.id})`);
      }
      c.explain(`Stashed changes re-applied on top of ${short(headId(w)!)}.${sub === 'apply' ? ' (apply keeps the stash entry. pop would have removed it.)' : ''}`);
      return;
    }
    default:
      throw new GitError(`error: unknown subcommand: '${sub}'`);
  }
}

// ─── remotes ───

function doFetch(c: Ctx, name = 'origin', prune = false): boolean {
  const w = c.w;
  const r = R(c);
  const rem = getRemote(c, name);
  const lines: string[] = [];
  for (const [b, id] of Object.entries(rem.branches)) {
    const key = `${name}/${b}`;
    const old = r.remoteBranches[key];
    if (old === id) continue;
    if (!old) lines.push(` * [new branch]      ${b} -> ${key}`);
    else if (isAncestor(w, old, id)) lines.push(`   ${short(old)}..${short(id)}  ${b} -> ${key}`);
    else lines.push(` + ${short(old)}...${short(id)} ${b} -> ${key}  (forced update)`);
    r.remoteBranches[key] = id;
  }
  for (const key of Object.keys(r.remoteBranches)) {
    if (!key.startsWith(name + '/')) continue;
    if (!(key.slice(name.length + 1) in rem.branches)) {
      if (prune) {
        delete r.remoteBranches[key];
        lines.push(` - [deleted]         (none)     -> ${key}`);
      }
    }
  }
  if (lines.length) {
    c.out(`From ${rem.url}`);
    lines.forEach((l) => c.out(l));
  }
  return lines.length > 0;
}

function fetch(c: Ctx, a: Args) {
  const prune = a.flag('-p', '--prune');
  a.flag('--all');
  a.noUnknownFlags('fetch');
  const changed = doFetch(c, a.rest[0] ?? 'origin', prune);
  const br = currentBranch(c.w);
  if (changed) {
    c.explain(`fetch only downloads. The origin/* labels moved, but your branches and files are untouched. Peek with git log --oneline ${br ?? 'HEAD'}..origin/${br ?? 'main'}, then merge or rebase.`);
  } else c.explain('Nothing new on origin.');
}

function pull(c: Ctx, a: Args) {
  const w = c.w;
  const r = R(c);
  const rebaseFlag = a.flag('--rebase', '-r');
  const noRebase = a.flag('--no-rebase');
  const ffOnly = a.flag('--ff-only');
  a.flag('--no-edit', '--ff');
  a.noUnknownFlags('pull');
  const br = currentBranch(w);
  if (!br) throw new GitError('You are not currently on a branch.', 'Please specify which branch you want to merge with.', '', '    git pull <remote> <branch>');
  if (r.op) {
    if (r.op.kind === 'rebase') throw new GitError('error: cannot pull with rebase: a rebase is in progress.', 'hint: git rebase --continue or git rebase --abort first');
    guardOp(c);
  }
  let remoteName: string;
  let branchName: string;
  if (a.rest.length) {
    remoteName = a.rest[0];
    branchName = a.rest[1] ?? br;
  } else {
    const up = r.upstream[br];
    if (!up) {
      throw new GitError(
        'There is no tracking information for the current branch.',
        'Please specify which branch you want to merge with.',
        '',
        '    git pull <remote> <branch>',
        '',
        'If you wish to set tracking information for this branch you can do so with:',
        '',
        `    git branch --set-upstream-to=origin/${br} ${br}`,
      );
    }
    remoteName = up.split('/')[0];
    branchName = up.slice(remoteName.length + 1);
  }
  const rem = getRemote(c, remoteName);
  doFetch(c, remoteName);
  const key = `${remoteName}/${branchName}`;
  const target = r.remoteBranches[key];
  if (!target) throw new GitError(`fatal: couldn't find remote ref ${branchName}`);
  const head = headId(w);
  if (!head) {
    carryTo(w, treeOf(w, target), 'merge', 'merge');
    moveHead(w, target, 'pull: Fast-forward');
    return;
  }
  if (isAncestor(w, target, head)) {
    c.out('Already up to date.');
    return;
  }
  const rebaseCfg = cfg(w, 'pull.rebase');
  const ffCfg = cfg(w, 'pull.ff');
  const useRebase = rebaseFlag || (!noRebase && rebaseCfg === 'true');
  if (isAncestor(w, head, target)) {
    r.origHead = head;
    fastForward(c, target, `pull: Fast-forward`);
    c.explain(`pull = fetch + merge. You had no new local commits, so it was a fast-forward: ${br} slid forward to match ${key}.`);
    return;
  }
  if (useRebase) {
    startRebase(c, target, key, 'pull --rebase');
    return;
  }
  if (ffOnly || ffCfg === 'only') {
    c.err('fatal: Not possible to fast-forward, aborting.');
    c.ok = false;
    c.explain('--ff-only refuses to make merge commits. Your branch and origin both have new commits, so a fast-forward is impossible. Use git pull --rebase or git pull --no-rebase.');
    return;
  }
  if (!noRebase && rebaseCfg === undefined && ffCfg === undefined) {
    c.err(
      [
        'hint: You have divergent branches and need to specify how to reconcile them.',
        'hint: You can do so by running one of the following commands sometime before',
        'hint: your next pull:',
        'hint:',
        'hint:   git config pull.rebase false  # merge',
        'hint:   git config pull.rebase true   # rebase',
        'hint:   git config pull.ff only       # fast-forward only',
        'hint:',
        'hint: You can replace "git config" with "git config --global" to set a default',
        'hint: preference for all repositories. You can also pass --rebase, --no-rebase,',
        'hint: or --ff-only on the command line to override the configured default per',
        'hint: invocation.',
        'fatal: Need to specify how to reconcile divergent branches.',
      ].join('\n'),
    );
    c.ok = false;
    c.explain(`Both you and origin have new commits ("divergent"). The fetch DID happen (origin/${branchName} is updated), but git wants you to pick: merge (--no-rebase) makes a merge commit, rebase (--rebase) replays your commits on top for a straight line.`);
    return;
  }
  doMerge(c, target, `Merge branch '${branchName}' of ${rem.url}`, key);
}

function push(c: Ctx, a: Args) {
  const w = c.w;
  const r = R(c);
  let setUp = a.flag('-u', '--set-upstream');
  const force = a.flag('-f', '--force');
  const lease = a.flag('--force-with-lease');
  const del = a.flag('-d', '--delete');
  a.noUnknownFlags('push');
  let [remoteName, ...refs] = a.rest;
  const br = currentBranch(w);
  const upRef = (b: string) => {
    const up = r.upstream[b];
    return up ? `${b}:${up.slice(up.indexOf('/') + 1)}` : b;
  };
  if (!remoteName || !refs.length) {
    if (!br && !del) {
      throw new GitError('fatal: You are not currently on a branch.', 'To push the history leading to the current (detached HEAD)', 'state now, use', '', '    git push origin HEAD:<name-of-remote-branch>');
    }
    if (!remoteName) {
      const up = br ? r.upstream[br] : undefined;
      if (up) remoteName = up.split('/')[0];
      else if (cfg(w, 'push.autosetupremote') === 'true' && r.remotes.origin) {
        remoteName = 'origin';
        setUp = true;
      } else if (!setUp) {
        throw new GitError(
          `fatal: The current branch ${br} has no upstream branch.`,
          'To push the current branch and set the remote as upstream, use',
          '',
          `    git push --set-upstream origin ${br}`,
          '',
          'To have this happen automatically for branches without a tracking',
          "upstream, see 'push.autoSetupRemote' in 'git help config'.",
        );
      } else remoteName = 'origin';
    }
    if (!refs.length && br) refs = [setUp ? br : upRef(br)];
  }
  const rem = getRemote(c, remoteName);
  const out: string[] = [];
  const after: (() => void)[] = [];
  let rejected = false;
  let upToDate = 0;
  for (const ref of refs) {
    const [src, dst] = ref.includes(':') ? ref.split(':') : [ref, ref];
    const key = `${remoteName}/${dst}`;
    if (del || src === '') {
      if (!rem.branches[dst]) throw new GitError(`error: unable to delete '${dst}': remote ref does not exist`, `error: failed to push some refs to '${rem.url}'`);
      if (rem.protectedBranches.includes(dst)) {
        out.push(` ! [remote rejected] ${dst} (protected branch hook declined)`);
        rejected = true;
        continue;
      }
      delete rem.branches[dst];
      delete r.remoteBranches[key];
      out.push(` - [deleted]         ${dst}`);
      continue;
    }
    const local = src === 'HEAD' ? headId(w) : r.branches[src];
    if (!local) throw new GitError(`error: src refspec ${src} does not match any`, `error: failed to push some refs to '${rem.url}'`);
    const remoteTip = rem.branches[dst];
    const accept = (line: string) => {
      out.push(line);
      rem.branches[dst] = local;
      r.remoteBranches[key] = local;
      if (setUp && src !== 'HEAD') {
        r.upstream[src] = key;
        after.push(() => c.out(`branch '${src}' set up to track '${key}'.`));
      }
    };
    if (remoteTip === local) {
      upToDate++;
      r.remoteBranches[key] = local;
      if (setUp && src !== 'HEAD') r.upstream[src] = key;
      continue;
    }
    if (!remoteTip) accept(` * [new branch]      ${src} -> ${dst}`);
    else if (isAncestor(w, remoteTip, local)) accept(`   ${short(remoteTip)}..${short(local)}  ${src} -> ${dst}`);
    else if (force || lease) {
      if (lease && r.remoteBranches[key] !== remoteTip) {
        out.push(` ! [rejected]        ${src} -> ${dst} (stale info)`);
        rejected = true;
        after.push(() => c.explain(`--force-with-lease saved you: ${key} changed on the server since your last fetch (someone pushed). git fetch, look at what they added, integrate it, then try again.`));
        continue;
      }
      if (rem.protectedBranches.includes(dst)) {
        out.push(` ! [remote rejected] ${src} -> ${dst} (protected branch hook declined)`);
        after.unshift(() => c.err(`remote: error: Cannot force-push to protected branch '${dst}'.`));
        rejected = true;
        after.push(() => c.explain(`${dst} is protected on the server: nobody may rewrite its history. To undo pushed commits there, use git revert and push normally.`));
        continue;
      }
      const lost = exclusive(w, remoteTip, local);
      accept(` + ${short(remoteTip)}...${short(local)} ${src} -> ${dst} (forced update)`);
      if (lost.length) {
        const others = lost.filter((cm) => cm.author !== cfg(w, 'user.name'));
        after.push(() =>
          c.warn(
            `Force push removed ${plural(lost.length, 'commit')} from origin/${dst}: ${lost.map((cm) => `${short(cm.id)} "${firstLine(cm.message)}" (${cm.author})`).join(', ')}.${others.length ? ` Some were a teammate's work! They'll have a bad time on their next pull.` : ''}${lease ? '' : ' --force-with-lease would have stopped you if those were unknown to you.'}`,
          ),
        );
      }
    } else {
      rejected = true;
      const known = r.remoteBranches[key] === remoteTip;
      out.push(` ! [rejected]        ${src} -> ${dst} (${known ? 'non-fast-forward' : 'fetch first'})`);
      after.push(() => {
        c.err(`error: failed to push some refs to '${rem.url}'`);
        if (known) {
          c.err("hint: Updates were rejected because the tip of your current branch is behind\nhint: its remote counterpart. If you want to integrate the remote changes,\nhint: use 'git pull' before pushing again.\nhint: See the 'Note about fast-forwards' in 'git push --help' for details.");
          c.explain(`Your ${src} and origin/${dst} have different histories. Either someone pushed commits you merged/rebased away, or you rewrote history (reset, amend, rebase). Integrate with git pull, or if you KNOW the rewrite is right and the branch is yours alone, git push --force-with-lease.`);
        } else {
          c.err('hint: Updates were rejected because the remote contains work that you do not\nhint: have locally. This is usually caused by another repository pushing to\nhint: the same ref. If you want to integrate the remote changes, use\nhint: \'git pull\' before pushing again.\nhint: See the \'Note about fast-forwards\' in \'git push --help\' for details.');
          c.explain(`Someone pushed to origin/${dst} since your last fetch. Git refuses to overwrite their work. Bring it in first (git pull or git pull --rebase), then push again. Don't reach for --force here!`);
        }
      });
    }
  }
  if (out.length) {
    c.out(`To ${rem.url}`);
    out.forEach((l) => c.out(l));
  } else if (upToDate) c.out('Everything up-to-date');
  after.forEach((f) => f());
  if (rejected) {
    if (!out.some((l) => l.includes('[rejected]') && !l.includes('stale'))) c.err(`error: failed to push some refs to '${rem.url}'`);
    c.ok = false;
  } else if (out.some((l) => l.includes('->') || l.includes('[deleted]'))) {
    c.explain(`origin is updated. Teammates get these commits on their next fetch or pull.${setUp ? ' (-u remembered origin as the upstream, so plain git push / git pull work from now on.)' : ''}`);
  }
}

function remote(c: Ctx, a: Args) {
  const r = R(c);
  const v = a.flag('-v', '--verbose');
  const sub = a.rest.shift();
  if (!sub) {
    for (const [n, url] of Object.entries(r.remotes)) {
      if (v) c.out(`${n}\t${url} (fetch)\n${n}\t${url} (push)`);
      else c.out(n);
    }
    return;
  }
  const [name, url] = a.rest;
  switch (sub) {
    case 'add':
      if (!name || !url) throw new GitError('usage: git remote add <name> <url>');
      if (r.remotes[name]) throw new GitError(`error: remote ${name} already exists.`);
      r.remotes[name] = url;
      c.explain(`"${name}" is now a nickname for ${url}. Next: git push -u ${name} <branch>.`);
      return;
    case 'remove':
    case 'rm':
      if (!r.remotes[name]) throw new GitError(`error: No such remote: '${name}'`);
      delete r.remotes[name];
      for (const k of Object.keys(r.remoteBranches)) if (k.startsWith(name + '/')) delete r.remoteBranches[k];
      return;
    case 'set-url':
      if (!r.remotes[name]) throw new GitError(`error: No such remote '${name}'`);
      r.remotes[name] = url;
      return;
    case 'get-url':
      if (!r.remotes[name]) throw new GitError(`error: No such remote '${name}'`);
      c.out(r.remotes[name]);
      return;
    default:
      throw new GitError(`error: unknown subcommand: \`${sub}'`);
  }
}

function printDiff(c: Ctx, from: FileMap, to: FileMap) {
  for (const p of pathsOf(from, to)) {
    if (from[p] === to[p]) continue;
    c.print('diff-meta', `diff --git a/${p} b/${p}`);
    if (!(p in from)) c.print('diff-meta', 'new file mode 100644');
    if (!(p in to)) c.print('diff-meta', 'deleted file mode 100644');
    c.print('diff-meta', `--- ${p in from ? `a/${p}` : '/dev/null'}`);
    c.print('diff-meta', `+++ ${p in to ? `b/${p}` : '/dev/null'}`);
    for (const d of diffLines(from[p] ?? '', to[p] ?? '')) {
      c.print(d.t === '+' ? 'diff-add' : d.t === '-' ? 'diff-del' : 'out', `${d.t}${d.line}`);
    }
  }
}

function diff(c: Ctx, a: Args) {
  const w = c.w;
  const r = R(c);
  const staged = a.flag('--staged', '--cached');
  const stat = a.flag('--stat');
  const dd = a.dashdash();
  a.noUnknownFlags('diff');
  const tracked = (): FileMap => {
    const t: FileMap = {};
    for (const p of Object.keys(r.index)) if (p in w.files) t[p] = w.files[p];
    return t;
  };
  let from: FileMap;
  let to: FileMap;
  const revs = a.rest;
  if (revs.length === 1 && revs[0].includes('..')) {
    const [x, y] = revs[0].split('..');
    from = treeOf(w, resolveRev(w, x || 'HEAD'));
    to = treeOf(w, resolveRev(w, y || 'HEAD'));
  } else if (revs.length === 2) {
    from = treeOf(w, resolveRev(w, revs[0]));
    to = treeOf(w, resolveRev(w, revs[1]));
  } else if (revs.length === 1) {
    from = treeOf(w, resolveRev(w, revs[0]));
    to = staged ? r.index : tracked();
  } else {
    from = staged ? headTree(w) : r.index;
    to = staged ? r.index : tracked();
  }
  if (dd?.length) {
    const keep = new Set(matchPaths(dd, pathsOf(from, to), (s) => new GitError(`fatal: ambiguous argument '${s}'`)));
    from = Object.fromEntries(Object.entries(from).filter(([p]) => keep.has(p)));
    to = Object.fromEntries(Object.entries(to).filter(([p]) => keep.has(p)));
  }
  if (stat) statLines(from, to).forEach((l) => c.out(l));
  else printDiff(c, from, to);
  if (!revs.length && sameTree(from, to)) {
    c.explain(staged ? 'Nothing staged. (git diff --staged compares the staging area with your last commit.)' : 'No unstaged changes. (Plain git diff compares your files with the staging area. Try git diff --staged for staged changes.)');
  }
}

function show(c: Ctx, a: Args) {
  const w = c.w;
  a.noUnknownFlags('show');
  const id = resolveRev(w, a.rest[0] ?? 'HEAD');
  const cm = w.objects[id];
  const d = decorations(w).get(id);
  c.out(`commit ${cm.id}${d ? ` (${d.join(', ')})` : ''}`);
  if (cm.parents.length > 1) c.out(`Merge: ${cm.parents.map(short).join(' ')}`);
  c.out(`Author: ${cm.author} <${cm.email}>\nDate:   ${formatDate(cm.time)}\n`);
  cm.message.split('\n').forEach((l) => c.out(`    ${l}`));
  c.out('');
  printDiff(c, treeOf(w, cm.parents[0]), cm.tree);
}

function help(c: Ctx, cmd?: string) {
  if (cmd && COMMAND_DOCS[cmd]) {
    const d = COMMAND_DOCS[cmd];
    c.print('success', `git ${cmd}: ${d.summary}`);
    d.usage.forEach((u) => c.out(`   ${u}`));
    return;
  }
  c.out('Supported git commands (type git <command> -h for details):');
  const names = Object.keys(COMMAND_DOCS);
  for (let i = 0; i < names.length; i += 6) c.out('   ' + names.slice(i, i + 6).map((n) => n.padEnd(12)).join(''));
}

const COMMANDS: Record<string, (c: Ctx, a: Args) => void> = {
  init,
  config,
  status,
  add,
  rm,
  commit,
  log,
  reflog,
  branch,
  switch: switchCmd,
  checkout,
  restore,
  reset,
  merge,
  rebase,
  'cherry-pick': (c, a) => pickLike(c, a, 'cherry-pick'),
  revert: (c, a) => pickLike(c, a, 'revert'),
  stash,
  fetch,
  pull,
  push,
  remote,
  diff,
  show,
};

/** Commands that work before `git init`. */
const NO_REPO_OK = new Set(['init', 'config', 'help']);

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

export function runGit(c: Ctx, argv: string[], depth = 0) {
  const [sub, ...rest] = argv;
  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') return help(c, rest[0]);
  if (sub === '--version') return c.out('git version 2.47.0 (git-learn simulator)');
  if (rest.includes('-h') || rest.includes('--help')) return help(c, sub);
  const alias = c.w.repo?.config[`alias.${sub}`] ?? c.w.globalConfig[`alias.${sub}`];
  if (!COMMANDS[sub] && alias && depth < 5) {
    return runGit(c, [...alias.split(/\s+/).filter(Boolean), ...rest], depth + 1);
  }
  const fn = COMMANDS[sub];
  if (!fn) {
    const best = Object.keys(COMMANDS)
      .map((n) => [n, levenshtein(sub, n)] as const)
      .sort((x, y) => x[1] - y[1])[0];
    throw new GitError(`git: '${sub}' is not a git command. See 'git --help'.`, ...(best && best[1] <= 2 ? ['', 'The most similar command is', `\t${best[0]}`] : []));
  }
  if (!c.w.repo && !NO_REPO_OK.has(sub) && !(sub === 'config' && rest.includes('--global'))) {
    throw new GitError('fatal: not a git repository (or any of the parent directories): .git');
  }
  let args = rest;
  if (sub === 'commit') {
    // expand combined short flags like -am
    args = rest.flatMap((x) => (/^-[a-z]{2,}$/.test(x) ? x.slice(1).split('').map((ch) => `-${ch}`) : [x]));
  }
  fn(c, new Args(args));
}
