/**
 * Level pack 2: levels that use tags, clean, --ours/--theirs, revert -m,
 * stash-by-sha, --reset-author and pull-request-only branches.
 */
import { cfg, headId, isAncestor, treeOf } from '../engine/repo';
import type { World } from '../engine/types';
import { Scenario, TEAMMATES, branchTip, firstParentChain, hasMessage, isClean, isLinear, remoteHas, teammatePush } from './scenario';
import type { Level } from './types';

const { alex, sam } = TEAMMATES;

const onBranch = (w: World, b: string) => w.repo?.head.kind === 'branch' && w.repo.head.name === b;
const tipTree = (w: World, b: string) => treeOf(w, branchTip(w, b));
const remoteTree = (w: World, b: string) => treeOf(w, w.remote?.branches[b]);
const synced = (w: World, b: string) => !!w.repo && !!w.remote && w.repo.branches[b] === w.remote.branches[b];

// ───────────────────────────── Basics ─────────────────────────────

export const BASICS_2: Level[] = [
  {
    id: 'aliases',
    chapter: 'Basics',
    title: 'Make git type less',
    story: `<p>You type <code>git status</code> about 300 times a day. Make shortcuts:</p>
<ul><li><code>git st</code> → <code>git status</code></li><li><code>git lg</code> → <code>git log --oneline --graph --all</code></li></ul>
<p>Then try them out.</p>`,
    setup: () =>
      new Scenario()
        .run('git init')
        .commit({ 'README.md': '# Shop\n' }, 'Initial commit')
        .run('git switch -c search')
        .commit({ 'search.js': 'export const search = () => [];\n' }, 'Add search')
        .run('git switch main').w,
    goals: [
      { text: 'git st runs git status', check: (w) => cfg(w, 'alias.st') === 'status' },
      { text: 'git lg runs git log --oneline --graph --all', check: (w) => { const v = cfg(w, 'alias.lg') ?? ''; return /^log\b/.test(v) && ['--oneline', '--graph', '--all'].every((f) => v.includes(f)); } },
    ],
    hints: ['Aliases are just config: git config --global alias.<name> <command>', 'git config --global alias.st status', 'Quote multi-word aliases: git config --global alias.lg "log --oneline --graph --all"'],
    solution: ['git config --global alias.st status', 'git config --global alias.lg "log --oneline --graph --all"', 'git st', 'git lg'],
    lesson: 'An alias is any git command line saved under a short name, in ~/.gitconfig with --global. Popular ones: st, co (checkout), sw (switch), lg, and unstage = "restore --staged".',
  },
  {
    id: 'typo-amend',
    chapter: 'Basics',
    title: 'Oops: typo, and a forgotten file',
    story: `<p>You just committed <code>"Fix chekout totl"</code>. Two problems: the typo, and you forgot to add <code>checkout.test.js</code>.</p>
<p>Fix both <b>without</b> making a second commit. You haven't pushed.</p>`,
    setup: () =>
      new Scenario()
        .run('git init')
        .commit({ 'checkout.js': 'export const total = (items) => items.length;\n' }, 'Initial commit')
        .commit({ 'checkout.js': 'export const total = (items) => items.reduce((s, i) => s + i.price, 0);\n' }, 'Fix chekout totl')
        .write({ 'checkout.test.js': 'test("total", () => expect(total([{ price: 2 }])).toBe(2));\n' }).w,
    goals: [
      { text: 'The last commit is called "Fix checkout total"', check: (w) => w.objects[branchTip(w, 'main') ?? '']?.message === 'Fix checkout total' },
      { text: 'That commit includes checkout.test.js', check: (w) => 'checkout.test.js' in tipTree(w, 'main') },
      { text: 'main still has just 2 commits', check: (w) => firstParentChain(w, branchTip(w, 'main')).length === 2 },
    ],
    hints: ['git commit --amend replaces the last commit with a new one built from the staging area.', 'Stage the forgotten file first: git add checkout.test.js', 'git commit --amend -m "Fix checkout total"'],
    solution: ['git add checkout.test.js', 'git commit --amend -m "Fix checkout total"'],
    lesson: '--amend swaps the last commit for a new one: same parent, new snapshot and/or message. Fine before pushing. After pushing it rewrites shared history, so prefer a new commit.',
  },
  {
    id: 'work-email',
    chapter: 'Basics',
    title: 'Wrong email on a work commit',
    story: `<p>Your <code>--global</code> email is your personal one, <code>you@example.com</code>. This is a work repo, and your company wants commits from <code>you@shopco.com</code>.</p>
<p>Set the work email <b>for this repo only</b> (keep the personal one for everything else), then fix the author of your last commit. It isn't pushed yet. Check with <code>git log</code>.</p>`,
    setup: () =>
      new Scenario()
        .run('git init')
        .commit({ 'invoice.js': 'export const invoice = () => ({});\n' }, 'Initial commit')
        .withRemote()
        .commit({ 'invoice.js': 'export const invoice = () => ({});\nexport const toCsv = (inv) => Object.values(inv).join(",");\n' }, 'Add invoice export').w,
    goals: [
      { text: 'This repo uses you@shopco.com', check: (w) => w.repo?.config['user.email'] === 'you@shopco.com' },
      { text: 'Your global email is still you@example.com', check: (w) => w.globalConfig['user.email'] === 'you@example.com' },
      { text: '"Add invoice export" is authored by you@shopco.com', check: (w) => { const c = w.objects[branchTip(w, 'main') ?? '']; return c?.message === 'Add invoice export' && c.email === 'you@shopco.com'; } },
      { text: 'The pushed commit was not rewritten', check: (w) => !!w.remote && isAncestor(w, w.remote.branches.main, branchTip(w, 'main')!) },
    ],
    hints: ['Without --global, git config writes to this repo only: git config user.email you@shopco.com', 'Changing the config doesn\'t touch commits you already made. Amend the last one.', 'git commit --amend keeps the ORIGINAL author. Add --reset-author: git commit --amend --no-edit --reset-author'],
    solution: ['git config user.email you@shopco.com', 'git commit --amend --no-edit --reset-author', 'git log'],
    lesson: 'Repo config beats global config. Commits remember the name/email that was set when they were made, and --amend keeps that author unless you pass --reset-author.',
  },
];

