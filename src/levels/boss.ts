/** Chapter 6: boss levels. Each one chains several earlier skills. */
import { hasConflictMarkers } from '../engine/merge';
import { ancestors, isAncestor, treeOf } from '../engine/repo';
import type { World } from '../engine/types';
import { EDITOR } from './runtime';
import { ORIGIN_URL, Scenario, TEAMMATES, YOU, branchTip, hasMessage, isClean, remoteHas, shaOf, teammatePush, todoFor } from './scenario';
import type { Level } from './types';

const { alex, sam } = TEAMMATES;
const chapter = 'Boss levels';

const remoteTree = (w: World, b: string) => treeOf(w, w.remote?.branches[b]);
const synced = (w: World, b: string) => !!w.repo && !!w.remote && w.repo.branches[b] === w.remote.branches[b];
/** no commit on any server branch contains `path` */
const serverNeverHad = (w: World, path: string) =>
  !!w.remote && Object.values(w.remote.branches).every((tip) => [...ancestors(w, tip)].every((id) => !(path in w.objects[id].tree)));

// ───── Friday 5pm ─────

const PAY_1 = 'export function webhook(event) {\n  if (event.type === "payment.succeeded") markPaid(event.id);\n}\n';
const PAY_2 = PAY_1.replace('markPaid(event.id);\n', 'markPaid(event.id);\n  if (event.type === "charge.refunded") markRefunded(event.id);\n');
const fridaySetup = () => {
  const s = new Scenario().run('git init').commit({ 'README.md': '# Shop\n', 'app.js': 'start();\n' }, 'Initial commit').withRemote();
  s.server((rem) => (rem.prOnly = ['main']));
  s.commit({ 'payments.js': PAY_1, '.env': 'STRIPE_SECRET=sk_live_51Hx9aQ2\n' }, 'Add payment webhook')
    .commit({ 'payments.js': PAY_2 }, 'Handle refunds')
    .teammatePush(alex, 'main', { 'README.md': '# Shop\n\nDeploys run every Friday at 6pm.\n' }, 'Document deploy schedule');
  return s.w;
};

// ───── The rebase from hell ─────

const CART_BASE = "export const TAX = 0.07;\nexport const CURRENCY = 'USD';\nexport function total(items) { return sum(items) * (1 + TAX); }\n";
const CART_FINAL = "export const TAX = rates.tax;\nexport const CURRENCY = 'USD';\nexport function total(items) { return sum(items, CURRENCY) * (1 + TAX) + fees(items); }\n";
const hellSetup = () => {
  const s = new Scenario().run('git init').commit({ 'cart.js': CART_BASE }, 'Initial commit').withRemote().run('git switch -c checkout-v2');
  s.commit({ 'cart.js': CART_BASE.replace('TAX = 0.07', 'TAX = rates.tax') }, 'Read tax from rates')
    .commit({ 'rates.js': 'export const rates = { tax: 0.08 };\n' }, 'Add rates table')
    .commit({ 'cart.js': CART_BASE.replace('TAX = 0.07', 'TAX = rates.tax').replace('sum(items)', 'sum(items, CURRENCY)') }, 'Sum in the cart currency')
    .commit({ 'cart.test.js': 'test("total", () => expect(total([])).toBe(0));\n' }, 'Test cart total')
    .run('git push -u origin checkout-v2')
    .run('git switch main')
    .as(sam)
    .commit({ 'cart.js': CART_BASE.replace('TAX = 0.07', 'TAX = 0.08') }, 'Raise tax to 8%')
    .commit({ 'cart.js': CART_BASE.replace('TAX = 0.07', 'TAX = 0.08').replace('(1 + TAX); }', '(1 + TAX) + fees(items); }') }, 'Add payment fees')
    .run('git push')
    .as(YOU)
    .run('git switch checkout-v2');
  return s.w;
};
const hellOriginalIds = (() => {
  const w = hellSetup();
  return [...ancestors(w, w.repo!.branches['checkout-v2'])].filter((id) => !isAncestor(w, id, w.repo!.branches.main));
})();

