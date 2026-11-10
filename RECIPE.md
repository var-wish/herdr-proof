# Proof

Proof is a 320px panel on the right of the window. Each Herdr space is one card: the branch, ahead or behind, the last check, a screenshot when there is one, and a verdict. Verified means the person's own command passed on this exact commit with a clean worktree. It does not mean the change is correct.

## What you see

The panel sits on the chrome background, full height, 12px text.

The header is 40px. "Proof" is semibold. Beside it, a dim tally such as `1 verified · 1 unverified · 1 stale · 1 failing`. "Refresh" sits at the right in muted text.

The list scrolls, with 8px of padding and 8px between cards. A card is a rounded 8px rectangle with a 1px border and 8px of padding. The active space uses the accent border and the selected background. The others use the background color and light up with hover.

Each card, top to bottom:

- The space's status dot, 6px, only when an agent in it has a status. The name, semibold, then a 10px pill: Verified in `done`, Failing in `blocked`, Stale in `working`, Unverified in `dim`. The pill's fill is that color with `22` alpha.
- An 11px muted line: the branch, or `No git`, `detached` plus the first 7 hex digits of HEAD, `Git unavailable`, `No commits`, or `No folder`. Then `↑n` and `↓n` in the foreground when those counts are greater than zero. `dirty` in the working color when the worktree has tracked or untracked changes outside `.proof`, when `git status` failed, or the recorded run has `dirty: true`. A submodule with `ignore = all` is not reported by Git, so its changes do not show as dirty. The most urgent agent, right aligned, as `Claude Code · working`, with ` +n` when more than one agent is in the space.
- An 11px dim line: the command, `pass` or `fail`, `dirty` when the run recorded it, a relative time (`just now`, `5m ago`, `2h ago`, `3d ago`, otherwise the date), and the duration (`800ms`, `4.2s`, `13s`, `1m 5s`). No evidence reads `No evidence`. Before the first read the card says `Checking…`.
- The log or shot path, 11px muted, when one is set.
- A blocked error line when `latest.json` cannot be read, or git failed.
- The screenshot, 72px tall and the full width of the card, on the canvas color, when the shot is png, jpg, webp, or gif and is not a symlink.

The footer has a 1px top border. It shows the full command Run will use, wrapping, or `No command — set the layout's command, or shared proof.command`, or `No space`. Under that, three buttons, 28px tall, 7px radius: Run, Open, Shot. An enabled button uses `solid` and `solid_foreground`. A disabled one uses `raised` and `dim`. Run reads `Running…` and Shot reads `Saving…` while that work is in flight.

No spaces: `No spaces yet.` On a Herdr older than 0.1.14 the panel shows that requirement and does not read git or run anything.

## How it behaves

Verified is the configured command passing on this exact commit with a clean tree.

- Verified: `ok` is a pass, `command` equals the person's command, `commit` matches HEAD, `dirty` is not true, and `git status` succeeded with a clean tree apart from `.proof`.
- Failing: `commit` matches HEAD and `ok` is a failure. A dirty tree can still be Failing.
- Stale: `commit` names a different commit. The line under the branch still says pass or fail.
- Unverified: no evidence, no `commit` inside a git repo, a pass with no git commit, a dirty tree that would otherwise be Verified, a command other than the one configured, or git could not be read.

`at` does not tie a run to HEAD. A timestamp more than two minutes ahead of now is ignored. A missing `commit` is Unverified, not Stale. Seven or more hex digits match a full sha, and either string may be the prefix. A detached HEAD uses the same sha rule.

Agent status is only the label on the card. blocked, then done, then working, then idle. It does not move the verdict.

Clicking a card runs `space.select`. Refresh reads again. The footer follows the active space.

Run executes only the command from `props.command` or shared `proof.command`, in the git toplevel (the folder, when there is no git). It writes `.proof/last.log` and `.proof/latest.json` with `v: 1` and `dirty` from a fresh `git status` that excludes `.proof`. A nonzero status is stored as `dirty: true`. It keeps an existing screenshot. A timeout is a failure with the note `timed out`. A command longer than 240 characters is not run.

Open launches the shot, else the log, only when the extension is png, jpg, jpeg, gif, webp, log, or txt and the path is not a symlink. Every other path opens the `.proof` directory.

Shot saves `herdr-app shot` to `.proof/shots/<time>.png` and sets `shot` on the manifest without changing `ok`, `at`, or `commit`. The picture is the whole Herdr window.

Git and `.proof` are reread every 10 seconds, and when the space's folder changes. `.proof` is also watched when the directory exists. A watch that cannot start (on Linux, a gitignored directory) is left to the timer. Nothing is polled faster than that, and a read already in flight is not started again. Manifests over 64 KiB are rejected.

## Built from

