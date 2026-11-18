/** path -> file content */
export type FileMap = Record<string, string>;

export interface Commit {
  id: string;
  parents: string[];
  message: string;
  tree: FileMap;
  author: string;
  email: string;
  time: number;
  /** creation order, used for sorting and graph layout */
  seq: number;
}

export interface ReflogEntry {
  id: string;
  msg: string;
}

export type Head = { kind: 'branch'; name: string } | { kind: 'detached'; id: string };

export interface StashEntry {
  id: string;
  base: string;
  index: FileMap;
  worktree: FileMap;
  message: string;
}

export type Op =
  | { kind: 'merge'; theirs: string; message: string; origHead: string }
  | {
      kind: 'rebase';
      onto: string;
      ontoName: string;
      origHead: string;
      branch: string | null;
      todo: string[];
      current: string | null;
    }
  | { kind: 'cherry-pick' | 'revert'; commit: string; message: string; origHead: string };

export interface Repo {
  branches: Record<string, string>;
  head: Head;
  index: FileMap;
  /** HEAD reflog, oldest first */
  reflog: ReflogEntry[];
  config: Record<string, string>;
  /** remote name -> url */
  remotes: Record<string, string>;
  /** "origin/main" -> commit id (what we knew at the last fetch/push) */
  remoteBranches: Record<string, string>;
  /** local branch -> "origin/main" */
  upstream: Record<string, string>;
  origHead?: string;
  op?: Op;
  conflicts: string[];
  stash: StashEntry[];
  prevBranch?: string;
  /** tag name -> commit id */
  tags: Record<string, string>;
  /** during a conflict: each side's version of a conflicted file (for --ours / --theirs) */
  stages?: Record<string, { ours?: string; theirs?: string }>;
  /** stash entries that were dropped or popped: unreachable but still in the object store */
  lostStashes?: StashEntry[];
}

/** The shared server everyone pushes to (e.g. GitHub). */
export interface RemoteRepo {
  url: string;
  branches: Record<string, string>;
  /** branches that refuse force pushes */
  protectedBranches: string[];
  /** branches that only accept changes through a pull request (no direct pushes at all) */
  prOnly?: string[];
  tags?: Record<string, string>;
}

export interface World {
  /** every commit object ever created (local, remote, teammates) */
  objects: Record<string, Commit>;
  seq: number;
  /** the working directory on disk */
  files: FileMap;
  /** null until `git init` (or after `rm -rf .git`) */
  repo: Repo | null;
  remote: RemoteRepo | null;
  globalConfig: Record<string, string>;
}

export type LineKind =
  | 'cmd'
  | 'out'
  | 'err'
  | 'hint'
  | 'explain'
  | 'warn'
  | 'event'
  | 'success'
  | 'info'
  | 'diff-add'
  | 'diff-del'
  | 'diff-meta';

export interface Line {
  kind: LineKind;
  text: string;
}
