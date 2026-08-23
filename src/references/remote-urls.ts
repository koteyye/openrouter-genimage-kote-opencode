import { PluginError } from "../openrouter/errors.js"

export const MAX_REFERENCE_URL_LENGTH = 8_192

export function validatePublicHttpsUrl(value: string): string {
  if (value.length === 0 || value.length > MAX_REFERENCE_URL_LENGTH) {
    throw new PluginError(
      "GENIMAGE_REFERENCE_URL_INVALID",
      "The reference URL is empty or too long.",
    )
  }

  let url: URL
  try {
    url = new URL(value)
  } catch (error) {
    throw new PluginError(
      "GENIMAGE_REFERENCE_URL_INVALID",
      "The reference URL is invalid.",
      { cause: error },
    )
  }

  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hostname === ""
  ) {
    throw new PluginError(
      "GENIMAGE_REFERENCE_URL_INVALID",
      "Reference URLs must use HTTPS and must not contain credentials.",
    )
  }
  return value
}
