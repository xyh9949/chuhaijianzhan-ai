# Form Studio

[简体中文](README.zh-CN.md)

Form Studio is a self-hosted CMS for B2B product catalogs, company websites, and requests for quotes. It includes a responsive page editor, multilingual content, and staged publishing. The administration interface currently uses Simplified Chinese.

**0.42.0 Beta** adds product comparison tables, project timelines, before-and-after images, and six reusable section layouts.

## Quick start

Use Node.js **22.15 or later within the 22.x line**. Run these commands from the repository root.

```sh
npm ci
npm run setup
npm run build
npm start
```

1. During setup, create the first administrator with your email and a password of at least 12 characters. Setup generates a local instance secret and initializes SQLite.
2. Open [the admin workspace](http://127.0.0.1:3200/admin). New instances start with a blank home page draft. To try an example, open **模板与区块** (Templates and blocks) → **整站案例** (Site examples), preview a fictional site, then import it into the draft.
3. Open **发布管理** (Releases) to review and publish your selected changes. The [public site](http://127.0.0.1:3200/) serves the published version.

## What you can do

- Build pages with drag-and-drop blocks and device-specific layouts. Edit products, categories, and reusable sections.
- Manage drafts and publish selected changes after review. Restore an earlier published version if needed.
- Collect quote requests for multiple products, with quantities and requirements per item. Import product data and preview spreadsheet updates matched by SKU.
- Configure your own compatible AI provider for assisted editing. Email notifications and other external services are configured per instance.

[Site examples](docs/SHOWCASE_THEMES.md) · [Blocks](docs/BUSINESS_BLOCKS.md) · [Quote forms](docs/WEBSITE_FORMS.md) · [AI setup](docs/AI_SETTINGS.md)

## Deploy and contribute

A deployment serves one site with one Node writer and local persistent SQLite storage. See the [deployment guide](DEPLOYMENT.md) and [Linux container and backup guide](docs/OPERATIONS.md) for HTTPS, persistence, and recovery.

[Contributing](CONTRIBUTING.md) · [Reporting a security issue](SECURITY.md) · [MIT license](LICENSE) · [Third-party notices](THIRD_PARTY_NOTICES.md)
