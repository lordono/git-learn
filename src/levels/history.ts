/** Chapter 4: rewriting history with interactive rebase. */
import { treeOf } from '../engine/repo';
import type { World } from '../engine/types';
import { EDITOR } from './runtime';
import { Scenario, branchTip, firstParentChain, isClean, todoFor } from './scenario';
import type { Level } from './types';

const chapter = 'Rewriting history';

/** commit messages from `branch` back to (not including) the tip of `base` */
const messagesSince = (w: World, branch: string, base: string) => {
  const stop = branchTip(w, base);
  const out: string[] = [];
  for (const id of firstParentChain(w, branchTip(w, branch))) {
    if (id === stop) return out;
    out.push(w.objects[id].message);
  }
  return null; // base is not on the branch's first-parent line
};
const sameFiles = (a: Record<string, string>, b: Record<string, string>) =>
  Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((k) => a[k] === b[k]);
const onBranch = (w: World, b: string) => w.repo?.head.kind === 'branch' && w.repo.head.name === b && !w.repo.op;
/** files a commit changed compared to its parent */
const touched = (w: World, id: string) => {
  const c = w.objects[id];
  const p = treeOf(w, c.parents[0]);
  return [...new Set([...Object.keys(p), ...Object.keys(c.tree)])].filter((f) => p[f] !== c.tree[f]).sort();
};

const WISHLIST_FINAL = 'const list = [];\nexport const add = (x) => { if (!list.includes(x)) list.push(x); };\nexport const all = () => list;\n';
const cleanupSetup = () => {
  const s = new Scenario().run('git init').commit({ 'README.md': '# Shop\n' }, 'Initial commit').withRemote().run('git switch -c wishlist');
  s.commit({ 'wishlist.js': 'const list = [];\nexport const add = (x) => list.push(x);\nexport const all = () => lsit;\n' }, 'Add wishlist')
    .commit({ 'wishlist.js': 'const list = [];\nexport const add = (x) => { if (!list.includes(x)) list.push(x); };\nexport const all = () => lsit;\n' }, 'wip')
    .commit({ 'wishlist.js': WISHLIST_FINAL }, 'fix typo')
    .commit({ 'wishlist.test.js': 'test("no duplicates", () => { add(1); add(1); expect(all()).toEqual([1]); });\n' }, 'Add wishlist tests')
    .run('git push -u origin wishlist');
  return s.w;
};

const rewordSetup = () => {
  const s = new Scenario().run('git init').commit({ 'README.md': '# Shop\n' }, 'Initial commit').run('git switch -c coupons');
  s.commit({ 'coupon.js': 'export const coupon = (code, pct) => ({ code, pct });\n' }, 'Add coupon model')
    .commit({ 'checkout.js': 'export const apply = (total, c) => total * (1 - c.pct / 100);\n' }, 'asdf')
    .commit({ 'coupon.js': 'export const coupon = (code, pct, expires) => ({ code, pct, expires });\nexport const valid = (c, now) => now < c.expires;\n' }, 'Validate coupon expiry');
  return s.w;
};

const dropSetup = () => {
  const s = new Scenario().run('git init').commit({ 'search.js': 'export const search = () => [];\n' }, 'Initial commit').run('git switch -c ranking');
  s.commit({ 'rank.js': 'export const rank = (r) => r.sort((a, b) => b.score - a.score);\n' }, 'Rank results by score')
    .commit({ 'debug.js': 'console.log("RANKING DEBUG", process.env);\n' }, 'TEMP: debug logging (do not ship)')
    .commit({ 'rank.js': 'export const rank = (r) => r.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));\n' }, 'Break score ties by name');
  return s.w;
};

const splitSetup = () => {
  const s = new Scenario().run('git init').commit({ 'tax.js': 'export const tax = (p) => p * 0.07;\n', 'button.css': '.buy { color: gray; }\n' }, 'Initial commit');
  s.commit({ 'tax.js': 'export const tax = (p) => Math.round(p * 7) / 100;\n', 'button.css': '.buy { color: white; background: green; }\n' }, 'Fix tax rounding and restyle buy button')
    .commit({ 'receipt.js': 'export const receipt = (items) => items.map((i) => i.name).join("\\n");\n' }, 'Add receipts');
  return s.w;
};

