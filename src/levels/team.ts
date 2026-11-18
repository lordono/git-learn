import { hasConflictMarkers } from '../engine/merge';
import { isAncestor, treeOf } from '../engine/repo';
import { Scenario, TEAMMATES, branchTip, hasMessage, isClean, isLinear, remoteHas, teammatePush } from './scenario';
import type { Level } from './types';

const { alex, sam } = TEAMMATES;
const chapter = 'Team life';

const LOGIN_JS = `export function login(user) {
  if (!user) return false;
  const session = createSession(user);
  audit("login", user.id);
  return session;
}

export function logout(session) {
  session.end();
}
`;

export const TEAM: Level[] = [
  {
    id: 'push-rejected',
    chapter,
    title: 'Push rejected',
    story: `<p>You committed a search feature and want to share it. Run <code>git push</code>.</p>
<p>What you don't know: Alex pushed to <code>main</code> 10 minutes ago. Get your commit onto <code>origin/main</code> <b>without</b> deleting Alex's work.</p>`,
    setup: () =>
      new Scenario()
        .run('git init')
        .commit({ 'README.md': '# Shop\n', 'app.js': 'export const items = [];\n' }, 'Initial commit')
        .withRemote()
        .teammatePush(alex, 'main', { 'README.md': '# Shop\n\nRun `npm start` to begin.\n' }, 'Document npm start')
        .commit({ 'app.js': 'export const items = [];\nexport const search = (q) => items.filter((i) => i.includes(q));\n' }, 'Add search').w,
    goals: [
      { text: 'origin/main has your "Add search" commit', check: (w) => remoteHas(w, 'main', 'Add search') },
      { text: "origin/main still has Alex's commit", check: (w) => remoteHas(w, 'main', 'Document npm start') },
      { text: 'Your main matches origin/main', check: (w) => !!w.repo && w.repo.branches.main === w.remote?.branches.main },
    ],
    hints: ['Read the push error: "fetch first" means origin has commits you don\'t have.', 'git pull. If git asks how to reconcile divergent branches, pick one: git pull --rebase (straight line) or git pull --no-rebase (merge commit).', 'git pull --rebase, then git push'],
    solution: ['git push', 'git pull --rebase', 'git push'],
    lesson: 'A rejected push is git protecting your teammates. Integrate first (pull), then push. Set your default once with git config --global pull.rebase true (or false).',
    events: [
      {
        id: 'alex-slack',
        when: (_w, line) => /^git push\b/.test(line.trim()),
        run: () => ['💬 Alex: "oh I pushed a README tweak to main earlier, hope that\'s ok!"'],
      },
    ],
  },
  {
    id: 'stash-pull',
    chapter,
    title: 'Pull blocked by local changes',
    story: `<p>You're halfway through editing <code>cart.js</code> (not ready to commit). Sam says: "I pushed a fix to cart.js, pull it before you continue!"</p>
<p>Get Sam's commit, and keep your half-done edit. Uncommitted, since it's not finished.</p>`,
    setup: () =>
      new Scenario()
        .run('git init')
        .commit({ 'cart.js': '// cart\nexport function total(items) {\n  return items.reduce((s, i) => s + i.price, 0);\n}\n\nexport const CURRENCY = "USD";\n' }, 'Add cart')
        .withRemote()
        .teammatePush(sam, 'main', { 'cart.js': '// cart: prices are in cents\nexport function total(items) {\n  return items.reduce((s, i) => s + i.price, 0);\n}\n\nexport const CURRENCY = "USD";\n' }, 'Clarify cart units')
        .write({ 'cart.js': '// cart\nexport function total(items) {\n  return items.reduce((s, i) => s + i.price, 0);\n}\n\nexport const CURRENCY = "EUR"; // WIP: multi-currency\n' }).w,
    goals: [
      { text: "Your main includes Sam's commit", check: (w) => hasMessage(w, branchTip(w, 'main'), 'Clarify cart units') },
      { text: "cart.js on disk has Sam's comment AND your EUR edit", check: (w) => !!w.files['cart.js']?.includes('cents') && !!w.files['cart.js']?.includes('EUR') },
      { text: 'Your EUR edit is still uncommitted', check: (w) => !treeOf(w, branchTip(w, 'main'))['cart.js']?.includes('EUR') },
      { text: 'The stash is empty again', check: (w) => w.repo?.stash.length === 0 },
    ],
    hints: ['Try git pull and read the error.', 'git stash shelves your edit and gives you a clean working tree.', 'git pull, then git stash pop'],
    solution: ['git pull', 'git stash', 'git pull', 'git stash pop'],
    lesson: 'git stash is a temporary shelf for unfinished work. Stash, pull, pop. (git stash -u also shelves untracked files.)',
  },
  {
    id: 'merge-conflict',
    chapter,
    title: 'Merge conflict',
    story: `<p>You changed the theme in <code>config.js</code> to <code>"dark"</code>. Alex changed the <i>same line</i> to <code>"blue"</code> and pushed first.</p>
<p>Pull with a <b>merge</b> (<code>git pull --no-rebase</code>), resolve the conflict (the team agreed on <code>"dark"</code>), and push.</p>
<p>Tip: <code>nano config.js</code> opens an editor.</p>`,
    setup: () =>
      new Scenario()
        .run('git init')
        .commit({ 'config.js': 'export const config = {\n  theme: "light",\n  pageSize: 20,\n};\n' }, 'Add config')
        .withRemote()
        .teammatePush(alex, 'main', { 'config.js': 'export const config = {\n  theme: "blue",\n  pageSize: 20,\n};\n' }, 'Use brand color')
        .commit({ 'config.js': 'export const config = {\n  theme: "dark",\n  pageSize: 20,\n};\n' }, 'Dark theme by default').w,
    goals: [
      { text: 'origin/main has both commits', check: (w) => remoteHas(w, 'main', 'Use brand color') && remoteHas(w, 'main', 'Dark theme by default') },
      { text: 'config.js on origin uses theme "dark", no conflict markers', check: (w) => { const t = treeOf(w, w.remote?.branches.main)['config.js']; return !!t && t.includes('"dark"') && !hasConflictMarkers(t) && !t.includes('"blue"'); } },
      { text: 'Nothing left half-done locally', check: (w) => isClean(w) },
    ],
    hints: ['git pull --no-rebase. It will stop with a CONFLICT.', 'cat config.js shows the markers. Edit it (nano config.js) so only theme: "dark" remains, without <<<<<<< ======= >>>>>>> lines.', 'git add config.js, git commit (the message is pre-filled), git push'],
    solution: ['git pull --no-rebase', 'echo "export const config = {\\n  theme: \\"dark\\",\\n  pageSize: 20,\\n};" > config.js', 'git add config.js', 'git commit', 'git push'],
    lesson: "A conflict isn't an error. Git is asking a human to decide. Between <<<<<<< HEAD and ======= is yours; below ======= is theirs. git merge --abort is always there if you panic.",
  },
  {
    id: 'moving-target',
    chapter,
    title: 'Moving target',
    story: `<p>Same situation as before: you and Alex both edited the banner text. Pull with <code>git pull --no-rebase</code>, keep <b>your</b> wording, and push.</p>
<p>But Alex is still working today. Keep an eye on the chat… 👀</p>`,
    setup: () =>
      new Scenario()
        .run('git init')
        .commit({ 'banner.js': 'export const banner = "Welcome to the shop";\n' }, 'Add banner')
        .withRemote()
        .teammatePush(alex, 'main', { 'banner.js': 'export const banner = "Shop now";\n' }, 'Shorter banner')
        .commit({ 'banner.js': 'export const banner = "Welcome! Free shipping today";\n' }, 'Friendlier banner').w,
    goals: [
      { text: 'origin/main has your banner commit', check: (w) => remoteHas(w, 'main', 'Friendlier banner') },
      { text: "origin/main still has both of Alex's commits", check: (w) => remoteHas(w, 'main', 'Shorter banner') && remoteHas(w, 'main', 'Add analytics') },
      { text: 'banner on origin is your wording, no markers', check: (w) => { const t = treeOf(w, w.remote?.branches.main)['banner.js'] ?? ''; return t.includes('Free shipping') && !t.includes('Shop now') && !hasConflictMarkers(t); } },
      { text: 'Nothing left half-done locally', check: (w) => isClean(w) },
    ],
    hints: ['git pull --no-rebase, fix banner.js (nano banner.js), git add banner.js, git commit.', 'If your push is rejected again, someone pushed while you were resolving. Nothing is wrong with your merge.', 'git pull --no-rebase again (no conflict this time), then git push.'],
    solution: ['git pull --no-rebase', 'echo "export const banner = \\"Welcome! Free shipping today\\";" > banner.js', 'git add banner.js', 'git commit', 'git push', 'git pull --no-rebase', 'git push'],
    lesson: 'Pushing is a race: the server only accepts a push that builds on its latest commit. If you lose the race, just integrate again. Never "win" it with --force.',
    events: [
      {
        id: 'alex-pushes-again',
        when: (w, line) => /^git add\b/.test(line.trim()) && w.repo?.op?.kind === 'merge',
        run: (w) => {
          teammatePush(w, alex, 'main', { 'analytics.js': 'export const track = (event) => send("/t", event);\n' }, 'Add analytics');
          return ['💬 Alex: "just pushed analytics, unrelated to the banner 👍"'];
        },
      },
    ],
  },
  {
    id: 'rebase-conflict',
    chapter,
    title: 'Rebase conflict → continue',
    story: `<p>Your team likes a straight-line history, so you pull with <code>git pull --rebase</code>.</p>
<p>You and Sam both changed the button color in <code>style.css</code>. Resolve it keeping <b>Sam's</b> color <code>green</code> but <b>your</b> rounded corners, finish the rebase, and push.</p>`,
    setup: () =>
      new Scenario()
        .run('git init')
        .commit({ 'style.css': '.button {\n  color: gray;\n}\n' }, 'Add button style')
        .withRemote()
        .teammatePush(sam, 'main', { 'style.css': '.button {\n  color: green;\n}\n' }, 'Brand green buttons')
        .commit({ 'style.css': '.button {\n  color: purple; border-radius: 8px;\n}\n' }, 'Rounded purple buttons').w,
    goals: [
      { text: 'origin/main has both commits', check: (w) => remoteHas(w, 'main', 'Brand green buttons') && remoteHas(w, 'main', 'Rounded purple buttons') },
      { text: 'History is a straight line (no merge commits)', check: (w) => isLinear(w, w.remote?.branches.main) },
      { text: 'style.css on origin is green with rounded corners', check: (w) => { const t = treeOf(w, w.remote?.branches.main)['style.css'] ?? ''; return t.includes('green') && t.includes('border-radius') && !t.includes('purple') && !hasConflictMarkers(t); } },
      { text: 'No rebase in progress', check: (w) => !w.repo?.op },
    ],
    hints: ['git pull --rebase. It stops on a conflict while replaying YOUR commit.', 'During a rebase, HEAD (top half) is Sam\'s version and the bottom half is your commit. Edit style.css to: color: green; border-radius: 8px;', 'git add style.css, git rebase --continue, git push'],
    solution: ['git pull --rebase', 'echo ".button {\\n  color: green; border-radius: 8px;\\n}" > style.css', 'git add style.css', 'git rebase --continue', 'git push'],
    lesson: 'Rebase replays your commits one by one on top of theirs. Conflicts get resolved per commit, then git rebase --continue. Notice "ours/theirs" feel flipped during a rebase.',
  },
  {
    id: 'rebase-abort',
    chapter,
    title: 'Get me out of this rebase',
    story: `<p>You started <code>git rebase main</code> on your <code>checkout-v2</code> branch and hit a conflict on the very first commit (scroll up). There are 3 commits to go and you don't understand the code on <code>main</code>.</p>
<p>Bail out. Get back <i>exactly</i> to where you were before the rebase started.</p>`,
    setup: () =>
      new Scenario()
        .run('git init')
        .commit({ 'checkout.js': 'export function checkout(cart) {\n  return pay(cart.total);\n}\n' }, 'Add checkout')
        .run('git switch -c checkout-v2')
        .commit({ 'checkout.js': 'export function checkout(cart) {\n  validate(cart);\n  return pay(cart.total);\n}\n' }, 'Checkout v2: validate cart')
        .commit({ 'checkout.js': 'export function checkout(cart) {\n  validate(cart);\n  return pay(cart.total, { retry: 3 });\n}\n' }, 'Checkout v2: retry payments')
        .commit({ 'receipt.js': 'export const receipt = (o) => `Paid ${o.total}`;\n' }, 'Checkout v2: receipts')
        .run('git switch main')
        .commit({ 'checkout.js': 'export async function checkout(cart) {\n  await audit(cart);\n  return pay(cart.total);\n}\n' }, 'Audit every checkout')
        .run('git switch checkout-v2').w,
    prelude: ['git rebase main'],
    goals: [
      { text: 'No rebase in progress', check: (w) => !w.repo?.op },
      { text: 'checkout-v2 is back to its original 3 commits (not rebased)', check: (w) => { const t = branchTip(w, 'checkout-v2'); const m = branchTip(w, 'main'); return !!t && !!m && w.objects[t].message === 'Checkout v2: receipts' && !isAncestor(w, m, t); } },
      { text: "You're on checkout-v2 with a clean working tree", check: (w) => w.repo?.head.kind === 'branch' && w.repo.head.name === 'checkout-v2' && isClean(w) },
    ],
    hints: ['git status tells you what state you are in and how to get out.', 'git rebase --abort'],
    solution: ['git status', 'git rebase --abort'],
    lesson: 'Every multi-step operation has an escape hatch: git rebase --abort, git merge --abort, git cherry-pick --abort. git status always tells you which one applies.',
  },
  {
    id: 'gone-upstream',
    chapter,
    title: 'My branch is [gone]',
    story: `<p>Your <code>holiday-banner</code> pull request was merged on the server, and the server deleted the branch. You're still sitting on your local copy of it.</p>
<p>Tidy up: update <code>main</code>, remove the stale <code>origin/holiday-banner</code> label, and delete your local branch. No <code>-D</code>, the safe way.</p>`,
    setup: () =>
      new Scenario()
        .run('git init')
        .commit({ 'index.html': '<h1>Shop</h1>\n' }, 'Initial commit')
        .withRemote()
        .run('git switch -c holiday-banner')
        .commit({ 'banner.html': '<div>🎄 Holiday sale</div>\n' }, 'Add holiday banner')
        .run('git push -u origin holiday-banner')
        .server((rem) => {
          rem.branches.main = rem.branches['holiday-banner'];
          delete rem.branches['holiday-banner'];
        }).w,
    goals: [
      { text: 'Your main has the banner (pulled)', check: (w) => hasMessage(w, branchTip(w, 'main'), 'Add holiday banner') && w.repo?.branches.main === w.remote?.branches.main },
      { text: 'The stale origin/holiday-banner label is gone', check: (w) => !!w.repo && !('origin/holiday-banner' in w.repo.remoteBranches) },
      { text: 'Local holiday-banner branch deleted', check: (w) => !!w.repo && !('holiday-banner' in w.repo.branches) },
    ],
    hints: ['git fetch --prune downloads AND removes labels for branches deleted on the server. Then git branch -vv shows [gone].', 'git switch main, then git pull.', 'git branch -d holiday-banner works now because its commit is in main.'],
    solution: ['git fetch --prune', 'git branch -vv', 'git switch main', 'git pull', 'git branch -d holiday-banner'],
    lesson: 'Server-side deletes never touch your machine: your origin/* labels and local branches stick around until you prune them. git config --global fetch.prune true makes every fetch prune.',
  },
  {
    id: 'force-pushed-over-you',
    chapter,
    title: 'Someone force-pushed over my work',
    story: `<p>You and Sam share the <code>redesign</code> branch. You pushed <i>"Redesign header"</i> this morning. Sam, working from an old copy, just ran <code>git push --force</code>. 😬</p>
<p>Your commit is gone from the server. Put it back, <b>keeping</b> Sam's commit too.</p>`,
    setup: () =>
      new Scenario()
        .run('git init')
        .commit({ 'header.html': '<header>Shop</header>\n', 'nav.html': '<nav>Home</nav>\n' }, 'Initial commit')
        .withRemote()
        .run('git switch -c redesign')
        .commit({ 'header.html': '<header class="new">Shop</header>\n' }, 'Redesign header')
        .run('git push -u origin redesign')
        .teammatePush(sam, 'redesign', { 'nav.html': '<nav class="new">Home</nav>\n' }, 'Redesign nav', { parentBranch: 'main' }).w,
    goals: [
      { text: "origin/redesign has Sam's commit", check: (w) => remoteHas(w, 'redesign', 'Redesign nav') },
      { text: 'origin/redesign has your commit back', check: (w) => remoteHas(w, 'redesign', 'Redesign header') && !!treeOf(w, w.remote?.branches.redesign)['header.html']?.includes('new') },
      { text: 'Your redesign matches the server', check: (w) => w.repo?.branches.redesign === w.remote?.branches.redesign },
    ],
    hints: ['git fetch. Look for "(forced update)" in the output.', 'Your local redesign branch still has your commit. Only the server lost it. git status shows you have diverged.', 'git pull --rebase replays your commit on top of Sam\'s, then git push.'],
    solution: ['git fetch', 'git status', 'git pull --rebase', 'git push'],
    lesson: "A force push can only delete commits from the server, not from people's machines. Whoever still has the commit can restore it. And that's why teams use --force-with-lease (or ban force pushes on shared branches).",
  },
  {
    id: 'lease-saves-you',
    chapter,
    title: '--force-with-lease saves the day',
    story: `<p>You pushed <code>login</code> for review, then improved your commit with <code>git commit --amend</code>. Amending rewrote the commit, so a normal push will be rejected.</p>
<p>Team rule: <b>never</b> <code>--force</code>, only <code>--force-with-lease</code>. Get your amended commit onto <code>origin/login</code> without losing anyone's work.</p>`,
    setup: () =>
      new Scenario()
        .run('git init')
        .commit({ 'login.js': LOGIN_JS }, 'Initial commit')
        .withRemote()
        .run('git switch -c login')
        .commit({ 'login.js': LOGIN_JS.replace('if (!user)', 'if (!user || !user.email)') }, 'Validate login email')
        .run('git push -u origin login')
        .teammatePush(alex, 'login', { 'login.test.js': 'test("rejects missing email", () => expect(login({})).toBe(false));\n' }, 'Add login tests')
        .write({ 'login.js': LOGIN_JS.replace('if (!user)', 'if (!user || !user.email)').replace('session.end()', 'session?.end()') })
        .run('git add login.js', 'git commit --amend --no-edit').w,
    goals: [
      { text: "origin/login still has Alex's tests", check: (w) => remoteHas(w, 'login', 'Add login tests') },
      { text: 'origin/login has your amended code (email check + session?.end())', check: (w) => { const t = treeOf(w, w.remote?.branches.login)['login.js'] ?? ''; return t.includes('user.email') && t.includes('session?.end()'); } },
      { text: 'Your login matches the server', check: (w) => w.repo?.branches.login === w.remote?.branches.login },
    ],
    hints: ['Try git push --force-with-lease and read why it was rejected.', 'Someone pushed to origin/login since you last fetched. git fetch, then git log --oneline login..origin/login to see it.', 'git rebase origin/login puts your amended commit on top of Alex\'s, then a normal git push works.'],
    solution: ['git push --force-with-lease', 'git fetch', 'git log --oneline login..origin/login', 'git rebase origin/login', 'git push'],
    lesson: '--force-with-lease = "force, but only if the server still has what I last saw". Plain --force would have silently deleted Alex\'s tests.',
  },
  {
    id: 'hotfix',
    chapter,
    title: 'Hotfix the release branch',
    story: `<p>Version 1.0 ships from the <code>release/1.0</code> branch. A crash fix landed on <code>main</code>, but <code>main</code> also has new unfinished features.</p>
<p>Bring <b>only</b> the crash fix into <code>release/1.0</code>.</p>`,
    setup: () =>
      new Scenario()
        .run('git init')
        .commit({ 'checkout.js': 'export function checkout(cart) {\n  return pay(cart.total);\n}\n' }, 'Initial commit')
        .run('git branch release/1.0')
        .commit({ 'wishlist.js': 'export const wishlist = [];\n' }, 'Add wishlist (beta)')
        .commit({ 'checkout.js': 'export function checkout(cart) {\n  if (!cart.items.length) return null;\n  return pay(cart.total);\n}\n' }, 'Fix checkout crash on empty cart')
        .commit({ 'reviews.js': 'export const reviews = [];\n' }, 'Add reviews (beta)').w,
    goals: [
      { text: 'release/1.0 has the crash fix', check: (w) => !!treeOf(w, branchTip(w, 'release/1.0'))['checkout.js']?.includes('items.length') },
      { text: 'release/1.0 has NO beta features', check: (w) => { const t = treeOf(w, branchTip(w, 'release/1.0')); return !('wishlist.js' in t) && !('reviews.js' in t); } },
      { text: 'main is untouched', check: (w) => { const t = branchTip(w, 'main'); return !!t && w.objects[t].message === 'Add reviews (beta)'; } },
    ],
    hints: ['git log --oneline to find the fix. It is main~1.', 'git switch release/1.0', 'git cherry-pick main~1 (or the commit id)'],
    solution: ['git log --oneline', 'git switch release/1.0', 'git cherry-pick main~1'],
    lesson: 'cherry-pick copies one commit\'s change onto your current branch (as a new commit). Perfect for hotfixes; a merge would have dragged the beta features along.',
  },
  {
    id: 'revert-pushed',
    chapter,
    title: 'Undo a pushed commit',
    story: `<p>Your commit <i>"Apply 90% discount"</i> shipped to production. It was supposed to be 10%. 🔥 Alex already pushed more work on top, and you've pulled it.</p>
<p><code>main</code> is <b>protected</b>: nobody may rewrite its history. Undo the discount commit and push the fix.</p>`,
    setup: () =>
      new Scenario()
        .run('git init')
        .commit({ 'price.js': 'export const PRICE = 100;\n' }, 'Set price')
        .withRemote({ protect: ['main'] })
        .commit({ 'price.js': 'export const PRICE = 10;\n' }, 'Apply 90% discount')
        .run('git push')
        .teammatePush(alex, 'main', { 'footer.html': '<footer>© Shop</footer>\n' }, 'Add footer')
        .run('git pull').w,
    goals: [
      { text: 'origin/main still contains "Apply 90% discount" (history not rewritten)', check: (w) => remoteHas(w, 'main', 'Apply 90% discount') },
      { text: "origin/main still has Alex's footer", check: (w) => 'footer.html' in treeOf(w, w.remote?.branches.main) },
      { text: 'Price on origin is back to 100', check: (w) => treeOf(w, w.remote?.branches.main)['price.js'] === 'export const PRICE = 100;\n' },
    ],
    hints: ['git log --oneline to find the bad commit. It is not the latest one!', 'git revert <id-of-discount-commit> (or git revert HEAD~1)', 'git push'],
    solution: ['git log --oneline', 'git revert HEAD~1', 'git push'],
    lesson: 'reset rewrites history (fine for unpushed work). revert adds an "anti-commit" (the right tool for anything already shared).',
  },
];
