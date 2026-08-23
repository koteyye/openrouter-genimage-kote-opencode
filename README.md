# openrouter-genimage-kote-opencode

OpenRouter image generation and image-to-image tools for OpenCode, with optional fail-closed routing through KoteGateway. Image-to-image is the primary workflow: attached images, project files, and public HTTPS URLs are sent to the configured OpenRouter image model as ordered `input_references`. Text-to-image is also available when no visual reference is needed.

The plugin registers:

- `openrouter_edit_image` — edit or create from one or more visual references;
- `openrouter_generate_image` — create a new image from text only;
- `openrouter_balance` — show current-key usage and, when authorized, account credits;
- `/openrouter-balance` — invoke the balance tool without generating an image.

The operation may incur OpenRouter charges. The OpenRouter model, API keys, and routing mode are configuration only; they are never tool arguments.

## Installation

Add the npm package to the `plugin` array in `opencode.jsonc`, then configure it as a tuple as shown below. OpenCode installs npm plugins referenced by its configuration.

Use permissions that ask before paid image operations while allowing balance checks:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "permission": {
    "openrouter_edit_image": "ask",
    "openrouter_generate_image": "ask",
    "openrouter_balance": "allow"
  }
}
```

## Direct configuration

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "openrouter-genimage-kote-opencode@0.1.0",
      {
        "routing": "direct",
        "model": "openai/gpt-image-1",
        "apiKey": "{env:OPENROUTER_API_KEY}",
        "managementApiKey": "{env:OPENROUTER_MANAGEMENT_API_KEY}",
        "outputDirectory": "assets/generated",
        "defaults": {
          "n": 1,
          "output_format": "png"
        }
      }
    ]
  ]
}
```

Direct mode sends HTTPS requests straight to the fixed OpenRouter API origin. It does not obtain a KoteGateway descriptor or use the gateway as a fallback.

## Proxy configuration

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "openrouter-genimage-kote-opencode@0.1.0",
      {
        "routing": "proxy",
        "model": "openai/gpt-image-1",
        "apiKey": "{env:OPENROUTER_API_KEY}",
        "outputDirectory": "assets/generated",
        "input": {
          "maxReferences": 16,
          "maxFileBytes": 20971520,
          "maxTotalBytes": 52428800
        },
        "requestTimeoutMs": 300000
      }
    ]
  ]
}
```

Proxy mode obtains a signed KoteGateway descriptor and uses an HTTPS CONNECT tunnel for every OpenRouter endpoint used by this plugin. It is fail-closed: bootstrap, signature, CONNECT, or proxy timeout errors end the request and never trigger a direct retry. OpenRouter keys, prompts, references, and results remain inside the TLS connection to OpenRouter and are not proxy headers.

## API keys

Create an OpenRouter generation key and expose it as `OPENROUTER_API_KEY`. Resolution order is `apiKey` in plugin options, then the environment variable. An absent key produces `GENIMAGE_OPENROUTER_KEY_MISSING` before any paid request.

Full account credits require a management key. Set `managementApiKey` or `OPENROUTER_MANAGEMENT_API_KEY`. The generation key may be used for credits only if `/key` explicitly reports that it is a management key. Do not commit either key to `opencode.jsonc`; use OpenCode's `{env:NAME}` substitution.

## Choosing an image model

Set `model` to an OpenRouter image-model ID. The model is deliberately not exposed to tools, so an agent cannot silently select a different or more expensive model. Before the first paid request, the plugin discovers image-model capabilities and checks image output, image input for edit calls, and requested parameters. It does not substitute another model when a capability is missing.

Provider support can be narrower than the OpenRouter API limits. In particular, a provider may accept fewer results or fewer parameters than another endpoint for the same model.

## Image-to-image (primary workflow)

`openrouter_edit_image` requires at least one image input. It never falls back to text-to-image. If `references` is omitted, the plugin uses all image attachments from the parent user message, in their original order. If none exist, it returns `GENIMAGE_REFERENCE_REQUIRED`.

### Attached images

Attach one or more images to the current user message and ask OpenCode to edit them. To select specific image attachments, references use one-based indexing among image attachments only:

```json
{
  "prompt": "Reference image 1 defines the character. Reference image 2 defines clothing only. Preserve the face and illustration style.",
  "references": [
    { "type": "message_attachment", "index": 1 },
    { "type": "message_attachment", "index": 2 }
  ]
}
```

The plugin supports trusted attachment representations supplied by OpenCode. It does not accept arbitrary `file:`, `data:`, or `blob:` URLs as tool arguments.

### Project files

Paths are relative to the current OpenCode worktree:

```json
{
  "prompt": "Preserve the isometric angle, proportions, and palette. Create a damaged version with broken boards.",
  "references": [
    { "type": "project_file", "path": "assets/props/crate.png" }
  ],
  "output_path": "assets/props/crate-damaged.png"
}
```

PNG, JPEG, and WebP inputs are accepted after size and magic-byte validation. Absolute paths, traversal, symlink escapes, directories, and files outside the worktree are rejected. Source images and existing outputs are never overwritten.

### Multiple references and HTTPS URLs

References are sent in exactly the order supplied. The first is the primary reference; describe each reference's role in the prompt because the plugin does not reorder, combine, or infer roles.

```json
{
  "prompt": "Reference 1 defines identity and face. Reference 2 defines clothing only. Reference 3 defines palette and lighting.",
  "references": [
    { "type": "project_file", "path": "assets/character.png" },
    { "type": "message_attachment", "index": 1 },
    { "type": "https_url", "url": "https://example.com/palette.webp" }
  ]
}
```

Only public HTTPS URLs without embedded credentials are accepted. Explicit HTTPS references are passed to OpenRouter unchanged; local images are encoded in memory as base64 data URLs. No external storage service is required.

See [Image-to-image guide](docs/image-to-image.md) for prompt patterns and limits.

## Text-to-image

Use `openrouter_generate_image` only for a completely new image with no visual reference. It accepts a prompt and output parameters, but no references, paths, attachment indexes, base64, or URLs.

## Install the model skill

The skill ships in the npm tarball but OpenCode discovers skills from project or user skill directories. Install it explicitly:

```bash
npx openrouter-genimage-kote-opencode install-skill
npx openrouter-genimage-kote-opencode check-skill
```

For the user-wide directory:

```bash
npx openrouter-genimage-kote-opencode install-skill --global
npx openrouter-genimage-kote-opencode check-skill --global
```

Project install writes `.opencode/skills/openrouter-image-generation/SKILL.md`; global install always writes `~/.config/opencode/skills/openrouter-image-generation/SKILL.md`, including on Windows. An identical SHA-256 is a no-op. `check-skill` exits nonzero when the skill is missing or modified. Use `--force` only to atomically replace a locally modified skill. The CLI has no postinstall hook, needs no API key, and performs no network request.

## Balance and usage

Run `/openrouter-balance` or call `openrouter_balance`. The result keeps two concepts separate:

- `/key` reports usage and the spending limit of the configured API key, including the remaining API-key limit;
- `/credits` reports total account credits and total account usage, and requires a management key.

The remaining spending limit of one key is not the OpenRouter account balance. Without management authorization, account credits are reported as unavailable. A successful `/key` response is still returned if `/credits` fails.

## Security

- Production requests are fixed to `https://openrouter.ai/api/v1`; custom base URLs are rejected.
- Redirects are rejected. Paid `POST /images` requests are never retried automatically.
- Proxy mode is fail-closed and never retries directly.
- The plugin does not replace `globalThis.fetch` or intercept other providers.
- Keys, full prompts, base64, binary data, unredacted upstream bodies, and full URLs with query strings are excluded from logs and metadata.
- Local input and output paths are confined to the worktree; real paths are checked to prevent symlink escape.
- Output uses atomic writes and never overwrites a source or existing file.