export const HISTORY: Level[] = [
  {
    id: 'rebase-i-cleanup',
    chapter,
    title: 'Clean up a branch before review',
    story: `<p>Your <code>wishlist</code> PR has 4 commits, and two of them ("wip", "fix typo") are just fixes to the first one. It's your own branch and you already pushed it.</p>
<p>Use <code>git rebase -i main</code> to melt "wip" and "fix typo" into "Add wishlist", keeping "Add wishlist tests" separate. Then update the PR.</p>
<p>In the editor, change a line's <code>pick</code> to <code>fixup</code> (or <code>squash</code> if you want to edit the combined message). Save to run it.</p>`,
    setup: cleanupSetup,
    goals: [
      { text: 'wishlist has exactly 2 commits: "Add wishlist", "Add wishlist tests"', check: (w) => JSON.stringify(messagesSince(w, 'wishlist', 'main')) === JSON.stringify(['Add wishlist tests', 'Add wishlist']) },
      { text: 'The code is the same as before', check: (w) => treeOf(w, branchTip(w, 'wishlist'))['wishlist.js'] === WISHLIST_FINAL },
      { text: 'origin/wishlist has the cleaned-up history', check: (w) => !!w.remote && w.remote.branches.wishlist === branchTip(w, 'wishlist') },
    ],
    hints: [
      'git rebase -i main opens a todo list of every commit since main, oldest first.',
      'Change "pick" to "fixup" (or f) on the "wip" and "fix typo" lines. fixup glues a commit onto the line above it and keeps the line above\'s message.',
      'Your local branch now differs from origin/wishlist. Since nobody else uses it: git push --force-with-lease',
    ],
    solution: [
      'git rebase -i main',
      EDITOR + todoFor(cleanupSetup(), [['pick', 'Add wishlist'], ['fixup', 'wip'], ['fixup', 'fix typo'], ['pick', 'Add wishlist tests']]),
      'git push --force-with-lease',
    ],
    lesson: 'rebase -i is a script: one line per commit, top to bottom. fixup and squash merge a commit into the one above (squash lets you edit the message). It rewrites ids, so only do it on your own branch, then --force-with-lease.',
  },
  {
    id: 'rebase-i-reword',
    chapter,
    title: 'Rename a commit from 2 commits ago',
    story: `<p>Mid-way through <code>coupons</code> you committed with the message <code>"asdf"</code>. <code>--amend</code> only fixes the <i>latest</i> commit, and this one has a commit on top of it.</p>
<p>Rename it to <code>"Apply coupons at checkout"</code>. Leave every other commit's message alone.</p>`,
    setup: rewordSetup,
    goals: [
      { text: 'The "asdf" commit is now "Apply coupons at checkout"', check: (w) => JSON.stringify(messagesSince(w, 'coupons', 'main')) === JSON.stringify(['Validate coupon expiry', 'Apply coupons at checkout', 'Add coupon model']) },
      { text: 'No files changed', check: (w) => sameFiles(treeOf(w, branchTip(w, 'coupons')), treeOf(w, rewordSetup().repo!.branches.coupons)) },
      { text: 'Rebase finished, on coupons', check: (w) => onBranch(w, 'coupons') && isClean(w) },
    ],
    hints: ['git rebase -i HEAD~3 (or main) lists the last 3 commits.', 'Change pick to reword (r) on the "asdf" line, save. Git replays the commits and opens the editor again for the new message.', 'In the second editor replace "asdf" with "Apply coupons at checkout" and save.'],
    solution: ['git rebase -i HEAD~3', EDITOR + todoFor(rewordSetup(), [['pick', 'Add coupon model'], ['reword', 'asdf'], ['pick', 'Validate coupon expiry']]), EDITOR + 'Apply coupons at checkout\n'],
    lesson: 'reword stops on a commit just to change its message. Every commit after it gets a new id too, because a commit\'s id includes its parent\'s id.',
  },
  {
    id: 'rebase-i-drop',
    chapter,
    title: "Drop a commit that mustn't ship",
    story: `<p>On <code>ranking</code> you committed some temporary debug logging that dumps <code>process.env</code> (secrets!). There's a good commit after it.</p>
<p>Remove the debug commit entirely, keeping the commits before and after it.</p>`,
    setup: dropSetup,
    goals: [
      { text: 'The debug commit is gone from ranking', check: (w) => JSON.stringify(messagesSince(w, 'ranking', 'main')) === JSON.stringify(['Break score ties by name', 'Rank results by score']) },
      { text: 'debug.js is gone', check: (w) => !('debug.js' in treeOf(w, branchTip(w, 'ranking'))) && !('debug.js' in w.files) },
      { text: 'The tie-breaking change is still there', check: (w) => !!treeOf(w, branchTip(w, 'ranking'))['rank.js']?.includes('localeCompare') },
      { text: 'Rebase finished, on ranking', check: (w) => onBranch(w, 'ranking') && isClean(w) },
    ],
    hints: ['git revert would add an "undo" commit, but the secret would still be in history. Before pushing, you can remove it completely.', 'git rebase -i main, then change pick to drop (d) on the TEMP line. (Deleting the line works too.)'],
    solution: ['git rebase -i main', EDITOR + todoFor(dropSetup(), [['pick', 'Rank results by score'], ['drop', 'TEMP: debug logging (do not ship)'], ['pick', 'Break score ties by name']])],
    lesson: 'drop (or deleting the line) removes a commit from the rewritten history. Before pushing, that\'s the clean fix. Once it\'s pushed, assume the secret leaked: rotate it, and use revert on shared branches.',
  },
  {
    id: 'rebase-i-split',
    chapter,
    title: 'Split one commit into two',
    story: `<p>One commit, <i>"Fix tax rounding and restyle buy button"</i>, mixes two unrelated changes. Your reviewer wants them separate, so the tax fix could be reverted on its own.</p>
<p>Split it into <code>"Fix tax rounding"</code> (only <code>tax.js</code>) and <code>"Restyle buy button"</code> (only <code>button.css</code>), in that order. "Add receipts" stays on top.</p>`,
    setup: splitSetup,
    goals: [
      { text: 'History is: Fix tax rounding → Restyle buy button → Add receipts', check: (w) => JSON.stringify(firstParentChain(w, branchTip(w, 'main')).map((id) => w.objects[id].message)) === JSON.stringify(['Add receipts', 'Restyle buy button', 'Fix tax rounding', 'Initial commit']) },
      { text: '"Fix tax rounding" only changes tax.js', check: (w) => { const id = firstParentChain(w, branchTip(w, 'main'))[2]; return !!id && JSON.stringify(touched(w, id)) === '["tax.js"]'; } },
      { text: '"Restyle buy button" only changes button.css', check: (w) => { const id = firstParentChain(w, branchTip(w, 'main'))[1]; return !!id && JSON.stringify(touched(w, id)) === '["button.css"]'; } },
      { text: 'Rebase finished, clean working tree', check: (w) => onBranch(w, 'main') && isClean(w) },
    ],
    hints: [
      'git rebase -i HEAD~2, and mark the mixed commit with edit (e). Git stops right after replaying it.',
      'While stopped: git reset HEAD~1 undoes the commit but keeps both changes in your files (unstaged).',
      'git add tax.js, git commit -m "Fix tax rounding", then the same for button.css, then git rebase --continue.',
    ],
    solution: [
      'git rebase -i HEAD~2',
      EDITOR + todoFor(splitSetup(), [['edit', 'Fix tax rounding and restyle buy button'], ['pick', 'Add receipts']]),
      'git reset HEAD~1',
      'git add tax.js',
      'git commit -m "Fix tax rounding"',
      'git add button.css',
      'git commit -m "Restyle buy button"',
      'git rebase --continue',
    ],
    lesson: 'edit pauses the rebase on a commit. From there you can amend it, or reset HEAD~1 and re-commit the changes in pieces. git rebase --continue replays the rest on top.',
  },
];
