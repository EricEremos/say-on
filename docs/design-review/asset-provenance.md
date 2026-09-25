# Say-On asset provenance and release policy

**Recorded:** 2026-09-13  
**Scope:** the Say-On assets stored in `public/images/say-on/` in this source package.

## What this record covers

The included Say-On visual assets were generated for this project with OpenAI's built-in image generation. The product's active runtime uses:

- the `favicon-*` and `apple-touch-icon-*` conversation-mark variants;
- `shared-table-cutout-v1.webp` for the Arrival and Guide surfaces;
- `balance-choice-ritual-v1.png` and the 120 transparent, separately generated choice illustrations in `balance-catalog-individual-v3/`;
- the legacy-in-package Say-On alternatives in `balance-catalog/`, `balance-choice-catalog-v1.png`, the food cutouts, and the PNG/WebP scene variants.

The `balance-catalog-individual-v3/` directory is the active 60-question Balance catalog. It has one PNG per choice, so neither the product nor a downstream user needs to crop an illustration from a sheet. The earlier `balance-catalog-individual/` directory is retained only as a legacy source-package alternative and is excluded from the public export.

## Rights basis and release policy

OpenAI's current Terms say that, as between the user and OpenAI and to the extent permitted by applicable law, the user owns output; they also state that outputs may not be unique and that the user is responsible for the rights in the inputs they provide. See the [OpenAI Terms of Use](https://openai.com/policies/row-terms-of-use/).

The project therefore releases the included source, documentation, and project-created Say-On assets under the repository's [MIT License](../../LICENSE), to the extent the copyright holder has rights to do so. This record does not assert exclusivity over a generated output, nor does it grant rights in a third party's name, logo, character, photograph, or other material that a contributor may introduce later.

## Release checks for a future clean repository

Before the future public repository is created, its owner should verify that the exported candidate contains only the assets named here or other assets with equivalent provenance, and that no prompt input or final asset contains a third party's protected branding or personal image without permission. Keep this file and `LICENSE` with that history-free export.

This is a source-package policy record. It does not create a repository, change this repository's visibility, publish a deployment, or replace the required hosted-room rehearsal.
