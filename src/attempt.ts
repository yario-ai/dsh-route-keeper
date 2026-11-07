import type { StreamChunk } from './types.js'

/**
 * Whether one stream chunk represents model output for the zero-output gate.
 *
 * Deliberately stricter than the host `isVisibleChunk`: reasoning IS output,
 * tool-call block-start/delta/end IS output, and any chunk type outside the
 * non-content allowlist {usage, finish} is treated as output (unknown
 * model-content representation ⇒ deny). Only usage/finish pass.
 */
export function emittedModelContent(chunk: StreamChunk): boolean {
  return chunk.type !== 'usage' && chunk.type !== 'finish'
}

/** Opaque attempt correlation key for one step. */
export function attemptKey(turn: number, step: number): string {
  return `${turn}:${step}`
}

/**
 * Bounded current-task synopsis from genuine user-authored input only.
 *
 * Only messages whose source kind is `user` contribute. Model-selection
 * continuation notices (`kind: 'model-selection'`, `form: 'notice'`), tool
 * results, system prompt, assistant output, and child/relay deliveries never
 * replace the user's task, so an automatic continuation or an empty claimed
 * step leaves the previous goal intact instead of feeding machine-control text
 * to the optional Jev classifier.
 */
export function extractUserTaskText(messages: ReadonlyArray<{ source?: { kind?: string }; content?: ReadonlyArray<{ type?: string; text?: string }> }>): string {
  let out = ''
  for (const message of messages) {
    if (message.source?.kind !== 'user') continue
    for (const block of message.content ?? []) {
      if (block.type === 'text' && typeof block.text === 'string') out += block.text + '\n'
    }
  }
  return out.trim()
}
