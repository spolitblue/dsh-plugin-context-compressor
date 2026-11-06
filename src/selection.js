/**
 * Pure surface-range selection for in-turn context compression.
 *
 * The shipped automatic backend decides *when* to condense; this module decides
 * *what* a model-requested compression may touch. It is deliberately free of
 * Harness imports so it can be unit-tested without a live session: the caller
 * supplies the surface sequence, the priced nodes, and the two boundary
 * predicates.
 *
 * The retention policy intentionally mirrors the shipped backend so a manual
 * compression and an automatic one agree on where a safe cut lives:
 *
 *  - a `system/message` at surface position 0 is never inside the range;
 *  - the newest tail worth `retainTokens` is kept verbatim;
 *  - the cut never splits a step's assistant tool-call / tool-result pair.
 *
 * @module dsh-plugin-context-compressor/selection
 */

/** The exact reason no range could be selected, for a model-facing report. */
export const NO_RANGE = 'no-safe-range'
/** The measured surface did not line up with the session surface. */
export const SURFACE_MISMATCH = 'surface-mismatch'

/**
 * Price one measured surface node.
 *
 * `tokens` is the route-priced value and `heuristicTokens` the route-independent
 * fallback; a node carrying neither is priced at zero rather than rejected, so a
 * partially populated measurement degrades into a conservative range.
 *
 * The result is rounded to a whole token. The heuristic estimator and the route
 * prices are whole numbers already, but every downstream field is declared as an
 * integer on the tool schemas, so rounding here keeps a single source of truth
 * rather than repeating the guard at each schema boundary.
 * @param node - One entry of `ctx.tokenMeter.measure()` `nodes`.
 * @returns The non-negative whole-token price of that node.
 */
export function nodeTokens(node) {
  const priced = Number(node?.tokens)
  if (Number.isFinite(priced) && priced >= 0) return Math.round(priced)
  const heuristic = Number(node?.heuristicTokens)
  if (Number.isFinite(heuristic) && heuristic >= 0) return Math.round(heuristic)
  return 0
}

/**
 * Whether the measured nodes describe exactly the current session surface.
 * @param seqs - Current surface event sequences, in order.
 * @param nodes - Measured nodes, expected to align positionally with `seqs`.
 * @returns True when both describe the same positions in the same order.
 */
export function isAligned(seqs, nodes) {
  if (!Array.isArray(seqs) || !Array.isArray(nodes)) return false
  if (seqs.length !== nodes.length) return false
  return seqs.every((seq, index) => nodes[index]?.seq === seq)
}

/**
 * Select the oldest compactable span of the conversation surface.
 * @param input - Selection inputs.
 * @param input.seqs - Surface event sequences in surface order.
 * @param input.nodes - Measured nodes aligned positionally with `seqs`.
 * @param input.retainTokens - Minimum recent tail kept verbatim, in tokens.
 * @param input.isSystemHead - Predicate: is this sequence a `system/message`?
 * @param input.isBalancedBefore - Predicate: is the cut immediately before this sequence tool-pairing balanced?
 * @returns The inclusive span to replace, or `null` when no safe useful span exists.
 */
export function selectCompactableRange(input) {
  const { seqs, nodes, retainTokens, isSystemHead, isBalancedBefore } = input
  if (!isAligned(seqs, nodes)) return null
  if (seqs.length === 0) return null

  // A leading system prompt is never condensed: compaction shrinks derived
  // history, not the envelope that carries instructions and tools.
  const firstIdx = isSystemHead(seqs[0]) ? 1 : 0
  if (firstIdx >= seqs.length) return null

  const budget = Number.isFinite(retainTokens) && retainTokens > 0 ? retainTokens : 0
  let accumulated = 0
  let keepFromIdx = seqs.length
  for (let index = seqs.length - 1; index >= 0; index -= 1) {
    accumulated += nodeTokens(nodes[index])
    keepFromIdx = index
    if (accumulated >= budget) break
  }
  if (keepFromIdx <= firstIdx) return null

  // Walk the cut earlier until it lands on a boundary that cannot split a step.
  while (keepFromIdx > firstIdx) {
    if (isBalancedBefore(seqs[keepFromIdx])) break
    keepFromIdx -= 1
  }
  if (keepFromIdx <= firstIdx) return null

  const endIdx = keepFromIdx - 1
  const shadowed = nodes.slice(firstIdx, endIdx + 1)
  const retained = nodes.slice(keepFromIdx)
  return {
    start: seqs[firstIdx],
    end: seqs[endIdx],
    startIdx: firstIdx,
    endIdx,
    shadowedSeqs: seqs.slice(firstIdx, endIdx + 1),
    shadowedItems: shadowed.length,
    shadowedTokens: shadowed.reduce((total, node) => total + nodeTokens(node), 0),
    retainedItems: retained.length,
    retainedTokens: retained.reduce((total, node) => total + nodeTokens(node), 0),
  }
}
