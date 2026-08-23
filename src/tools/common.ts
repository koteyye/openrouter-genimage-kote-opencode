import type { SafeLogger } from "../logging.js"
import { isPluginError } from "../openrouter/errors.js"

export async function runToolOperation<Result>(
  logger: SafeLogger,
  operation: () => Promise<Result>,
): Promise<Result> {
  try {
    return await operation()
  } catch (error) {
    if (isPluginError(error)) {
      logger.log("warn", "OpenRouter image tool failed.", {
        errorCode: error.code,
        ...(typeof error.details?.status === "number"
          ? { httpStatus: error.details.status }
          : {}),
      })
    }
    throw error
  }
}
