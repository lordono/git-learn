import { describe, expect, it } from 'vitest';
import { runLine, saveEditor } from './shell';
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

describe('newer engine features', () => {
  const conflicted = () => {
    const s = new Scenario().run('git init').commit({ 'c.txt': 'base\n' }, 'base').run('git switch -c other');
    s.commit({ 'c.txt': 'theirs\n' }, 'theirs').run('git switch main').commit({ 'c.txt': 'ours\n' }, 'ours');
    return s.runExpectFail('git merge other').w;
  };
  it('checkout --ours / --theirs picks a side of a conflict', () => {
    expect(sh(conflicted(), 'git checkout --theirs c.txt').w.files['c.txt']).toBe('theirs\n');
    const { w, out } = sh(conflicted(), 'git restore --ours c.txt', 'git add c.txt', 'git commit -m m');
    expect(w.files['c.txt']).toBe('ours\n');
    expect(out).toContain('Merge concluded');
  });
  it('modify/delete conflicts get their own message and git rm resolves them', () => {
    const s = new Scenario().run('git init').commit({ 'c.txt': 'base\n' }, 'base').run('git switch -c other');
    s.commit({ 'c.txt': null }, 'delete').run('git switch main').commit({ 'c.txt': 'edit\n' }, 'edit');
    const { w, out } = sh(s.w, 'git merge other', 'git rm c.txt', 'git commit -m m');
    expect(out).toContain('CONFLICT (modify/delete)');
    expect(w.files['c.txt']).toBeUndefined();
    expect(w.repo!.conflicts).toEqual([]);
  });
  it('revert -m 1 undoes a merge', () => {
    const s = new Scenario().run('git init').commit({ 'a.txt': 'a\n' }, 'base').run('git switch -c f');
    s.commit({ 'f.txt': 'f\n' }, 'feature').run('git switch main').commit({ 'b.txt': 'b\n' }, 'main work').run('git merge f -m merge');
    expect(sh(s.w, 'git revert HEAD').out).toContain('no -m option');
    const { w } = sh(s.w, 'git revert -m 1 HEAD');
    expect(w.files['f.txt']).toBeUndefined();
    expect(w.files['b.txt']).toBe('b\n');
  });
  it('a dropped stash can be applied by its sha', () => {
    const s = new Scenario().run('git init').commit({ 'a.txt': 'a\n' }, 'base').write({ 'a.txt': 'wip\n' }).run('git stash');
    const id = s.w.repo!.stash[0].id;
    const { w, out } = sh(s.w, 'git stash drop', 'git fsck --lost-found', `git stash apply ${id.slice(0, 7)}`);
    expect(out).toContain(`dangling commit ${id}`);
    expect(w.files['a.txt']).toBe('wip\n');
  });
  it('clean needs -f, dry-runs with -n and skips folders without -d', () => {
    const s = new Scenario().run('git init').commit({ 'a.txt': 'a\n' }, 'base').write({ 'junk.log': 'x', 'tmp/out.txt': 'y' });
    expect(sh(s.w, 'git clean').out).toContain('refusing to clean');
    const dry = sh(s.w, 'git clean -n');
    expect(dry.out).toContain('Would remove junk.log');
    expect(dry.out).not.toContain('Would remove tmp/');
    expect(dry.w.files['junk.log']).toBe('x');
    const { w } = sh(s.w, 'git clean -fd');
    expect(Object.keys(w.files)).toEqual(['a.txt']);
  });
  it('tags: create, push, refuse to move on origin without force', () => {
    const s = new Scenario().run('git init').commit({ 'a.txt': 'a\n' }, 'one').withRemote().commit({ 'a.txt': 'b\n' }, 'two');
    const { w, out } = sh(s.w, 'git tag v1 HEAD~1', 'git push origin v1', 'git tag -f v1', 'git push origin v1');
    expect(out).toContain('[new tag]');
    expect(out).toContain('(already exists)');
    expect(w.remote!.tags!.v1).toBe(w.objects[headId(w)!].parents[0]);
    const fixed = sh(w, 'git push origin --delete v1', 'git push origin v1').w;
    expect(fixed.remote!.tags!.v1).toBe(headId(fixed));
  });
  it('amend keeps the author unless --reset-author', () => {
    const s = new Scenario().run('git init').commit({ 'a.txt': 'a\n' }, 'one').run('git config user.email work@corp.com');
    expect(sh(s.w, 'git commit --amend --no-edit').w.objects[headId(sh(s.w, 'git commit --amend --no-edit').w)!].email).toBe('you@example.com');
    const { w } = sh(s.w, 'git commit --amend --no-edit --reset-author');
    expect(w.objects[headId(w)!].email).toBe('work@corp.com');
  });
  it('PR-only branches reject any direct push', () => {
    const s = new Scenario().run('git init').commit({ 'a.txt': 'a\n' }, 'one').withRemote();
    s.w.remote!.prOnly = ['main'];
    const { out } = sh(s.commit({ 'a.txt': 'b\n' }, 'two').w, 'git push');
    expect(out).toContain('Changes must be made through a pull request');
  });
});

