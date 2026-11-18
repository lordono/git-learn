import { GitError, headTree, pathsOf } from './repo';
import type { FileMap, World } from './types';
import { diffLines } from './merge';

export type StatusEntry = { kind: string; path: string };

export function computeStatus(w: World) {
  const r = w.repo!;
  const head = headTree(w);
  const conflicts = new Set(r.conflicts);
  const staged: StatusEntry[] = [];
  const unstaged: StatusEntry[] = [];
  for (const p of pathsOf(head, r.index)) {
    if (conflicts.has(p) || head[p] === r.index[p]) continue;
    staged.push({ kind: !(p in head) ? 'new file' : !(p in r.index) ? 'deleted' : 'modified', path: p });
  }
  for (const p of Object.keys(r.index).sort()) {
    if (conflicts.has(p) || w.files[p] === r.index[p]) continue;
    unstaged.push({ kind: p in w.files ? 'modified' : 'deleted', path: p });
  }
  const ignored = ignoreMatcher(w);
  const untracked = Object.keys(w.files)
    .filter((p) => !(p in r.index) && !conflicts.has(p) && !ignored(p))
    .sort();
  return { staged, unstaged, untracked, conflicts: [...conflicts].sort() };
}

export function isDirty(w: World) {
  const s = computeStatus(w);
  return s.staged.length > 0 || s.unstaged.length > 0 || s.conflicts.length > 0;
}

/**
 * Update index + working tree from HEAD's tree to `target`, keeping local
 * modifications that don't collide (what checkout / switch / fast-forward do).
 * Returns the paths that still carry local changes.
 */
export function carryTo(w: World, target: FileMap, opName: string, verb: string): string[] {
  const r = w.repo!;
  const from = headTree(w);
  const blocked: string[] = [];
  const untrackedBlocked: string[] = [];
  const all = pathsOf(from, target, r.index, w.files);
  for (const p of all) {
    if (from[p] === target[p]) continue;
    const tracked = p in from || p in r.index;
    if (!tracked) {
      if (p in w.files && w.files[p] !== target[p]) untrackedBlocked.push(p);
      continue;
    }
    const localChange = r.index[p] !== from[p] || w.files[p] !== r.index[p];
    if (localChange && !(r.index[p] === target[p] && w.files[p] === target[p])) blocked.push(p);
  }
  if (blocked.length) {
    throw new GitError(
      `error: Your local changes to the following files would be overwritten by ${opName}:`,
      ...blocked.map((p) => `\t${p}`),
      `Please commit your changes or stash them before you ${verb}.`,
      'Aborting',
    );
  }
  if (untrackedBlocked.length) {
    throw new GitError(
      `error: The following untracked working tree files would be overwritten by ${opName}:`,
      ...untrackedBlocked.map((p) => `\t${p}`),
      `Please move or remove them before you ${verb}.`,
      'Aborting',
    );
  }
  for (const p of all) {
    if (from[p] === target[p]) continue;
    if (target[p] === undefined) {
      delete r.index[p];
      delete w.files[p];
    } else {
      r.index[p] = target[p];
      w.files[p] = target[p];
    }
  }
  return pathsOf(r.index, from).filter(
    (p) => (r.index[p] !== target[p] || w.files[p] !== r.index[p]) && (p in r.index || p in target),
  );
}

/** Make index and tracked files match `target`. Untracked files survive. */
export function hardReset(w: World, target: FileMap) {
  const r = w.repo!;
  for (const p of pathsOf(headTree(w), r.index, target)) {
    if (p in target) w.files[p] = target[p];
    else delete w.files[p];
  }
  r.index = { ...target };
}

export function statLines(a: FileMap, b: FileMap): string[] {
  const lines: string[] = [];
  let ins = 0;
  let del = 0;
  let files = 0;
  for (const p of pathsOf(a, b)) {
    if (a[p] === b[p]) continue;
    const d = diffLines(a[p] ?? '', b[p] ?? '');
    const plus = d.filter((x) => x.t === '+').length;
    const minus = d.filter((x) => x.t === '-').length;
    ins += plus;
    del += minus;
    files++;
    lines.push(` ${p} | ${plus + minus} ${'+'.repeat(Math.min(plus, 20))}${'-'.repeat(Math.min(minus, 20))}`);
  }
  if (files) {
    let s = ` ${files} file${files === 1 ? '' : 's'} changed`;
    if (ins) s += `, ${ins} insertion${ins === 1 ? '' : 's'}(+)`;
    if (del) s += `, ${del} deletion${del === 1 ? '' : 's'}(-)`;
    lines.push(s);
  }
  return lines;
}

/** Resolve pathspecs ('.', dirs, simple globs) against a set of known paths. */
export function matchPaths(specs: string[], universe: string[], onMissing: (spec: string) => GitError): string[] {
  const out = new Set<string>();
  for (const raw of specs) {
    const spec = raw.replace(/^\.\//, '').replace(/\/$/, '');
    let hits: string[];
    if (spec === '.' || spec === '' || spec === ':/') hits = universe;
    else if (spec.includes('*')) {
      const re = new RegExp('^' + spec.split('*').map(escapeRe).join('.*') + '$');
      hits = universe.filter((p) => re.test(p) || re.test(p.split('/').pop()!));
    } else hits = universe.filter((p) => p === spec || p.startsWith(spec + '/'));
    if (!hits.length) throw onMissing(raw);
    hits.forEach((h) => out.add(h));
  }
  return [...out].sort();
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Minimal .gitignore support: names, simple globs and dir/ prefixes. */
export function ignoreMatcher(w: World): (path: string) => boolean {
  const txt = w.files['.gitignore'];
  if (!txt) return () => false;
  const pats = txt
    .split('\n')
    .map((x) => x.trim())
    .filter((x) => x && !x.startsWith('#'));
  return (p) =>
    pats.some((pat) => {
      const clean = pat.replace(/^\//, '');
      if (clean.endsWith('/')) return p.startsWith(clean);
      const re = new RegExp('^' + clean.split('*').map(escapeRe).join('[^/]*') + '$');
      return re.test(p) || re.test(p.split('/').pop()!);
    });
}
