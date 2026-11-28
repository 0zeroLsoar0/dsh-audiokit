# Release runbook — `dsh-audiokit` 0.6.1

This is the exact manual procedure for publishing the plugin. The publish
actions themselves — `npm publish`, creating the GitHub repository and pushing —
are **not** done by an agent: run them yourself with your own npm/GitHub
credentials. (The repository-side pieces — `package.json`, the test runner and
the CI workflow — are already in place; everything below is verification plus
the human-only steps.)

Commands assume the current directory is **this plugin root** — `dsh-audio/` in
the workspace repository
(`F:\Users\Administrator\Documents\deepseek-harness\default-workspace\dsh-audio`);
the release number lives there, in `package.json` only. On Windows the bundled
node is not on `PATH`; use its full path, e.g.
`C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`.
`npm` sits next to it at `F:\tools\node\npm.cmd` on this machine.

> **Do not publish from `dsh-audio-lab/plugin/`.** That is an older staging copy
> (still 0.5.10), and `dsh-audio-lab/tools/publish-pack.mjs` currently stages it
> from a hard-coded `..\plugin` path. Until that path is repointed at `dsh-audio/`,
> publish by packing this tree and handing the tarball to npm (see §6).

## 0. What the rename does and does not change

- The **package name is `dsh-audiokit`** everywhere it is an identity: the manifest
  (`package.json`), the client bundle id (`client.js` →
  `window.__ModuleLoader__.load({ id: 'dsh-audiokit' })`), the settings-section id,
  the Cordis patch entry *name*, the skill provider/locator, `tools/*` banners and
  these docs. Nothing installable still says `@local/dsh-audio`.
- The **Cordis bundle entry id stays `dsh-audio`** (`cordis.patch.yml` →
  `insert[0].id: dsh-audio`). That id is the key a profile stores the entry — and
  the saved MiniMax key — under; renaming it would orphan an existing config, so it
  is frozen even though the plugin's name changed.
- The **HTTP routes stay** `/dsh-audio/config`, `/dsh-audio/test`,
  `/dsh-audio/voices`, `/dsh-audio/validate`, and the **tool names stay `audio_*`**.
  Both halves of the running app already agree on them; changing either would force
  a matching change in the live page and in every recorded tool call, for no gain.
- Also unchanged on purpose: the settings label 声音/Sound, the skill name
  `animation-sound`, and the JSON format tags
  `dsh-audio-lipsync` / `dsh-audio-beats` / `dsh-audio-stems` / `dsh-audio-analyze`
  (on-disk data contracts, read back by the tests).
- The package version is **0.6.1**, and it is written **only** in `package.json`:
  `index.js` reads it into `VERSION` (the settings page and the editor header echo
  it), and `test/version-single-source.mjs` fails the suite if `index.js`, this
  runbook, the tarball name or the git tag names a different version. Bump the
  manifest, not those files by hand.
- A profile installed under the old `@local/dsh-audio` specifier must be
  **reinstalled under the new name** (`plugin_manager action: install_bundle
  target: <path>`, or `dsh plugin --profile <profile> add "file:<path>"` plus
  `dsh-audiokit` in `dsh.profile.bundles`). The saved entry config — including the
  MiniMax key — survives, because the entry id did not change.

`cordis.patch.yml` now declares `name: dsh-audiokit` and `client.js` registers the
bundle as `id: 'dsh-audiokit'`; the repo manifest carries the same name, so no
staging rewrite is needed any more (`tools/publish-pack.mjs` only changes the name
when `--name` really differs from the manifest). Verify with a tarball install
(step 8) before announcing.

## 1. Prerequisites

- Node **>= 20** and npm 9+ (the CI matrix runs node 20, 22 and 24 on
  `ubuntu-latest` and on `windows-latest`; see §7).
- An npm account, `npm login` done, and 2FA ready: `npm publish` asks for an OTP.
- A GitHub account and permission to create `dsh-audiokit` (step 7).
- A clean tree: no stray `*.tgz`, no `test/out/` noise, no scratch `.wav` files
  under `assets/audio/` (test runs may leave those; they are not shipped).

