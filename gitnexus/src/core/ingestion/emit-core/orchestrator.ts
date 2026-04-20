/**
 * `runScopeResolution` — generic registry-primary resolution
 * orchestrator.
 *
 *     ParsedFile[]  (one per file via `extractParsedFile`)
 *        │  finalizeScopeModel(  + provider hooks adapted to FinalizeHooks)
 *        ▼
 *     ScopeResolutionIndexes
 *        │  resolveReferenceSites
 *        ▼
 *     ReferenceIndex
 *        │  emitReceiverBoundCalls (FIRST — see Contract Invariant I1)
 *        │  emitFreeCallFallback   (THEN)
 *        │  emitReferencesViaLookup (LAST — uses handledSites)
 *        │  emitImportEdges
 *        ▼
 *     KnowledgeGraph
 *
 * Per-language entry points (e.g. `runPythonScopeResolution` in
 * `languages/python/emit/index.ts`) construct an `EmitProvider` and
 * delegate here.
 *
 * Plan: `docs/plans/2026-04-20-001-refactor-emit-pipeline-generalization-plan.md`.
 */

import type { ParsedFile, RegistryProviders } from 'gitnexus-shared';
import type { KnowledgeGraph } from '../../graph/types.js';
import { extractParsedFile } from '../scope-extractor-bridge.js';
import { finalizeScopeModel } from '../finalize-orchestrator.js';
import { resolveReferenceSites, type ResolveStats } from '../resolve-references.js';
import { buildGraphNodeLookup } from './graph-node-lookup.js';
import { buildPopulatedMethodDispatch } from './method-dispatch-bridge.js';
import { propagateImportedReturnTypes } from './propagate-return-types.js';
import { emitReceiverBoundCalls } from './emit-receiver-bound.js';
import { emitFreeCallFallback } from './emit-free-call.js';
import { emitReferencesViaLookup } from './emit-references.js';
import { emitImportEdges } from './emit-imports.js';
import type { EmitProvider } from './emit-provider.js';

export interface RunScopeResolutionInput {
  readonly graph: KnowledgeGraph;
  readonly files: readonly { readonly path: string; readonly content: string }[];
  readonly onWarn?: (message: string) => void;
}

export interface RunScopeResolutionStats {
  readonly filesProcessed: number;
  readonly filesSkipped: number;
  readonly importsEmitted: number;
  readonly resolve: ResolveStats;
  readonly referenceEdgesEmitted: number;
  readonly referenceSkipped: number;
}

export function runScopeResolution(
  input: RunScopeResolutionInput,
  provider: EmitProvider,
): RunScopeResolutionStats {
  const { graph, files } = input;
  const onWarn = input.onWarn ?? (() => {});

  // ── Phase 1: extract each file → ParsedFile ────────────────────────────
  const parsedFiles: ParsedFile[] = [];
  let filesSkipped = 0;
  for (const file of files) {
    const parsed = extractParsedFile(provider.languageProvider, file.content, file.path, onWarn);
    if (parsed === undefined) {
      filesSkipped++;
      continue;
    }
    provider.populateOwners(parsed);
    parsedFiles.push(parsed);
  }

  if (parsedFiles.length === 0) {
    return {
      filesProcessed: 0,
      filesSkipped,
      importsEmitted: 0,
      resolve: { sitesProcessed: 0, referencesEmitted: 0, unresolved: 0 },
      referenceEdgesEmitted: 0,
      referenceSkipped: 0,
    };
  }

  // ── Phase 2: finalize → ScopeResolutionIndexes ─────────────────────────
  const allFilePaths = new Set(parsedFiles.map((f) => f.filePath));
  const nodeLookup = buildGraphNodeLookup(graph);
  const mroByClassDefId = provider.buildMro(graph, parsedFiles, nodeLookup);

  const indexes = finalizeScopeModel(parsedFiles, {
    hooks: {
      resolveImportTarget: (targetRaw, fromFile) =>
        provider.resolveImportTarget(targetRaw, fromFile, allFilePaths),
      mergeBindings: (existing, incoming, scopeId) =>
        provider.mergeBindings(existing, incoming, scopeId),
    },
  });

  // Stitch the MRO into the finalized indexes (same pattern as before
  // generalization — finalizeScopeModel builds an empty
  // MethodDispatchIndex by design).
  (indexes as { methodDispatch: typeof indexes.methodDispatch }).methodDispatch =
    buildPopulatedMethodDispatch(mroByClassDefId);

  // Cross-file return-type propagation (Contract Invariant I3 timing:
  // after finalize, before resolve).
  if (provider.propagatesReturnTypesAcrossImports !== false) {
    propagateImportedReturnTypes(parsedFiles, indexes);
  }

  // ── Phase 3: resolve references via Registry.lookup ────────────────────
  const registryProviders: RegistryProviders = {
    arityCompatibility: provider.arityCompatibility,
  };
  const { referenceIndex, stats: resolveStats } = resolveReferenceSites({
    scopes: indexes,
    providers: registryProviders,
  });

  // ── Phase 4: emit graph edges (LOAD-BEARING ORDER — see I1) ────────────
  const handledSites = new Set<string>();
  const receiverExtras = emitReceiverBoundCalls(
    graph,
    indexes,
    parsedFiles,
    nodeLookup,
    handledSites,
    provider,
  );
  const freeCallExtras = emitFreeCallFallback(
    graph,
    indexes,
    parsedFiles,
    nodeLookup,
    referenceIndex,
    handledSites,
  );
  const { emitted, skipped } = emitReferencesViaLookup(
    graph,
    indexes,
    referenceIndex,
    nodeLookup,
    handledSites,
  );
  const importsEmitted = emitImportEdges(
    graph,
    indexes.imports,
    indexes.scopeTree,
    provider.importEdgeReason,
  );

  return {
    filesProcessed: parsedFiles.length,
    filesSkipped,
    importsEmitted,
    resolve: resolveStats,
    referenceEdgesEmitted: emitted + receiverExtras + freeCallExtras,
    referenceSkipped: skipped,
  };
}
