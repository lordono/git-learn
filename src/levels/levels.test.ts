import { describe, expect, it } from 'vitest';
import { LEVELS, type Level } from './levels';
import { fireEvents, isSolved, runStep, startLevel } from './runtime';
import type { World } from '../engine/types';

/** Play commands the way the UI does: run, then fire level events. */
function play(level: Level, lines: string[], start?: World) {
  let w = start ?? startLevel(level).world;
  const fired = new Set<string>();
  const log: string[] = [];
  for (const l of lines) {
    const r = runStep(w, l);
    log.push(`$ ${l}`, ...r.lines.map((x) => `  [${x.kind}] ${x.text}`));
    const ev = fireEvents(level, r.world, l, fired);
    ev.messages.forEach((m) => log.push(`  [event] ${m}`));
    w = ev.world;
  }
  return { w, log: log.join('\n') };
}

const byId = (id: string) => {
  const l = LEVELS.find((x) => x.id === id);
  if (!l) throw new Error(`no level ${id}`);
  return l;
};

it('level ids are unique', () => {
  expect(new Set(LEVELS.map((l) => l.id)).size).toBe(LEVELS.length);
});

describe.each(LEVELS.map((l) => [l.id, l] as const))('level %s', (_id, level) => {
  it('starts unsolved, and its prelude runs', () => {
    const { world, transcript } = startLevel(level);
    expect(isSolved(level, world)).toBe(false);
    expect(transcript).toHaveLength(level.prelude?.length ?? 0);
  });
  it('is solved by its solution', () => {
    const { w, log } = play(level, level.solution);
    const failed = level.goals.filter((g) => !g.check(w)).map((g) => g.text);
    expect(failed, log).toEqual([]);
  });
  it('fires every scripted event during the solution', () => {
    const fired = new Set<string>();
    let w = startLevel(level).world;
    for (const l of level.solution) {
      w = fireEvents(level, runStep(w, l).world, l, fired).world;
    }
    expect([...fired].sort()).toEqual((level.events ?? []).map((e) => e.id).sort());
  });
});