One mod, `mods/proof/`, with `main.js`, `logic.js`, and `mod.json` (`place: "right"`, `size: 320`, `herdr: "0.1.14"`). Herdr 0.1.14 ignores the `herdr` key. The panel imports `updates` only if it is there. Below 0.1.14 it draws the requirement and stops. If `updates` is missing, it keeps the panel and does not start the 10s timer: Refresh is manual. No layout file and no `keys.json`. `logic.js` is pure and is what `node --test` imports. `main.js` default-exports a `View`.

The folder for a space is its first terminal's live cwd, otherwise `space.folder`. Evidence is read at `git rev-parse --show-toplevel`, or at that folder when git says it is not a repository.

Git calls, all with `--no-optional-locks` and `core.fsmonitor=false`: `rev-parse --show-toplevel`, `symbolic-ref -q HEAD`, `rev-list --left-right --count HEAD...@{upstream}`, `rev-parse --verify HEAD`, `log -1 --format=%cI`, `status --porcelain=v1 -- . :!.proof` (untracked files count as dirty; `.proof` does not; a nonzero status is dirty).

Herdr: `spaces`, `panes`, `agents`, `theme`, `exec`, `readTextFile`, `writeTextFile`, `watchFolder`, `appHome`, `props`, `shared`, `run`, `window`, `updates`. The only app command is `space.select`.

Programs: `git`, `sh -c` (Windows `cmd /c`) for the person's command only, `mkdir`, `rm`, `cp -P`, `test -f`, `realpath -e`, `herdr-app shot`, and `xdg-open` / `open` / `cmd /c start`. Open runs only when `test -f` succeeds and `realpath` of the file stays inside `realpath` of `.proof`. A directory named like an image, or a symlink that leaves that directory, opens the folder. A space on another machine writes files through `python3`. Screenshots that are regular image files are copied to `data/proof/<space-id>.<ext>` under the app home so `image()` can draw them. Symlinks are not copied. `latest.json` wins when it exists. Otherwise the newest of the last 32 `.proof/runs/*.json` files is used.

The command Run uses is `props.command`, else shared `proof.command`. `timeout_ms` on the props or shared `proof.timeout_ms` defaults to 120000 and is clamped to 1000–600000. `.proof/config.json` is not read.

Colors come from `theme()`. There is no extra art.

## Watch out

- On Herdr 0.1.14 a shipped layout will not take a new mod, and cloning `main` did not insert this one either. Add the block to a layout you own, and put the check command in that block's `props.command`. `place` and `size` are only the request.
- Tell the person to gitignore `.proof/`. A committed copy is how a clone would ship a badge or a path.
- Shot captures the whole window, then writes it into the worktree.
- `image()` loads paths inside the app home. Copying a shot into `mods/proof/` reloads the mod. Copy it under `data/proof/` with `cp -P` after `rm` of the destination, and skip symlinks. Spaces on another machine do not get a thumbnail.
- Without `commit`, a pass on a repository is Unverified, not Stale and not Verified. `at` cannot fill in for it.
- `latest.json` that is present but invalid, too large, or a different `v` is shown as an error. The runs folder is not a fallback for a broken pointer. Missing `v` is version 1.
- Paths outside `.proof` (`..`, absolute, empty segments) are dropped. Open refuses every extension except png, jpg, jpeg, gif, webp, log, and txt.
- `ok` is a boolean or an integer exit code. Anything else is ignored.
- Run is the person's shell command. Do not take one from the repository. Do not trim a too-long command and run the remainder.
- Ahead/behind need an upstream. A missing upstream is not shown as zero.
- The 10s timer keeps running while the panel is hidden. That is the whole poll. It does not start when the Herdr version is too old.
- Remote writes need `python3` on that machine. Local writes use `writeTextFile`.
- Control characters and bidi marks are stripped from text fields before they are shown or compared.

## Done when

- `node --test` passes, including a pass tied to HEAD only when the configured command matches, a failure tied to HEAD, evidence for another commit (pass or fail) marked stale, a missing commit marked unverified, a future `at` ignored, a dirty or untracked tree not verified, a hostile fixture whose `config.json` is not the command and whose `.sh` shot opens the folder, detached HEAD, no git, and a missing manifest.
- `herdr-app check` on `mods/proof` passes on 0.1.14.
- Four spaces show four cards: a clean branch whose `.proof/latest.json` matches HEAD, passed, and names the configured command (Verified, with `↑` when it is ahead), a branch whose manifest names the previous commit (Stale), a branch whose manifest failed on HEAD (Failing), and a folder that is not a git repo (Unverified, `No git`).
- Making that verified tree dirty, including with an untracked file, drops it to Unverified until the tree is clean again.
- Run on the failing space rewrites `latest.json` with `dirty` and `last.log`, keeps the shot, and the card stays Failing.
- Shot on the stale space writes a png from `herdr-app shot` and the card shows it without leaving Stale.
- Open opens a png, and a manifest that points at a script opens the `.proof` folder instead.
