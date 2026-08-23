import type { HttpTransport } from "./types.js"
import { fetch as undiciFetch } from "undici"

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

/** A fetch implementation that cannot be replaced by another plugin's global wrapper. */
export const nativeFetch: FetchLike =
  typeof Bun !== "undefined" && typeof Bun.fetch === "function"
    ? (Bun.fetch.bind(Bun) as unknown as FetchLike)
    : (undiciFetch as unknown as FetchLike)

export class DirectTransport implements HttpTransport {
  readonly #fetch: FetchLike

  constructor(fetchImplementation: FetchLike = nativeFetch) {
    this.#fetch = fetchImplementation
  }

  request(url: URL, init: RequestInit, signal: AbortSignal): Promise<Response> {
    return this.#fetch(url, { ...init, signal })
  }
}