// ───────────────────────────── Undo & rescue ─────────────────────────────

const droppedStashSetup = () =>
  new Scenario()
    .run('git init')
    .commit({ 'login.js': 'export function login(user) {\n  return createSession(user);\n}\n' }, 'Add login')
    .write({ 'login.js': 'export function login(user) {\n  // try: magic links?\n  return createSession(user);\n}\n' })
    .run('git stash -m "old experiment"')
    .write({ 'login.js': 'export function login(user) {\n  if (rateLimited(user)) return null;\n  return createSession(user);\n}\n' })
    .run('git stash -m "rate limiting"').w;
const droppedStashId = droppedStashSetup().repo!.stash[0].id;

export const UNDO_2: Level[] = [
  {
    id: 'squash-wip',
    chapter: 'Undo & rescue',
    title: 'Squash the wip commits',
    story: `<p>Your <code>wishlist</code> branch has four commits: <i>wip</i>, <i>wip 2</i>, <i>fix</i>, <i>actually works</i>. Not something you want reviewers to read.</p>
<p>Turn them into <b>one</b> commit called <code>"Add wishlist"</code> with the same final code. You haven't pushed the branch.</p>`,
    setup: () => {
      const s = new Scenario().run('git init').commit({ 'README.md': '# Shop\n' }, 'Initial commit').withRemote().run('git switch -c wishlist');
      s.commit({ 'wishlist.js': 'const list = [];\n' }, 'wip')
        .commit({ 'wishlist.js': 'const list = [];\nexport const add = (x) => list.push(x);\n' }, 'wip 2')
        .commit({ 'wishlist.js': 'const list = [];\nexport const add = (x) => list.push(x);\nexport const all = () => list;\n' }, 'fix')
        .commit({ 'wishlist.js': 'const list = [];\nexport const add = (x) => { if (!list.includes(x)) list.push(x); };\nexport const all = () => list;\n' }, 'actually works');
      return s.w;
    },
    goals: [
      { text: 'wishlist is exactly one commit ahead of main', check: (w) => { const t = branchTip(w, 'wishlist'); return !!t && w.objects[t].parents[0] === branchTip(w, 'main'); } },
      { text: 'That commit is called "Add wishlist"', check: (w) => w.objects[branchTip(w, 'wishlist') ?? '']?.message === 'Add wishlist' },
      { text: 'The code is the same as "actually works"', check: (w) => !!tipTree(w, 'wishlist')['wishlist.js']?.includes('list.includes(x)') },
      { text: 'Clean working tree', check: isClean },
    ],
    hints: ['You could use interactive rebase, but there is a two-command trick.', 'git reset --soft main moves the branch back to main but keeps ALL the changes staged.', 'git reset --soft main, then git commit -m "Add wishlist"'],
    solution: ['git reset --soft main', 'git commit -m "Add wishlist"'],
    lesson: 'reset --soft <base> + one commit = squash. The four old commits are still in the reflog if you change your mind. (git rebase -i does the same with more control.)',
  },
  {
    id: 'dropped-stash',
    chapter: 'Undo & rescue',
    title: 'Dropped the wrong stash',
    story: `<p>You had two stashes and wanted to throw away the old experiment. But <code>git stash drop</code> drops <code>stash@{0}</code>: the <b>newest</b> one, your rate-limiting work.</p>
<p>Get the rate-limiting change back into <code>login.js</code>.</p>`,
    setup: droppedStashSetup,
    prelude: ['git stash list', 'git stash drop'],
    goals: [{ text: 'login.js has the rateLimited check again', check: (w) => !!w.files['login.js']?.includes('rateLimited') }],
    hints: ['Look at what drop printed: "Dropped stash@{0} (<long id>)".', 'A dropped stash isn\'t erased right away. git stash apply accepts that id.', 'Lost the id? git fsck --lost-found lists dangling commits.'],
    solution: [`git stash apply ${droppedStashId.slice(0, 7)}`],
    lesson: 'Stashes are commits underneath. drop only removes the stash@{n} name, and the id that drop prints brings it back until git garbage-collects it. Use git stash drop stash@{1} to pick a specific one.',
  },
  {
    id: 'clean-junk',
    chapter: 'Undo & rescue',
    title: 'Clean up junk files',
    story: `<p>A crashed build left <code>debug.log</code> and a <code>tmp/</code> folder lying around. Delete them with git.</p>
<p>Careful: <code>notes.md</code> is untracked too, and you want to keep it. And <code>.env</code> (ignored) has your local secrets.</p>
<p>Deleted untracked files are gone for good, so <b>dry-run first</b>.</p>`,
    setup: () =>
      new Scenario()
        .run('git init')
        .commit({ '.gitignore': '.env\n', 'app.js': 'console.log("shop");\n' }, 'Initial commit')
        .write({ 'debug.log': 'Error: ENOMEM\n', 'tmp/chunk-1.json': '{}\n', 'tmp/chunk-2.json': '{}\n', 'notes.md': '- ask Sam about caching\n', '.env': 'API_KEY=local-dev\n' }).w,
    goals: [
      { text: 'debug.log is gone', check: (w) => !('debug.log' in w.files) },
      { text: 'tmp/ is gone', check: (w) => !Object.keys(w.files).some((p) => p.startsWith('tmp/')) },
      { text: 'notes.md is still there', check: (w) => 'notes.md' in w.files },
      { text: '.env is still there', check: (w) => '.env' in w.files },
    ],
    hints: ['git clean -n shows what would be deleted without deleting. Add -d to include folders.', 'git clean -nd lists notes.md too. Pass paths to limit what gets cleaned.', 'git clean -fd tmp debug.log'],
    solution: ['git clean -nd', 'git clean -fd tmp debug.log'],
    lesson: 'git clean deletes untracked files, and no reflog can bring them back. Always run -n first. -d includes folders, -x also deletes ignored files like .env, so be extra careful with -x.',
  },
  {
    id: 'bad-rebase-resolution',
    chapter: 'Undo & rescue',
    title: '--ours during a rebase is NOT yours',
    story: `<p>You rebased <code>tax-update</code> onto <code>main</code> and hit a conflict in <code>price.js</code>. You wanted to keep <b>your</b> 8% tax, so you ran <code>git checkout --ours</code>… and your commit vanished.</p>
<p>Get back to before the rebase, then redo it so <code>tax-update</code> sits on top of <code>main</code> and keeps your <code>TAX = 0.08</code>.</p>`,
    setup: () => {
      const s = new Scenario().run('git init').commit({ 'price.js': 'export const TAX = 0.07;\nexport const total = (p) => p * (1 + TAX);\n' }, 'Initial commit').run('git switch -c tax-update');
      s.commit({ 'price.js': 'export const TAX = 0.08;\nexport const total = (p) => p * (1 + TAX);\n' }, 'Update tax rate to 8%')
        .run('git switch main')
        .commit({ 'price.js': 'export const TAX = 0.07; // state sales tax\nexport const total = (p) => p * (1 + TAX);\n' }, 'Document tax constant')
        .run('git switch tax-update');
      return s.w;
    },
    prelude: ['git rebase main', 'git checkout --ours price.js', 'git add price.js', 'git rebase --continue', 'git log --oneline'],
    goals: [
      { text: 'tax-update has your "Update tax rate to 8%" commit', check: (w) => hasMessage(w, branchTip(w, 'tax-update'), 'Update tax rate to 8%') },
      { text: 'tax-update is on top of main (rebased, no merge commit)', check: (w) => hasMessage(w, branchTip(w, 'tax-update'), 'Document tax constant') && isLinear(w, branchTip(w, 'tax-update')) },
      { text: 'price.js says TAX = 0.08', check: (w) => !!tipTree(w, 'tax-update')['price.js']?.includes('0.08') },
      { text: 'Rebase finished, clean working tree', check: (w) => onBranch(w, 'tax-update') && isClean(w) },
    ],
    hints: ['A rebase replays YOUR commits onto main. While it runs, HEAD is main, so "ours" = main and "theirs" = your commit being replayed.', 'Undo the finished rebase: git reset --hard ORIG_HEAD (or find "rebase (start)" in git reflog).', 'git rebase main, then git checkout --theirs price.js, git add price.js, git rebase --continue'],
    solution: ['git reset --hard ORIG_HEAD', 'git rebase main', 'git checkout --theirs price.js', 'git add price.js', 'git rebase --continue'],
    lesson: 'In a merge, --ours is your branch. In a rebase it flips: --ours is the branch you rebase onto, --theirs is your own commit. If a rebase went wrong, ORIG_HEAD (or the reflog) takes you back to before it started.',
  },
];

