# Third-party notices

Form Studio's own source code is available under the [MIT license](LICENSE). Each dependency, font and other third-party resource retains its own license. Site content and customer material keep their separate permissions.

## Dependencies

The [lockfile](package-lock.json) identifies the packages used to build Form Studio. The [dependency inventory](docs/DEPENDENCY_INVENTORY.json) distinguishes collected notices, package metadata and platform-specific packages. [Third-party license texts](THIRD_PARTY_LICENSES.txt) preserve the notices collected from the dependencies and bundled fonts. Run `node scripts/license-inventory.cjs` after installation to collect notices for that platform.

Examples of terms that apply to dependencies include LGPL for the libvips binary bundled with Sharp, MPL-2.0 for Lightning CSS and CC BY 4.0 for caniuse-lite. Keep the applicable upstream notices when distributing a build. This repository provides the source and installs locked dependencies for the target platform. [Sharp installation and licenses](https://sharp.pixelplumbing.com/install/) · [Mozilla Public License FAQ](https://www.mozilla.org/en-US/MPL/2.0/FAQ/) · [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)

## Bundled fonts

- Source Han Sans SC uses an unmodified Simplified Chinese subset from [Adobe's Source Han Sans release](https://github.com/adobe-fonts/source-han-sans/tree/release/Variable/WOFF2/TTF/Subset). [Font license](public/fonts/SOURCE-HAN-LICENSE.txt)
- Manrope uses the unmodified variable font from [Google Fonts](https://github.com/google/fonts/tree/main/ofl/manrope). [Font license](public/fonts/MANROPE-LICENSE.txt)

## Demo content

The starter sites use fictional content. The [demo asset inventory](docs/SHOWCASE_ASSETS.md) records the original illustrations and the two generated concept images. Demo assets and customer uploads have their own permission records.
