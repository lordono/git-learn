import { expect, it } from 'vitest';
import { LEVELS } from './levels';
import { buildIndex, search } from './search';

const ids = (q: string) => search(buildIndex(LEVELS), q).map((e) => e.level.id);

it('finds levels by command, goal words and partial words', () => {
  expect(ids('bisect')).toEqual(expect.arrayContaining(['bisect-manual', 'bisect-run']));
  expect(ids('stash')).toContain('stash-pull');
  expect(ids('reba')).toContain('rebase-conflict');
  expect(ids('squash')).toContain('rebase-i-cleanup');
  expect(ids('copy')).toContain('hotfix');
  expect(ids('lazygit undo')).toEqual(['lg-undo']);
});
it('undo is useful but not everything', () => {
  const hits = ids('undo');
  expect(hits).toEqual(expect.arrayContaining(['reflog-rescue', 'undo-merge', 'revert-pushed']));
  expect(hits.length).toBeLessThan(LEVELS.length / 2);
});
it('an empty query lists every level, nonsense lists none', () => {
  expect(ids('')).toHaveLength(LEVELS.length);
  expect(ids('xyzzy')).toEqual([]);
});
it('every level has a blurb and teaches at least one command', () => {
  for (const e of buildIndex(LEVELS)) {
    expect(e.blurb.length, e.level.id).toBeGreaterThan(10);
    expect(e.teaches.length, e.level.id).toBeGreaterThan(0);
  }
});
