# Testing

Tests are layered so most behavior is verified without paid network calls.

## Local checks

```bash
bun install
bun run lint
bun run typecheck
bun run test
bun run build
npm pack
```

Useful focused commands:

```bash
bun run test:unit
bun run test:integration
bun run test:smoke
bun run package:smoke
```

## Unit coverage

Unit tests cover strict configuration and environment-key resolution; ordered attachment/project/HTTPS references; MIME, magic-byte, base64, path, count, and size validation; generation parameter ranges and cross-field rules; model/capability caching; response parsing and partial success; atomic collision-safe output; balance terminology and partial credits failure; and redaction of secrets, prompts, and base64.

Important invariants include:

- edit requires a reference and cannot become text-to-image;
- model always comes from configuration;
- `n` is 1–10 and reference count is 1–16;
- transparent JPEG and PNG compression fail locally;
- source/existing files cannot be overwritten;
- absolute/traversing/symlink-escaping paths fail;
- key limit is never labeled account balance.

## Synthetic integration coverage

OpenRouter client tests use an injected fetch implementation to verify exact endpoints, authorization separation, manual redirect behavior, GET retry, no POST retry, timeout/abort, bounded bodies, and sanitized upstream failures. They do not start a real HTTPS server.

Tool integration tests decode received data URLs and compare bytes, preserve multiple-reference order, preserve prompts, use only the configured model, save results, and return attachment-shaped tool results.

Transport unit tests use injected gateway and fetch fakes to verify direct/gateway separation, lazy bootstrap, fail-closed errors, descriptor forwarding, target-header isolation, cancellation, and disposal.

The socket-level harness additionally starts a TLS signed-bootstrap service, TLS CONNECT proxy, and separate HTTPS OpenRouter target. It verifies direct bypass, one CONNECT in proxy mode, Ed25519 verification, ordered target bodies, TLS secrecy at the proxy boundary, invalid/expired bootstrap failures, refused CONNECT without direct fallback, and both image/gateway-plugin load orders without a route marker or double CONNECT. Test trust is scoped to per-request custom CA configuration; TLS verification is not disabled globally.

## OpenCode smoke tests

The baseline runtime is OpenCode **1.18.21**; the scaffold currently pins `@opencode-ai/plugin` **1.18.18**. The automated CLI smoke loads the installed tarball through a tuple and verifies its options, all three executable tool definitions, `/openrouter-balance`, plugin context (`directory`, `worktree`, `serverUrl`), the message-client attachment access shape, permissions, and CLI skill installation without executing a model request.

The CLI configuration probe does not execute a tool, so it does not validate `sessionID`/`messageID` tool context, a returned ToolResult attachment, or TUI/Desktop/Web rendering. Those are separate manual real-host release checks. Test the latest stable OpenCode again at release time.

The synthetic KoteGateway proxy/coexistence matrix runs in ordinary integration tests. CI also loads the installed tarball in real baseline/latest OpenCode runtimes. The KoteGateway adapter's narrower peer metadata is documented in the README; this plugin consumes its runtime-independent `/core` export.

Skill CLI tests cover project and global paths (the latter is always `~/.config/opencode/...`, including Windows), `check-skill --global`, nonzero checks for missing/modified files, SHA-256 no-op installs, refusal to replace modifications without `--force`, and atomic forced replacement.

## Real OpenRouter E2E (paid, opt-in)

Real tests are disabled in ordinary CI and pull requests. Run them only with an explicitly budgeted key/model:

Set `OPENROUTER_IMAGE_REFERENCE_URL_E2E` to a public PNG/JPEG/WebP URL to include the real HTTPS-reference check, or omit that assignment.

```bash
RUN_OPENROUTER_E2E=1 \
OPENROUTER_API_KEY=... \
OPENROUTER_IMAGE_MODEL_E2E=... \
OPENROUTER_IMAGE_REFERENCE_URL_E2E=https://... \
bun test tests/e2e
```

The current harness covers `/key`, text-to-image, one/two ordered inline data references, and an optional `usage.cost` field. One combined tool-level request also resolves an OpenCode message attachment plus a project file, optionally appends `OPENROUTER_IMAGE_REFERENCE_URL_E2E` unchanged, persists the generated image, and validates the returned ToolResult attachment. `/credits` is a separate opt-in test: set `RUN_OPENROUTER_CREDITS_E2E=1` and `OPENROUTER_MANAGEMENT_API_KEY`. Configure the public HTTPS variable for that release check; TUI/Desktop/Web rendering remains manual.

Never place E2E credentials, prompts with private content, or generated base64 in fixtures, logs, snapshots, artifacts, or the npm tarball.

## Package smoke

After `npm pack`, the package smoke installs the produced tarball with an isolated npm cache, imports its package-root and `/server` exports under Node with network blocked, invokes its installed bin to install/check the skill, runs the OpenCode smoke against the installed package, checks the file list, and scans for secrets/test credentials. It does not load the source tree as the plugin under test.

Do not claim a compatibility target or workflow as working until its automated test or documented manual smoke has passed.
