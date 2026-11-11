# Releasing

denormo publishes three packages, always together and with the same version:

| Package             | Contents                                       |
| ------------------- | ---------------------------------------------- |
| `@denormo/core`     | ODM-agnostic engine                            |
| `@denormo/mongoose` | Mongoose adapter (depends on core)             |
| `denormo`           | Short name: re-exports `@denormo/mongoose`     |

Versions and changelogs are managed with [Changesets](https://github.com/changesets/changesets); publishing runs in GitHub Actions (`.github/workflows/release.yml`) with npm [trusted publishing](https://docs.npmjs.com/trusted-publishers): no npm token is stored anywhere, and every version gets a provenance statement linking it to the commit and workflow run that built it.

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

npm only lets a package trust a GitHub workflow once the package exists, so 0.1.0 is published by hand. Until the `NPM_PUBLISH` variable below is set, the Release workflow skips publishing (it logs a notice) and never fails for lack of credentials.

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

   Check: `npm view denormo`, `npm view @denormo/core`, `npm view @denormo/mongoose`.

2. **Trust the workflow on npm.** For each of the three packages, on npmjs.com open the package → Settings → Trusted publishing → GitHub Actions, and enter:

   | Field                | Value         |
   | -------------------- | ------------- |
   | Organization or user | `denormo`     |
   | Repository           | `denormo`     |
   | Workflow filename    | `release.yml` |
   | Environment name     | (leave empty) |

   Then, under Settings → Publishing access, choose **Require two-factor authentication and disallow tokens**, so the workflow is the only way to publish besides you with 2FA.

3. **Let the workflow publish and open PRs.** In the GitHub repository settings:
   - Actions → General → Workflow permissions: tick **Allow GitHub Actions to create and approve pull requests**.
   - Secrets and variables → Actions → Variables: add a repository variable `NPM_PUBLISH` with the value `enabled`.

From then on, releases follow [Every release](#every-release). Setting `NPM_PUBLISH` to anything else pauses publishing.

## Release workflow details

- Trigger: every push to `main`. One release runs at a time.
- `changesets/action/select-mode` decides: pending changesets → `version` (open or update the version PR); versions in `package.json` that are not on npm → `publish`; otherwise nothing.
- Publishing uses `pnpm publish` (through `changeset publish`), which replaces the `workspace:*` dependencies with the released version, and authenticates to npm with the workflow's GitHub OIDC token.
- The checks before publishing run on Node 24 against MongoDB 8.0; the full MongoDB and Mongoose matrix runs in CI on every PR.
