/**
 * dsh-plugin-context-compressor — model-facing context compression for DeepSeek Harness.
 *
 * The shipped Harness already condenses a growing conversation automatically and
 * on demand through the human `/compact` command. What it does not offer is a way
 * for the model itself to notice context pressure and act on it, so a long
 * agentic task can only wait for the automatic step-pressure threshold.
 *
 * This plugin registers two model-facing tools:
 *
 *  - `context_status` measures the live conversation surface and reports how much
 *    of it could be condensed right now. Read-only and parallel-safe.
 *  - `context_compress` replaces the oldest safe span of the conversation with one
 *    summary checkpoint through the mounted `ctx.compaction` backend. Declared
 *    exclusive, so it never races another tool call for the same surface.
 *
 * Both go through the backend-independent compaction seam, so the plugin works
 * with any backend and never touches the session log itself. The span is chosen
 * with the same retention and tool-pairing rules the automatic path uses, which
 * is why a compression triggered from inside a turn is still a legal compaction.
 *
 * @module dsh-plugin-context-compressor
 */

import { toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { buildContextReport, REASON, renderCompressOutcome, renderContextStatus } from './src/report.js'
import { isAligned, nodeTokens, selectCompactableRange } from './src/selection.js'

export const name = 'context-compressor'
export const inject = ['tools', 'tokenMeter']

/** dsh-plugin-context-compressor plugin configuration. */
export const Config = z.object({
  /** Register the tools at all. Off leaves the plugin mounted but inert. */
  enabled: z.boolean().default(true),
  /** Default recent tail kept verbatim by `context_compress`, in tokens. */
  keepRecentTokens: z.number().default(20000),
  /**
   * Refuse a compression whose safe span is smaller than this, so the tool does
   * not spend a summary call to save a few hundred tokens.
   */
  minCompactTokens: z.number().default(2000),
  /** Row cap for the optional surface listing in a `context_status` result. */
  maxNodesListed: z.number().default(60),
})

/** Map a session event type onto the short kind used in reports. */
const SURFACE_KINDS = {
  'system/message': 'system',
  'user/message': 'user',
  'assistant/message': 'assistant',
  'tool/result': 'tool',
}

/**
 * Classify one surface event.
 * @param event - A session event, or undefined for a sequence outside the log.
 * @returns A short kind label.
 */
function kindOf(event) {
  const type = event?.type
  if (typeof type !== 'string') return 'unknown'
  return SURFACE_KINDS[type] ?? type
}

/**
 * Read the current conversation surface together with its token measurement.
 *
 * `measure()` replays the durable log, so the nodes line up positionally with
 * `session.surface.nodes`. A mismatch means the surface moved between the two
 * reads; the caller reports that instead of guessing a range.
 * @param ctx - Plugin context carrying `tokenMeter`.
 * @param session - Session whose surface is read.
 * @returns Measured nodes, surface sequences, priced rows, and alignment.
 */
function readSurface(ctx, session) {
  const measurement = ctx.tokenMeter.measure(session)
  const seqs = [...session.surface.nodes]
  const priced = Array.isArray(measurement.nodes) ? measurement.nodes : []
  const aligned = isAligned(seqs, priced)
  const entries = seqs.map((seq, index) => ({
    seq,
    kind: kindOf(session.eventAt(seq)),
    tokens: aligned ? nodeTokens(priced[index]) : 0,
  }))
  return { measurement, seqs, priced, aligned, entries }
}

/**
 * Choose the span a compression would replace, using the session's own tool-pairing helpers.
 * @param session - Session supplying surface membership and balance.
 * @param surface - The value returned by {@link readSurface}.
 * @param retainTokens - Minimum recent tail kept verbatim, in tokens.
 * @returns The selected span, or `null` when no safe useful span exists.
 */
function planCompression(session, surface, retainTokens) {
  if (!surface.aligned) return null
  return selectCompactableRange({
    seqs: surface.seqs,
    nodes: surface.priced,
    retainTokens,
    isSystemHead: seq => kindOf(session.eventAt(seq)) === 'system',
    isBalancedBefore: seq => toolPairingBalancedBefore(session, seq),
  })
}

/** Nullable integer schema shared by the range fields. */
const nullableInteger = { oneOf: [{ type: 'integer' }, { type: 'null' }] }

/**
 * Build the `context_status` tool.
 * @param ctx - Plugin context.
 * @param config - Validated plugin configuration.
 * @returns The tool definition.
 */
function defineContextStatusTool(ctx, config) {
  return defineTool({
    name: 'context_status',
    description:
      'Report the current context pressure of this conversation and how much of it can be compressed. '
      + 'Returns the measured surface size, its system/message split, whether a compaction backend is mounted, '
      + 'and the exact span `context_compress` would replace while keeping a recent tail verbatim. '
      + 'Use this before a long stretch of reading or searching to decide whether to free context first.',
    parameters: {
      includeNodes: {
        type: 'boolean',
        description: 'Also list the individual surface items (seq, kind, tokens) so you can see what dominates the context.',
      },
      keepRecentTokens: {
        type: 'integer',
        description: 'Preview the compression decision with this recent tail kept verbatim, in tokens. Defaults to the configured value.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          surfaceTokens: { type: 'integer', required: true },
          systemTokens: { type: 'integer', required: true },
          messageTokens: { type: 'integer', required: true },
          nodeCount: { type: 'integer', required: true },
          compactionBackend: { type: 'string', required: true, enum: ['available', 'unavailable'] },
          compressible: { type: 'boolean', required: true },
          reason: { type: 'string', required: true },
          shadowedItems: { type: 'integer', required: true },
          shadowedTokens: { type: 'integer', required: true },
          retainedItems: { type: 'integer', required: true },
          retainedTokens: { type: 'integer', required: true },
          startSeq: nullableInteger,
          endSeq: nullableInteger,
          listedNodes: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                seq: { type: 'integer', required: true },
                kind: { type: 'string', required: true },
                tokens: { type: 'integer', required: true },
              },
            },
          },
          omittedNodes: { type: 'integer' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderContextStatus(value) }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('context_status requires a calling agent')
      const session = agent.session
      const surface = readSurface(ctx, session)
      const report = buildContextReport(surface.entries, { maxNodes: config.maxNodesListed })
      const backend = ctx.get('compaction') === undefined ? 'unavailable' : 'available'
      const retainTokens = args.keepRecentTokens ?? config.keepRecentTokens

      let reason = REASON.ok
      let range = null
      if (backend === 'unavailable') reason = REASON.noBackend
      else if (!surface.aligned) reason = REASON.surfaceMismatch
      else {
        range = planCompression(session, surface, retainTokens)
        if (range === null) reason = REASON.noSafeRange
      }

      return {
        surfaceTokens: report.surfaceTokens,
        systemTokens: report.systemTokens,
        messageTokens: report.messageTokens,
        nodeCount: report.nodeCount,
        compactionBackend: backend,
        compressible: range !== null,
        reason,
        shadowedItems: range?.shadowedItems ?? 0,
        shadowedTokens: range?.shadowedTokens ?? 0,
        retainedItems: range?.retainedItems ?? report.nodeCount,
        retainedTokens: range?.retainedTokens ?? report.surfaceTokens,
        startSeq: range?.start ?? null,
        endSeq: range?.end ?? null,
        ...args.includeNodes === true
          ? { listedNodes: report.listedNodes, omittedNodes: report.omittedNodes }
          : {},
      }
    },
    presentCall: args => ({ card: 'generic', title: 'Context status', kind: 'read', rawInput: args }),
  })
}

