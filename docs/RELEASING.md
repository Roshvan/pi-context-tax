# Releasing

Use the same local first-publish flow as `pi-zen`. The package is prepared as `pi-context-tax@0.1.0`.

## Before publishing

Commit the release changes, push `main`, and confirm the Check workflow passes. From that clean checkout:

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm pack:check
```

`check` runs TypeScript and lint. CI runs on Node 22.19 and 24. `pack:check` lists the exact package contents; it must include the extension, its source, README, license, screenshots, and this guide. The panel uses the active Pi theme.

For an installation check, pack into a temporary directory, install that tarball in separate projects with Pi 0.84.3 and 0.85.0, and run `/ctx` in a fresh session using each version's shipped CLI. Check refresh, expanding sources, scrolling in a short terminal, and the active Pi theme. No model request is needed to inspect a fresh session.

Development dependencies remain pinned to Pi 0.84.3. The published 0.85.0 SDK currently fails to import because it references an undeclared `@earendil-works/pi-server` dependency. Its bundled CLI works and has been checked with this extension and pi-zen 0.1.2. Check a future SDK release before updating the development pins; do not add the missing server package to this extension as a workaround.

## First npm release

The first release is manual. Authenticate as `roshvan`, the npm account that owns `pi-zen`, then publish:

```bash
npm login
npm whoami
npm publish
npm view pi-context-tax version
```

`npm publish` reruns `check` and `pack:check` through `prepublishOnly`. It publishes publicly using the registry configured in `package.json`.

Verify the registry version is `0.1.0`, then install it in Pi:

```bash
pi install npm:pi-context-tax
```

Run `/reload` in an existing Pi session, then `/ctx`.

## Later releases through GitHub Actions

After the first release, add a GitHub Actions trusted publisher in the npm package settings with these exact values:

- Organization or user: `Roshvan`
- Repository: `pi-context-tax`
- Workflow filename: `publish.yml`
- Environment: leave empty
- Allowed actions: enable direct `npm publish`

The workflow uses OIDC and requires no npm token secret. The repository and package must be public for automatic provenance. See [npm's trusted publishing guide](https://docs.npmjs.com/trusted-publishers/).

For a later release, begin from a clean, checked `main` branch:

```bash
npm version patch
git push origin main --follow-tags
```

The Publish workflow requires the tag to match the package version: `v0.1.1` publishes `0.1.1`. It installs the locked dependencies and runs the prepublish checks before publishing. Do not push a `v0.1.0` tag after the manual first release: every `v*` tag starts a publication, and npm versions cannot be republished.
