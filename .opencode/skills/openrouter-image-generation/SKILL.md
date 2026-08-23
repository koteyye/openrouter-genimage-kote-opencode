---
name: openrouter-image-generation
description: Use when the user explicitly asks to generate, create, draw, render, edit, transform, redraw, or restyle an image, or requests new visual assets for a project.
license: MIT
compatibility: opencode
metadata:
  plugin: openrouter-genimage-kote-opencode
  edit-tool: openrouter_edit_image
  generate-tool: openrouter_generate_image
---

# OpenRouter Image Generation

Use the image tools provided by `openrouter-genimage-kote-opencode`.

Image-to-image is the primary workflow.

## Available tools

### `openrouter_edit_image`

Use when one or more existing images should influence the result.

Typical scenarios:

- edit an attached image;
- redraw or restyle an image;
- create a variation;
- change the background;
- recolor an asset;
- add or remove an object;
- preserve a character while changing the pose;
- preserve an object while changing its state;
- create another asset in the same style;
- use several visual references;
- create a new asset based on an existing image.

### `openrouter_generate_image`

Use only when the user requests a completely new image and no existing image
needs to be preserved or used as a visual reference.

## When to use image tools

Use an image tool when:

1. The user explicitly asks to generate, create, draw, render, edit, transform,
   redraw, or restyle an image.
2. The user requests new visual assets.
3. The user requests game assets such as:
   - characters;
   - sprites;
   - inventory icons;
   - ability icons;
   - textures;
   - backgrounds;
   - environment art;
   - concept art;
   - loading screens;
   - promotional art.
4. The user requests application or website assets such as:
   - UI illustrations;
   - empty-state illustrations;
   - thumbnails;
   - banners;
   - avatars;
   - hero images;
   - decorative graphics.
5. The user attaches an image and requests a visible change.

The request may be written in any language. Follow the user's intent rather
than relying on exact English trigger words.

## When not to use image tools

Do not call image tools when:

- the user only asks to discuss an idea;
- the user asks to analyze an image without changing it;
- the user asks to find an existing image online;
- the user asks for factual information about an image;
- the task should be solved with deterministic SVG, HTML, CSS, a chart, or a
  technical diagram;
- the user did not request a new or modified visual result.

Do not call `openrouter_balance` after every generation. Use it only when the
user asks about balance, usage, credits, spending, or limits.

## Choosing the correct tool

Use `openrouter_edit_image` when:

- an image is attached;
- the user references an image inside the project;
- the user provides an image URL;
- the user asks to preserve visual properties;
- the user asks for a variation;
- the user asks to match an existing style.

Use `openrouter_generate_image` when:

- the user requests a completely new image;
- no visual reference is required;
- nothing from an existing image must be preserved.

When the user attaches images and asks to edit "this image", omit the
`references` argument. The tool will use all image attachments from the current
user message.

When only some attached images should be used, pass explicit attachment
indexes.

## Image-to-image prompt structure

Clearly separate:

1. The role of every reference.
2. What must be preserved.
3. What must be changed.
4. What may change if necessary.
5. What must not appear.
6. The intended use of the result.

Recommended structure:

> Reference image 1 is the primary source.
>
> Preserve: [identity, face, hairstyle, silhouette, proportions, camera angle,
> composition, art style, palette, lighting, materials].
>
> Change: [specific requested changes].
>
> Final result: [pose, composition, background, framing, asset purpose].
>
> Avoid: [unwanted changes or additions].

Do not describe the entire source image from scratch when the user wants most
of it preserved. Excessive redescription can cause the image model to replace
details that should remain unchanged.

Use explicit preservation phrases:

- preserve the same character identity;
- keep the facial features unchanged;
- preserve the original proportions;
- keep the camera angle;
- maintain the same illustration style;
- retain the original color palette;
- change only the requested element;
- do not add extra characters;
- do not crop the subject.

## Multiple references

Always explain the role of every reference by order.

Example:

- Reference image 1: character identity and face.
- Reference image 2: clothing design only.
- Reference image 3: pose only.
- Reference image 4: visual style and color palette.
- Reference image 5: background composition.

Do not assume that the image model knows why each reference was supplied.

