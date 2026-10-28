# Troubleshooting

Errors use a stable `GENIMAGE_*` code, a safe message, optional sanitized details, and a suggested action. They must not contain keys, prompts, base64, full upstream bodies, query-bearing URLs, or bootstrap documents.

## Configuration

| Code | Cause and action |
|---|---|
| `GENIMAGE_CONFIG_INVALID` | A required field is absent, an object contains unknown fields, a string is blank, a numeric/cross-field limit is invalid, or a forbidden base URL was supplied. Validate against `schema/plugin-options.schema.json`; also ensure `maxTotalBytes >= maxFileBytes`. No network request is made while blocked. |
| `GENIMAGE_OPENROUTER_KEY_MISSING` | Set `apiKey` via `{env:OPENROUTER_API_KEY}` or expose `OPENROUTER_API_KEY` to the OpenCode process. Restart OpenCode if its environment changed. |

## References

| Code | Cause and action |
|---|---|
| `GENIMAGE_REFERENCE_REQUIRED` | `openrouter_edit_image` found no explicit reference and no image in the parent user message. Attach an image or pass a reference; there is no text-to-image fallback. |
| `GENIMAGE_REFERENCE_NOT_FOUND` | Verify the project-relative path and current worktree. |
| `GENIMAGE_REFERENCE_INDEX_INVALID` | Attachment indexes start at 1 and count only image attachments in the parent user message. |
| `GENIMAGE_REFERENCE_FORMAT_UNSUPPORTED` | Convert the input to PNG, JPEG, or WebP. Renaming an extension is insufficient. |
| `GENIMAGE_REFERENCE_TOO_LARGE` | Resize/compress that local image or use a public HTTPS URL. |
| `GENIMAGE_TOTAL_REFERENCE_SIZE_EXCEEDED` | Use fewer/smaller local references or public HTTPS URLs. |
| `GENIMAGE_REFERENCE_INVALID` | The MIME, base64, magic bytes, or file contents are invalid/mismatched. Re-export the image. |
| `GENIMAGE_REFERENCE_URL_INVALID` | Use a public `https://` URL without embedded credentials. `http:`, `file:`, `data:`, `blob:`, and `javascript:` tool URLs are rejected. |
| `GENIMAGE_TOO_MANY_REFERENCES` | Reduce references to the configured limit (maximum 16). Order is never changed automatically. |
| `GENIMAGE_ATTACHMENT_ACCESS_FAILED` | Reattach the image to the current message. For internal OpenCode URLs, confirm the client/runtime smoke target supports attachment retrieval. |

## Model and parameters

| Code | Cause and action |
|---|---|
| `GENIMAGE_MODEL_NOT_FOUND` | Correct the configured OpenRouter model ID. Routing variants are resolved through the base catalog entry; unsupported catalog variants still fail. The tool cannot select another model. |
| `GENIMAGE_MODEL_DOES_NOT_SUPPORT_IMAGE_INPUT` | Configure a model/endpoint with image input and `input_references`; edit never falls back to generation. |
| `GENIMAGE_MODEL_DOES_NOT_SUPPORT_IMAGE_OUTPUT` | Configure a model with image output. |
| `GENIMAGE_PARAMETER_UNSUPPORTED` | Remove the unsupported tool/default parameter or deliberately change the configured model. Check transparent output, `n`, resolution, and advertised endpoint-specific capabilities. Unadvertised quality/compression are passed through as ignorable. |

## OpenRouter

| Code | Cause and action |
|---|---|
| `GENIMAGE_OPENROUTER_AUTH` | Verify/recreate the generation key and its environment mapping. Do not paste it into logs/issues. |
| `GENIMAGE_OPENROUTER_FORBIDDEN` | Check key permissions, endpoint/model access, and any reported organization/workspace/key budget. `/credits` needs management authorization. |
| `GENIMAGE_INSUFFICIENT_CREDITS` | Check account credits and key limits. For an in-flight-budget error, wait for the reported retry delay instead of assuming the account has no funds. The plugin cannot purchase credits. |
| `GENIMAGE_RATE_LIMITED` | Wait for the reported `Retry-After` delay; safe GETs have bounded retries, but paid POST generation is not retried. |
| `GENIMAGE_BAD_REQUEST` | Recheck prompt and parameters against model capabilities and any safe typed error metadata. |
| `GENIMAGE_REQUEST_TOO_LARGE` | Reduce image count/size. Base64 expands local payloads. |
| `GENIMAGE_PROVIDER_ERROR` | Retry later after checking OpenRouter/provider status. The plugin does not switch provider/model automatically. |
| `GENIMAGE_TIMEOUT` | Increase `requestTimeoutMs` only if appropriate and check connectivity. An image POST is not retried automatically. |
| `GENIMAGE_REQUEST_STATUS_UNKNOWN` | The connection failed after submission and the generation result is unknown. Check OpenRouter activity before manually repeating. OpenRouter documents failed/cancelled image generations as unbilled. |
| `GENIMAGE_RESPONSE_INVALID` / `GENIMAGE_IMAGE_INVALID` | OpenRouter returned missing, malformed, oversized, unsupported, unsafe, or MIME-mismatched data. Valid partial results may still be saved with warnings. |

## KoteGateway

`GENIMAGE_GATEWAY_BOOTSTRAP_FAILED`, `GENIMAGE_GATEWAY_SIGNATURE_INVALID`, `GENIMAGE_GATEWAY_CACHE_EXPIRED`, `GENIMAGE_GATEWAY_CONNECT_FAILED`, and `GENIMAGE_GATEWAY_TIMEOUT` all stop a proxy-mode operation. Check bootstrap reachability, clock/signature/cache state, descriptor, proxy connectivity, and TLS CONNECT. Proxy mode intentionally never retries direct. Switch to `routing: "direct"` only as an explicit user configuration decision, not as an automated recovery.

When both gateway packages are installed, verify the tested versions and plugin load-order smoke matrix. The intended behavior is one per-request proxy for image traffic and no impact on ordinary OpenCode provider traffic.

## Output filesystem

| Code | Cause and action |
|---|---|
| `GENIMAGE_OUTPUT_PATH_INVALID` | Use a relative file path, not an absolute path, drive/UNC path, directory, or traversal. |
| `GENIMAGE_OUTPUT_OUTSIDE_WORKTREE` | Remove `..` or a symlink that resolves outside `context.worktree`. |
| `GENIMAGE_OUTPUT_FORMAT_MISMATCH` | Use an extension consistent with the actual PNG/JPEG/WebP/SVG bytes; the plugin may correct the saved extension and warn. |
| `GENIMAGE_OUTPUT_WRITE_FAILED` | Check directory permissions/free space. Atomic writes should leave no partial final file. Existing files are not overwritten; choose another name. |
| `GENIMAGE_SOURCE_OVERWRITE_FORBIDDEN` | Choose a destination different from every source reference. |

## Balance terminology

`Remaining API-key spending limit` comes from `/key` and is not account balance. Configured budgets and the effective budget are reported separately because they can block requests before the key limit is exhausted. Full `Account credits` come from `/credits`, require a management key, and may legitimately calculate to a negative value. If credits are unavailable but key usage appears, this is intentional partial success.

## Safe diagnostic report

Include package version, OpenCode version/client, OS/runtime, routing mode, configured model ID, error code, safe HTTP status/request ID, reference count and byte sizes, and relative output path. Remove keys, authorization/proxy headers, full prompts, base64, private images, query strings, full upstream bodies, and gateway bootstrap data.
