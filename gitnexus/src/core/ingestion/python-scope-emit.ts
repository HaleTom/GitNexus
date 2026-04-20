/**
 * `runPythonScopeResolution` — drive the registry-primary resolution
 * pipeline end-to-end for the Python files in a workspace and emit
 * graph edges (RFC #909 Ring 3 — Python migration).
 *
 *     ParsedFile[]  (one per .py via `extractParsedFile`)
 *        │  finalizeScopeModel(  + Python hooks adapted to FinalizeHooks)
 *        ▼
 *     ScopeResolutionIndexes
 *        │  resolveReferenceSites
 *        ▼
 *     ReferenceIndex
 *        │  emitReferencesViaLookup (shared — emit-core)
 *        │  + emitReceiverBoundCalls (Python-specific; moves to
 *        │     languages/python/emit/ in Unit 11)
 *        │  + emitImportEdges (shared — emit-core)
 *        ▼
 *     KnowledgeGraph
 *
 * The orchestrator is the public seam between the gitnexus pipeline and
 * the language-agnostic scope-resolution machinery in `gitnexus-shared`.
 * It wires the Python provider's hooks into `FinalizeOrchestratorOptions`
 * and threads the workspace index through the import-target resolver.
 *
 * Gating lives in the pipeline phase (`pipeline-phases/python-scope.ts`),
 * not here — this function is "what to do" once we've decided to do it.
 */

import type { ParsedFile, RegistryProviders, Scope, WorkspaceIndex } from 'gitnexus-shared';
import type { KnowledgeGraph } from '../graph/types.js';
import { extractParsedFile } from './scope-extractor-bridge.js';
import { finalizeScopeModel } from './finalize-orchestrator.js';
import { resolveReferenceSites, type ResolveStats } from './resolve-references.js';
import { pythonProvider } from './languages/python.js';
import {
  pythonArityCompatibility,
  pythonMergeBindings,
  resolvePythonImportTarget,
  type PythonResolveContext,
} from './languages/python/index.js';
import {
  buildGraphNodeLookup,
  buildMro,
  buildPopulatedMethodDispatch,
  defaultLinearize,
  emitFreeCallFallback,
  emitImportEdges,
  emitReceiverBoundCalls,
  emitReferencesViaLookup,
  populateClassOwnedMembers,
  propagateImportedReturnTypes,
  type EmitProvider,
} from './emit-core/index.js';
import { SupportedLanguages } from 'gitnexus-shared';

// ─── Public API ─────────────────────────────────────────────────────────────

export interface RunPythonScopeResolutionInput {
  readonly graph: KnowledgeGraph;
  readonly files: readonly { readonly path: string; readonly content: string }[];
  /** Optional warning sink (e.g. for telemetry). Failures per-file are non-fatal. */
  readonly onWarn?: (message: string) => void;
}

export interface RunPythonScopeResolutionStats {
  readonly filesProcessed: number;
  readonly filesSkipped: number;
  readonly importsEmitted: number;
  readonly resolve: ResolveStats;
  readonly referenceEdgesEmitted: number;
  readonly referenceSkipped: number;
}

/**
 * Run the full registry-primary resolution path for `files` and emit the
 * resulting CALLS / ACCESSES / INHERITS / USES / IMPORTS edges into
 * `graph`. Caller is responsible for ensuring `files` are Python only.
 *
 * Returns telemetry; never throws on per-file failures (warnings flow
 * through `onWarn`).
 */
