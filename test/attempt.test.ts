import { describe, expect, it } from 'vitest'
import { emittedModelContent, extractUserTaskText } from '../lib/attempt.js'

describe('emittedModelContent (zero-output gate)', () => {
  it('allows only usage and finish', () => {
    expect(emittedModelContent({ type: 'usage' })).toBe(false)
    expect(emittedModelContent({ type: 'finish' })).toBe(false)
  })
  it('denies text and reasoning deltas (reasoning IS output)', () => {
    expect(emittedModelContent({ type: 'text-delta', text: '' })).toBe(true)
    expect(emittedModelContent({ type: 'text-delta', text: 'x' })).toBe(true)
    expect(emittedModelContent({ type: 'reasoning-delta', text: 'x' })).toBe(true)
  })
  it('denies tool-call deltas', () => {
    expect(emittedModelContent({ type: 'tool-call-delta', argumentsDelta: '{}', name: 'f' })).toBe(true)
    expect(emittedModelContent({ type: 'tool-call-delta' })).toBe(true)
  })
  it('denies block-start and block-end', () => {
    expect(emittedModelContent({ type: 'block-start', blockType: 'text' })).toBe(true)
    expect(emittedModelContent({ type: 'block-end' })).toBe(true)
  })
  it('denies unknown chunk types (fail closed)', () => {
    expect(emittedModelContent({ type: 'surprise' })).toBe(true)
  })
})

describe('extractUserTaskText (Jev current-task minimization)', () => {
  const user = (text: string) => ({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
  const notice = (text: string) => ({ source: { kind: 'model-selection', form: 'notice', summary: text }, content: [{ type: 'text', text }] })
  const tool = (text: string) => ({ source: { kind: 'tool', callId: 'c' }, content: [{ type: 'text', text }] })
  const relay = (text: string) => ({ source: { kind: 'subagent', form: 'relay' }, content: [{ type: 'text', text }] })

  it('extracts only genuine user-authored text', () => {
    expect(extractUserTaskText([user('do task A'), notice('provider switch x → y')])).toBe('do task A')
  })

  it('returns empty for control/delivery/system/tool messages (never leaks their text)', () => {
    expect(extractUserTaskText([notice('provider switch x → y')])).toBe('')
    expect(extractUserTaskText([tool('tool result payload')])).toBe('')
    expect(extractUserTaskText([relay('child output/code')])).toBe('')
    expect(extractUserTaskText([{ source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'sys' }] }])).toBe('')
  })

  it('concatenates multiple user text blocks but ignores non-text blocks', () => {
    expect(extractUserTaskText([
      { source: { kind: 'user' }, content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }, { type: 'image', attachment: {} }] },
    ])).toBe('a\nb')
  })

  it('ignores unknown producer kinds (fail closed on source)', () => {
    expect(extractUserTaskText([{ source: { kind: 'surprise' }, content: [{ type: 'text', text: 'x' }] }])).toBe('')
  })
})
