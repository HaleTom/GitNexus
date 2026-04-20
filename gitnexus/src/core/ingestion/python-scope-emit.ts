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

import type {
  ParsedFile,
  RegistryProviders,
  Scope,
  ScopeId,
  WorkspaceIndex,
} from 'gitnexus-shared';
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
  buildPopulatedMethodDispatch,
  emitFreeCallFallback,
  emitImportEdges,
  emitReceiverBoundCalls,
  emitReferencesViaLookup,
  propagateImportedReturnTypes,
  resolveDefGraphId,
  type EmitProvider,
  type GraphNodeLookup,
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
    populateMethodOwnerIds(parsed);
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
  const mroByClassDefId = buildPythonMro(graph, parsedFiles, nodeLookup);

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

// ─── Python-specific internals (move to languages/python/emit/ in Unit 11) ──

/**
 * Build a Python MRO map keyed by scope-resolution Class `DefId`.
 *
 * The legacy `parse` phase has already emitted EXTENDS edges into the
 * graph (via the heritage processor in `parsing-processor.ts`) by the
 * time this orchestrator runs (we depend on `parse`). We mirror those
 * edges into a `DefId → ancestor DefId[]` map so receiver-typed
 * `MethodRegistry.lookup` can walk inherited methods.
 *
 * MRO ordering: this is a **simple linear walk** (depth-first parent
 * chain, dedup by first-seen). Full Python C3 linearization lives in
 * the legacy heritage processor; replicating it here is out of scope
 * for the first cut. The single-inheritance case — which covers the
 * existing fixture suite (`User → BaseModel`, `Child → Parent`,
 * `Grandchild → Child → Parent`) — is identical to C3, so the
 * difference only surfaces with diamond hierarchies. Tracked as a
 * follow-up alongside generalizing this orchestrator across languages.
 */
function buildPythonMro(
  graph: KnowledgeGraph,
  parsedFiles: readonly ParsedFile[],
  nodeLookup: GraphNodeLookup,
): Map<string /* DefId */, string[] /* DefId[] */> {
  // Step 1: build (graph node id) → (parent graph node id[]) from
  // EXTENDS edges. Python only has class inheritance via `class
  // Child(Parent)`, which the heritage processor maps to EXTENDS
  // (not IMPLEMENTS).
  const parentsByGraphId = new Map<string, string[]>();
  for (const rel of graph.iterRelationships()) {
    if (rel.type !== 'EXTENDS') continue;
    let list = parentsByGraphId.get(rel.sourceId);
    if (list === undefined) {
      list = [];
      parentsByGraphId.set(rel.sourceId, list);
    }
    list.push(rel.targetId);
  }

  // Step 2: collect every Class def from the parsed scope model and
  // build a graph-node → DefId reverse map.
  const defIdByGraphId = new Map<string, string>();
  for (const parsed of parsedFiles) {
    for (const def of parsed.localDefs) {
      if (def.type !== 'Class') continue;
      const graphId = resolveDefGraphId(parsed.filePath, def, nodeLookup);
      if (graphId !== undefined) defIdByGraphId.set(graphId, def.nodeId);
    }
  }

  // Step 3: for each Class def, walk parents transitively (depth-first,
  // first-seen-wins) and translate each ancestor back to its DefId.
  const mroByDefId = new Map<string, string[]>();
  for (const [graphId, defId] of defIdByGraphId) {
    const ancestors: string[] = [];
    const visited = new Set<string>();
    const queue: string[] = [...(parentsByGraphId.get(graphId) ?? [])];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (visited.has(cur)) continue;
      visited.add(cur);
      const ancDefId = defIdByGraphId.get(cur);
      if (ancDefId !== undefined) ancestors.push(ancDefId);
      for (const p of parentsByGraphId.get(cur) ?? []) queue.push(p);
    }
    mroByDefId.set(defId, ancestors);
  }
  return mroByDefId;
}

/**
 * Populate `ownerId` on Method/Function/Field defs that live structurally
 * inside a `Class` scope.
 *
 * Python's ownership rule: methods belong to the lexically enclosing
 * class. Applied before finalize so `MethodRegistry.lookup` Step 2
 * (`collectOwnedMembers`) finds candidates by class owner.
 *
 * Mutates `parsed.localDefs` in place via type cast — `SymbolDefinition`
 * is `readonly` for consumers but the extractor returns plain objects.
 * Defs are shared by reference between `localDefs` and `Scope.ownedDefs`,
 * so this single mutation is visible from both sides.
 */
function populateMethodOwnerIds(parsed: ParsedFile): void {
  const scopesById = new Map<ScopeId, Scope>();
  for (const scope of parsed.scopes) scopesById.set(scope.id, scope);

  for (const scope of parsed.scopes) {
    // Methods (Function scopes whose PARENT is Class): set ownerId
    // on every def in the function's own scope.
    if (scope.parent !== null) {
      const parentScope = scopesById.get(scope.parent);
      if (parentScope !== undefined && parentScope.kind === 'Class') {
        const classDef = parentScope.ownedDefs.find((d) => d.type === 'Class');
        if (classDef !== undefined) {
          for (const def of scope.ownedDefs) {
            (def as { ownerId?: string }).ownerId = classDef.nodeId;
          }
        }
      }
    }
    // Class-body fields (defs structurally owned by the Class scope
    // itself — class-body annotations like `name: str`): set ownerId
    // on every def except the class itself.
    if (scope.kind === 'Class') {
      const classDef = scope.ownedDefs.find((d) => d.type === 'Class');
      if (classDef !== undefined) {
        for (const def of scope.ownedDefs) {
          if (def === classDef) continue;
          (def as { ownerId?: string }).ownerId = classDef.nodeId;
        }
      }
    }
  }
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
