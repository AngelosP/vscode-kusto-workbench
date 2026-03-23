---
name: release-tag
description: "Release gating workflow for tagging and pushing versions. Use when the user says 'tag with', 'tag and push', 'release vX.Y.Z', 'push tag', 'create release', 'ship it', or any request involving creating a version tag and pushing it to a remote. Runs all quality gates before allowing the tag."
---

# Release Tag Workflow

This skill runs a mandatory quality gate before creating a version tag and pushing it to the remote. No tag is created until every gate passes.

## When to Use

When the user asks to tag and/or push a release:
- "Tag with vX.Y.Z and push to remote"
- "Release vX.Y.Z"
- "Push tag vX.Y.Z"
- "Create release"
- "Ship it"

## Workflow

### Phase 1: Extract Version

1. Parse the version from the user's request (e.g. `v1.2.3`).
2. Confirm the version looks valid (semver format: `vMAJOR.MINOR.PATCH`).
3. Check that the working tree is clean (`git status --porcelain` should be empty). If there are uncommitted changes, **stop and tell the user** — do not proceed.

### Phase 2: Run Quality Gates

Run each gate sequentially. **Stop on the first failure** — do not continue to the next gate if one fails.

#### Gate 1: TypeScript Compilation
```
npx tsc --noEmit
```
Must exit 0 with no errors.

#### Gate 2: Lint
```
npm run lint
```
Must exit 0.

#### Gate 3: Unit Tests
```
npx vitest run
```
All tests must pass.

#### Gate 4: Production Build + Bundle Size Gate
```
node esbuild.js --production
```
Must exit 0. This includes the integrated bundle size gate — if any bundle exceeds its baseline + buffer, the build will fail.

#### Gate 5: Package VSIX
```
npm run vsix
```
Must succeed. Report the final VSIX file size to the user.

### Phase 3: Report Results

Present a summary table to the user:

| Gate | Result |
|------|--------|
| TypeScript compilation | ✅ / ❌ |
| Lint | ✅ / ❌ |
| Unit tests (count) | ✅ / ❌ |
| Production build + bundle gate | ✅ / ❌ |
| VSIX packaging (size) | ✅ / ❌ |

If any gate failed, **stop here**. Show what failed and why. Do NOT create the tag.

### Phase 4: Tag and Push

Only if ALL gates passed:

1. Update `package.json` version to match the tag (strip leading `v`):
   ```
   npm version X.Y.Z --no-git-tag-version
   ```
2. Commit the version bump:
   ```
   git add package.json package-lock.json
   git commit -m "release: vX.Y.Z"
   ```
3. Create the annotated tag:
   ```
   git tag -a vX.Y.Z -m "Release vX.Y.Z"
   ```
4. **Ask the user for confirmation** before pushing. Show them:
   - The tag name
   - The commit hash
   - The remote and branch it will push to
5. Only after explicit confirmation:
   ```
   git push origin main --follow-tags
   ```

## Important Rules

- **Never skip a gate.** Every gate must run and pass.
- **Never force-push.** Use `git push`, not `git push --force`.
- **Always ask before pushing.** The tag+push is the irreversible step.
- **If the user says "skip tests" or "just tag it"**, politely refuse and explain that the gates exist to prevent shipping broken releases. Offer to run them quickly instead.
