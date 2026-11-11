# Releasing

denormo publishes three packages, always together and with the same version:

| Package             | Contents                                       |
| ------------------- | ---------------------------------------------- |
| `@denormo/core`     | ODM-agnostic engine                            |
| `@denormo/mongoose` | Mongoose adapter (depends on core)             |
| `denormo`           | Short name: re-exports `@denormo/mongoose`     |

Versions and changelogs are managed with [Changesets](https://github.com/changesets/changesets); publishing runs in GitHub Actions (`.github/workflows/release.yml`) with npm [trusted publishing](https://docs.npmjs.com/trusted-publishers): no npm token is stored anywhere, and every version it publishes gets a provenance statement linking it to the commit and workflow run that built it (0.1.0, published by hand, has none).

## Every release

1. **In each PR that changes a published package**, add a changeset:

   ```sh
   pnpm changeset
   ```

   Pick the bump and write one line for the changelog, from the user's point of view. While we are on 0.x, a breaking change is a `minor` bump; everything else is a `patch`. PRs that only touch tests, docs or CI need no changeset.

2. **Merge the PR.** The Release workflow opens (or updates) a PR titled `chore: version packages`. It bumps the versions and writes the changelogs from the pending changesets.

3. **Review and merge the version PR.** The Release workflow then builds, runs lint, typecheck and the full test suite, and publishes every version not yet on npm. It also pushes a git tag and creates a GitHub release per package.

Notes:

- The version PR is opened by GitHub Actions, and GitHub does not run other workflows on PRs opened that way, so it shows no CI checks. The Release workflow runs every check itself before publishing. To see CI on the PR anyway, close and reopen it.
- If publishing fails halfway, fix the cause and re-run the workflow: it only publishes versions that are not on npm yet.

## First release (one time)

npm only lets a package trust a GitHub workflow once the package exists, so 0.1.0 was published by hand (done on 2026-11-11). Follow these steps again for any package added later: publish its first version by hand, then add its trusted publisher. Until the `NPM_PUBLISH` variable below is set, the Release workflow skips publishing (it logs a notice) and never fails for lack of credentials.

0. **Before merging the release branch**, in the GitHub repository settings → Actions → General → Workflow permissions, tick **Allow GitHub Actions to create and approve pull requests**. The Release workflow needs it to open version PRs, whether or not publishing is on.

1. **Publish 0.1.0 from your machine**, on an up-to-date `main` that contains the 0.1.0 versions:

   ```sh
   git switch main && git pull
   npm login                       # an account that owns the denormo npm organization
   pnpm install --frozen-lockfile
   pnpm build
   pnpm test
   pnpm changeset publish          # add --otp=123456 if your account uses 2FA codes
   git push origin --tags          # the tags changeset publish created
   ```

   Optionally, create the GitHub releases the workflow would have made:

   ```sh
   for tag in @denormo/core@0.1.0 @denormo/mongoose@0.1.0 denormo@0.1.0; do
     gh release create "$tag" --title "$tag" --notes "First public release (experimental). See the CHANGELOG."
   done
   ```

   Check: `npm view denormo`, `npm view @denormo/core`, `npm view @denormo/mongoose`.

2. **Trust the workflow on npm.** For each of the three packages, on npmjs.com open the package → Settings → Trusted publishing → GitHub Actions, and enter:

   | Field                | Value                                                |
   | -------------------- | ---------------------------------------------------- |
   | Label                | `release` (optional, only a name)                    |
   | Organization or user | `denormo`                                            |
   | Repository           | `denormo`                                            |
   | Workflow filename    | `release.yml`                                        |
   | Environment name     | (leave empty)                                        |
   | Allowed actions      | tick publishing directly (`npm publish`); no dist-tag |

   and click **Set up connection**. The workflow publishes directly (`changeset publish` runs `pnpm publish`), so stage-only would leave every release waiting; it needs no dist-tag access because publishing sets `latest` itself.

   Then, under Settings → Publishing access, choose **Require two-factor authentication and disallow bypass 2fa tokens**, so the workflow is the only way to publish besides you with 2FA. This setting blocks tokens only; trusted publishing keeps working.

3. **Turn publishing on.** In the GitHub repository settings → Secrets and variables → Actions → Variables, add a repository variable `NPM_PUBLISH` with the value `enabled`.

From then on, releases follow [Every release](#every-release). Setting `NPM_PUBLISH` to anything else pauses publishing.

## Release workflow details

- Trigger: every push to `main`. One release runs at a time.
- Jobs: `mode` (select-mode) decides; `version` opens the PR; `check` runs build, lint, typecheck and tests; `publish` runs only after `check` passes and is the only job allowed to mint the OIDC token npm trusts.
- `changesets/action/select-mode` decides: pending changesets → `version` (open or update the version PR); versions in `package.json` that are not on npm → `publish`; otherwise nothing.
- Publishing uses `pnpm publish` (through `changeset publish`), which replaces the `workspace:*` dependencies with the released version, and authenticates to npm with the workflow's GitHub OIDC token.
- The checks before publishing run on Node 24 against MongoDB 8.0; the full MongoDB and Mongoose matrix runs in CI on every PR.
