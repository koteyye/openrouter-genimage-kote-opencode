export interface HttpTransport {
  request(url: URL, init: RequestInit, signal: AbortSignal): Promise<Response>
  dispose?(): Promise<void>
}

export type GatewayErrorCode =
  | "GENIMAGE_GATEWAY_BOOTSTRAP_FAILED"
  | "GENIMAGE_GATEWAY_SIGNATURE_INVALID"
  | "GENIMAGE_GATEWAY_CACHE_EXPIRED"
  | "GENIMAGE_GATEWAY_CONNECT_FAILED"
  | "GENIMAGE_GATEWAY_TIMEOUT"

export class GatewayTransportError extends Error {
  readonly code: GatewayErrorCode

  constructor(code: GatewayErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "GatewayTransportError"
    this.code = code
  }
}
