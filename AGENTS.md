# Development guardrails

- Image-to-image is the primary workflow; never silently fall back to text-to-image.
- The configured OpenRouter model, key, and routing mode are not tool arguments.
- Proxy mode is fail-closed and must never retry directly.
- Do not install a global fetch interceptor from this package.
- Never log API keys, full prompts, base64 payloads, or unredacted upstream bodies.
- Resolve all project input and output paths against the OpenCode worktree.
- Preserve reference order exactly and never overwrite a source or existing output.
- Real OpenRouter E2E tests are opt-in and must not run in ordinary CI.