See [Security](docs/security.md) and [SECURITY.md](SECURITY.md).

## Version 0.1.0 limitations

No masks or pixel-local inpainting, interactive editor, LoRA training, video, streaming generation, SVG results, provider-specific options, automatic credit purchase, automatic model selection, hidden fallback, or external object storage are included. Only PNG, JPEG, and WebP raster inputs/results are supported. Seeds do not promise reproducibility across providers. OpenRouter may return fewer images than requested; valid partial results are preserved with warnings.

## Troubleshooting

- `GENIMAGE_REFERENCE_REQUIRED`: attach an image or pass at least one ordered reference to `openrouter_edit_image`.
- `GENIMAGE_MODEL_DOES_NOT_SUPPORT_IMAGE_INPUT`: choose an image-to-image capable model in configuration; the plugin will not switch models.
- `GENIMAGE_PARAMETER_UNSUPPORTED`: remove the unsupported argument/default or choose a compatible configured model.
- `GENIMAGE_OPENROUTER_KEY_MISSING`: expose `OPENROUTER_API_KEY` to the OpenCode process or set `apiKey` through an environment substitution.
- `GENIMAGE_*_TOO_LARGE` / `GENIMAGE_TOTAL_REFERENCE_SIZE_EXCEEDED`: compress or resize inputs, use fewer references, or supply a public HTTPS URL.
- `GENIMAGE_GATEWAY_*`: repair KoteGateway/bootstrap/connectivity; proxy mode intentionally does not fall back to direct.
- Output path errors: use a relative worktree path that neither exists nor names a source image.

See the complete [Troubleshooting guide](docs/troubleshooting.md), [Configuration reference](docs/configuration.md), and [Testing guide](docs/testing.md).

## Compatibility status

- OpenCode smoke-test baseline: **1.18.21**. CI is configured to test that baseline and the latest release, but TUI and Desktop attachment rendering still require manual release checks; Web is tested when available.
- `@koteye/kote-gateway-opencode` **0.1.1** declares an `@opencode-ai/plugin`/OpenCode compatibility ceiling of **1.18.18**, while this package targets **1.18.21**. The current build therefore pins the SDK to **1.18.18** and is not publishable as fully baseline-compatible until the reusable gateway core is released independently (without the OpenCode peer) or the gateway package range is updated.
- Synthetic TLS/CONNECT tests pass for signed bootstrap, fail-closed routing, one CONNECT, and both plugin load orders. They do not waive the package-range blocker above or the real-client smoke checks.
- Node.js 20 or newer is declared by the package. The implementation is intended to be Bun-compatible and to support Windows, macOS, and Linux; release artifacts must be tested on the supported matrix.

## Documentation

- [Architecture](docs/architecture.md)
- [Configuration](docs/configuration.md)
- [Image-to-image](docs/image-to-image.md)
- [Security](docs/security.md)
- [Testing](docs/testing.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Русская версия](README.ru.md)

## License

MIT. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