// ───── Archaeology+ ─────

const archSetup = () => {
  const s = new Scenario().as(alex).run('git init').commit({ 'app.js': 'init();\nrender();\n' }, 'Initial commit').withRemote({ protect: ['main'] });
  s.as(sam)
    .run('git switch -c promo-banner')
    .commit({ 'app.js': 'init();\nshowBanner();\nrender();\n', 'banner.js': 'export const showBanner = () => show("SALE ENDS SOON");\n' }, 'Add promo banner')
    .commit({ 'banner.js': 'export const showBanner = () => show("SALE ENDS SOON", countdown());\n' }, 'Promo: countdown timer')
    .run('git switch main')
    .as(alex)
    .commit({ 'footer.js': 'export const footer = "<a href=/help>Help</a>";\n' }, 'Add footer')
    .as(sam)
    .run('git merge --no-ff promo-banner -m "Merge branch \'promo-banner\'"', 'git branch -d promo-banner')
    .as(alex)
    .commit({ 'footer.js': 'export const footer = "<a href=/support>Help</a>";\n' }, 'Fix footer link')
    .as(YOU)
    .run('git push');
  return s.w;
};
const PROMO_MERGE = "Merge branch 'promo-banner'";

// ───── rm -rf .git ─────

const rmSetup = () => {
  const s = new Scenario().run('git init').commit({ 'app.js': 'start();\n', 'invoice.js': 'export const invoices = [];\n' }, 'Initial commit');
  s.commit({ 'app.js': 'start();\nloadInvoices();\n' }, 'Load invoices on start').withRemote();
  s.commit({ 'invoice.js': 'export const invoices = [];\nexport const pdf = (inv) => render(inv);\n' }, 'Invoice PDFs').write({ 'invoice.css': '.invoice { font: 12px serif; }\n' });
  return s.w;
};

