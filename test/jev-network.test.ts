import { afterEach, describe, expect, it, vi } from 'vitest'
import { classifyWithJev } from '../lib/jev.js'

const cfg = {
  enabled: true,
  model: 'jev-latest',
  maxPromptChars: 1000,
  maxRequestBytes: 32 * 1024,
  maxResponseBytes: 64 * 1024,
  timeoutMs: 25_000,
}

function okResolver(value: string | undefined) {
  return { resolve: async () => ({ value }) }
}

afterEach(() => vi.useRealTimers())

describe('classifyWithJev network', () => {
  it('missing/blank key → missing-ref', async () => {
    expect(await classifyWithJev(cfg, 'task', { a: 'd' }, undefined, { credentials: undefined }))
      .toEqual({ status: 'noChange', reason: 'missing-ref' })
    expect(await classifyWithJev(cfg, 'task', { a: 'd' }, undefined, { credentials: okResolver('') }))
      .toEqual({ status: 'noChange', reason: 'missing-ref' })
    expect(await classifyWithJev(cfg, 'task', { a: 'd' }, undefined, { credentials: okResolver('   ') }))
      .toEqual({ status: 'noChange', reason: 'missing-ref' })
  })

  it('request body over budget → request-budget-exceeded', async () => {
    const out = await classifyWithJev({ ...cfg, maxRequestBytes: 10 }, 'a'.repeat(1000), { a: 'd' }, undefined, { credentials: okResolver('k') })
    expect(out).toEqual({ status: 'noChange', reason: 'request-budget-exceeded' })
  })

  it('hanging resolver → timeout (deadline covers credential wait)', async () => {
    const never = { resolve: () => new Promise<{ value?: string }>(() => {}) }
    const out = await classifyWithJev({ ...cfg, timeoutMs: 20 }, 'task', { a: 'd' }, undefined, { credentials: never })
    expect(out).toEqual({ status: 'noChange', reason: 'timeout' })
  })

  it('late resolve after caller cancel → cancelled, no fetch', async () => {
    const ac = new AbortController()
    let release: ((v: { value?: string }) => void) | undefined
    const slow = { resolve: () => new Promise<{ value?: string }>((res) => { release = res }) }
    const fetchImpl = vi.fn<typeof fetch>()
    const p = classifyWithJev(cfg, 'task', { a: 'd' }, ac.signal, { credentials: slow, fetchImpl })
    ac.abort(new Error('user cancel'))
    release!({ value: 'k' })
    expect(await p).toEqual({ status: 'noChange', reason: 'cancelled' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('hung streaming response body → timeout', async () => {
    const hung = new Response(new ReadableStream({ start() { /* never enqueue */ } }), { status: 200 })
    const fetchImpl = async () => hung
    const out = await classifyWithJev({ ...cfg, timeoutMs: 20 }, 'task', { a: 'd' }, undefined, { credentials: okResolver('k'), fetchImpl })
    expect(out).toEqual({ status: 'noChange', reason: 'timeout' })
  })

  it('oversized body without Content-Length → bad-response', async () => {
    const big = new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify({ answers: { model: { choice: 'a' } } }) + ' '.repeat(1024))); controller.close() },
    }), { status: 200 })
    const fetchImpl = async () => big
    const out = await classifyWithJev({ ...cfg, maxResponseBytes: 16 }, 'task', { a: 'd' }, undefined, { credentials: okResolver('k'), fetchImpl })
    expect(out).toEqual({ status: 'noChange', reason: 'bad-response' })
  })

  it('ok response → ok with choice and confidence', async () => {
    const body = JSON.stringify({ answers: { model: { choice: 'a', confidence: 0.8 } } })
    const resp = new Response(body, { status: 200 })
    const fetchImpl = async () => resp
    expect(await classifyWithJev(cfg, 'task', { a: 'd' }, undefined, { credentials: okResolver('k'), fetchImpl }))
      .toEqual({ status: 'ok', choice: 'a', confidence: 0.8 })
  })

  it('redirect:error rejects a redirect (no follow)', async () => {
    const redirecting = new Response(null, { status: 302, headers: { location: 'https://evil.example/' } })
    const fetchImpl = async () => redirecting
    // fetch with redirect:'error' would throw on a real redirect; here the stub
    // returns a 302 which we treat as bad-response.
    expect(await classifyWithJev(cfg, 'task', { a: 'd' }, undefined, { credentials: okResolver('k'), fetchImpl }))
      .toEqual({ status: 'noChange', reason: 'bad-response', httpStatus: 302 })
  })
})
