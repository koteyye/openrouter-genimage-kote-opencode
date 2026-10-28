# Architecture

## Scope and invariants

The plugin owns three OpenCode tools: image-to-image editing, text-to-image generation, and balance reporting. Image-to-image is the primary path. It is never silently converted into text-to-image. The configured model, key, and routing mode are not exposed as tool arguments.

Core invariants:

- all generation uses `POST https://openrouter.ai/api/v1/images`, never `/chat/completions`;
- model discovery is lazy and occurs before the first paid request;
- direct mode never initializes KoteGateway;
- proxy mode routes every OpenRouter endpoint through KoteGateway and fails closed;
- the package never installs a global fetch interceptor;
- reference order is preserved exactly;
- project paths are resolved against `context.worktree`, not `process.cwd()`;
- source files and existing outputs are never overwritten;
- secrets, prompts, and base64 are not logged.

## Request flow

```text
OpenCode tool call
  -> resolve and validate strict plugin options
  -> merge tool arguments over configured defaults
  -> resolve ordered references (edit only)
  -> validate formats, paths, byte limits, and request combinations
  -> discover/cache configured model capabilities
  -> choose direct or per-request proxy transport
  -> OpenRouter Images API
  -> bounded response read and binary validation
  -> atomic worktree writes
  -> OpenCode ToolResult with file attachments
```

Configuration failures establish a blocked state. Tools may remain registered, but they return `GENIMAGE_CONFIG_INVALID` without network access.

## Reference pipeline

Message attachments are resolved only from the parent user message identified through the current `sessionID` and `messageID`. The plugin does not search session history or the project automatically. Explicit project paths are confined to the real worktree. Explicit public references accept HTTPS only and are passed directly to OpenRouter.

Local PNG, JPEG, and WebP bytes are validated using magic bytes and encoded in memory as normalized data URLs. No external object store or temporary publishing service is involved. Count, per-file bytes, total local bytes, estimated base64 growth, and final body size are bounded before constructing a large request.

## Model and request validation

`GET /images/models` and the capability path returned by the model record determine whether the configured model supports image output, image input, `input_references`, and requested optional parameters. Routing variants are removed only for metadata lookup; catalog variants remain part of the catalog ID, and generation always sends the exact configured model ID. Endpoint paths are not reconstructed from the model ID. Cache keys include model ID, TTL, and only a short SHA-256 key fingerprint.

The plugin never changes the configured model. Unsupported capabilities fail before the paid request when discovery data makes that possible. `quality` and `output_compression` are treated as ignorable only when an endpoint does not advertise them; advertised descriptors are enforced.

## Transports

Direct mode performs ordinary HTTPS requests to OpenRouter. It never obtains bootstrap data, opens CONNECT, or treats KoteGateway as fallback.

Proxy mode reuses KoteGateway core functionality for signed bootstrap, Ed25519 verification, descriptor/cache handling, and sanitized errors. Each plugin-owned OpenRouter request uses the returned per-request proxy. Proxy headers remain separate from target headers. API keys, prompts, base64, and responses stay within TLS to OpenRouter. Any gateway error ends the operation; no direct retry is allowed.

Synthetic coexistence tests load `@koteye/kote-gateway-opencode` and this plugin in both orders. They verify one CONNECT for the image request, no image route marker, restoration of the gateway plugin's global wrapper, and native direct transport isolation. Real-runtime compatibility is still gated by the package ranges and OpenCode smoke described in the testing guide.

## HTTP behavior

Production base URL is fixed. Redirect mode is manual and all 3xx responses fail. Safe idempotent GET operations may retry temporary statuses up to two times while respecting `Retry-After` and jitter. `POST /images` is never retried to avoid duplicate generation. An ambiguous disconnect becomes `GENIMAGE_REQUEST_STATUS_UNKNOWN`. OpenRouter documents image billing as all-or-nothing: failed or cancelled generations are not billed, although the client may not learn the generation result after a disconnect.

Error bodies are bounded and parsed without exposing upstream messages. Only allowlisted typed error, provider, budget, limit, reset, and retry fields reach safe diagnostics.

The caller's abort signal, configured timeout, and transport cancellation are combined. Response bodies are streamed with `maxResponseBytes`; decoded images are bounded by `maxDecodedBytes` before persistence.

## Output and ToolResult

Returned base64 is decoded, validated, and classified by actual contents. PNG, JPEG, WebP, and safe SVG are supported for output. SVG requires strict UTF-8 and document-structure validation and rejects active or external content. A mismatch between requested and actual format changes the output extension and adds a warning. Valid images from a partially invalid response are saved and returned with warnings.

Files are written completely to same-directory temporary files and atomically published with a no-clobber hard link. Names avoid collisions; multiple outputs receive numeric suffixes. ToolResult metadata contains safe model/routing/count/path/MIME/size/cost fields, never prompts or base64. Each saved image is also returned as an OpenCode file attachment.

## Balance flow

`GET /key` uses the generation key and reports key-specific usage, spending limits, configured budgets, and the effective budget. `GET /credits` uses the management key and reports account totals. If the generation key explicitly identifies itself as a management key, it may be reused when no separate management key exists. Credits failure does not discard a successful key response. Balance calls are not cached.

## Lifecycle

Import and initial plugin load perform no network requests. The config hook registers the slash command and missing default permissions without overwriting user entries. `dispose` releases only plugin-owned resources. The plugin does not mutate global fetch, provider behavior, MCP, Git, npm, or OpenCode update traffic.