## 2. Confirm the metadata before packing

`package.json` already carries the real repository URLs:

```json
"repository": { "type": "git", "url": "git+https://github.com/0zeroLsoar0/dsh-audiokit.git" },
"homepage": "https://github.com/0zeroLsoar0/dsh-audiokit#readme",
"bugs": { "url": "https://github.com/0zeroLsoar0/dsh-audiokit/issues" }
```

Re-check them **before** packing: the tarball embeds `package.json`, so a publish
made with a wrong URL is permanent (the version cannot be reused). The manifest
already carries the public name `dsh-audiokit`; `tools/publish-pack.mjs` (step 6)
only rewrites it when `--name` asks for a different one.

## 3. Confirm the name is still free

```powershell
npm view dsh-audiokit version
```

Expected: `npm error code E404` / `Not Found` — that means the name is
available. If it prints a version, someone took it after this run: choose another
name and update `package.json` first.

For context, the taken name prints a version:

```powershell
npm view dsh-audio version        # -> 0.0.1, belongs to another package; do not use
```

## 4. Run the suite before packing

```powershell
node tools/test-all.mjs
```

Expected final line: `63 file(s) · 63 ok · 0 failed · …` with one `ok` line per
file (63 files at the time of writing — the suite keeps changing as features land
and leave; `node tools/test-all.mjs --list` prints the authoritative list and its
final `<n> file(s)` count, so trust that number if this line has drifted). No file
skips on this machine: DSH's bundled ffmpeg lets `test/video.mjs` run.
`tools/test-all.mjs` runs one child process per file, capped output, exits
non-zero on any failure. A file that exits 0 without printing `OK:` or `SKIP:` is
reported as a **failure**: every executable file under `test/` must state its own
verdict, and reusable helpers live in `test/support/` (not discovered) instead of
being counted as passing tests.

- `npm test` runs the same command.
- `npm run test:smoke` runs only `test/smoke.mjs`.
- `npm run pack:check` runs the smoke test and then `npm pack --dry-run`.

Tests that cannot run on the machine **skip themselves** by printing `SKIP:` and
exiting 0; the runner reports them as `ok … [skip]`. Never "fix" a SKIP by
deleting the test. The full suite takes ~4 minutes on this Windows machine
(3 m 27 s measured on the 0.6.1 integration tree, node 24 / 63 files, 0 failed) with
no skips here; on a hosted runner `test/video.mjs` is the one skip (see the table
below).

### What CI skips, and why

`.github/workflows/test.yml` runs the suite on a matrix of `os:
[ubuntu-latest, windows-latest]` × `node-version: [20, 22, 24]` with
`fail-fast: false` and a 15-minute job timeout (measured locally: ~3 minutes
serial on this machine, so a 2-vCPU runner lands around 4-8 minutes per leg; the
6 legs run in parallel, and the job timeout is the guard against a hung leg).
A hosted runner is a clean checkout with no audio tooling and no downloaded
assets, so one file skips itself on **both** operating systems (exit 0 with a
`SKIP:` line, which the runner reports as `ok … [skip]`). That count is a
consequence of the table below, not a target: after a feature that owns such an
asset is added or removed, re-read the run log instead of assuming a number.

| file | why it skips on CI |
| --- | --- |
| `test/video.mjs` | needs `ffmpeg`/`ffprobe`. It only trusts DSH's bundled ffmpeg (`~/.dsh/tools/ffmpeg/bin`) or one on `PATH`; neither the [ubuntu-latest image](https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2404-Readme.md) nor the [windows-latest image](https://github.com/actions/runner-images/blob/main/images/windows/Windows2025-Readme.md) ships ffmpeg in its software list. It runs on a machine with DSH's bundled ffmpeg (this one). |

