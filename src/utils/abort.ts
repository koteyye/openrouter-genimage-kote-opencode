export interface DeadlineSignal {
  signal: AbortSignal
  didTimeout(): boolean
  dispose(): void
}

export interface LinkedAbortSignal {
  signal: AbortSignal
  dispose(): void
}

export function createLinkedAbortSignal(
  signals: readonly AbortSignal[],
): LinkedAbortSignal {
  const controller = new AbortController()
  const listeners: Array<readonly [AbortSignal, () => void]> = []

  for (const signal of signals) {
    const relay = () => controller.abort(signal.reason)
    if (signal.aborted) {
      relay()
      break
    }
    signal.addEventListener("abort", relay, { once: true })
    listeners.push([signal, relay])
  }

  return {
    signal: controller.signal,
    dispose() {
      for (const [signal, listener] of listeners) {
        signal.removeEventListener("abort", listener)
      }
    },
  }
}

export function createDeadlineSignal(
  parent: AbortSignal,
  timeoutMs: number,
): DeadlineSignal {
  const controller = new AbortController()
  let timedOut = false

  const abortFromParent = () => {
    controller.abort(parent.reason)
  }

  if (parent.aborted) {
    abortFromParent()
  } else {
    parent.addEventListener("abort", abortFromParent, { once: true })
  }

  const timer = setTimeout(() => {
    timedOut = true
    controller.abort(new DOMException("The operation timed out", "TimeoutError"))
  }, timeoutMs)

  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    dispose() {
      clearTimeout(timer)
      parent.removeEventListener("abort", abortFromParent)
    },
  }
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException("The operation was aborted", "AbortError")
  }
}

export function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  throwIfAborted(signal)

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, milliseconds)

    const onAbort = () => {
      clearTimeout(timer)
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new DOMException("The operation was aborted", "AbortError"),
      )
    }

    signal.addEventListener("abort", onAbort, { once: true })
  })
}

export function isAbortError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  )
}

export function abortablePromise<Value>(
  promise: PromiseLike<Value>,
  signal: AbortSignal,
): Promise<Value> {
  throwIfAborted(signal)

  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      signal.removeEventListener("abort", onAbort)
      callback()
    }
    const onAbort = () => {
      finish(() =>
        reject(
          signal.reason instanceof Error
            ? signal.reason
            : new DOMException("The operation was aborted", "AbortError"),
        ),
      )
    }

    signal.addEventListener("abort", onAbort, { once: true })
    void Promise.resolve(promise).then(
      (value) => finish(() => resolve(value)),
      (error: unknown) =>
        finish(() =>
          reject(
            error instanceof Error
              ? error
              : new Error("The asynchronous operation failed.", { cause: error }),
          ),
        ),
    )
  })
}

type StreamReadResult<Value> = Awaited<
  ReturnType<ReadableStreamDefaultReader<Value>["read"]>
>

export function abortableStreamRead<Value>(
  reader: ReadableStreamDefaultReader<Value>,
  signal: AbortSignal,
): Promise<StreamReadResult<Value>> {
  throwIfAborted(signal)

  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (
      callback: () => void,
    ) => {
      if (settled) return
      settled = true
      signal.removeEventListener("abort", onAbort)
      callback()
    }
    const onAbort = () => {
      finish(() => {
        void reader.cancel(signal.reason).catch(() => undefined)
        reject(
          signal.reason instanceof Error
            ? signal.reason
            : new DOMException("The operation was aborted", "AbortError"),
        )
      })
    }

    signal.addEventListener("abort", onAbort, { once: true })
    void reader.read().then(
      (result) => finish(() => resolve(result)),
      (error: unknown) =>
        finish(() =>
          reject(
            error instanceof Error
              ? error
              : new Error("The response stream failed.", { cause: error }),
          ),
        ),
    )
  })
}
