# Configuration

Plugin options are supplied as the second item in an OpenCode plugin tuple. The public JSON Schema is [`schema/plugin-options.schema.json`](../schema/plugin-options.schema.json).

```jsonc
{
  "plugin": [
    [
      "openrouter-genimage-kote-opencode@0.1.0",
      {
        "routing": "direct",
        "model": "openai/gpt-image-1",
        "apiKey": "{env:OPENROUTER_API_KEY}"
      }
    ]
  ]
}
```

Unknown fields are errors at every configuration object level. `baseUrl`, `openrouterUrl`, and `apiUrl` are intentionally unsupported; production traffic is fixed to `https://openrouter.ai/api/v1`.

## Options

| Option | Required | Default | Constraints |
|---|---:|---|---|
| `routing` | yes | — | `direct` or `proxy` |
| `model` | yes | — | non-empty after trimming |
| `apiKey` | no | `OPENROUTER_API_KEY` | non-empty after trimming |
| `managementApiKey` | no | `OPENROUTER_MANAGEMENT_API_KEY` | non-empty after trimming |
| `outputDirectory` | no | `assets/generated` | relative worktree directory |
| `requestTimeoutMs` | no | `300000` | positive integer |
| `modelCacheTtlMs` | no | `3600000` | positive integer |
| `maxResponseBytes` | no | `134217728` | positive integer |
| `maxDecodedBytes` | no | `134217728` | positive integer |

`apiKey` resolution is options first, environment second, then `GENIMAGE_OPENROUTER_KEY_MISSING`. The management key uses the same precedence but may remain absent; only full account credits become unavailable.

## Generation defaults

Values in `defaults` apply to both image tools. A tool argument overrides the corresponding default; absent values are omitted from the OpenRouter request.

| Option | Default | Constraints |
|---|---|---|
| `aspect_ratio` | omitted | `1:1`, `1:2`, `1:4`, `1:8`, `2:1`, `2:3`, `2.35:1`, `3:2`, `3:4`, `4:1`, `4:3`, `4:5`, `5:2`, `5:4`, `5:7`, `7:5`, `8:1`, `9:16`, `16:9`, `9:19.5`, `19.5:9`, `9:20`, `20:9`, `9:21`, `21:9`, `auto` |
| `background` | omitted | `auto`, `transparent`, `opaque` |
| `n` | `1` | integer, 1–10 |
| `output_format` | omitted | `png`, `jpeg`, `webp`, `svg` |
| `output_compression` | omitted | integer, 0–100; used for JPEG/WebP and ignored where inapplicable |
| `quality` | omitted | `auto`, `low`, `medium`, `high`, `xhigh`, `max` |
| `resolution` | omitted | `512`, `768`, `1K`, `1.5K`, `2K`, `4K` |
| `seed` | omitted | integer |

`background: "transparent"` is valid only with PNG or WebP. OpenRouter ignores `output_compression` for formats and providers without a compression knob, and ignores `quality` on providers without a quality knob. When an endpoint advertises either capability, the plugin validates the requested value against its descriptor. SVG is supported for generated outputs only; reference inputs remain PNG, JPEG, or WebP.

## Input limits

| Option | Default | Constraints |
|---|---:|---|
| `input.maxReferences` | `16` | integer, 1–16 |
| `input.maxFileBytes` | `20971520` | positive integer |
| `input.maxTotalBytes` | `52428800` | positive integer and not less than `maxFileBytes` |

Limits apply before constructing a large base64 JSON request. The implementation also accounts for base64 expansion and final request-body size.

Standard JSON Schema cannot compare two arbitrary sibling numeric values. Consequently, the published schema validates both byte fields as positive integers but cannot express `maxTotalBytes >= maxFileBytes`; strict runtime validation enforces that relationship. Likewise, trim-aware non-empty checks and output-format combinations remain runtime checks in addition to schema validation.

## Complete example

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
        "managementApiKey": "{env:OPENROUTER_MANAGEMENT_API_KEY}",
        "outputDirectory": "assets/generated",
        "defaults": {
          "aspect_ratio": "auto",
          "background": "auto",
          "n": 1,
          "output_format": "png",
          "quality": "auto"
        },
        "input": {
          "maxReferences": 16,
          "maxFileBytes": 20971520,
          "maxTotalBytes": 52428800
        },
        "requestTimeoutMs": 300000,
        "modelCacheTtlMs": 3600000,
        "maxResponseBytes": 134217728,
        "maxDecodedBytes": 134217728
      }
    ]
  ],
  "permission": {
    "openrouter_edit_image": "ask",
    "openrouter_generate_image": "ask",
    "openrouter_balance": "allow"
  }
}
```

## Invalid configuration behavior

Invalid options establish a blocked configuration state and return `GENIMAGE_CONFIG_INVALID`. Tools may still be visible, but no network request is allowed. Examples include missing routing/model, blank strings, unknown fields, invalid numeric limits, `maxTotalBytes < maxFileBytes`, unsupported enum values, and forbidden custom API URL fields.
