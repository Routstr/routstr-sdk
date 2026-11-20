# Agent notes

## This repository's forge is Grasp (git over Nostr), not GitHub

`origin` is `nostr://npub1m5tu2t8fynfw46hcm779qtnltt74uc6fzmf6t0l2zxwsy5uutens6mxx2f/relay.ngit.dev/routstr-sdk`
and it is canonical. Use [ngit](https://ngit.dev/install) (`ngit`, gitworkshop.dev)
for issues, pull requests, reviews and releases.

Before any of those tasks — including pushing a pull request branch — run
`ngit --help` and follow its workflow map. PR branches must be named `pr/<name>`.
If ngit is missing, install it from https://ngit.dev/install.

## GitHub is a mirror, used only as a CI runner

`github` (`git@github.com:Routstr/routstr-sdk`) mirrors nostr. Never push to it
directly; `.github/workflows/sync-nostr-github.yml` keeps the two sides in step.

GitHub Actions exists here for things Nostr CI does not yet do for this repo:
`ci.yml` (typecheck, tests, build) and `publish.yml` (npm trusted publishing).
Both run on the mirror. Push to `origin` (nostr) and let sync run.

## Releasing

Canonical steps, in order — the order matters:

1. Bump `package.json` and move `CHANGELOG.md`'s `## Unreleased` section to
   `## <version>`.
2. Commit and push `main` to `origin`, so the sync workflow forwards it to
   GitHub and `ci.yml` runs.
3. Tag, then push **the branch and the tag in one command**:

   ```sh
   git tag vX.Y.Z
   git push origin main vX.Y.Z
   ```

   Pushing them together guarantees the sync run sees both refs. Two separate
   pushes race: the `main` sync can finish before the tag exists.

4. Sync forwards the tag to GitHub, which triggers `publish.yml`. It verifies
   the tag matches `package.json`, then publishes to npm with provenance.

Do **not** tag on GitHub. Tag syncing is one-way, nostr → GitHub: a tag created
only on GitHub never reaches the canonical repo, and `publish.yml` would publish
from a commit nostr does not have a release ref for.

`publish.yml` is safe to re-run: `workflow_dispatch` takes an existing tag, and
the run skips publishing if that version is already on npm.

Verify with `ngit ci status vX.Y.Z`, `gh run list --workflow=publish.yml`, and
`npm view @routstr/sdk@X.Y.Z version`.
