# Contributing to Form Studio

## Report an issue

Include the Form Studio version, operating system or container, Node.js version, and steps to reproduce. Describe what you expected and what happened. Use fictional site content in examples and share redacted logs or screenshots. For security issues, follow the [security policy](SECURITY.md).

## Verify a change

Use Node.js 22.15 or a later version in the 22.x line. Follow the [quick start](README.md#quick-start) to create a local development instance if you need one. Run the relevant checks from the repository root.

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run test:http
npm run test:ui:policy
```

The HTTP integration tests use a temporary instance on loopback port 3201. Set `HTTP_TEST_PORT` to another available non-production port if needed. For browser tests, install the browser once and use a current production build. See the [browser regression guide](docs/UI_REGRESSION.md).

```sh
npm run test:ui:install
npm run test:ui
```

Submit focused changes that describe the user impact and the checks you ran. Use synthetic fixtures for new examples or tests. Keep instance configuration, credentials, backups, and private diagnostic traces out of commits.