/**
 * Build the `context_compress` tool.
 * @param ctx - Plugin context.
 * @param config - Validated plugin configuration.
 * @returns The tool definition.
 */
function defineContextCompressTool(ctx, config) {
  return defineTool({
    name: 'context_compress',
    description:
      'Compress older conversation history in this session into a single summary, freeing context while keeping the '
      + 'recent tail verbatim. Runs through the mounted compaction backend, which writes a summary checkpoint and '
      + 'leaves the original events in the session log. Use it when a long task is filling the context window and '
      + 'earlier details are no longer needed; call `context_status` first if you want to preview the effect. '
      + 'The newest history is always preserved, and a cut never splits a tool call from its result.',
    parameters: {
      keepRecentTokens: {
        type: 'integer',
        description: 'Recent tail kept verbatim, in tokens. Larger keeps more detail and frees less. Defaults to the configured value.',
      },
      dryRun: {
        type: 'boolean',
        description: 'Report what would be compressed without changing the conversation.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          compacted: { type: 'boolean', required: true },
          reason: { type: 'string', required: true },
          shadowedItems: { type: 'integer', required: true },
          shadowedTokens: { type: 'integer', required: true },
          retainedItems: { type: 'integer', required: true },
          retainedTokens: { type: 'integer', required: true },
          remainingSurfaceTokens: nullableInteger,
          summarySeq: nullableInteger,
          error: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderCompressOutcome(value) }],
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('context_compress requires a calling agent')
      const compaction = ctx.get('compaction')
      const session = agent.session
      const retainTokens = args.keepRecentTokens ?? config.keepRecentTokens

      /** The value returned when nothing was compressed. */
      const nothing = (reason, extra = {}) => ({
        compacted: false,
        reason,
        shadowedItems: 0,
        shadowedTokens: 0,
        retainedItems: 0,
        retainedTokens: 0,
        remainingSurfaceTokens: null,
        summarySeq: null,
        error: null,
        ...extra,
      })

      if (compaction === undefined) return nothing(REASON.noBackend)

      let surface
      let range
      try {
        surface = readSurface(ctx, session)
        if (!surface.aligned) return nothing(REASON.surfaceMismatch)
        range = planCompression(session, surface, retainTokens)
      } catch (error) {
        return nothing(REASON.failed, { error: messageOf(error) })
      }
      if (range === null) return nothing(REASON.noSafeRange)

      const span = {
        shadowedItems: range.shadowedItems,
        shadowedTokens: range.shadowedTokens,
        retainedItems: range.retainedItems,
        retainedTokens: range.retainedTokens,
      }
      if (range.shadowedTokens < config.minCompactTokens) {
        return nothing(REASON.belowMinimum, span)
      }
      if (args.dryRun === true) return nothing(REASON.dryRun, span)

      let result
      try {
        result = await compaction.compactRegion(range.start, range.end, agent, exec.signal)
      } catch (error) {
        // Cancellation belongs to the caller: let the registry record ABORTED
        // instead of reporting a compression failure the model should retry.
        if (exec.signal.aborted) throw error
        if (isBusy(error)) return nothing(REASON.busy, span)
        return nothing(REASON.failed, { ...span, error: messageOf(error) })
      }

      let remainingSurfaceTokens = null
      try {
        remainingSurfaceTokens = buildContextReport(readSurface(ctx, session).entries, { maxNodes: 2 }).surfaceTokens
      } catch {
        remainingSurfaceTokens = null
      }

      return {
        compacted: true,
        reason: REASON.compacted,
        shadowedItems: Array.isArray(result?.shadowedSeqs) ? result.shadowedSeqs.length : range.shadowedItems,
        shadowedTokens: Number.isFinite(result?.shadowedTokenCount)
          ? Math.round(result.shadowedTokenCount)
          : range.shadowedTokens,
        retainedItems: range.retainedItems,
        retainedTokens: range.retainedTokens,
        remainingSurfaceTokens,
        summarySeq: Number.isFinite(result?.summarySeq) ? result.summarySeq : null,
        error: null,
      }
    },
    presentCall: args => ({ card: 'generic', title: 'Compress context', kind: 'other', rawInput: args }),
  })
}

/**
 * Whether a compaction failure means another compaction already holds the lock.
 * @param error - The thrown value.
 * @returns True for the seam's expected `busy` classification.
 */
function isBusy(error) {
  return error?.name === 'ManualCompactionError' && error?.code === 'busy'
}

/**
 * Read a thrown value's message.
 * @param error - The thrown value.
 * @returns A non-empty diagnostic string.
 */
function messageOf(error) {
  if (error instanceof Error && error.message.length > 0) return error.message
  return String(error)
}

/**
 * Apply the plugin: register the two model-facing context tools.
 * @param ctx - Registrant context carrying the tool runtime and token meter.
 * @param config - Validated plugin configuration.
 */
export function apply(ctx, config) {
  if (config.enabled === false) return
  ctx.tools.register(defineContextStatusTool(ctx, config))
  ctx.tools.register(defineContextCompressTool(ctx, config))
}