export function runPythonScopeResolution(
  input: RunPythonScopeResolutionInput,
): RunPythonScopeResolutionStats {
  const { graph, files } = input;
  const onWarn = input.onWarn ?? (() => {});

  // ── Phase 1: extract each file → ParsedFile ─────────────────────────────
  const parsedFiles: ParsedFile[] = [];
  let filesSkipped = 0;
  for (const file of files) {
    const parsed = extractParsedFile(pythonProvider, file.content, file.path, onWarn);
    if (parsed === undefined) {
      filesSkipped++;
      continue;
    }
    populateClassOwnedMembers(parsed);
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
  // Pre-build a graph-node lookup (used both for MRO bridging and for
  // edge emission below). EXTENDS edges already in the graph (from the
  // legacy heritage processor in `parse`) drive the MRO chain — we
  // mirror them into a `MethodDispatchIndex` so receiver-typed
  // resolution can walk inherited methods.
  const nodeLookup = buildGraphNodeLookup(graph);
  const mroByClassDefId = buildMro(graph, parsedFiles, nodeLookup, defaultLinearize);

  const indexes = finalizeScopeModel(parsedFiles, {
    hooks: {
      // Adapter: shared `finalize()` calls `resolveImportTarget(targetRaw,
      // fromFile, ws)` with `targetRaw` already extracted; the Python
      // provider's signature takes a synthetic `ParsedImport`. Wrap it so
      // the hook contract is satisfied without leaking provider internals.
      resolveImportTarget: (targetRaw, fromFile) => {
        const ws: PythonResolveContext = { fromFile, allFilePaths };
        return resolvePythonImportTarget(
          { kind: 'named', localName: '_', importedName: '_', targetRaw },
          ws as unknown as WorkspaceIndex,
        );
      },
      // Python LEGB precedence: local > import/namespace/reexport > wildcard.
      mergeBindings: (existing, incoming, scopeId) => {
        // `pythonMergeBindings(scope, bindings)` only consults
        // `BindingRef.origin` for tier ordering, not `scope.kind`. A
        // shape-stub satisfies the type contract without falsifying
        // behavior.
        const fakeScope = { id: scopeId } as unknown as Scope;
        return pythonMergeBindings(fakeScope, [...existing, ...incoming]);
      },
    },
  });

  // Stitch the MRO into the finalized indexes. `finalizeScopeModel`
  // builds an empty MethodDispatchIndex (the comment in
  // `finalize-orchestrator.ts:124-129` notes this is a known gap); we
  // overwrite with a populated index that wraps the same shape.
  (indexes as { methodDispatch: typeof indexes.methodDispatch }).methodDispatch =
    buildPopulatedMethodDispatch(mroByClassDefId);

  // Propagate return-type typeBindings across imports. The shared
  // finalize pass copies callable bindings (`from x import f` puts
  // `f` in the importer's bindings), but typeBindings stay file-local.
  // Without this step, `u = get_user(); u.save()` works only when
  // get_user is in the same file as the call. Done as a post-finalize
  // mutation since `Scope.typeBindings` is a plain Map (per
  // `draftToScope` line 302).
  propagateImportedReturnTypes(parsedFiles, indexes);

  // ── Phase 3: resolve references via Registry.lookup ─────────────────────
  const providers: RegistryProviders = {
    // The Python provider's `arityCompatibility` predates the
    // RegistryProviders contract and uses `(def, callsite)` argument
    // order. The contract is `(callsite, def)`. Adapt at the boundary
    // so the provider source stays untouched.
    arityCompatibility: (callsite, def) => pythonArityCompatibility(def, callsite),
  };
  const { referenceIndex, stats: resolveStats } = resolveReferenceSites({
    scopes: indexes,
    providers,
  });

  // ── Phase 4: emit graph edges ───────────────────────────────────────────
  // Order matters: run the Python-specific receiver-bound and free-call
  // passes FIRST so they record (filePath, line, col) keys for sites
  // they emit edges for. The shared resolver then skips those sites in
  // `emitReferencesViaLookup` so its potentially-wrong fallback (e.g.
  // resolving `app_metrics.get_metrics()` to a same-named local function
  // instead of the namespace target) doesn't fight the precise emission.
  const handledSites = new Set<string>();
  const receiverExtras = emitReceiverBoundCalls(
    graph,
    indexes,
    parsedFiles,
    nodeLookup,
    handledSites,
    pythonEmitProviderInline,
  );
  const freeCallExtras = emitFreeCallFallback(
    graph,
    indexes,
    parsedFiles,
    nodeLookup,
    referenceIndex,
    handledSites,
  );

  // The shared `emit-references.ts` emits edges between
  // `SymbolDefinition.nodeId` values, which use the scope-extractor's
  // `def:<file>#<line>:<col>:<type>:<name>` format. The CLI's existing
  // graph nodes (created by `parsing-processor.ts`) use the legacy
  // `<Type>:<file>:<qualifiedName>` ID format. Bridging is required so
  // edges actually link to existing graph nodes.
  const { emitted, skipped } = emitReferencesViaLookup(
    graph,
    indexes,
    referenceIndex,
    nodeLookup,
    handledSites,
  );

  // IMPORTS edges: the scope-resolution path now owns Python file→file
  // IMPORTS edge emission when `REGISTRY_PRIMARY_PYTHON=1`. The legacy
  // `processImports` path still runs (heritage needs its `importMap`
  // population for `ctx.resolve`), but import-processor's graph edge
  // emission is gated per-language in `createImportEdgeHelpers` so
  // Python no longer double-emits.
  const importsEmitted = emitImportEdges(
    graph,
    indexes.imports,
    indexes.scopeTree,
    'python-scope: import',
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

/** Minimal `EmitProvider` carrying only the hooks the receiver-bound
 *  pass currently consults. The full provider (with mergeBindings,
 *  resolveImportTarget, arityCompatibility, buildMro, populateOwners)
 *  lands in G-Unit 6 when it moves to `languages/python/emit/`. */
const pythonEmitProviderInline: Pick<
  EmitProvider,
  'language' | 'isSuperReceiver' | 'fieldFallbackOnMethodLookup'
> = {
  language: SupportedLanguages.Python,
  isSuperReceiver: (text) => /^super\s*\(/.test(text),
  fieldFallbackOnMethodLookup: true,
};