`test/lufs.mjs` is **not** a whole-file skip: its `ffmpeg ebur128 cross-check`
section finds an ffmpeg (DSH's bundled copy, `DSH_FFMPEG_PATH`, or one on `PATH`),
compares a real mono render and a real stereo render against the plugin's LUFS,
and prints `SKIP:` for just that section when none is available. The rest of the
file always runs, so the BS.1770 calibration (mono single-channel weight, EBU
Tech 3341 stereo reference, dual-mono option) is checked on every CI leg.

`test/edge.mjs` is **not** a SKIP. It talks live to Microsoft's Edge read-aloud
service; it passes here and on a runner with network, and fails loudly (`FAIL`,
not `SKIP`) if that service is blocked or rate-limiting, so a real provider
regression is never hidden by the environment. A red `edge.mjs` line in CI means
"check the service first, then the code" — re-run the job before treating it as a
code defect.

Everything else is expected to pass on both operating systems, including the
files that write scratch data under `test/out/` and the ones that render real
`.wav` output. A Windows-only failure is a real bug unless it is the skip
above: check `\` vs `/`, CRLF and case-insensitive paths before widening
any SKIP condition — the correct fix is a skip only when the machine genuinely
cannot run the test, and it must print `SKIP:` with the reason, never delete the
assertions.

Two Windows specifics the workflow relies on, both verified locally rather than
in CI:

- **Line endings.** A fresh Windows checkout can hold CRLF. The suite is
  CRLF-safe: `test/docs-consistency.mjs` and `test/version-single-source.mjs`
  normalise newlines while reading source files, and the rest compare generated
  data rather than checked-in text. Checked by running the source-comparing tests
  (`docs-consistency`, `version-single-source`, `client-locale`, `tool-schemas`,
  `schema-budget`, `smoke`, `editor-route`, `settings-validate`,
  `security-settings`) against a CRLF-converted copy of the tree: 9/9 pass.
- **Shell and paths.** No step needs a shell override: `npm install` / `npm test`
  resolve through the runner's default shell (bash on Linux, pwsh on Windows),
  and `tools/test-all.mjs` spawns `process.execPath` with a *relative* path, so
  no `\` vs `/` handling is required from the workflow.

## 5. Inspect exactly what will be packed

```powershell
npm pack --dry-run
# machine-readable: npm pack --dry-run --json
```

This writes nothing. Expected result (measured on the 0.6.1 integration tree on
2026-11-28; the tree keeps gaining `lib/` modules and tests while this runbook is
written, so the exact counts drift — re-run `npm pack --dry-run --json` and trust
the `entryCount` / `size` / `unpackedSize` it reports, and check the *groups* below
and the absence of residue):

- tarball name: **`dsh-audiokit-0.6.1.tgz`** (the one value this runbook must get
  right; `test/version-single-source.mjs` fails the suite if it drifts)
- **167 files** (`entryCount`; measured on 2026-11-28), packed size
  **1,284,918 B ≈ 1.23 MiB** (`size`), unpacked **4,477,690 B ≈ 4.27 MiB**
  (`unpackedSize`)
- root: `package.json`, `index.js`, `client.js`, `cordis.patch.yml`, `icon.svg`,
  `README.md`, `LICENSE`
- `lib/`: every `.js` module (78 at the time of writing; grows with every new
  tool/module — all of them must be there, none may be missing)
- `locale/`: `en.json`, `zh.json`
- `docs/`: every document under `docs/` (`CREATURES.zh.md`, `DETAIL.md`,
  `DETAIL.zh.md`, `ECOSYSTEM.zh.md`, `EDITOR.zh.md`, `GENERATE.zh.md`,
  `INTEROP.zh.md`, `preview.svg`, `RELEASE.md`, `SCHEMA_DIET.zh.md`)
- `test/`: 63 `.mjs` files at the time of writing (one per file the runner
  executes; `node tools/test-all.mjs --list` is authoritative) plus
  `test/support/fake-provider.mjs` and `test/support/legacy-resample.mjs`,
  shared helpers the HTTP and resampler tests import
- `tools/`: 5 `.mjs` files —
  `preset-report.mjs`, `probe-minimax.mjs`, `stretch-demo.mjs`, `test-all.mjs`,
  `verify-html.mjs`
- `package.json` is always included even though it is not listed in `files`.

Must **not** appear: `node_modules/`, `test/out/`, `*.tgz`, `.git/`, `.github/`,
`assets/audio/*.wav` (test output), `package-lock.json`. If any do, fix the
`files` array in `package.json` and re-check.

## 6. Publish to npm

`npm login` first (human step, 2FA/OTP). Publish from **this** tree: the packer in
`dsh-audio-lab/tools/publish-pack.mjs` still stages a hard-coded `..\plugin`
directory, which is the stale 0.5.10 copy, so running it as-is would publish the
wrong version. Two safe routes:

```powershell
# route A (works today): pack here, then publish exactly the tarball step 5 inspected
npm pack                                          # -> dsh-audiokit-0.6.1.tgz
npm publish .\dsh-audiokit-0.6.1.tgz --access public
```

```powershell
# route B (only after publish-pack.mjs's pluginDir points at dsh-audio/): the
# packer stages a temp copy and filters residue out of the tarball
node dsh-audio-lab/tools/publish-pack.mjs --name dsh-audiokit --repo https://github.com/0zeroLsoar0/dsh-audiokit --publish
```

Route A ships the tree as-is, so do step 5 first and clear the residue yourself
(`test/out/`, `*.tgz`, scratch `assets/audio/*.wav`); `npm pack` obeys the `files`
array, so the groups in step 5 are exactly what gets published. Route B reports
the tarball name, file count and size without `--publish` — run that once first
and compare with step 5.

Expected: `dsh-audiokit-0.6.1.tgz`, then `+ dsh-audiokit@0.6.1` and a registry
URL `https://www.npmjs.com/package/dsh-audiokit`.

- Publishing the **same version twice fails**: npm rejects it with `E403 You
  cannot publish over the previously published versions`. Fix forward with a new
  version (`npm version patch`, then repack); never try to reuse a version with
  `--force`.
- `npm publish` re-packs locally. Keep the tree identical to what step 5
  inspected; if you changed files after the dry run, re-run it.

## 7. Put the source on GitHub

The publish target is a standalone repository whose root is **this plugin
directory**. In this workspace the tree is instead tracked by the repository one
level up (`default-workspace/`, which whitelists `dsh-audio/`), so either tag
there (`git -C .. tag v0.6.1`) or export this directory to a staging folder —
which has no `.git` — and initialise it from its root:

```powershell
git init -b main
git add -A
git status                 # confirm no test/out, no *.tgz, no scratch assets/audio/*.wav
git commit -m "dsh-audiokit 0.6.1"
git tag v0.6.1

# create the repository (browser, or with the GitHub CLI)
#   gh repo create 0zeroLsoar0/dsh-audiokit --public --source . --remote origin
git remote add origin https://github.com/0zeroLsoar0/dsh-audiokit.git
git push -u origin main --tags
```

- Do not commit `test/out/`, `*.tgz` or generated `assets/audio/*.wav`; they are
  build/test residue. `.gitignore` already covers `node_modules/`, `*.tgz` and
  `test/out/`; add `assets/audio/` (or the specific files) if they keep showing
  up in `git status`.
- The workflow `.github/workflows/test.yml` starts running once `main` exists on
  GitHub. It is a `strategy.matrix` of `os: [ubuntu-latest, windows-latest]` ×
  `node-version: [20, 22, 24]` — 6 jobs, `fail-fast: false` so one red leg does
  not hide the other five, `timeout-minutes: 15`. Each job runs
  `npm install --no-audit --no-fund` (the package has zero dependencies, so this
  only proves the manifest is installable) and then `npm test`
  (`node tools/test-all.mjs`). See §4 for the file that self-skips on a
  hosted runner and for the live-network `test/edge.mjs`. The workflow is not in
  the npm tarball (not in `files`).
- The `v0.6.1` tag is a convention, not a CI trigger; the source of truth for
  the published artifact is npm.
- If the real repo URL is not `github.com/0zeroLsoar0/...`, finish step 2 with the
  final URL **before** step 6, or publish a corrected metadata patch release.

## 8. Verify the published package

There is **no CLI** to run: `npx dsh-audiokit` does not exist. The package is
a DSH plugin loaded by the host, not a command. Verify the real registry
artifact by installing the tarball into a scratch profile:

```powershell
mkdir "$env:TEMP\dsh-audiokit-verify"
cd "$env:TEMP\dsh-audiokit-verify"
npm pack dsh-audiokit@0.6.1
tar -xzf dsh-audiokit-0.6.1.tgz
dir package          # same file list as step 5
```

Then, from DSH, install that extracted artifact rather than the working copy:

```
plugin_manager  action: install_bundle  target: <absolute path>\package
# or, per the README:
dsh plugin --profile <profile> add "file:<absolute path>\package"
```

Check that:

- Settings → Sound opens (the client settings page and locale load).
- The tool list contains `audio_synth` (and the other `audio_*` tools).
- One short render returns a `.wav` path plus measured numbers, e.g.
  `audio_synth({ preset: 'impact', duration: 0.6 })`.
- `npm view dsh-audiokit@0.6.1 dist.tarball` prints a registry URL.

Remove the scratch profile/install afterwards so it does not shadow your real
plugin entry.

## 9. Rollback

**Within 72 hours** of publishing, npm allows unpublishing that version:

```powershell
npm unpublish dsh-audiokit@0.6.1 --force
```

Limits: npm only permits unpublish of a version within 72 h of its publish, and
repeated unpublishes are throttled. After the window it fails; do not fight it —
publish a fixed patch and deprecate the bad one instead:

```powershell
npm deprecate dsh-audiokit@0.6.1 "broken: use a later version"
npm version patch
node dsh-audio-lab/tools/publish-pack.mjs --name dsh-audiokit --repo https://github.com/0zeroLsoar0/dsh-audiokit --publish
```

Git side (only if the tag itself was wrong):

```powershell
git tag -d v0.6.1
git push origin :refs/tags/v0.6.1
```

Do not rewrite `main` if anyone has cloned it; a revert commit is safer than a
force-push. Unpublishing does not remove installs that already downloaded the
tarball.

## 10. Human-only checklist

- [ ] Re-check the `repository` / `homepage` / `bugs` URLs still point at the
      real GitHub repo — before publishing.
- [ ] `npm login` with your account (2FA/OTP); an agent cannot do this.
- [ ] `npm view dsh-audiokit version` still returns 404 right before publish.
- [ ] Step 5's dry run is re-run on the final tree; publish from this root as
      `npm pack` + `npm publish .\dsh-audiokit-0.6.1.tgz`. Do **not** run the
      `dsh-audio-lab` packer as-is: it still stages the stale 0.5.10 copy (§6).
- [ ] Publish (human action, needs the npm OTP; never run by an agent).
- [ ] Create the GitHub repo, `git remote add origin`, `git push -u origin main --tags`.
- [ ] Leave `cordis.patch.yml`'s `id: dsh-audio` and the `/dsh-audio/*` routes
      as-is — they are the profile's link target, not the package name (see §0).
- [ ] Verify by installing the packed tarball (`npm pack dsh-audiokit@0.6.1`)
      in a scratch profile — there is no `npx` CLI.
- [ ] After the push, confirm CI is green on all six legs (ubuntu/windows × node
      20/22/24): no `FAIL`, and the `[skip]` line is the environment skip from
      §4 (`test/video.mjs`). `test/edge.mjs` talks to the live
      Edge service — if only that line is red, re-run the leg before calling it a
      code regression.
- [ ] Run the suite once on this Windows machine before tagging: it is the leg
      that exercises the bundled ffmpeg (`test/video.mjs` actually runs here, not
      SKIP) and the only one that renders real audio through the local install.
