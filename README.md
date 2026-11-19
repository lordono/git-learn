# git-learn

Learn git by typing real commands in a sandbox where every mistake can be undone.

57 levels in seven chapters (Basics, Undo & rescue, Team life, Rewriting history, Detective work, Boss levels, lazygit). Each level drops you into a situation (normal workflow, or a mess you made, or a mess a teammate made) and checks the repository's final state. Next to the terminal you can watch the commit graph, the three trees (working dir / staging / HEAD), and the server (`origin`) change as you type.

```bash
npm install
npm run dev     # http://localhost:5173
npm test        # engine tests + runs every level's solution
```

## How it works

- `src/engine/`: a git simulator in TypeScript. It is not real git: it models commits, branches, HEAD, the index, the reflog, stash, merge/rebase/cherry-pick/revert with real line-level conflicts, interactive rebase (the todo list and commit messages open in a sandbox editor), `blame`, `bisect` (with a sandbox `npm test` so `bisect run` works), tags, `clean`, `--ours/--theirs`, `revert -m`, and a fake remote with push rejection, `--force-with-lease`, protected and pull-request-only branches. Output mimics real git, plus 💡 explanations and ⚠️ warnings (e.g. "these uncommitted changes can't be recovered").
- `src/engine/shell.ts`: a tiny shell (`ls`, `cat`, `echo > file`, `nano`, `rm`, `&&`).
- `src/levels/`: levels are built by running real commands (`Scenario`), and teammates push via `teammatePush`.
- `src/ui/`: terminal, SVG commit graph, panels. Vanilla TS, no framework.
- **lazygit mode** (`src/lazygit/model.ts`, `src/ui/lazygit.ts`): a lazygit-style screen with lazygit's default keys. Every key runs real git commands through the same engine, listed in a command log, so learners see what lazygit does for them. It's always on in the lazygit chapter, and unlocks on many regular levels once you've beaten them with plain git.
- ⏪ **Rewind** is the app's own undo stack, separate from git, so learners can always back out.

See [docs/SCENARIOS.md](docs/SCENARIOS.md) for the level roadmap.
