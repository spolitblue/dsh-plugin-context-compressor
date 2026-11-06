/**
 * Unit tests for the pure reporting layer: composition arithmetic, the capped
 * surface listing, and the model-facing wording of both tools.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { buildContextReport, formatCount, REASON, renderCompressOutcome, renderContextStatus } from '../src/report.js'

/** Seven surfaced rows with a leading system message. */
const rows = [
  { seq: 0, kind: 'system', tokens: 1000 },
  { seq: 1, kind: 'user', tokens: 100 },
  { seq: 2, kind: 'assistant', tokens: 200 },
  { seq: 3, kind: 'tool', tokens: 300 },
  { seq: 4, kind: 'assistant', tokens: 400 },
  { seq: 5, kind: 'user', tokens: 500 },
  { seq: 6, kind: 'assistant', tokens: 600 },
]

test('formatCount groups thousands without relying on the process locale', () => {
  assert.equal(formatCount(0), '0')
  assert.equal(formatCount(999), '999')
  assert.equal(formatCount(1000), '1,000')
  assert.equal(formatCount(1234567), '1,234,567')
  assert.equal(formatCount(10.6), '11')
  assert.equal(formatCount(Number.NaN), '0')
})

test('buildContextReport splits system from messages and totals them', () => {
  const report = buildContextReport(rows)
  assert.equal(report.systemTokens, 1000)
  assert.equal(report.messageTokens, 2100)
  assert.equal(report.surfaceTokens, 3100)
  assert.equal(report.nodeCount, 7)
  assert.equal(report.omittedNodes, 0)
  assert.equal(report.listedNodes.length, 7)
})

test('buildContextReport caps the listing while keeping the oldest and newest rows', () => {
  const report = buildContextReport(rows, { maxNodes: 4 })
  assert.equal(report.nodeCount, 7)
  assert.equal(report.listedNodes.length, 4)
  assert.equal(report.omittedNodes, 3)
  assert.deepEqual(report.listedNodes.map(node => node.seq), [0, 4, 5, 6])
})

test('buildContextReport treats a malformed entry list as empty', () => {
  const report = buildContextReport(undefined)
  assert.equal(report.nodeCount, 0)
  assert.equal(report.surfaceTokens, 0)
})

test('renderContextStatus describes a compressible surface', () => {
  const text = renderContextStatus({
    surfaceTokens: 3100,
    systemTokens: 1000,
    messageTokens: 2100,
    nodeCount: 7,
    compactionBackend: 'available',
    compressible: true,
    reason: REASON.ok,
    shadowedItems: 4,
    shadowedTokens: 1000,
    retainedItems: 3,
    retainedTokens: 2100,
    startSeq: 1,
    endSeq: 4,
  })
  assert.match(text, /Context: 3,100 tokens across 7 surface items \(system 1,000 \+ messages 2,100\)\./)
  assert.match(text, /Compaction backend: available\./)
  assert.match(text, /Compressible now: 4 items \(~1,000 tokens\)/)
  assert.match(text, /surface seqs 1-4/)
})

test('renderContextStatus explains why nothing can be compressed', () => {
  const text = renderContextStatus({
    surfaceTokens: 100,
    systemTokens: 100,
    messageTokens: 0,
    nodeCount: 1,
    compactionBackend: 'unavailable',
    compressible: false,
    reason: REASON.noBackend,
    shadowedItems: 0,
    shadowedTokens: 0,
    retainedItems: 1,
    retainedTokens: 100,
    startSeq: null,
    endSeq: null,
  })
  assert.match(text, /Compaction backend: NOT AVAILABLE\./)
  assert.match(text, /Nothing is compressible right now \(no-backend\)/)
})

test('renderContextStatus lists surface nodes only when they were requested', () => {
  const base = {
    surfaceTokens: 100, systemTokens: 100, messageTokens: 0, nodeCount: 2,
    compactionBackend: 'available', compressible: true, reason: REASON.ok,
    shadowedItems: 1, shadowedTokens: 10, retainedItems: 1, retainedTokens: 90,
    startSeq: 1, endSeq: 1,
  }
  assert.doesNotMatch(renderContextStatus(base), /Surface, oldest first/)
  const listed = renderContextStatus({
    ...base,
    listedNodes: [{ seq: 1, kind: 'user', tokens: 10 }],
    omittedNodes: 4,
  })
  assert.match(listed, /Surface, oldest first/)
  assert.match(listed, /1: user ~10/)
  assert.match(listed, /4 older\/middle items omitted/)
})

test('renderCompressOutcome words every outcome', () => {
  const base = {
    compacted: false, shadowedItems: 4, shadowedTokens: 1000,
    retainedItems: 3, retainedTokens: 2100, remainingSurfaceTokens: null,
    summarySeq: null, error: null,
  }
  assert.match(
    renderCompressOutcome({ ...base, compacted: true, reason: REASON.compacted, summarySeq: 42, remainingSurfaceTokens: 2200 }),
    /Compressed 4 history items \(~1,000 tokens\) into one summary checkpoint \(seq 42\)\. The conversation surface is now ~2,200 tokens\./,
  )
  assert.match(renderCompressOutcome({ ...base, reason: REASON.dryRun }), /^Dry run: 4 items/)
  assert.match(renderCompressOutcome({ ...base, reason: REASON.belowMinimum }), /under the configured minimum/)
  assert.match(renderCompressOutcome({ ...base, reason: REASON.busy }), /another compaction is already running/)
  assert.match(renderCompressOutcome({ ...base, reason: REASON.noSafeRange }), /retained recent tail already covers/)
  assert.match(renderCompressOutcome({ ...base, reason: REASON.noBackend }), /no compaction backend is mounted/)
  assert.match(renderCompressOutcome({ ...base, reason: REASON.surfaceMismatch }), /did not line up/)
  assert.match(renderCompressOutcome({ ...base, reason: REASON.failed, error: 'boom' }), /Compression failed.*boom/)
})
