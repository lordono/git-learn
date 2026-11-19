/**
 * Chapter: lazygit. Replays earlier levels in lazygit mode to show how much typing it saves,
 * and which git commands it runs for you (watch the command log).
 */
import { runLine } from '../engine/shell';
import type { World } from '../engine/types';
import { BASICS } from './basics';
import { HISTORY } from './history';
import { shaOf } from './scenario';
import { TEAM } from './team';
import type { Level } from './types';

const chapter = 'lazygit';
const from = (list: Level[], id: string) => list.find((l) => l.id === id)!;
const withConfig = (setup: () => World, ...lines: string[]) => () => {
  let w = setup();
  for (const l of lines) w = runLine(w, l).world;
  return w;
};
const keys = (rows: [string, string][]) =>
  `<table class="keys">${rows.map(([k, what]) => `<tr><td>${k
    .split(' ')
    .map((x) => `<kbd>${x}</kbd>`)
    .join(' ')}</td><td>${what}</td></tr>`).join('')}</table>`;

const staging = from(BASICS, 'staging');
const stash = from(TEAM, 'stash-pull');
const rejected = from(TEAM, 'push-rejected');
const conflict = from(TEAM, 'merge-conflict');
const hotfix = from(TEAM, 'hotfix');
const cleanup = from(HISTORY, 'rebase-i-cleanup');
const reword = from(HISTORY, 'rebase-i-reword');

const intro = `<p class="lg-note">This level runs in <b>lazygit mode</b>: the terminal is swapped for a lazygit-style screen. Click a panel or press its number, move with <kbd>j</kbd>/<kbd>k</kbd> (or ↑/↓), and press the keys below. Every key runs real git commands, listed in the <b>Command log</b>.</p>`;

