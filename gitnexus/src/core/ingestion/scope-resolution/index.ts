/**
 * `scope-resolution/` — registry-primary call/reference resolution.
 *
 * Public surface, grouped by concern. New language migrations should
 * read `contract/scope-resolver.ts` first — it lists every hook the
 * generic pipeline needs from a per-language adapter.
 *
 * Folder layout:
 *   - `contract/`     — `ScopeResolver` interface + shared types
 *   - `pipeline/`     — orchestrator, registry, pipeline-phase wrapper
 *   - `passes/`       — reference-resolution passes (receiver-bound,
 *                       free-call fallback, compound-receiver, MRO,
 *                       cross-file return-type propagation)
 *   - `graph-bridge/` — CLI-local layer that translates resolved
 *                       references into `KnowledgeGraph` edges
 *   - `scope/`        — generic scope-chain walkers + namespace targets
 *
 * The `scope/` and `passes/` content is pure logic with no graph
 * dependency; if a future consumer (gitnexus-web) needs the resolver
 * without the graph, those two folders are the natural promotion path
 * to `gitnexus-shared/`.
 */

// ── Contract ──────────────────────────────────────────────────────────────
export type { ArityVerdict, LinearizeStrategy, ScopeResolver } from './contract/scope-resolver.js';

// ── Pipeline ──────────────────────────────────────────────────────────────
export {
  runScopeResolution,
  type RunScopeResolutionInput,
  type RunScopeResolutionStats,
} from './pipeline/run.js';
export { SCOPE_RESOLVERS, getScopeResolver } from './pipeline/registry.js';

// ── Passes ────────────────────────────────────────────────────────────────
export { emitReceiverBoundCalls } from './passes/receiver-bound-calls.js';
export { emitFreeCallFallback } from './passes/free-call-fallback.js';
export {
  matchingOpenParen,
  resolveCompoundReceiverClass,
  type ResolveCompoundReceiverOptions,
} from './passes/compound-receiver.js';
export {
  followChainPostFinalize,
  propagateImportedReturnTypes,
} from './passes/imported-return-types.js';
export { buildMro, defaultLinearize } from './passes/mro.js';

// ── Graph bridge (CLI-local) ──────────────────────────────────────────────
export {
  buildGraphNodeLookup,
  isLinkableLabel,
  type GraphNodeLookup,
} from './graph-bridge/node-lookup.js';
export {
  resolveCallerGraphId,
  resolveDefGraphId,
  simpleQualifiedName,
} from './graph-bridge/ids.js';
export { mapReferenceKindToEdgeType, tryEmitEdge } from './graph-bridge/edges.js';
export { emitReferencesViaLookup } from './graph-bridge/references-to-edges.js';
export { emitImportEdges } from './graph-bridge/imports-to-edges.js';
export { buildPopulatedMethodDispatch } from './graph-bridge/method-dispatch.js';

// ── Scope walkers ─────────────────────────────────────────────────────────
export {
  findReceiverTypeBinding,
  findClassBindingInScope,
  findCallableBindingInScope,
  findEnclosingClassDef,
  findExportedDefByName,
  findOwnedMember,
  findExportedDef,
  populateClassOwnedMembers,
} from './scope/walkers.js';
export { collectNamespaceTargets } from './scope/namespace-targets.js';
