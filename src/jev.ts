import type { JevConfig } from './types.js'

/**
 * Optional bounded Jev (TypeSafe System One) advisory classifier.
 *
 * Per the owner-authorized security addendum: fixed official origin/path, no
 * redirects, dedicated host credential reference only, bounded request/response
 * bytes, linked hard timeout (covering credential wait through body read), and
 * no raw body/error logging. Failure modes are fixed reason codes only.
 */

export const JEV_ORIGIN = 'https://api.typesafe.ai'
export const JEV_PATH = '/v1/systemone'
export const JEV_DEDICATED_REF = 'TYPESAFE_API_KEY'

export type JevReason =
  | 'missing-ref'
  | 'input-budget-exceeded'
  | 'request-budget-exceeded'
  | 'timeout'
  | 'cancelled'
  | 'bad-response'
  | 'unavailable'

export type JevOutcome =
  | { status: 'ok'; choice: string; confidence?: number }
  | { status: 'noChange'; reason: JevReason; httpStatus?: number }

/** Build the native decision body (choice question only; no orchestrate/noul). */
export function buildJevRequestBody(model: string, state: string, criteria: Record<string, string>): string {
  return JSON.stringify({
    model,
    state,
    questions: {
      model: { type: 'choice', instructions: 'Which model should run the next step?', criteria },
    },
  })
}

/** Parse a decision reply (answers envelope or bare map). Out-of-set/NaN ⇒ null. */
export function parseJevResponse(raw: unknown, allowed: ReadonlySet<string>): { choice: string; confidence?: number } | null {
  try {
    if (raw === null || typeof raw !== 'object') return null
    const record = raw as Record<string, unknown>
    const answers = record.answers !== null && typeof record.answers === 'object'
      ? record.answers as Record<string, unknown>
      : record
    const modelAnswer = answers.model
    if (modelAnswer === null || typeof modelAnswer !== 'object') return null
    const m = modelAnswer as Record<string, unknown>
    const choice = typeof m.choice === 'string' ? m.choice : null
    if (choice === null || !allowed.has(choice)) return null
    const probabilities = m.probabilities
    const probability = probabilities !== null && typeof probabilities === 'object'
      ? (probabilities as Record<string, unknown>)[choice]
      : undefined
    const rawConfidence = typeof probability === 'number' ? probability
      : typeof m.confidence === 'number' ? m.confidence : undefined
    const confidence = rawConfidence !== undefined && Number.isFinite(rawConfidence) && rawConfidence >= 0 && rawConfidence <= 1
      ? rawConfidence
      : undefined
    return { choice, ...(confidence !== undefined ? { confidence } : {}) }
  } catch {
    return null
  }
}

interface CredentialResolver {
  resolve(ref: unknown): Promise<{ value?: string } | undefined>
}

export interface JevNetworkDeps {
  credentials: CredentialResolver | undefined
  fetchImpl?: typeof fetch
}

function byteLength(s: string): number {
  return new TextEncoder().encode(s).byteLength
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException('aborted', 'AbortError')
}

/** Race a promise against a signal; `onAbort` performs best-effort cancellation. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal, onAbort: () => void): Promise<T> {
  if (signal.aborted) {
    onAbort()
    return Promise.reject(abortReason(signal))
  }
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      onAbort()
      reject(abortReason(signal))
    }
    signal.addEventListener('abort', abort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', abort)
        reject(error)
      },
    )
  })
}

async function readBodyWithCap(response: Response, cap: number, signal: AbortSignal): Promise<Uint8Array | 'overflow'> {
  if (response.body === null) return new Uint8Array(0)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const result = await raceAbort(reader.read(), signal, () => {
        void reader.cancel('cancelled').catch(() => {
          /* @silent-catch: reader cancel is best-effort cleanup; outcome already decided */
        })
      })
      if (result.done) break
      if (result.value !== undefined) {
        total += result.value.byteLength
        if (total > cap) {
          await raceAbort(reader.cancel('response-overflow'), signal, () => {}).catch(() => {
            /* @silent-catch: cancel cleanup is best-effort; overflow is the outcome */
          })
          return 'overflow'
        }
        chunks.push(result.value)
      }
    }
    const out = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      out.set(chunk, offset)
      offset += chunk.byteLength
    }
    return out
  } finally {
    try {
      reader.releaseLock()
    } catch {
      /* @silent-catch: releaseLock throws when already released/closed; cleanup only */
    }
  }
}

