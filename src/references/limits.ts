import { PluginError } from "../openrouter/errors.js"

export interface ReferenceLimits {
  maxReferences: number
  maxFileBytes: number
  maxTotalBytes: number
}

export class ReferenceBudget {
  readonly #limits: ReferenceLimits
  #referenceCount = 0
  #localBytes = 0

  constructor(limits: ReferenceLimits) {
    this.#limits = limits
  }

  get referenceCount(): number {
    return this.#referenceCount
  }

  get localBytes(): number {
    return this.#localBytes
  }

  addRemoteReference(): void {
    this.#addReferenceCount()
  }

  addLocalReference(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new PluginError(
        "GENIMAGE_REFERENCE_INVALID",
        "The reference image has an invalid byte size.",
      )
    }
    if (bytes > this.#limits.maxFileBytes) {
      throw new PluginError(
        "GENIMAGE_REFERENCE_TOO_LARGE",
        "The reference image exceeds the configured file-size limit.",
        {
          details: { bytes, maxFileBytes: this.#limits.maxFileBytes },
          suggestion:
            "Resize or compress the image, use fewer references, or provide a public HTTPS URL.",
        },
      )
    }
    if (this.#localBytes + bytes > this.#limits.maxTotalBytes) {
      throw new PluginError(
        "GENIMAGE_TOTAL_REFERENCE_SIZE_EXCEEDED",
        "The combined local reference images exceed the configured size limit.",
        {
          details: {
            bytes: this.#localBytes + bytes,
            maxTotalBytes: this.#limits.maxTotalBytes,
          },
          suggestion:
            "Resize or compress images, use fewer references, or provide public HTTPS URLs.",
        },
      )
    }
    this.#addReferenceCount()
    this.#localBytes += bytes
  }

  assertEstimatedRequestSize(promptCharacters: number, urlCharacters: number): void {
    const estimatedBase64Bytes = Math.ceil(this.#localBytes / 3) * 4
    const overhead = 64 * 1024 + promptCharacters * 4 + urlCharacters * 4
    const maximum = Math.ceil(this.#limits.maxTotalBytes / 3) * 4 + 1024 * 1024
    if (estimatedBase64Bytes + overhead > maximum) {
      throw new PluginError(
        "GENIMAGE_TOTAL_REFERENCE_SIZE_EXCEEDED",
        "The encoded reference payload exceeds the safe request-size limit.",
        {
          suggestion:
            "Resize or compress images, use fewer references, or provide public HTTPS URLs.",
        },
      )
    }
  }

  #addReferenceCount(): void {
    this.#referenceCount += 1
    if (this.#referenceCount > this.#limits.maxReferences || this.#referenceCount > 16) {
      throw new PluginError(
        "GENIMAGE_TOO_MANY_REFERENCES",
        "Too many image references were supplied.",
        {
          details: {
            maxReferences: Math.min(this.#limits.maxReferences, 16),
          },
          suggestion: "Use fewer references.",
        },
      )
    }
  }
}