describe('interactive rebase', () => {
  const four = () => {
    const s = new Scenario().run('git init').commit({ 'a.txt': '0\n' }, 'base');
    s.commit({ 'a.txt': '1\n' }, 'one').commit({ 'b.txt': 'b\n' }, 'two').commit({ 'c.txt': 'c\n' }, 'three');
    return s.w;
  };
  /** run `git rebase -i`, then save the todo (or a function of the proposed todo) */
  const rebaseI = (w: World, todo: (proposed: string) => string, base = 'HEAD~3') => {
    let r = runLine(w, `git rebase -i ${base}`);
    const pe = r.world.repo!.pendingEdit!;
    expect(pe.purpose).toBe('todo');
    const out = r.lines.map((l) => l.text);
    r = saveEditor(r.world, todo(pe.text));
    return { w: r.world, out: [...out, ...r.lines.map((l) => l.text)].join('\n') };
  };
  const msgs = (w: World) => {
    const out: string[] = [];
    let id = headId(w);
    while (id) {
      out.push(w.objects[id].message);
      id = w.objects[id].parents[0];
    }
    return out;
  };
  const lineOf = (text: string, msg: string) => text.split('\n').find((l) => l.endsWith(` ${msg}`))!;

  it('lists commits oldest first and keeps ids when nothing changes', () => {
    const start = four();
    const { w } = rebaseI(start, (t) => {
      expect(t.split('\n').slice(0, 3).map((l) => l.split(' ')[2])).toEqual(['one', 'two', 'three']);
      return t;
    });
    expect(headId(w)).toBe(headId(start));
    expect(w.repo!.op).toBeUndefined();
  });
  it('squash melds commits and asks for the combined message', () => {
    const { w, out } = rebaseI(four(), (t) => t.replace(lineOf(t, 'two'), lineOf(t, 'two').replace('pick', 'squash')).replace(lineOf(t, 'three'), lineOf(t, 'three').replace('pick', 's')));
    const pe = w.repo!.pendingEdit!;
    expect(pe.purpose).toBe('squash');
    expect(pe.text).toContain('This is a combination of 3 commits');
    expect(out).toContain('Waiting for your editor');
    const done = saveEditor(w, 'One, two and three\n').world;
    expect(msgs(done)).toEqual(['One, two and three', 'base']);
    expect(Object.keys(done.files).sort()).toEqual(['a.txt', 'b.txt', 'c.txt']);
    expect(done.repo!.op).toBeUndefined();
  });
  it('fixup melds without asking and keeps the first message', () => {
    const { w } = rebaseI(four(), (t) => t.replace(/^pick (\w+) two$/m, 'fixup $1 two').replace(/^pick (\w+) three$/m, 'f $1 three'));
    expect(w.repo!.pendingEdit).toBeUndefined();
    expect(msgs(w)).toEqual(['one', 'base']);
  });
  it('reword opens the message editor', () => {
    const { w } = rebaseI(four(), (t) => t.replace(/^pick (\w+) two$/m, 'reword $1 two'));
    expect(w.repo!.pendingEdit!.text.startsWith('two\n')).toBe(true);
    expect(msgs(saveEditor(w, 'Add b.txt\n# comment\n').world)).toEqual(['three', 'Add b.txt', 'one', 'base']);
  });
  it('drop and deleting a line both remove commits; reorder works', () => {
    const { w, out } = rebaseI(four(), (t) => [lineOf(t, 'three'), lineOf(t, 'one').replace('pick', 'drop')].join('\n'));
    expect(msgs(w)).toEqual(['three', 'base']);
    expect(out).toContain('no line in the todo list');
    expect(w.files['b.txt']).toBeUndefined();
  });
  it('edit stops so you can amend, then --continue finishes', () => {
    const { w, out } = rebaseI(four(), (t) => t.replace(/^pick (\w+) one$/m, 'edit $1 one'));
    expect(out).toContain('Stopped at');
    const r = sh(w, 'echo 1b > a.txt', 'git add a.txt', 'git rebase --continue');
    expect(r.out).toContain('staged changes');
    const done = sh(w, 'echo 1b > a.txt', 'git add a.txt', 'git commit --amend --no-edit', 'git rebase --continue').w;
    expect(msgs(done)).toEqual(['three', 'two', 'one', 'base']);
    expect(done.files['a.txt']).toBe('1b\n');
  });
  it('a bad todo can be fixed with --edit-todo; an empty one cancels', () => {
    const bad = rebaseI(four(), (t) => t.replace('pick', 'pik'));
    expect(bad.out).toContain("invalid command 'pik'");
    expect(bad.w.repo!.op?.kind).toBe('rebase');
    const reopened = runLine(bad.w, 'git rebase --edit-todo').world;
    const fixed = saveEditor(reopened, reopened.repo!.pendingEdit!.text.replace('pik', 'pick')).world;
    expect(fixed.repo!.op).toBeUndefined();
    const empty = rebaseI(four(), () => '# nothing\n');
    expect(empty.out).toContain('nothing to do');
    expect(empty.w.repo!.op).toBeUndefined();
  });
  it('squash as the first line is refused', () => {
    expect(rebaseI(four(), (t) => t.replace('pick', 'squash')).out).toContain("cannot 'squash' without a previous commit");
  });
  it('a conflict during squash continues into the message editor', () => {
    const s = new Scenario().run('git init').commit({ 'a.txt': '0\n' }, 'base');
    s.commit({ 'a.txt': '1\n' }, 'one').commit({ 'b.txt': 'b\n' }, 'two').commit({ 'a.txt': '2\n' }, 'three');
    // reorder so "three" (edits a.txt) is squashed into "two" before "one" is applied: conflict
    const { w } = rebaseI(s.w, (t) => [lineOf(t, 'two'), lineOf(t, 'three').replace('pick', 'squash'), lineOf(t, 'one')].join('\n'));
    expect(w.repo!.conflicts).toEqual(['a.txt']);
    const r = sh(w, 'echo 2 > a.txt', 'git add a.txt', 'git rebase --continue');
    expect(r.w.repo!.pendingEdit?.purpose).toBe('squash');
  });
  it('plain git commit opens the message editor', () => {
    const s = new Scenario().run('git init').commit({ 'a.txt': '0\n' }, 'base').write({ 'a.txt': '1\n' });
    const opened = runLine(runLine(s.w, 'git add a.txt').world, 'git commit').world;
    expect(opened.repo!.pendingEdit?.purpose).toBe('commit');
    expect(runLine(opened, 'git status').lines[0].text).toContain('waiting for your editor');
    expect(msgs(saveEditor(opened, 'Bump a\n').world)[0]).toBe('Bump a');
    expect(saveEditor(opened, '# only comments\n').lines[0].text).toContain('empty commit message');
  });
});
