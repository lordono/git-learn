import { runLine } from '../engine/shell';
import { ancestors, createCommit, treeOf } from '../engine/repo';
import type { World } from '../engine/types';

export const ORIGIN_URL = 'https://git.example.com/team/shop.git';

export const TEAMMATES = {
  alex: { name: 'Alex', email: 'alex@example.com' },
  sam: { name: 'Sam', email: 'sam@example.com' },
};

/** Builds a level's starting world by running real commands through the engine. */
export class Scenario {
  w: World = { objects: {}, seq: 0, files: {}, repo: null, remote: null, globalConfig: {} };

  constructor(opts: { identity?: boolean } = {}) {
    if (opts.identity !== false) {
      this.w.globalConfig['user.name'] = 'You';
      this.w.globalConfig['user.email'] = 'you@example.com';
    }
  }

  run(...lines: string[]) {
    for (const line of lines) {
      const r = runLine(this.w, line);
      if (!r.ok) throw new Error(`level setup failed at "${line}":\n${r.lines.map((l) => l.text).join('\n')}`);
      this.w = r.world;
    }
    return this;
  }

  /** run a command that is expected to fail (e.g. a rebase that stops on a conflict) */
  runExpectFail(line: string) {
    this.w = runLine(this.w, line).world;
    return this;
  }

  write(files: Record<string, string | null>) {
    for (const [p, v] of Object.entries(files)) {
      if (v === null) delete this.w.files[p];
      else this.w.files[p] = v;
    }
    return this;
  }

  commit(files: Record<string, string | null>, message: string) {
    this.write(files);
    return this.run('git add -A', `git commit -m ${JSON.stringify(message)}`);
  }

  withRemote(opts: { protect?: string[] } = {}) {
    this.w.remote = { url: ORIGIN_URL, branches: {}, protectedBranches: opts.protect ?? [] };
    return this.run(`git remote add origin ${ORIGIN_URL}`, 'git push -u origin main');
  }

  /** A teammate pushes a commit straight to the server (you haven't fetched it). */
  teammatePush(
    who: { name: string; email: string },
    branch: string,
    changes: Record<string, string | null>,
    message: string,
    opts: { parentBranch?: string } = {},
  ) {
    teammatePush(this.w, who, branch, changes, message, opts);
    return this;
  }

  /** Do something directly on the server (merge a PR, delete a branch…). */
  server(fn: (remote: NonNullable<World['remote']>, w: World) => void) {
    fn(this.w.remote!, this.w);
    return this;
  }
}

export function teammatePush(
  w: World,
  who: { name: string; email: string },
  branch: string,
  changes: Record<string, string | null>,
  message: string,
  /** parentBranch: build on another server branch instead (used to fake a force push) */
  opts: { parentBranch?: string } = {},
): string {
  const rem = w.remote!;
  const parent = rem.branches[opts.parentBranch ?? branch];
  const tree = { ...treeOf(w, parent) };
  for (const [p, v] of Object.entries(changes)) {
    if (v === null) delete tree[p];
    else tree[p] = v;
  }
  const id = createCommit(w, { parents: parent ? [parent] : [], message, tree, author: who });
  rem.branches[branch] = id;
  return id;
}

// ───── helpers for goal checks ─────

export const branchTip = (w: World, b: string) => w.repo?.branches[b];

export function hasMessage(w: World, tip: string | undefined, msg: string): boolean {
  if (!tip) return false;
  return [...ancestors(w, tip)].some((id) => w.objects[id].message === msg);
}

export const remoteHas = (w: World, branch: string, msg: string) => hasMessage(w, w.remote?.branches[branch], msg);

export const isClean = (w: World) => {
  const r = w.repo;
  if (!r) return false;
  const head = r.head.kind === 'branch' ? r.branches[r.head.name] : r.head.id;
  const t = treeOf(w, head);
  const keys = new Set([...Object.keys(t), ...Object.keys(r.index)]);
  return !r.op && !r.conflicts.length && [...keys].every((p) => t[p] === r.index[p] && r.index[p] === w.files[p]);
};

/** Commits along the first-parent line from `tip` (the branch's "main line"). */
export function firstParentChain(w: World, tip: string | undefined): string[] {
  const out: string[] = [];
  let id = tip;
  while (id) {
    out.push(id);
    id = w.objects[id].parents[0];
  }
  return out;
}

export const isLinear = (w: World, tip: string | undefined) =>
  !!tip && [...ancestors(w, tip)].every((id) => w.objects[id].parents.length <= 1);

/** A rebase todo list that names commits by message (resolved to short ids in world `w`). */
export function todoFor(w: World, steps: [string, string][]): string {
  return steps
    .map(([cmd, msg]) => {
      const c = Object.values(w.objects).find((x) => x.message === msg);
      if (!c) throw new Error(`todoFor: no commit "${msg}"`);
      return `${cmd} ${c.id.slice(0, 7)} ${msg}`;
    })
    .join('\n');
}