describe('bad moves are caught', () => {
  it('force-pushing over a protected main is rejected', () => {
    const level = byId('revert-pushed');
    const { w, log } = play(level, ['git reset --hard HEAD~2', 'git push --force']);
    expect(log).toContain('protected branch');
    expect(level.goals[0].check(w)).toBe(true);
  });

  it('plain pull on divergent branches asks how to reconcile', () => {
    const { log } = play(byId('push-rejected'), ['git pull']);
    expect(log).toContain('Need to specify how to reconcile divergent branches');
  });

  it('force push warns that a teammate commit was wiped', () => {
    const level = byId('push-rejected');
    const { w, log } = play(level, ['git push --force']);
    expect(log).toContain("teammate's work");
    expect(level.goals[1].check(w)).toBe(false);
  });

  it('force-with-lease refuses when origin moved since the last fetch', () => {
    const { log } = play(byId('lease-saves-you'), ['git push --force-with-lease']);
    expect(log).toContain('stale info');
  });

  it('plain --force in the lease level deletes Alex\'s tests and fails the level', () => {
    const level = byId('lease-saves-you');
    const { w } = play(level, ['git push --force']);
    expect(level.goals[0].check(w)).toBe(false);
  });

  it('reset --hard on uncommitted work warns that it is unrecoverable', () => {
    const { log } = play(byId('stash-pull'), ['git reset --hard']);
    expect(log).toContain('thrown away');
  });

  it('merge --abort restores the pre-merge state', () => {
    const level = byId('merge-conflict');
    const start = startLevel(level).world;
    const { w } = play(level, ['git pull --no-rebase', 'git merge --abort'], start);
    expect(w.repo!.op).toBeUndefined();
    expect(w.files['config.js']).toBe(start.files['config.js']);
  });

  it('moving target: the second push is rejected after Alex pushes mid-merge', () => {
    const { log } = play(byId('moving-target'), byId('moving-target').solution.slice(0, 5));
    expect(log).toContain('Alex: "just pushed analytics');
    expect(log).toContain('[rejected]');
  });

  it('merging header after footer makes header a non-fast-forward', () => {
    const level = byId('fast-forward');
    const { w } = play(level, ['git merge footer', 'git merge header']);
    expect(level.goals[0].check(w)).toBe(false);
  });

  it('branch -d before pulling warns it is not merged to HEAD yet', () => {
    const { log } = play(byId('gone-upstream'), ['git switch main', 'git branch -d holiday-banner']);
    expect(log).toContain('not yet merged to HEAD');
  });

  it('branch -d refuses after prune, until main has the commit', () => {
    const { log } = play(byId('gone-upstream'), ['git fetch --prune', 'git switch main', 'git branch -d holiday-banner']);
    expect(log).toContain('not fully merged');
  });

  it('rm -rf .git deletes the repo', () => {
    const { w } = play(byId('reflog-rescue'), ['rm -rf .git']);
    expect(w.repo).toBeNull();
  });

  it('revert without -m on a merge explains what -m means', () => {
    const { log } = play(byId('revert-merge'), ['git pull', 'git revert HEAD~1']);
    expect(log).toContain('is a merge but no -m option');
  });

  it('re-landing with a plain merge leaves the reverted file out', () => {
    const level = byId('reland-feature');
    const { w } = play(level, ['git merge new-checkout', 'git push']);
    expect(level.goals[0].check(w)).toBe(false);
  });

  it('git clean -fdx also deletes the ignored .env', () => {
    const level = byId('clean-junk');
    const { w } = play(level, ['git clean -fdx']);
    expect(level.goals[3].check(w)).toBe(false);
  });

  it('the --ours prelude really dropped your commit', () => {
    const level = byId('bad-rebase-resolution');
    const { world } = startLevel(level);
    expect(level.goals[0].check(world)).toBe(false);
  });

  it('pushing the moved tag without force is rejected', () => {
    const { log } = play(byId('wrong-tag'), ['git tag -f v2.0', 'git push origin v2.0']);
    expect(log).toContain('(already exists)');
  });

  it('force-pushing to a PR-only main is still rejected', () => {
    const { log } = play(byId('pr-only'), ['git push --force']);
    expect(log).toContain('pull request');
  });

  it('after rebase -i, a plain push of the rewritten branch is rejected', () => {
    const level = byId('rebase-i-cleanup');
    const { log } = play(level, [...level.solution.slice(0, 2), 'git push']);
    expect(log).toContain('non-fast-forward');
  });

  it('reverting the debug commit instead of dropping it fails the level', () => {
    const level = byId('rebase-i-drop');
    const { w } = play(level, ['git revert HEAD~1 --no-edit']);
    expect(level.goals[0].check(w)).toBe(false);
  });

  it('reverting the newest shipping commit instead of the culprit loses express shipping', () => {
    const level = byId('blame-fee');
    const { w } = play(level, ['git revert HEAD~1 --no-edit', 'git push']);
    expect(level.goals[0].check(w)).toBe(false);
    expect(level.goals[1].check(w)).toBe(false);
  });

  it('answering bisect wrongly blames an innocent commit', () => {
    const level = byId('bisect-manual');
    const { w, log } = play(level, ['git bisect start', 'git bisect bad', 'git bisect good v1.0', 'git bisect bad', 'git bisect bad', 'git bisect bad', 'git bisect bad']);
    expect(log).toContain('is the first bad commit');
    expect(w.objects[w.repo!.bisect!.found!].message).not.toBe('Refactor cart helpers');
  });

  it('boss friday: pushing webhooks with .env still in history fails the secret goal', () => {
    const level = byId('boss-friday');
    const { w, log } = play(level, ['git push', 'git switch -c webhooks', 'git push -u origin webhooks']);
    expect(log).toContain('pull request');
    expect(level.goals[1].check(w)).toBe(false);
  });

  it('boss rebase hell: finishing the rebase rewrites the shared commits', () => {
    const level = byId('boss-rebase-hell');
    const { w } = play(level, ['git checkout --theirs cart.js', 'git add cart.js', 'git rebase --continue', 'git push --force-with-lease']);
    expect(level.goals[1].check(w)).toBe(false);
  });

  it('boss rm -rf: reset --hard instead of mixed wipes the uncommitted css', () => {
    const level = byId('boss-rm-rf');
    const { w, log } = play(level, ['git init', 'git remote add origin https://git.example.com/team/shop.git', 'git fetch', 'git reset --hard origin/main']);
    expect(log).toContain('thrown away');
    expect('invoice.css' in w.files).toBe(true); // untracked files survive --hard...
    expect(w.files['invoice.js']).not.toContain('pdf'); // ...but tracked edits are gone
  });

  it('boss archaeology: reverting only the first promo commit conflicts', () => {
    const level = byId('boss-archaeology');
    const sha = Object.values(startLevel(level).world.objects).find((c) => c.message === 'Add promo banner')!.id.slice(0, 7);
    const { log } = play(level, [`git revert ${sha}`]);
    expect(log).toContain('CONFLICT');
  });
});