export const BOSS: Level[] = [
  {
    id: 'boss-friday',
    chapter,
    title: 'Boss: Friday, 5pm',
    story: `<p>It's Friday at 5pm. You finished the payment webhook in two commits and are about to push. Then you notice three problems:</p>
<ol><li>You committed on <code>main</code>, which only accepts pull requests.</li>
<li>The first commit includes <code>.env</code> with the <b>live Stripe secret</b>.</li>
<li>Alex pushed to <code>main</code> since you last fetched.</li></ol>
<p>Get your work onto a branch <code>webhooks</code> on origin, built on the latest <code>main</code>, with the secret in <b>no</b> commit anywhere on the server. Keep <code>.env</code> on your disk (ignored), and put your local <code>main</code> back in sync with origin.</p>`,
    setup: fridaySetup,
    goals: [
      { text: 'origin/webhooks has the webhook AND the refund handling', check: (w) => remoteTree(w, 'webhooks')['payments.js'] === PAY_2 },
      { text: 'No commit on the server contains .env', check: (w) => !!w.remote?.branches.webhooks && serverNeverHad(w, '.env') },
      { text: "webhooks is built on Alex's latest main", check: (w) => remoteHas(w, 'webhooks', 'Document deploy schedule') },
      { text: '.env is still on disk and ignored', check: (w) => '.env' in w.files && !!w.files['.gitignore']?.split('\n').includes('.env') && !('.env' in (w.repo?.index ?? {})) },
      { text: 'Your main matches origin/main', check: (w) => synced(w, 'main') },
    ],
    hints: [
      'One problem at a time. First give your commits their own branch: git switch -c webhooks. (main still points at them too, fix that later.)',
      'Remove .env from the first commit with git rebase -i HEAD~2, marking it "edit". While stopped: git rm --cached .env, echo .env > .gitignore, git add .gitignore, git commit --amend --no-edit, git rebase --continue.',
      'Then git fetch, put main back with git branch -f main origin/main, git rebase origin/main (on webhooks), and git push -u origin webhooks.',
    ],
    solution: [
      'git switch -c webhooks',
      'git rebase -i HEAD~2',
      EDITOR + todoFor(fridaySetup(), [['edit', 'Add payment webhook'], ['pick', 'Handle refunds']]),
      'git rm --cached .env',
      'echo .env > .gitignore',
      'git add .gitignore',
      'git commit --amend --no-edit',
      'git rebase --continue',
      'git fetch',
      'git branch -f main origin/main',
      'git rebase origin/main',
      'git push -u origin webhooks',
    ],
    lesson: 'Big messes are a stack of small ones. Here: a branch label saves the commits, rebase -i with edit removes the secret before it ever leaves your laptop, branch -f fixes main, rebase catches up with Alex. Had the secret been pushed, the only real fix is rotating the key.',
    events: [
      {
        id: 'sam-friday',
        when: (_w, line) => /^git (rebase|reset|switch|branch)\b/.test(line.trim()),
        run: () => ['💬 Sam: "heading out in 10, can you get that PR up before the 6pm deploy? 🙏"'],
      },
    ],
  },
  {
    id: 'boss-rebase-hell',
    chapter,
    title: 'Boss: the rebase from hell',
    story: `<p>You ran <code>git rebase main</code> on <code>checkout-v2</code> to catch up with Sam's tax changes. Commit 1 of 4 already conflicts, and commit 3 edits the same lines again, so you'd be untangling the same file twice.</p>
<p>Also, <code>checkout-v2</code> is already pushed and Sam reviews from it, so a rebase would need a force push anyway.</p>
<p>Abort, and bring <code>main</code> in with a <b>merge</b> instead: one conflict to fix, no rewritten commits. The team agreed on this result for <code>cart.js</code>:</p>
<pre>${CART_FINAL.replace(/</g, '&lt;')}</pre>
<p>Then push (no force).</p>`,
    setup: hellSetup,
    prelude: ['git rebase main'],
    goals: [
      { text: 'No rebase in progress', check: (w) => !!w.repo && w.repo.op?.kind !== 'rebase' },
      { text: 'Your 4 original commits are untouched (same ids)', check: (w) => hellOriginalIds.every((id) => isAncestor(w, id, branchTip(w, 'checkout-v2') ?? '')) },
      { text: "checkout-v2 includes Sam's main", check: (w) => hasMessage(w, branchTip(w, 'checkout-v2'), 'Add payment fees') },
      { text: 'cart.js is exactly the agreed version', check: (w) => treeOf(w, branchTip(w, 'checkout-v2'))['cart.js'] === CART_FINAL && !hasConflictMarkers(w.files['cart.js']) },
      { text: 'Pushed without force', check: (w) => synced(w, 'checkout-v2') && isClean(w) },
    ],
    hints: [
      'git rebase --abort puts checkout-v2 back exactly as it was.',
      'git merge main: both conflicts show up at once, in one file.',
      "Write the agreed cart.js (nano cart.js, or echo with \\n between lines), then git add cart.js, git commit --no-edit, git push.",
    ],
    solution: [
      'git rebase --abort',
      'git merge main',
      `echo "${CART_FINAL.trimEnd().replace(/\n/g, '\\n')}" > cart.js`,
      'git add cart.js',
      'git commit --no-edit',
      'git push',
    ],
    lesson: 'A rebase replays commits one by one, so the same lines can conflict again and again. A merge resolves everything once. When a branch is shared or the rebase gets painful: --abort and merge. Neither is wrong, pick what costs least.',
  },
  {
    id: 'boss-archaeology',
    chapter,
    title: 'Boss: kill the promo banner',
    story: `<p>A "SALE ENDS SOON" banner is still on the site. The sale ended weeks ago. Marketing wants the <b>whole promo feature</b> gone: the <code>showBanner()</code> call, <code>banner.js</code>, and its countdown timer.</p>
<p>Nobody remembers how it got in. <code>main</code> is protected and the team keeps pushing. Remove it on origin without losing anyone's work.</p>`,
    setup: archSetup,
    goals: [
      { text: 'origin/main no longer calls showBanner()', check: (w) => !remoteTree(w, 'main')['app.js']?.includes('showBanner') },
      { text: 'banner.js is gone on origin/main', check: (w) => !('banner.js' in remoteTree(w, 'main')) },
      { text: "Everyone else's work is still there (footer fix, FAQ)", check: (w) => remoteTree(w, 'main')['footer.js']?.includes('/support') === true && 'faq.html' in remoteTree(w, 'main') },
      { text: 'History kept: the promo merge is still in the log', check: (w) => remoteHas(w, 'main', PROMO_MERGE) },
      { text: 'Your main matches origin/main', check: (w) => synced(w, 'main') },
    ],
    hints: [
      'git blame app.js tells you which commit added showBanner().',
      'That commit came in through a merge. git log --oneline --graph (or git log --oneline) shows the "Merge branch \'promo-banner\'" commit. Reverting the merge removes everything it brought in.',
      'git revert -m 1 <merge-sha>. If the push is rejected, someone pushed meanwhile: git pull --rebase, then push again.',
    ],
    solution: ['git blame app.js', 'git log --oneline', `git revert -m 1 ${shaOf(archSetup(), PROMO_MERGE)}`, 'git push', 'git pull --rebase', 'git push'],
    lesson: 'blame finds the commit, the graph tells you it arrived in a merge, and revert -m 1 removes the whole feature in one safe commit. On a busy shared branch, expect to pull once more before your push lands.',
    events: [
      {
        id: 'alex-faq',
        when: (_w, line) => /^git revert\b/.test(line.trim()),
        run: (w) => {
          teammatePush(w, alex, 'main', { 'faq.html': '<h1>FAQ</h1>\n' }, 'Add FAQ page');
          return ['💬 Alex: "pushed the FAQ page to main 🎉"'];
        },
      },
    ],
  },
  {
    id: 'boss-rm-rf',
    chapter,
    title: 'Boss: rm -rf .git',
    story: `<p>You meant to delete a cache folder and typed <code>rm -rf .git</code>. The repository is gone: branches, history, reflog. Your project <b>files</b> are still on disk, including today's work: the "Invoice PDFs" commit you never pushed, and an uncommitted <code>invoice.css</code>.</p>
<p>No ⏪ Rewind this time (well, there is, but pretend). Rebuild the repo, connect it to origin (<code>${ORIGIN_URL}</code>) <b>without</b> cloning over your files, and get today's work pushed on top of origin's history.</p>`,
    setup: rmSetup,
    prelude: ['rm -rf .git', 'git status'],
    goals: [
      { text: 'A repository with origin set up again', check: (w) => w.repo?.remotes.origin === ORIGIN_URL },
      { text: 'main tracks origin/main', check: (w) => w.repo?.upstream.main === 'origin/main' },
      { text: "origin's old history is kept (no force push)", check: (w) => !!w.remote && hasMessage(w, w.remote.branches.main, 'Load invoices on start') },
      { text: "Today's work is on origin: invoice PDFs and invoice.css", check: (w) => !!remoteTree(w, 'main')['invoice.js']?.includes('pdf') && 'invoice.css' in remoteTree(w, 'main') },
      { text: 'Clean working tree', check: (w) => synced(w, 'main') && isClean(w) },
    ],
    hints: [
      'git init gives you an empty repo, and your files are all "untracked". Then git remote add origin <url> and git fetch.',
      'git reset origin/main (mixed!) points main at origin\'s history WITHOUT touching your files. Now git status shows today\'s work as plain changes. (--hard would wipe it.)',
      'git branch -u origin/main, then git add -A, git commit, git push.',
    ],
    solution: ['git init', `git remote add origin ${ORIGIN_URL}`, 'git fetch', 'git reset origin/main', 'git branch -u origin/main', 'git status', 'git add -A', 'git commit -m "Invoice PDFs and styles"', 'git push'],
    lesson: 'Files survive rm -rf .git, history does not. git init + fetch + reset (mixed) origin/main reconnects your files to the server\'s history. Unpushed commits lose their separate history, which is why "push your branches" (even WIP ones) is the best backup.',
  },
];
