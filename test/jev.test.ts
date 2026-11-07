import { describe, expect, it } from 'vitest'
import { buildJevRequestBody, parseJevResponse, JEV_ORIGIN, JEV_PATH, JEV_DEDICATED_REF } from '../lib/jev.js'

describe('jev build/parse', () => {
  it('fixes the official origin and path', () => {
    expect(JEV_ORIGIN).toBe('https://api.typesafe.ai')
    expect(JEV_PATH).toBe('/v1/systemone')
    expect(JEV_DEDICATED_REF).toBe('TYPESAFE_API_KEY')
  })

  it('builds a choice-only request body', () => {
    const body = JSON.parse(buildJevRequestBody('jev-latest', 'task', { a: 'descA', b: 'descB' }))
    expect(body.model).toBe('jev-latest')
    expect(body.state).toBe('task')
    expect(body.questions.model.type).toBe('choice')
    expect(Object.keys(body.questions)).toEqual(['model'])
    expect(body.questions.model.criteria).toEqual({ a: 'descA', b: 'descB' })
  })

  it('parses answers envelope and bare map', () => {
    const allowed = new Set(['a', 'b'])
    expect(parseJevResponse({ answers: { model: { choice: 'a', confidence: 0.7 } } }, allowed)).toEqual({ choice: 'a', confidence: 0.7 })
    expect(parseJevResponse({ model: { choice: 'b' } }, allowed)).toEqual({ choice: 'b' })
  })

  it('rejects out-of-set and malformed choices', () => {
    const allowed = new Set(['a'])
    expect(parseJevResponse({ model: { choice: 'c' } }, allowed)).toBeNull()
    expect(parseJevResponse({ model: {} }, allowed)).toBeNull()
    expect(parseJevResponse(null, allowed)).toBeNull()
    expect(parseJevResponse('nope', allowed)).toBeNull()
  })

  it('drops non-finite or out-of-range confidence (1e309 ⇒ Infinity)', () => {
    const allowed = new Set(['a'])
    expect(parseJevResponse({ model: { choice: 'a', confidence: 1e309 } }, allowed)).toEqual({ choice: 'a' })
    expect(parseJevResponse({ model: { choice: 'a', confidence: -0.1 } }, allowed)).toEqual({ choice: 'a' })
    expect(parseJevResponse({ model: { choice: 'a', confidence: 1.1 } }, allowed)).toEqual({ choice: 'a' })
    expect(parseJevResponse({ model: { choice: 'a', probabilities: { a: 1e309 } } }, allowed)).toEqual({ choice: 'a' })
  })

  it('keeps finite in-range confidence', () => {
    const allowed = new Set(['a'])
    expect(parseJevResponse({ model: { choice: 'a', confidence: 0.55 } }, allowed)).toEqual({ choice: 'a', confidence: 0.55 })
  })
})
