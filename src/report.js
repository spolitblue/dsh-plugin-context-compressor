/**
 * Pure reporting helpers for the context-compression tools.
 *
 * Everything here turns already-measured plain data into the value a tool
 * returns and the text the model reads. No Harness import, no I/O, so the
 * model-facing wording and the arithmetic are both unit-testable.
 *
 * @module dsh-plugin-context-compressor/report
 */

import { nodeTokens } from './selection.js'

/** Reason codes shared by both tools. */
export const REASON = {
  ok: 'ok',
  compacted: 'compacted',
  dryRun: 'dry-run',
  noSafeRange: 'no-safe-range',
  belowMinimum: 'below-minimum',
  surfaceMismatch: 'surface-mismatch',
  noBackend: 'no-backend',
  busy: 'busy',
  failed: 'failed',
}

/**
 * Insert thousands separators without depending on the process locale.
 * @param value - A finite number.
 * @returns The decimal string with `,` group separators.
 */
export function formatCount(value) {
  const numeric = Number.isFinite(value) ? Math.round(value) : 0
  const negative = numeric < 0
  const digits = String(Math.abs(numeric))
  let grouped = ''
  for (let index = 0; index < digits.length; index += 1) {
    if (index > 0 && (digits.length - index) % 3 === 0) grouped += ','
    grouped += digits[index]
  }
  return negative ? `-${grouped}` : grouped
}

/**
 * Fold priced surface entries into the composition report a model reads.
 * @param entries - One `{ seq, kind, tokens }` record per surface position, in surface order.
 * @param options - Report options.
 * @param options.maxNodes - Maximum node rows to list; the newest and oldest rows are kept.
 * @returns A plain report value: totals plus an optional capped node list.
 */
export function buildContextReport(entries, options = {}) {
  const maxNodes = Number.isFinite(options.maxNodes) && options.maxNodes >= 2 ? Math.floor(options.maxNodes) : 60
  const rows = Array.isArray(entries) ? entries : []
  let systemTokens = 0
  let messageTokens = 0
  for (const row of rows) {
    const price = nodeTokens({ heuristicTokens: row.tokens })
    if (row.kind === 'system') systemTokens += price
    else messageTokens += price
  }
  const truncated = rows.length > maxNodes
  const listed = truncated
    ? [...rows.slice(0, 1), ...rows.slice(rows.length - (maxNodes - 1))]
    : rows
  return {
    surfaceTokens: systemTokens + messageTokens,
    systemTokens,
    messageTokens,
    nodeCount: rows.length,
    listedNodes: listed.map(row => ({ seq: row.seq, kind: row.kind, tokens: row.tokens })),
    omittedNodes: rows.length - listed.length,
  }
}

/**
 * Render the model-facing text for a `context_status` value.
 * @param value - The canonical `context_status` value.
 * @returns The text the model reads.
 */
export function renderContextStatus(value) {
  const lines = [
    `Context: ${formatCount(value.surfaceTokens)} tokens across ${formatCount(value.nodeCount)} surface items`
    + ` (system ${formatCount(value.systemTokens)} + messages ${formatCount(value.messageTokens)}).`,
    `Compaction backend: ${value.compactionBackend === 'available' ? 'available' : 'NOT AVAILABLE'}.`,
  ]
  if (value.compressible) {
    lines.push(
      `Compressible now: ${formatCount(value.shadowedItems)} items (~${formatCount(value.shadowedTokens)} tokens)`
      + ` can be replaced by one summary, keeping the newest ${formatCount(value.retainedItems)} items`
      + ` (~${formatCount(value.retainedTokens)} tokens) verbatim (surface seqs ${value.startSeq}-${value.endSeq}).`,
    )
  } else {
    lines.push(`Nothing is compressible right now (${value.reason}): ${explainStatus(value.reason)}`)
  }
  if (value.listedNodes !== undefined) {
    lines.push('Surface, oldest first (seq: kind ~tokens):')
    for (const node of value.listedNodes) {
      lines.push(`  ${node.seq}: ${node.kind} ~${formatCount(node.tokens)}`)
    }
    if (value.omittedNodes > 0) lines.push(`  ... ${formatCount(value.omittedNodes)} older/middle items omitted.`)
  }
  return lines.join('\n')
}

/**
 * Explain a status reason code in one clause.
 * @param reason - A `context_status` reason code.
 * @returns A short human-readable explanation.
 */
function explainStatus(reason) {
  switch (reason) {
    case REASON.noBackend:
      return 'no compaction backend is mounted in this profile, so history cannot be condensed.'
    case REASON.surfaceMismatch:
      return 'the token measurement did not line up with the session surface; retry.'
    case REASON.noSafeRange:
      return 'the retained recent tail already covers every item that may be condensed.'
    /* v8 ignore next 2 -- unknown codes are surfaced verbatim rather than thrown */
    default:
      return 'the measured surface offers no safe cut.'
  }
}

/**
 * Render the model-facing text for a `context_compress` value.
 * @param value - The canonical `context_compress` value.
 * @returns The text the model reads.
 */
export function renderCompressOutcome(value) {
  switch (value.reason) {
    case REASON.compacted:
      return `Compressed ${formatCount(value.shadowedItems)} history items (~${formatCount(value.shadowedTokens)} tokens)`
        + ` into one summary checkpoint${value.summarySeq === null ? '' : ` (seq ${value.summarySeq})`}.`
        + ` The conversation surface is now ~${formatCount(value.remainingSurfaceTokens ?? value.retainedTokens)} tokens.`
    case REASON.dryRun:
      return `Dry run: ${formatCount(value.shadowedItems)} items (~${formatCount(value.shadowedTokens)} tokens)`
        + ` would become one summary, keeping the newest ${formatCount(value.retainedItems)} items`
        + ` (~${formatCount(value.retainedTokens)} tokens) verbatim.`
    case REASON.belowMinimum:
      return `Nothing was compacted (below-minimum): the largest safe span is only ~${formatCount(value.shadowedTokens)} tokens,`
        + ` under the configured minimum.`
    case REASON.busy:
      return `Nothing was compacted (busy): another compaction is already running for this session.`
    case REASON.noBackend:
      return 'Nothing was compacted (no-backend): no compaction backend is mounted in this profile.'
    case REASON.surfaceMismatch:
      return 'Nothing was compacted (surface-mismatch): the token measurement did not line up with the session surface; retry.'
    case REASON.noSafeRange:
      return 'Nothing was compacted (no-safe-range): the retained recent tail already covers every item that may be condensed.'
    case REASON.failed:
      return `Compression failed before it committed: ${value.error ?? 'unknown error'}`
    /* v8 ignore next 2 -- unknown codes are surfaced verbatim rather than thrown */
    default:
      return `Nothing was compacted (${value.reason}).`
  }
}
