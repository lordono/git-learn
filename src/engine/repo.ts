import type { Commit, FileMap, Line, LineKind, Repo, World } from './types';

export class GitError extends Error {
  lines: string[];
  constructor(...lines: string[]) {
    super(lines[0]);
    this.lines = lines;
  }
}

/** Collects output for one command and gives access to the world being mutated. */
export class Ctx {
  lines: Line[] = [];
  ok = true;
  constructor(public w: World) {}
  print(kind: LineKind, text: string) {
    this.lines.push({ kind, text });
  }
  out(text: string) {
    for (const t of text.split('\n')) this.print(t.startsWith('hint:') ? 'hint' : 'out', t);
  }
  err(text: string) {
    for (const t of text.split('\n')) this.print(t.startsWith('hint:') ? 'hint' : 'err', t);
  }
  explain(text: string) {
    this.print('explain', text);
  }
  warn(text: string) {
    this.print('warn', text);
  }
  get repo(): Repo {
    if (!this.w.repo)
      throw new GitError('fatal: not a git repository (or any of the parent directories): .git');
    return this.w.repo;
  }
}

export const short = (id: string) => id.slice(0, 7);
export const firstLine = (msg: string) => msg.split('\n')[0];
export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function fnv(str: string, seed: number): string {
  let h = (0x811c9dc5 ^ seed) >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function makeId(seed: string): string {
  return [1, 2, 3, 4, 5].map((i) => fnv(seed, Math.imul(i, 2654435761))).join('');
}

const BASE_TIME = Date.UTC(2026, 0, 5, 9, 0);
export const nextSeq = (w: World) => ++w.seq;

export function cfg(w: World, key: string): string | undefined {
  const k = key.toLowerCase();
  return w.repo?.config[k] ?? w.globalConfig[k];
}

export function identity(w: World): { name: string; email: string } {
  const name = cfg(w, 'user.name');
  const email = cfg(w, 'user.email');
  if (!name || !email) {
    throw new GitError(
      'Author identity unknown',
      '',
      '*** Please tell me who you are.',
      '',
      'Run',
      '',
      '  git config --global user.email "you@example.com"',
      '  git config --global user.name "Your Name"',
      '',
      "to set your account's default identity.",
      'Omit --global to set the identity only in this repository.',
      '',
      `fatal: unable to auto-detect ${!email ? 'email address' : 'name'}`,
    );
  }
  return { name, email };
}

export function createCommit(
  w: World,
  opts: { parents: string[]; message: string; tree: FileMap; author?: { name: string; email: string } },
): string {
  const seq = nextSeq(w);
  const author = opts.author ?? identity(w);
  const id = makeId(`${seq}|${opts.parents.join(',')}|${opts.message}|${author.name}`);
  w.objects[id] = {
    id,
    parents: opts.parents,
    message: opts.message,
    tree: { ...opts.tree },
    author: author.name,
    email: author.email,
    time: BASE_TIME + seq * 17 * 60_000,
    seq,
  };
  return id;
}

export function headId(w: World): string | null {
  const r = w.repo;
  if (!r) return null;
  return r.head.kind === 'branch' ? (r.branches[r.head.name] ?? null) : r.head.id;
}

export const currentBranch = (w: World): string | null =>
  w.repo?.head.kind === 'branch' ? w.repo.head.name : null;

export const treeOf = (w: World, id: string | null | undefined): FileMap =>
  id ? w.objects[id].tree : {};

export const headTree = (w: World) => treeOf(w, headId(w));

export function ancestors(w: World, id: string): Set<string> {
  const seen = new Set<string>();
  const stack = [id];
  while (stack.length) {
    const c = stack.pop()!;
    if (seen.has(c)) continue;
    seen.add(c);
    stack.push(...w.objects[c].parents);
  }
  return seen;
}

/** true if `a` is `b` or an ancestor of `b` */
export const isAncestor = (w: World, a: string, b: string) => ancestors(w, b).has(a);

export function mergeBase(w: World, a: string, b: string): string | null {
  const A = ancestors(w, a);
  let best: Commit | null = null;
  for (const id of ancestors(w, b)) {
    if (A.has(id) && (!best || w.objects[id].seq > best.seq)) best = w.objects[id];
  }
  return best?.id ?? null;
}

/** commits reachable from `a` but not from `b`, newest first */
export function exclusive(w: World, a: string, b: string | null | undefined): Commit[] {
  const B = b ? ancestors(w, b) : new Set<string>();
  return [...ancestors(w, a)]
    .filter((id) => !B.has(id))
    .map((id) => w.objects[id])
    .sort((x, y) => y.seq - x.seq);
}

/** Every commit the local repo can still reach through a ref (what `git log --all` sees). */
export function reachable(w: World): Set<string> {
  const r = w.repo;
  const out = new Set<string>();
  if (!r) return out;
  const tips = [
    ...Object.values(r.branches),
    ...Object.values(r.remoteBranches),
    ...r.stash.map((s) => s.base),
  ];
  const h = headId(w);
  if (h) tips.push(h);
  for (const t of tips) for (const id of ancestors(w, t)) out.add(id);
  return out;
}

/** Move HEAD (and the branch it points at) to `id`, writing a reflog entry. */
export function moveHead(w: World, id: string, msg: string) {
  const r = w.repo!;
  if (r.head.kind === 'branch') r.branches[r.head.name] = id;
  else r.head = { kind: 'detached', id };
  r.reflog.push({ id, msg });
}

export function pathsOf(...maps: FileMap[]): string[] {
  const s = new Set<string>();
  for (const m of maps) for (const k of Object.keys(m)) s.add(k);
  return [...s].sort();
}

export const sameTree = (a: FileMap, b: FileMap) =>
  pathsOf(a, b).every((p) => a[p] === b[p]);

function walk(w: World, id: string, suffix: string, rev: string): string {
  let cur = id;
  const re = /([~^])(\d*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(suffix))) {
    const n = m[2] === '' ? 1 : Number(m[2]);
    if (m[1] === '~') {
      for (let i = 0; i < n; i++) {
        const p = w.objects[cur].parents[0];
        if (!p) throw unknownRev(rev);
        cur = p;
      }
    } else if (n > 0) {
      const p = w.objects[cur].parents[n - 1];
      if (!p) throw unknownRev(rev);
      cur = p;
    }
  }
  return cur;
}