/**
 * One advisory Jev call. Returns noChange on any failure; never throws.
 * The dedicated credential value stays in memory for this single call.
 */
export async function classifyWithJev(
  config: JevConfig,
  boundedTask: string,
  criteria: Record<string, string>,
  signal: AbortSignal | undefined,
  deps: JevNetworkDeps,
): Promise<JevOutcome> {
  if (!config.enabled) return { status: 'noChange', reason: 'unavailable' }

  // Owner addendum: never silently truncate the task synopsis. Oversize skips.
  if (boundedTask.length > config.maxPromptChars) {
    return { status: 'noChange', reason: 'input-budget-exceeded' }
  }

  const requestBody = buildJevRequestBody(config.model, boundedTask, criteria)
  if (byteLength(requestBody) > config.maxRequestBytes) {
    return { status: 'noChange', reason: 'request-budget-exceeded' }
  }

  const credentials = deps.credentials
  if (!credentials) return { status: 'noChange', reason: 'missing-ref' }

  // Link caller cancellation + owned hard deadline BEFORE any await (covers the
  // credential wait, request headers, body read, and parse).
  const linked = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(config.timeoutMs)])

  let resolved: { value?: string } | undefined
  try {
    resolved = await raceAbort(credentials.resolve(JEV_DEDICATED_REF), linked, () => {})
  } catch {
    return { status: 'noChange', reason: signal?.aborted ? 'cancelled' : 'timeout' }
  }
  const key = resolved?.value
  if (key === undefined || key === null || key.trim() === '') {
    return { status: 'noChange', reason: 'missing-ref' }
  }
  // Discard late resolution: no network after cancellation/timeout.
  if (linked.aborted) return { status: 'noChange', reason: signal?.aborted ? 'cancelled' : 'timeout' }

  const fetchImpl = deps.fetchImpl ?? fetch

  let response: Response
  try {
    response = await fetchImpl(`${JEV_ORIGIN}${JEV_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
      },
      body: requestBody,
      redirect: 'error',
      signal: linked,
    })
  } catch {
    if (linked.aborted) return { status: 'noChange', reason: signal?.aborted ? 'cancelled' : 'timeout' }
    return { status: 'noChange', reason: 'unavailable' }
  }

  let bodyBytes: Uint8Array | 'overflow'
  try {
    bodyBytes = await readBodyWithCap(response, config.maxResponseBytes, linked)
  } catch {
    return { status: 'noChange', reason: linked.aborted && !signal?.aborted ? 'timeout' : 'cancelled' }
  }
  if (bodyBytes === 'overflow') return { status: 'noChange', reason: 'bad-response' }
  if (!response.ok) return { status: 'noChange', reason: 'bad-response', httpStatus: response.status }

  const allowed = new Set(Object.keys(criteria))
  let parsed: { choice: string; confidence?: number } | null = null
  try {
    parsed = parseJevResponse(JSON.parse(new TextDecoder().decode(bodyBytes)), allowed)
  } catch {
    return { status: 'noChange', reason: 'bad-response' }
  }
  if (parsed === null) return { status: 'noChange', reason: 'bad-response' }
  // Final lifetime recheck: never accept a parsed choice after cancel/timeout.
  if (linked.aborted) return { status: 'noChange', reason: signal?.aborted ? 'cancelled' : 'timeout' }

  return { status: 'ok', choice: parsed.choice, ...(parsed.confidence !== undefined ? { confidence: parsed.confidence } : {}) }
}
