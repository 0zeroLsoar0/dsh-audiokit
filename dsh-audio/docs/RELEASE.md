# Release runbook — `dsh-audiokit` 0.5.10

This is the exact manual procedure for publishing the plugin. The publish
actions themselves — `npm publish`, creating the GitHub repository and pushing —
are **not** done by an agent: run them yourself with your own npm/GitHub
credentials. (The repository-side pieces — `package.json`, the test runner and
the CI workflow — are already in place; everything below is verification plus
the human-only steps.)

Commands assume the current directory is this plugin root
(`...\dsh-audio-lab\plugin`). On Windows the bundled node is not on `PATH`; use
its full path, e.g.
`C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`.
`npm` sits next to it at `F:\tools\node\npm.cmd` on this machine.

## 0. What the rename does and does not change

- The **public npm package name** is `dsh-audiokit`. The repo's own
  `package.json` keeps `"name": "@local/dsh-audio"` **on purpose**: the live DSH
  profile links to that specifier, so renaming it in the repo would break an
  already-installed profile. `tools/publish-pack.mjs` copies the tree and
  rewrites only the staged manifest's name before packing; that staged copy is
  what gets published under `dsh-audiokit`.
- The bare `dsh-audio` is already taken on npm (it resolves to someone else's
  `0.0.1`), which is why the public name needed the `-kit` suffix.
- The **Cordis bundle entry id stays `dsh-audio`**. These references are
  intentionally unchanged and must keep matching existing profiles/links:
  - `cordis.patch.yml` → `insert[0].id: dsh-audio`
  - `index.js` → `export const name = 'dsh-audio'` and the skill locator
  - HTTP routes `/dsh-audio/config`, `/dsh-audio/test`, `/dsh-audio/voices`,
    `/dsh-audio/validate`
  - the settings page id `dsh-audio` and its locale namespace
- The package version stays **0.5.10**.
- Only the npm identity changes. Installing/updating the plugin changes the
  package specifier (for example `dsh-audiokit@0.5.10`); anything that
  addresses the plugin by its entry id (`dsh-audio`) does not change.

`cordis.patch.yml` declares `name: '@local/dsh-audio'` and `client.js` registers
the settings page as `id: '@local/dsh-audio'`. Both literals are **intentional
and must not be renamed**: they are the names the live profile already links to.
Only the manifest inside the publish staging copy changes its name, so a
repo-installed profile keeps working while npm-installed bundles carry the
public name. Verify with a tarball install (step 8) before announcing.

## 1. Prerequisites

- Node **>= 20** and npm 9+ (the CI workflow targets node 20 and 22).
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
made with a wrong URL is permanent (the version cannot be reused). The public
package name is applied by `tools/publish-pack.mjs` (step 6), not by this file —
the repo manifest deliberately keeps `@local/dsh-audio` (see §0).

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