export const LAZYGIT: Level[] = [
  {
    ...staging,
    id: 'lg-staging',
    chapter,
    title: 'lazygit: stage & commit',
    story: `${intro}<p>Same job as <i>Staging is a choice</i>: commit only the <code>app.js</code> fix, and leave the rant in <code>notes.txt</code> uncommitted.</p>${keys([
      ['2', 'go to the Files panel'],
      ['j k', 'select app.js (the diff shows on the right)'],
      ['space', 'stage it (runs git add)'],
      ['c', 'commit: type a message, enter'],
    ])}`,
    hints: ['Press 2, select app.js with j/k, press space. The letters turn from " M" (unstaged) to "M " (staged).', 'Press c, type "Fix add()", press enter.'],
    lesson: 'lazygit is a picture of git status that you can act on. space = git add / git restore --staged, c = git commit -m. Same staging area, much less typing.',
  },
  {
    ...stash,
    id: 'lg-stash',
    chapter,
    title: 'lazygit: stash, pull, pop',
    story: `${intro}<p>Same as <i>Pull blocked by local changes</i>: get Sam's fix while keeping your half-done EUR edit uncommitted.</p>${keys([
      ['2 s', 'stash your changes (give it a name, enter)'],
      ['p', 'pull'],
      ['5', 'go to the Stash panel'],
      ['g', 'pop the stash'],
    ])}`,
    hints: ['In the Files panel press s, type a name, enter. Then p to pull.', 'Press 5 for the Stash panel, then g to pop (space would apply and keep the entry).'],
    solution: ['git stash push -m "multi-currency"', 'git pull', 'git stash pop stash@{0}'],
    lesson: 'The Stash panel makes stashes visible instead of something you forget about. s / g / space = git stash push / pop / apply.',
  },
  {
    ...rejected,
    id: 'lg-push-rejected',
    chapter,
    title: 'lazygit: push rejected',
    setup: withConfig(rejected.setup, 'git config pull.rebase true'),
    story: `${intro}<p>Same as <i>Push rejected</i>: Alex pushed first. (This repo already has <code>pull.rebase true</code>, so <kbd>p</kbd> rebases.)</p>${keys([
      ['P', 'push. It gets rejected: read the popup, esc'],
      ['p', 'pull (fetch + rebase)'],
      ['P', 'push again'],
    ])}`,
    hints: ['P pushes. Rejected? The popup shows git\'s own error. Press esc.', 'p pulls Alex\'s commit (rebasing yours on top), then P again.'],
    solution: ['git push', 'git pull', 'git push'],
    events: [],
    lesson: 'p and P are just git pull and git push, so the same rules apply: integrate first, then push. lazygit only offers a force push when your branch has really diverged.',
  },
  {
    ...conflict,
    id: 'lg-conflict',
    chapter,
    title: 'lazygit: resolve a conflict',
    setup: withConfig(conflict.setup, 'git config pull.rebase false'),
    story: `${intro}<p>Same as <i>Merge conflict</i>: you and Alex changed the same line of <code>config.js</code>. The team agreed on your <code>"dark"</code>. (This repo has <code>pull.rebase false</code>, so <kbd>p</kbd> merges.)</p>${keys([
      ['p', 'pull. Conflict! config.js shows as UU'],
      ['2 enter', 'open the merge view for config.js'],
      ['← →', 'choose your side (HEAD) or theirs, then space (b = keep both)'],
      ['enter', 'continue the merge when asked'],
      ['P', 'push'],
    ])}`,
    hints: ['After p, press 2, select config.js and press enter.', 'In the merge view, HEAD is your side. Pick it with ← and space. lazygit stages the file and asks to continue: enter.', 'Then P to push.'],
    solution: ['git pull', 'git checkout --ours config.js', 'git add config.js', 'git commit --no-edit', 'git push'],
    lesson: 'The merge view replaces hand-editing <<<<<<< markers: pick a side per hunk, and lazygit writes the file, runs git add, and offers git commit for you.',
  },
  {
    ...cleanup,
    id: 'lg-squash',
    chapter,
    title: 'lazygit: fixup without a todo list',
    story: `${intro}<p>Same as <i>Clean up a branch before review</i>: fold "wip" and "fix typo" into "Add wishlist", then update the pushed PR branch.</p>${keys([
      ['4', 'go to the Commits panel (newest at the top)'],
      ['j k', 'select "fix typo"'],
      ['f', 'fixup: fold it into the commit below'],
      ['f', 'do the same for "wip"'],
      ['P', 'push: lazygit offers --force-with-lease'],
    ])}`,
    hints: ['Press 4, select "fix typo", press f and confirm. Then select "wip", f again.', 'P: your branch diverged from origin, so lazygit asks to force push with --force-with-lease. Enter.'],
    lesson: 'Each f is a whole interactive rebase (git rebase -i + an edited todo list) done for you. Check the command log to see it. Same rules as before: only rewrite your own, unshared branches.',
  },
  {
    ...reword,
    id: 'lg-reword',
    chapter,
    title: 'lazygit: reword an old commit',
    story: `${intro}<p>Same as <i>Rename a commit from 2 commits ago</i>: rename <code>"asdf"</code> to <code>"Apply coupons at checkout"</code>.</p>${keys([
      ['4 j', 'select the "asdf" commit'],
      ['r', 'reword: edit the message, enter'],
    ])}`,
    hints: ['Press 4, move to "asdf" with j, press r.', 'Replace the text with "Apply coupons at checkout" and press enter.'],
    lesson: 'r on any commit = rebase -i with reword + the message editor, in one step. On the newest commit, lazygit uses git commit --amend instead.',
  },
  {
    ...hotfix,
    id: 'lg-cherry-pick',
    chapter,
    title: 'lazygit: copy & paste a commit',
    story: `${intro}<p>Same as <i>Hotfix the release branch</i>: bring only the crash fix from <code>main</code> into <code>release/1.0</code>.</p>${keys([
      ['4 j', 'select "Fix checkout crash on empty cart"'],
      ['c', 'copy it (it gets marked)'],
      ['3 j space', 'select release/1.0 and check it out'],
      ['4 v', 'paste: runs git cherry-pick'],
    ])}`,
    hints: ['Commits panel (4): select the fix, press c.', 'Branches panel (3): select release/1.0, press space to check it out.', 'Commits panel (4): press v and confirm.'],
    solution: ['git switch release/1.0', `git cherry-pick ${shaOf(hotfix.setup(), 'Fix checkout crash on empty cart')}`],
    lesson: 'c / v is cherry-pick as copy and paste. You can copy several commits, even from different branches, and paste them all at once.',
  },
];

/** regular levels where lazygit mode unlocks once you've beaten them with plain git */
export const LAZYGIT_UNLOCKABLE = new Set([
  'staging',
  'first-push',
  'typo-amend',
  'stash-pull',
  'push-rejected',
  'merge-conflict',
  'rebase-conflict',
  'rebase-abort',
  'wrong-branch',
  'undo-merge',
  'squash-wip',
  'hotfix',
  'revert-pushed',
  'take-theirs',
  'rebase-i-cleanup',
  'rebase-i-reword',
  'rebase-i-drop',
  'boss-rebase-hell',
]);
