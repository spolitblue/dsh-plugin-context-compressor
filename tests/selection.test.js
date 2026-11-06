/**
 * Unit tests for the pure compression-range selector.
 *
 * These run without a Harness session: the surface, its prices, and the
 * tool-pairing predicate are all supplied as plain data, so the retention and
 * boundary rules that make an in-turn compression legal are pinned down here.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { isAligned, nodeTokens, selectCompactableRange } from '../src/selection.js'

/**
 * Build a selector input from compact shorthand.
 * @param seqs - Surface sequences.
 * @param tokens - Token price per position.
 * @param overrides - Extra input overrides.
 * @returns A complete selector input.
 */
function input(seqs, tokens, overrides = {}) {
  return {
    seqs,
    nodes: seqs.map((seq, index) => ({ seq, tokens: tokens[index] })),
    retainTokens: 0,
    isSystemHead: () => false,
    isBalancedBefore: () => true,
    ...overrides,
  }
}

test('nodeTokens prefers the route price and falls back to the heuristic', () => {
  assert.equal(nodeTokens({ tokens: 12, heuristicTokens: 99 }), 12)
  assert.equal(nodeTokens({ heuristicTokens: 7 }), 7)
  assert.equal(nodeTokens({}), 0)
  assert.equal(nodeTokens(undefined), 0)
  assert.equal(nodeTokens({ tokens: -5, heuristicTokens: 3 }), 3)
})

test('nodeTokens rounds a fractional price to a whole token', () => {
  assert.equal(nodeTokens({ tokens: 10.4 }), 10)
  assert.equal(nodeTokens({ tokens: 10.6 }), 11)
})

test('isAligned requires positional agreement', () => {
  const nodes = [{ seq: 1 }, { seq: 2 }]
  assert.equal(isAligned([1, 2], nodes), true)
  assert.equal(isAligned([1], nodes), false)
  assert.equal(isAligned([1, 3], nodes), false)
  assert.equal(isAligned([2, 1], nodes), false)
})

test('returns null for an empty surface', () => {
  assert.equal(selectCompactableRange(input([], [])), null)
})

test('returns null when the measurement does not match the surface', () => {
  const seqs = [1, 2, 3]
  const mismatched = { ...input(seqs, [10, 10, 10]), nodes: [{ seq: 2, tokens: 10 }, { seq: 3, tokens: 10 }] }
  assert.equal(selectCompactableRange(mismatched), null)
})

test('never condenses a leading system message', () => {
  const range = selectCompactableRange(input([0, 1, 2, 3], [5000, 10, 10, 10], {
    isSystemHead: seq => seq === 0,
  }))
  assert.equal(range.start, 1)
  assert.equal(range.shadowedSeqs.includes(0), false)
})

test('returns null when only a system message is on the surface', () => {
  assert.equal(selectCompactableRange(input([0], [5000], {
    isSystemHead: seq => seq === 0,
  })), null)
})

test('keeps a recent tail worth the retention budget', () => {
  const range = selectCompactableRange(input([0, 1, 2, 3, 4], [100, 100, 100, 100, 400], {
    retainTokens: 500,
  }))
  // Accumulating from the tail: 400 (<500) then 400+100 >= 500, so the newest two nodes stay.
  assert.equal(range.end, 2)
  assert.deepEqual(range.shadowedSeqs, [0, 1, 2])
  assert.equal(range.retainedItems, 2)
  assert.equal(range.retainedTokens, 500)
  assert.equal(range.shadowedTokens, 300)
})

test('walks the cut back so a tool call is never split from its result', () => {
  // Cut before 3 is unbalanced: 2 is an assistant message whose tool call is
  // answered by 3. The selector must retreat to the cut before 2.
  const seqs = [0, 1, 2, 3, 4, 5]
  const tokens = [1000, 100, 200, 300, 400, 500]
  const range = selectCompactableRange(input(seqs, tokens, {
    retainTokens: 1200,
    isSystemHead: seq => seq === 0,
    isBalancedBefore: seq => seq !== 3,
  }))
  assert.equal(range.end, 1)
  assert.deepEqual(range.shadowedSeqs, [1])
  assert.equal(range.start, 1)
  assert.equal(range.endIdx, 1)
  assert.equal(range.retainedItems, 4)
  assert.equal(range.retainedTokens, 1400)
})

test('returns null when the retained tail already covers the whole surface', () => {
  assert.equal(selectCompactableRange(input([0, 1, 2], [100, 100, 100], {
    retainTokens: 10000,
  })), null)
})

test('returns null when every candidate cut sits inside a tool pair', () => {
  // Nothing but the cut before 0 is balanced, and 0 cannot be condensed.
  const range = selectCompactableRange(input([0, 1, 2], [1000, 100, 100], {
    retainTokens: 50,
    isSystemHead: seq => seq === 0,
    isBalancedBefore: seq => seq === 0,
  }))
  assert.equal(range, null)
})

test('a zero retention budget still keeps the newest node', () => {
  const range = selectCompactableRange(input([0, 1, 2], [10, 20, 30], { retainTokens: 0 }))
  assert.equal(range.end, 1)
  assert.equal(range.retainedItems, 1)
  assert.equal(range.retainedTokens, 30)
})