Expected final line: `45 file(s) · 45 ok · 0 failed · …` with one `ok` line per
file (45 files at the time of writing; add the new file's line if one is added).
`tools/test-all.mjs` runs one child process per file, capped output, exits
non-zero on any failure.

- `npm test` runs the same command.
- `npm run test:smoke` runs only `test/smoke.mjs`.
- `npm run pack:check` runs the smoke test and then `npm pack --dry-run`.

Tests that cannot run on the machine **skip themselves** by printing `SKIP:` and
exiting 0; the runner reports them as `ok … [skip]`. Never "fix" a SKIP by
deleting the test. On Windows the bundled ffmpeg under
`~\.dsh\tools\ffmpeg\bin` lets `test/video.mjs` run; on the Linux CI runner the
same test skips (no ffmpeg there). `test/edge.mjs` is a **live network** test
against Microsoft's Edge read-aloud service — it passes here and on hosted
runners with network, and fails loudly (not SKIP) if that service is unreachable.

## 5. Inspect exactly what will be packed

```powershell
npm pack --dry-run
# machine-readable: npm pack --dry-run --json
```

This writes nothing. Expected result (measured on the 0.5.10 tree on 2026-11-22;
the tree was still gaining `lib/` modules while this runbook was written, so the
exact count can drift by a few files — trust the `total files` / `package size`
lines npm prints, and check the *groups* below and the absence of residue):

- tarball name: **`dsh-audiokit-0.5.10.tgz`**
- **124 files** (measured on the 0.5.10 tree on 2026-11-22), packed size
  ≈ **876 KB**, unpacked ≈ **3.02 MB**
- root: `package.json`, `index.js`, `client.js`, `cordis.patch.yml`, `icon.svg`,
  `README.md`, `LICENSE`
- `lib/`: every `.js` module (59 at the time of writing; grows with every new
  tool/module — all of them must be there, none may be missing)
- `locale/`: `en.json`, `zh.json`
- `docs/`: `DETAIL.md`, `DETAIL.zh.md`, `preview.svg`, `RELEASE.md` (this file)
- `test/`: 45 `.mjs` files (one per file under `test/`)
- `tools/`: 7 `.mjs` files —
  `fetch-voicebank.mjs`, `preset-report.mjs`, `probe-minimax.mjs`,
  `sing-bank.mjs`, `stretch-demo.mjs`, `test-all.mjs`, `verify-html.mjs`
- `package.json` is always included even though it is not listed in `files`.

Must **not** appear: `node_modules/`, `test/out/`, `*.tgz`, `.git/`, `.github/`,
`assets/audio/*.wav` (test output), `package-lock.json`. If any do, fix the
`files` array in `package.json` and re-check.

## 6. Publish to npm

`npm login` first (human step, 2FA/OTP). Then publish through the packer, which
stages a copy, renames the manifest to `dsh-audiokit` and publishes that tarball:

```powershell
node dsh-audio-lab/tools/publish-pack.mjs --name dsh-audiokit --repo https://github.com/0zeroLsoar0/dsh-audiokit --publish
```

Without `--publish` it only packs and reports the tarball name, file count and
size — do that once first and compare with step 5. **Do not** run `npm publish`
in the plugin root: that manifest still says `@local/dsh-audio` (§0) and is not
the package people install.

Expected: `dsh-audiokit-0.5.10.tgz`, then `+ dsh-audiokit@0.5.10` and a registry
URL `https://www.npmjs.com/package/dsh-audiokit`.

- Publishing the **same version twice fails**: npm rejects it with `E403 You
  cannot publish over the previously published versions`. Fix forward with a new
  version (`npm version patch`, then repack); never try to reuse a version with
  `--force`.
- `npm publish` re-packs locally. Keep the tree identical to what step 5
  inspected; if you changed files after the dry run, re-run it.

## 7. Put the source on GitHub

This staging directory has **no `.git` yet**. From the plugin root:

```powershell
git init -b main
git add -A
git status                 # confirm no test/out, no *.tgz, no scratch assets/audio/*.wav
git commit -m "dsh-audiokit 0.5.10"
git tag v0.5.10

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
  GitHub: `ubuntu-latest`, node 20 and 22, `npm install` (zero dependencies) then
  `node tools/test-all.mjs`. It is not in the npm tarball (not in `files`).
- The `v0.5.10` tag is a convention, not a CI trigger; the source of truth for
  the published artifact is npm.
- If the real repo URL is not `github.com/0zeroLsoar0/...`, finish step 2 with the
  final URL **before** step 6, or publish a corrected metadata patch release.

## 8. Verify the published package

There is **no CLI** to run: `npx dsh-audiokit` does not exist. The package is
a DSH plugin loaded by the host, not a command. Verify the real registry
artifact by installing the tarball into a scratch profile:

```powershell
mkdir "$env:TEMP\dsh-audio-verify"
cd "$env:TEMP\dsh-audio-verify"
npm pack dsh-audiokit@0.5.10
tar -xzf dsh-audiokit-0.5.10.tgz
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
- `npm view dsh-audiokit@0.5.10 dist.tarball` prints a registry URL.

Remove the scratch profile/install afterwards so it does not shadow your real
plugin entry.

## 9. Rollback

**Within 72 hours** of publishing, npm allows unpublishing that version:

```powershell
npm unpublish dsh-audiokit@0.5.10 --force
```

Limits: npm only permits unpublish of a version within 72 h of its publish, and
repeated unpublishes are throttled. After the window it fails; do not fight it —
publish a fixed patch and deprecate the bad one instead:

```powershell
npm deprecate dsh-audiokit@0.5.10 "broken: use a later version"
npm version patch
node dsh-audio-lab/tools/publish-pack.mjs --name dsh-audiokit --repo https://github.com/0zeroLsoar0/dsh-audiokit --publish
```

Git side (only if the tag itself was wrong):

```powershell
git tag -d v0.5.10
git push origin :refs/tags/v0.5.10
```

Do not rewrite `main` if anyone has cloned it; a revert commit is safer than a
force-push. Unpublishing does not remove installs that already downloaded the
tarball.

## 10. Human-only checklist

- [ ] Re-check the `repository` / `homepage` / `bugs` URLs still point at the
      real GitHub repo — before publishing.
- [ ] `npm login` with your account (2FA/OTP); an agent cannot do this.
- [ ] `npm view dsh-audiokit version` still returns 404 right before publish.
- [ ] `node dsh-audio-lab/tools/publish-pack.mjs --name dsh-audiokit --repo
      https://github.com/0zeroLsoar0/dsh-audiokit` reports
      `dsh-audiokit-0.5.10.tgz` with only the expected groups and no residue.
- [ ] Publish with `--publish` added to that command (human action, needs the npm
      OTP; never run by an agent). Do not `npm publish` the plugin root.
- [ ] Create the GitHub repo, `git remote add origin`, `git push -u origin main --tags`.
- [ ] Leave `cordis.patch.yml`'s `name: '@local/dsh-audio'` as-is — it is the
      profile's link target, not the npm name (see §0).
- [ ] Verify by installing the packed tarball (`npm pack dsh-audiokit@0.5.10`)
      in a scratch profile — there is no `npx` CLI.
- [ ] Note that `test/video.mjs` only exercises the bundled Windows ffmpeg locally;
      on the Linux CI runner it self-skips, so run the suite once on Windows too.