// ───────────────────────────── Team life ─────────────────────────────

const LOCK_BASE = '{\n  "name": "shop",\n  "lockfileVersion": 3,\n  "packages": {\n    "react": "18.2.0"\n  }\n}\n';

export const TEAM_2: Level[] = [
  {
    id: 'review-branch',
    chapter: 'Team life',
    title: "Review a teammate's branch",
    story: `<p>Sam: <i>"can you try my <code>search-fix</code> branch locally before I merge?"</i></p>
<p>You've never had that branch. Get it, check it out as a <b>local branch that tracks origin</b>, and make sure you have Sam's latest commit.</p>`,
    setup: () =>
      new Scenario()
        .run('git init')
        .commit({ 'search.js': 'export const search = (items, q) => items.filter((i) => i.includes(q));\n' }, 'Add search')
        .withRemote()
        .teammatePush(sam, 'search-fix', { 'search.js': 'export const search = (items, q) => (q ? items.filter((i) => i.includes(q)) : items);\n' }, 'Fix search for empty query', { parentBranch: 'main' }).w,
    goals: [
      { text: 'You are on a local branch search-fix', check: (w) => onBranch(w, 'search-fix') },
      { text: 'It tracks origin/search-fix', check: (w) => w.repo?.upstream['search-fix'] === 'origin/search-fix' },
      { text: 'It has Sam\'s latest commit "Handle uppercase queries"', check: (w) => hasMessage(w, branchTip(w, 'search-fix'), 'Handle uppercase queries') },
    ],
    hints: ['git branch -a shows remote branches, but only ones you have fetched. Start with git fetch.', 'git switch search-fix: when only origin/search-fix exists, switch creates a local branch that tracks it.', 'Sam pushed again? git pull.'],
    solution: ['git fetch', 'git switch search-fix', 'git pull'],
    lesson: 'fetch first, then git switch <name> creates a tracking branch from origin/<name>. Don\'t git checkout origin/<name>: that is a detached HEAD, and commits made there get lost.',
    events: [
      {
        id: 'sam-pushes-more',
        when: (w) => onBranch(w, 'search-fix'),
        run: (w) => {
          teammatePush(w, sam, 'search-fix', { 'search.js': 'export const search = (items, q) => (q ? items.filter((i) => i.toLowerCase().includes(q.toLowerCase())) : items);\n' }, 'Handle uppercase queries');
          return ['💬 Sam: "oh wait, pushed one more fix to search-fix just now 🙏"'];
        },
      },
    ],
  },
  {
    id: 'pr-only',
    chapter: 'Team life',
    title: 'main only accepts pull requests',
    story: `<p>You committed "Add reviews" straight on <code>main</code> and ran <code>git push</code>. The server said no: <code>main</code> only accepts pull requests.</p>
<p>Put your commit on a branch called <code>reviews</code> on origin (so you can open a PR), and make your local <code>main</code> match <code>origin/main</code> again.</p>`,
    setup: () =>
      new Scenario()
        .run('git init')
        .commit({ 'product.js': 'export const product = { name: "Mug" };\n' }, 'Initial commit')
        .withRemote()
        .server((rem) => (rem.prOnly = ['main']))
        .commit({ 'reviews.js': 'export const reviews = [];\n' }, 'Add reviews').w,
    prelude: ['git push'],
    goals: [
      { text: 'origin/reviews has "Add reviews"', check: (w) => remoteHas(w, 'reviews', 'Add reviews') },
      { text: 'origin/main is unchanged', check: (w) => !remoteHas(w, 'main', 'Add reviews') },
      { text: 'Your main matches origin/main', check: (w) => synced(w, 'main') },
    ],
    hints: ['Same trick as "committed on the wrong branch": label the commit with a new branch, then move main back.', 'git branch reviews, then git reset --hard origin/main', 'git switch reviews, then git push -u origin reviews'],
    solution: ['git branch reviews', 'git reset --hard origin/main', 'git switch reviews', 'git push -u origin reviews'],
    lesson: 'Most teams protect main so changes arrive by pull request. Work on a branch from the start (git switch -c <feature>), and if you forget, a branch + reset moves the commits over.',
  },
  {
    id: 'take-theirs',
    chapter: 'Team life',
    title: 'Take their version of a file',
    story: `<p>You're merging <code>main</code> into your <code>wishlist</code> branch. <code>app.js</code> merges fine, but <code>package-lock.json</code> conflicts. Nobody resolves a lockfile by hand.</p>
<p>Team rule: take <code>main</code>'s lockfile <b>as a whole</b>. Finish the merge.</p>`,
    setup: () => {
      const s = new Scenario().run('git init').commit({ 'package-lock.json': LOCK_BASE, 'app.js': 'import "./cart";\n' }, 'Initial commit').run('git switch -c wishlist');
      s.commit({ 'package-lock.json': LOCK_BASE.replace('"react": "18.2.0"', '"react": "18.2.0",\n    "idb": "8.0.0"'), 'app.js': 'import "./cart";\nimport "./wishlist";\n' }, 'Add wishlist')
        .run('git switch main')
        .commit({ 'package-lock.json': LOCK_BASE.replace('18.2.0', '18.3.1') }, 'Upgrade react')
        .run('git switch wishlist');
      return s.w;
    },
    prelude: ['git merge main'],
    goals: [
      { text: "package-lock.json is exactly main's version", check: (w) => tipTree(w, 'wishlist')['package-lock.json'] === tipTree(w, 'main')['package-lock.json'] },
      { text: 'app.js still imports your wishlist', check: (w) => !!tipTree(w, 'wishlist')['app.js']?.includes('wishlist') },
      { text: 'The merge is committed', check: (w) => { const t = branchTip(w, 'wishlist'); return !!t && w.objects[t].parents.length === 2 && isClean(w); } },
    ],
    hints: ['In a merge, "ours" is the branch you are on (wishlist) and "theirs" is the one being merged in (main).', 'git checkout --theirs package-lock.json replaces the file with main\'s version.', 'Then git add package-lock.json and git commit --no-edit'],
    solution: ['git checkout --theirs package-lock.json', 'git add package-lock.json', 'git commit --no-edit'],
    lesson: 'git checkout --ours/--theirs <file> (or git restore --ours/--theirs) takes one side of a conflicted file wholesale. In real life, run npm install afterwards so your new package is added back to the lockfile.',
  },
  {
    id: 'modify-delete',
    chapter: 'Team life',
    title: 'You edited a file Alex deleted',
    story: `<p>You fixed a rounding bug in <code>legacy-cart.js</code>. Meanwhile Alex moved that code to <code>cart.js</code> and <b>deleted</b> <code>legacy-cart.js</code>.</p>
<p>Pull with a merge (<code>git pull --no-rebase</code>). Then move your fix (<code>Math.round</code>) into <code>cart.js</code>, delete <code>legacy-cart.js</code>, and push.</p>`,
    setup: () =>
      new Scenario()
        .run('git init')
        .commit({ 'legacy-cart.js': 'export const total = (items) => items.reduce((s, i) => s + i.price, 0);\n' }, 'Initial commit')
        .withRemote()
        .teammatePush(alex, 'main', { 'legacy-cart.js': null, 'cart.js': 'export const total = (items) => items.reduce((s, i) => s + i.price, 0);\n' }, 'Move cart code to cart.js')
        .commit({ 'legacy-cart.js': 'export const total = (items) => Math.round(items.reduce((s, i) => s + i.price, 0));\n' }, 'Round cart totals').w,
    goals: [
      { text: 'legacy-cart.js is gone', check: (w) => !('legacy-cart.js' in remoteTree(w, 'main')) },
      { text: 'cart.js has your Math.round fix', check: (w) => !!remoteTree(w, 'main')['cart.js']?.includes('Math.round') },
      { text: "origin/main has Alex's move and your commit", check: (w) => remoteHas(w, 'main', 'Move cart code to cart.js') && remoteHas(w, 'main', 'Round cart totals') },
      { text: 'Pushed, clean', check: (w) => synced(w, 'main') && isClean(w) },
    ],
    hints: ['The conflict says "modify/delete": one side edited, the other deleted. There are no <<<<<<< markers to fix.', 'Edit cart.js (nano cart.js) to wrap the reduce in Math.round(...), then git add cart.js.', 'git rm legacy-cart.js accepts the deletion. Then git commit --no-edit and git push.'],
    solution: [
      'git pull --no-rebase',
      'echo "export const total = (items) => Math.round(items.reduce((s, i) => s + i.price, 0));" > cart.js',
      'git add cart.js',
      'git rm legacy-cart.js',
      'git commit --no-edit',
      'git push',
    ],
    lesson: 'In a modify/delete conflict git keeps the edited file and asks you to choose: git add it to keep it, git rm it to accept the deletion. When code moved, port your change to its new home first.',
  },
  {
    id: 'revert-merge',
    chapter: 'Team life',
    title: 'Undo a pushed merge',
    story: `<p>The new checkout was merged into <code>main</code> an hour ago, and it's breaking payments in production. Since then Alex pushed an FAQ page on top.</p>
<p><code>main</code> is protected (no force pushes). Undo the whole checkout merge, keep Alex's FAQ, and push.</p>`,
    setup: () => {
      const s = new Scenario().run('git init').commit({ 'checkout.js': 'export const pay = () => "v1";\n' }, 'Initial commit').withRemote({ protect: ['main'] }).run('git switch -c new-checkout');
      s.commit({ 'checkout-v2.js': 'export const pay = () => charge(twice); // oops\n' }, 'New checkout flow')
        .run('git switch main')
        .commit({ 'about.html': '<h1>About</h1>\n' }, 'Add about page')
        .run('git merge --no-ff new-checkout -m "Merge branch \'new-checkout\'"', 'git push')
        .teammatePush(alex, 'main', { 'faq.html': '<h1>FAQ</h1>\n' }, 'Add FAQ page');
      return s.w;
    },
    goals: [
      { text: 'origin/main no longer has checkout-v2.js', check: (w) => !('checkout-v2.js' in remoteTree(w, 'main')) },
      { text: "origin/main keeps Alex's FAQ and the about page", check: (w) => 'faq.html' in remoteTree(w, 'main') && 'about.html' in remoteTree(w, 'main') },
      { text: 'History was not rewritten (the merge is still there)', check: (w) => remoteHas(w, 'main', "Merge branch 'new-checkout'") },
      { text: 'Your main matches origin/main', check: (w) => synced(w, 'main') },
    ],
    hints: ['Get up to date first: git pull. Then find the merge with git log --oneline --graph.', 'git revert <merge> fails: a merge has two parents and git needs to know which side is "main".', 'git revert -m 1 HEAD~1 (parent 1 = main), then git push'],
    solution: ['git pull', 'git revert -m 1 HEAD~1', 'git push'],
    lesson: 'git revert -m 1 <merge> undoes everything a merge brought in, as a new commit, which is safe on shared branches. -m 1 means "relative to the first parent", the branch that was merged into.',
  },
  {
    id: 'reland-feature',
    chapter: 'Team life',
    title: 'Re-land a reverted feature',
    story: `<p>After the checkout was reverted, you fixed the bug on <code>new-checkout</code> (commit "Fix double charge"). Time to bring the feature back to <code>main</code> and push.</p>
<p>Make sure <code>main</code> really ends up with <b>both</b> <code>checkout-v2.js</code> and the fix in <code>flags.js</code>.</p>`,
    setup: () => {
      const s = new Scenario().run('git init').commit({ 'checkout.js': 'export const pay = () => "v1";\n' }, 'Initial commit').withRemote().run('git switch -c new-checkout');
      s.commit({ 'checkout-v2.js': 'export const pay = () => charge(flags.once);\n' }, 'New checkout flow')
        .run('git switch main')
        .commit({ 'about.html': '<h1>About</h1>\n' }, 'Add about page')
        .run('git merge --no-ff new-checkout -m "Merge branch \'new-checkout\'"', 'git revert -m 1 HEAD --no-edit', 'git push', 'git switch new-checkout')
        .commit({ 'flags.js': 'export const flags = { once: true };\n' }, 'Fix double charge')
        .run('git push -u origin new-checkout', 'git switch main');
      return s.w;
    },
    goals: [
      { text: 'origin/main has checkout-v2.js', check: (w) => 'checkout-v2.js' in remoteTree(w, 'main') },
      { text: 'origin/main has the fix (flags.js)', check: (w) => 'flags.js' in remoteTree(w, 'main') },
      { text: 'Your main matches origin/main', check: (w) => synced(w, 'main') },
    ],
    hints: ['Try git merge new-checkout and look at what arrives. Only the fix! Git thinks the old commits are already merged (they are, then the revert undid them).', 'Bring the original back by reverting the revert: git revert HEAD (the revert is the latest commit on main).', 'git revert HEAD, then git merge new-checkout, then git push'],
    solution: ['git revert HEAD', 'git merge new-checkout', 'git push'],
    lesson: 'Reverting a merge does not un-merge the branch: git still counts those commits as merged. To re-land it, revert the revert first, then merge the new fixes.',
  },
  {
    id: 'wrong-tag',
    chapter: 'Team life',
    title: 'Tagged the wrong commit',
    story: `<p>You tagged and pushed <code>v2.0</code>… on the commit <i>before</i> "Release 2.0" (the one that bumps the version number). The deploy bot hasn't picked it up yet.</p>
<p>Move <code>v2.0</code> to the "Release 2.0" commit, both locally and on origin.</p>`,
    setup: () =>
      new Scenario()
        .run('git init')
        .commit({ 'package.json': '{ "version": "1.9.0" }\n' }, 'Initial commit')
        .commit({ 'pay.js': 'export const pay = () => true;\n' }, 'Add payments')
        .commit({ 'package.json': '{ "version": "2.0.0" }\n' }, 'Release 2.0')
        .withRemote().w,
    prelude: ['git tag v2.0 HEAD~1', 'git push origin v2.0', 'git log --oneline'],
    goals: [
      { text: 'Your v2.0 points at "Release 2.0"', check: (w) => !!w.repo && w.repo.tags['v2.0'] === headId(w) },
      { text: "origin's v2.0 points at it too", check: (w) => !!w.remote?.tags && w.remote.tags['v2.0'] === branchTip(w, 'main') },
    ],
    hints: ['git tag v2.0 fails: the tag exists. -f moves it: git tag -f v2.0', 'git push origin v2.0 gets rejected: tags are not supposed to move.', 'Force just that tag: git push --force origin v2.0 (or git push origin --delete v2.0 and push again)'],
    solution: ['git tag -f v2.0', 'git push --force origin v2.0'],
    lesson: 'Tags are meant to be permanent, so git refuses to move them on origin without force. Fix a tag only if nobody has used it yet. Once a release is out, make v2.0.1 instead.',
  },
];
