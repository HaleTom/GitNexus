/**
 * `emit-core/` — language-agnostic graph-feeding primitives for the
 * registry-primary scope-resolution pipeline.
 *
 * Responsibility boundary:
 *   - `gitnexus-shared/src/scope-resolution/` owns the semantic model
 *     (indexes, ParsedFile, registries, TypeRef, Reference).
 *   - `emit-core/` owns the bridge from that model to the legacy
 *     `KnowledgeGraph` edge format. Lives here (CLI, not shared)
 *     because graph bridging depends on `KnowledgeGraph` + `generateId`
 *     which are CLI-local.
 *   - `languages/<lang>/emit/` owns per-language post-passes that
 *     compose these primitives with language-specific captures and
 *     strategies (MRO, ownership, receiver conventions).
 *
 * Next-consumer contract: when the next language provider migrates
 * (TypeScript #927, JavaScript #928, etc.), it imports from this
 * module's public surface and never re-implements any of these
 * functions. See the per-file JSDoc for per-function reuse notes.
 */

export {
  buildGraphNodeLookup,
  isLinkableLabel,
  type GraphNodeLookup,
} from './graph-node-lookup.js';
export { resolveCallerGraphId, resolveDefGraphId, simpleQualifiedName } from './graph-id.js';
export { mapReferenceKindToEdgeType, tryEmitEdge } from './emit-edge.js';
export { emitReferencesViaLookup } from './emit-references.js';
export { emitImportEdges } from './emit-imports.js';
export {
  findReceiverTypeBinding,
  findClassBindingInScope,
  findCallableBindingInScope,
  findOwnedMember,
  findExportedDef,
} from './scope-walkers.js';
export { collectNamespaceTargets } from './namespace-targets.js';
export { buildPopulatedMethodDispatch } from './method-dispatch-bridge.js';
