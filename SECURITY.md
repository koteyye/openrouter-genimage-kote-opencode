# Security Policy

## Supported versions

Security fixes are provided for the latest published release. Version `0.1.0` targets the initial public release. Older prerelease/source snapshots are not supported unless a maintainer explicitly says otherwise.

## Reporting a vulnerability

Report vulnerabilities privately through the repository owner's private security-reporting channel (for example, GitHub Security Advisories when enabled). If no private channel is visible, contact the package owner through the contact information published on the npm package profile and ask for a secure reporting address before sending sensitive details.

Do not open a public issue with:

- an OpenRouter or management API key;
- authorization/proxy headers;
- a full prompt, private reference, or generated image;
- base64 or binary payloads;
- an unredacted upstream response;
- a gateway bootstrap document or descriptor;
- a private URL or query string.

Include the affected version, OpenCode/runtime version, OS, routing mode, impact, minimal redacted reproduction, and whether a key or private asset may have been exposed. Maintainers should acknowledge receipt, coordinate remediation and disclosure, and avoid asking for production secrets.

If a key may have been exposed, revoke it in OpenRouter immediately and replace the environment value before further testing.

## Security boundaries

Production OpenRouter origin is fixed; redirects fail; paid image POSTs are not retried; proxy mode is fail-closed; and the plugin must not install a global fetch interceptor. Project input/output is confined to the OpenCode worktree with lexical and realpath checks. Source and existing output files are never overwritten. PNG/JPEG/WebP content is checked by size and magic bytes.

The plugin must not persist or log keys, full prompts, base64, binary data, unredacted request/response bodies, full external URLs with query strings, or gateway bootstrap data. In proxy mode, keys and image content remain inside TLS to OpenRouter and are not proxy credentials.

See [`docs/security.md`](docs/security.md) for the detailed threat model and controls.