const unknownRev = (rev: string) =>
  new GitError(
    `fatal: ambiguous argument '${rev}': unknown revision or path not in the working tree.`,
    "Use '--' to separate paths from revisions, like this:",
    "'git <command> [<revision>...] -- [<file>...]'",
  );

export function tryResolve(w: World, rev: string): string | null {
  try {
    return resolveRev(w, rev);
  } catch {
    return null;
  }
}

/** Resolve HEAD, HEAD~2, main^, origin/main, HEAD@{1}, ORIG_HEAD, abc1234 ... */
export function resolveRev(w: World, rev: string): string {
  const r = w.repo;
  if (!r) throw new GitError('fatal: not a git repository (or any of the parent directories): .git');
  const m = rev.match(/^(.+?)((?:[~^]\d*)*)$/);
  if (!m) throw unknownRev(rev);
  const [, base, suffix] = m;
  let id: string | undefined;
  const reflogMatch = base.match(/^(HEAD|@)?@\{(\d+)\}$/) ?? base.match(/^(HEAD)@\{(\d+)\}$/);
  if (base === 'HEAD' || base === '@') {
    const h = headId(w);
    if (!h) {
      throw new GitError(
        `fatal: ambiguous argument '${rev}': unknown revision or path not in the working tree.`,
        '(there are no commits yet, so HEAD does not point anywhere)',
      );
    }
    id = h;
  } else if (reflogMatch) {
    const n = Number(reflogMatch[2]);
    const entry = r.reflog[r.reflog.length - 1 - n];
    if (!entry) throw new GitError(`fatal: log for 'HEAD' only has ${r.reflog.length} entries`);
    id = entry.id;
  } else if (base === 'ORIG_HEAD') {
    id = r.origHead;
  } else if (r.branches[base.replace(/^refs\/heads\//, '')]) {
    id = r.branches[base.replace(/^refs\/heads\//, '')];
  } else if (r.remoteBranches[base.replace(/^(refs\/)?remotes\//, '')]) {
    id = r.remoteBranches[base.replace(/^(refs\/)?remotes\//, '')];
  } else if (/^[0-9a-f]{4,40}$/.test(base)) {
    const hits = Object.keys(w.objects).filter((k) => k.startsWith(base));
    if (hits.length > 1) throw new GitError(`error: short object ID ${base} is ambiguous`);
    id = hits[0];
  }
  if (!id) throw unknownRev(rev);
  return walk(w, id, suffix, rev);
}

/** labels pointing at each commit, git-log style */
export function decorations(w: World): Map<string, string[]> {
  const r = w.repo;
  const map = new Map<string, string[]>();
  if (!r) return map;
  const add = (id: string, label: string) => map.set(id, [...(map.get(id) ?? []), label]);
  const cur = currentBranch(w);
  const h = headId(w);
  if (h && !cur) add(h, 'HEAD');
  for (const [b, id] of Object.entries(r.branches)) add(id, b === cur ? `HEAD -> ${b}` : b);
  for (const [b, id] of Object.entries(r.remoteBranches)) add(id, b);
  for (const [id, labels] of map) {
    map.set(id, labels.sort((a, b) => Number(b.startsWith('HEAD')) - Number(a.startsWith('HEAD'))));
  }
  return map;
}

export function formatDate(t: number): string {
  const d = new Date(t);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${days[d.getUTCDay()]} ${months[d.getUTCMonth()]} ${d.getUTCDate()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00 ${d.getUTCFullYear()} +0000`;
}

export function newRepo(defaultBranch: string): Repo {
  return {
    branches: {},
    head: { kind: 'branch', name: defaultBranch },
    index: {},
    reflog: [],
    config: {},
    remotes: {},
    remoteBranches: {},
    upstream: {},
    conflicts: [],
    stash: [],
  };
}

export const clone = <T>(x: T): T => structuredClone(x);
