# Image-to-image guide

`openrouter_edit_image` is the primary tool. Use it whenever an existing image must influence the result: editing, variations, identity preservation, pose/background/object changes, style transfer, multi-reference composition, or creation of a matching game/UI asset.

It requires at least one reference and never falls back to text-to-image. Use `openrouter_generate_image` only when no existing image needs to be preserved or consulted.

## Reference sources

Three explicit reference types are available:

```json
[
  { "type": "message_attachment", "index": 1 },
  { "type": "project_file", "path": "assets/reference.webp" },
  { "type": "https_url", "url": "https://example.com/reference.jpeg" }
]
```

- `message_attachment` indexes image attachments only, starting at 1. It resolves against the parent user message, not the full session history.
- `project_file` is relative to `context.worktree`. Only regular PNG, JPEG, and WebP files inside the real worktree are accepted.
- `https_url` accepts only public HTTPS URLs without embedded credentials. Tool arguments cannot contain `http:`, `file:`, `data:`, `blob:`, or `javascript:` references.

If `references` is omitted, all image attachments from the parent user message are used in original order. The plugin does not search older messages, scan the project, or reuse previous generations automatically.

## Ordering and prompt roles

Reference order is significant and preserved exactly. Reference 1 is primary; later references are supporting inputs. The plugin never sorts, drops, collages, or infers a role for a reference. State roles explicitly:

```text
Reference image 1 defines the character identity, face, proportions, and illustration style.
Reference image 2 defines clothing only.
Reference image 3 defines the palette and lighting.
Change only the pose. Keep the full body visible. Do not add text or other characters.
```

A useful edit prompt describes:

1. the role of each reference;
2. properties to preserve;
3. the exact requested change;
4. composition, pose, camera, lighting, and output purpose;
5. exclusions, especially text or extra objects.

The plugin sends the prompt without translation, style injection, or a separate prompt-improvement LLM. Prompts are required, trimmed for validation, and limited to 32,000 characters.

## Examples

Single project asset:

```json
{
  "prompt": "Reference 1 is the source crate. Preserve the isometric camera, proportions, palette, and painted style. Create a damaged version with broken boards and scratched metal corners. Keep the silhouette recognizable.",
  "references": [
    { "type": "project_file", "path": "assets/props/wooden-crate.png" }
  ],
  "output_path": "assets/props/wooden-crate-damaged.png",
  "n": 1
}
```

Two attachments:

```json
{
  "prompt": "Reference 1 is the primary character and defines identity, face, and body proportions. Reference 2 defines clothing only. Preserve the rendering style from reference 1 and show the character waving with the right hand.",
  "references": [
    { "type": "message_attachment", "index": 1 },
    { "type": "message_attachment", "index": 2 }
  ],
  "output_format": "png",
  "background": "transparent"
}
```

Style URL plus local subject:

```json
{
  "prompt": "Reference 1 defines the subject and silhouette. Reference 2 defines only palette, brushwork, and lighting. Preserve the subject while matching that visual style.",
  "references": [
    { "type": "project_file", "path": "assets/source.png" },
    { "type": "https_url", "url": "https://example.com/style.webp" }
  ]
}
```

## Encoding and limits

Local references are validated by MIME and magic bytes, then encoded in memory as `data:image/...;base64,...` inside `input_references`. Explicit HTTPS references are passed without download when no technical reason requires one. No third-party storage is used.

Defaults are 16 references, 20 MiB per local file, and 50 MiB total local bytes. All are configurable within documented constraints. Base64 growth and final request size are checked before building a huge JSON string. When limits are exceeded, the plugin does not silently resize, transcode, drop references, or fall back. Compress/resize the source, use fewer references, or supply a public HTTPS URL.

## Output

Outputs remain inside the worktree. `output_path` must be relative, may not escape through traversal or symlinks, and may not name a source or existing file. Multiple results receive `-01`, `-02`, and similar suffixes. Writes are atomic.

The actual returned bytes determine PNG/JPEG/WebP format and extension. A provider may return fewer results than requested or one invalid item; valid results are preserved and returned as OpenCode attachments with warnings. Cost is displayed only when OpenRouter supplies `usage.cost`.

## Capability failures

The configured model must advertise image input, image output, and `input_references`. Unsupported models or parameters fail before the paid request when discoverable. The plugin never substitutes another model and never converts an edit into generation.