The first reference should normally be the primary subject.

## Text-to-image prompt structure

Build the prompt in this order:

1. Asset type and intended use.
2. Main subject.
3. Action, pose, or state.
4. Composition, camera, viewpoint, and crop.
5. Environment or background.
6. Visual style and shape language.
7. Materials and important details.
8. Color palette and lighting.
9. Technical constraints.
10. Short exclusions.

Template:

> [Asset type and purpose]. [Main subject and action]. [Composition and
> viewpoint]. [Environment]. [Visual style and shape language]. [Materials and
> details]. [Palette and lighting]. [Technical constraints]. [Short
> exclusions].

## General prompt rules

### Be concrete

Specify:

- how many subjects are present;
- what they are doing;
- where they are positioned;
- whether the result is full-body, portrait, top-down, side-view, isometric,
  or orthographic;
- whether cropping is allowed;
- what the background should contain;
- where empty space is required.

Avoid prompts consisting only of adjectives such as:

> beautiful, epic, amazing, highly detailed, cinematic

Replace vague adjectives with visible instructions.

### State the asset purpose

Mention whether the result is:

- an inventory icon;
- a character portrait;
- a full-body character;
- a sprite;
- a side-scrolling background;
- a seamless texture;
- a loading screen;
- a UI illustration;
- a thumbnail;
- promotional art.

The purpose affects composition, padding, readability, and detail level.

### Use tool parameters

Do not rely on prompt text alone for:

- aspect ratio;
- transparent background;
- output format;
- resolution;
- number of results.

Describe the visual requirement in the prompt and also pass the appropriate
tool arguments.

### Transparent assets

For isolated assets:

- request one isolated subject;
- request a clean silhouette;
- leave padding around the subject;
- avoid cropped edges;
- avoid unwanted shadows extending beyond the asset;
- use PNG or WebP;
- set `background` to `transparent`.

### Game sprites

Specify:

- side-view, front-view, top-down, or isometric orientation;
- full body and no cropping;
- neutral or explicit pose;
- consistent scale;
- readable silhouette;
- intended gameplay context.

Generate separate assets instead of a sprite sheet unless the user explicitly
requests a sprite sheet.

### UI icons

Specify:

- one central object;
- strong silhouette;
- controlled detail;
- clear margins;
- no text;
- no watermark;
- transparent background when appropriate;
- readability at small sizes.

### Backgrounds

Specify:

- aspect ratio;
- viewpoint;
- depth layers;
- areas that should remain visually quiet for UI overlays;
- whether characters or text must be absent.

### Seamless textures

Explicitly request:

- seamless;
- tileable;
- uniform scale;
- no borders;
- no perspective;
- no large lighting gradient;
- no unique object that makes repetition obvious.

### Text inside images

Keep text to a minimum.

When text is required:

- include the exact text in quotation marks;
- specify placement;
- specify typography;
- inspect the generated result;
- do not claim that the spelling is correct without checking it.

### Consistent asset series

Preserve a reusable style block containing:

- visual medium;
- shape language;
- outline treatment;
- palette;
- lighting direction;
- camera or viewpoint;
- level of detail;
- background treatment.

Change only the subject-specific section.

Use separate tool calls for separate assets unless the user explicitly requests
a combined sheet.

### Exclusions

Keep exclusions short and specific.

Good example:

> no text, no watermark, no additional objects, no cropped edges

Avoid long and contradictory negative-prompt lists.

## Number of results

Generate one image by default.

Use `n > 1` only when the user explicitly requests:

- alternatives;
- variations;
- several concepts;
- multiple options.

Remember that additional images may increase cost.

## Output path

Use an existing project asset directory when it is obvious.

Otherwise save under:

`assets/generated`

Use a meaningful filename.

Never overwrite the source image.

## After generation

1. Report the exact paths returned by the tool.
2. Report how many images were requested and returned.
3. Report the configured image model when available.
4. Report routing mode when available.
5. Report OpenRouter cost only when the tool provides it.
6. Inspect returned image attachments when the active model supports image
   input.
7. Do not invent visual details that were not inspected.
8. Do not claim success when no file was returned.
9. Clearly report partial success and warnings.
