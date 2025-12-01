# Releasing @better-slop packages

Publishes `@better-slop/core` and `@better-slop/ocx-librarian-plugin` to npm.

## Required Secrets

| Secret | Description |
|--------|-------------|
| `NPM_TOKEN` | npm access token with publish permission for `@better-slop` scope |
| `GITHUB_TOKEN` | Auto-provided; used for git push and `gh release create` |

## Verify Setup

```bash
# Check npm auth
npm whoami --registry https://registry.npmjs.org

# Check org access
npm org ls better-slop

# Check gh cli works
gh auth status
```

## How to Release

1. Go to **Actions** > **Publish** workflow
2. Click **Run workflow**
3. Select bump type: `patch` | `minor` | `major`
4. Optionally override version (e.g. `1.0.0`)
5. Click **Run workflow**

## What Happens

1. Computes next version from `@better-slop/core` on npm (or starts at `0.0.1`)
2. Updates all `package.json` versions
3. Runs `bun install`
4. Publishes non-private `@better-slop/*` packages with `--tag latest`
5. Commits `release: vX.Y.Z`, tags, pushes, creates GitHub release

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OCX_CHANNEL` | git branch or `latest` | Release channel / npm tag |
| `OCX_BUMP` | `patch` | `major` \| `minor` \| `patch` |
| `OCX_VERSION` | computed | Explicit version override |

## Preview Release (Local)

```bash
OCX_CHANNEL=dev bun scripts/publish.ts
```

Creates `0.0.0-dev-{timestamp}` with `--tag dev`. No git commit/tag/push.
