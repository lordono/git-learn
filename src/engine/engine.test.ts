import { describe, expect, it } from 'vitest';
import { runLine } from './shell';
import { Scenario } from '../levels/scenario';
import { headId } from './repo';
import type { World } from './types';

function sh(w: World, ...lines: string[]) {
  let out = '';
  for (const l of lines) {
    const r = runLine(w, l);
    out += r.lines.map((x) => x.text).join('\n') + '\n';
    w = r.world;
  }
  return { w, out };
}

const base = () =>
  new Scenario()
    .run('git init')
    .commit({ 'a.txt': 'one\n' }, 'first')
    .commit({ 'a.txt': 'one\ntwo\n' }, 'second').w;

describe('reset modes', () => {
  it('--soft keeps changes staged', () => {
    const { w } = sh(base(), 'git reset --soft HEAD~1');
    expect(w.repo!.index['a.txt']).toBe('one\ntwo\n');
    expect(w.files['a.txt']).toBe('one\ntwo\n');
  });
  it('--mixed keeps changes unstaged', () => {
    const { w } = sh(base(), 'git reset HEAD~1');
    expect(w.repo!.index['a.txt']).toBe('one\n');
    expect(w.files['a.txt']).toBe('one\ntwo\n');
  });
  it('--hard resets files, and HEAD@{1} undoes it', () => {
    const start = base();
    const { w, out } = sh(start, 'git reset --hard HEAD~1');
    expect(w.files['a.txt']).toBe('one\n');
    expect(out).toContain('no longer on any branch');
    const back = sh(w, 'git reset --hard HEAD@{1}').w;
    expect(headId(back)).toBe(headId(start));
  });
  it('git reset <file> unstages', () => {
    const w0 = sh(base(), 'echo three >> a.txt', 'git add a.txt').w;
    const { w } = sh(w0, 'git reset a.txt');
    expect(w.repo!.index['a.txt']).toBe('one\ntwo\n');
    expect(w.files['a.txt']).toBe('one\ntwo\nthree\n');
  });
});

describe('shell', () => {
  it('supports && chains, redirects and quoting', () => {
    const { w } = sh(base(), 'echo "hello world" > b.txt && echo again >> b.txt');
    expect(w.files['b.txt']).toBe('hello world\nagain\n');
  });
  it('stops a && chain on failure', () => {
    const { w } = sh(base(), 'git checkout nope && echo x > c.txt');
    expect(w.files['c.txt']).toBeUndefined();
  });
});

describe('branches', () => {
  it('fast-forward merge moves the label', () => {
    const { w, out } = sh(base(), 'git switch -c feat', 'echo x > f.txt', 'git add f.txt', 'git commit -m feat', 'git switch main', 'git merge feat');
    expect(out).toContain('Fast-forward');
    expect(w.repo!.branches.main).toBe(w.repo!.branches.feat);
  });
  it('non-conflicting three-way merge makes a merge commit', () => {
    const { w } = sh(
      base(),
      'git switch -c feat', 'echo x > f.txt', 'git add .', 'git commit -m feat',
      'git switch main', 'echo y > g.txt', 'git add .', 'git commit -m main-work',
      'git merge feat',
    );
    expect(w.objects[headId(w)!].parents).toHaveLength(2);
  });
  it('detached HEAD commits trigger a warning when leaving', () => {
    const { out } = sh(base(), 'git checkout HEAD~1', 'echo z > z.txt', 'git add .', 'git commit -m lost', 'git switch main');
    expect(out).toContain('leaving 1 commit behind');
  });
  it('refuses to delete an unmerged branch with -d', () => {
    const { out } = sh(base(), 'git switch -c feat', 'echo x > f.txt', 'git add .', 'git commit -m feat', 'git switch main', 'git branch -d feat');
    expect(out).toContain('not fully merged');
  });
});

describe('aliases and config', () => {
  it('expands aliases', () => {
    const { out } = sh(base(), 'git config alias.st status', 'git st');
    expect(out).toContain('On branch main');
  });
});
