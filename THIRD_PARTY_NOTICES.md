# Third-Party Notices

This project depends on third-party software. The authoritative license texts and copyright notices are the files distributed with each installed package and its source repository; those notices remain in force and are not replaced by this summary.

Runtime dependencies declared for version 0.1.0:

| Package | Pinned version | Manifest license | Project |
|---|---:|---|---|
| `@koteye/kote-gateway-opencode` | `0.1.1` | MIT | KoteGateway integration/core ([source](https://github.com/koteyye/opencode-kote-gateway)) |
| `@opencode-ai/plugin` | `1.18.18` | MIT | OpenCode plugin API |
| `undici` | `6.28.0` | MIT | HTTP client primitives |
| `zod` | `4.1.8` | MIT | Runtime schema validation |

Development dependencies include `@eslint/js`, `@types/bun`, `eslint`, `typescript`, and `typescript-eslint` at the exact versions recorded in `package.json` and the package lock.

Binary distributions and npm tarballs should retain license/notice files required by these dependencies. Before release, generate or audit the production dependency inventory from the resolved lockfile and verify every dependency's license metadata. This document does not claim compatibility or certification by any third-party project.
