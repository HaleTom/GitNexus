/**
 * `runPythonScopeResolution` — drive the registry-primary resolution
 * pipeline end-to-end for the Python files in a workspace and emit
 * graph edges (RFC #909 Ring 4 — Python migration).
 *
 *     ParsedFile[]  (one per .py via `extractParsedFile`)
 *        │  finalizeScopeModel(  + Python hooks adapted to FinalizeHooks)
 *        ▼
 *     ScopeResolutionIndexes
 *        │  resolveReferenceSites
 *        ▼
 *     ReferenceIndex
 *        │  emitReferencesToGraph (CALLS / ACCESSES / INHERITS / USES)
 *        │  + emitImportEdgesToGraph (file→file IMPORTS)
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
  BindingRef,
  ImportEdge,
  NodeLabel,
  ParsedFile,
  Reference,
  RegistryProviders,
  Scope,
  ScopeId,
  WorkspaceIndex,
} from 'gitnexus-shared';
import type { KnowledgeGraph } from '../graph/types.js';
import { extractParsedFile } from './scope-extractor-bridge.js';
import { finalizeScopeModel } from './finalize-orchestrator.js';
import type { ScopeResolutionIndexes } from './model/scope-resolution-indexes.js';
import { resolveReferenceSites, type ResolveStats } from './resolve-references.js';
import { pythonProvider } from './languages/python.js';
import {
  pythonArityCompatibility,
  pythonMergeBindings,
  resolvePythonImportTarget,
  type PythonResolveContext,
} from './languages/python/index.js';
import { generateId } from '../../lib/utils.js';

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
  // The shared `emit-references.ts` emits edges between
  // `SymbolDefinition.nodeId` values, which use the scope-extractor's
  // `def:<file>#<line>:<col>:<type>:<name>` format. The CLI's existing
  // graph nodes (created by `parsing-processor.ts`) use the legacy
  // `<Type>:<file>:<qualifiedName>` ID format. Bridging is required so
  // edges actually link to existing graph nodes.
  //
  // We do that bridging here: translate the resolved `Reference`
  // records' source + target via `nodeLookup` (built earlier alongside
  // the MRO map) before calling `graph.addRelationship`. This keeps
  // `emit-references.ts` untouched (it stays pure scope-resolution).
  const { emitted, skipped } = emitReferencesViaLookup(
    graph,
    indexes,
    referenceIndex,
    nodeLookup,
  );

  // IMPORTS edges are emitted by the legacy `processImports` path
  // (which heritage resolution depends on for `ctx.resolve` to find
  // imported symbols). We intentionally do NOT emit IMPORTS here to
  // avoid duplicates and to keep heritage's resolution chain intact.
  const importsEmitted = 0;

  return {
    filesProcessed: parsedFiles.length,
    filesSkipped,
    importsEmitted,
    resolve: resolveStats,
    referenceEdgesEmitted: emitted,
    referenceSkipped: skipped,
  };
}

// ─── Internal ───────────────────────────────────────────────────────────────

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

const EMPTY_DEFS: readonly string[] = Object.freeze([]);

/** Wrap a `DefId → ancestor DefId[]` map in the `MethodDispatchIndex` shape. */
function buildPopulatedMethodDispatch(
  mroByDefId: ReadonlyMap<string, readonly string[]>,
): import('gitnexus-shared').MethodDispatchIndex {
  return {
    mroByOwnerDefId: mroByDefId,
    implsByInterfaceDefId: new Map(),
    mroFor(ownerDefId) {
      return mroByDefId.get(ownerDefId) ?? EMPTY_DEFS;
    },
    implementorsOf() {
      return EMPTY_DEFS;
    },
  };
}

/**
 * Build a `(filePath, simpleName, kind) → graphNodeId` lookup over the
 * graph's Function/Method/Class/Constructor nodes. Used to translate
 * scope-resolution `SymbolDefinition.nodeId` values into the legacy
 * graph node ID format that downstream consumers (queries, edges, MCP)
 * expect.
 */
type GraphNodeLookup = ReadonlyMap<string, string>;

function buildGraphNodeLookup(graph: KnowledgeGraph): GraphNodeLookup {
  const lookup = new Map<string, string>();
  for (const node of graph.iterNodes()) {
    const props = node.properties as { filePath?: string; name?: string };
    if (props.filePath === undefined || props.name === undefined) continue;
    if (!isLinkableLabel(node.label)) continue;
    // Keyed by (filePath, simpleName). Class kinds and method kinds
    // share the same simple-name space within a file in Python — no
    // overload of "class Foo" + "def Foo()" at the same level — so a
    // single key per (file, name) is unambiguous in practice. The
    // method-vs-class disambiguation for resolved references happens
    // earlier inside `MethodRegistry.lookup` (Step 1 + Step 2).
    const key = `${props.filePath}::${props.name}`;
    if (!lookup.has(key)) lookup.set(key, node.id);
  }
  return lookup;
}

function isLinkableLabel(label: NodeLabel): boolean {
  return (
    label === 'Function' ||
    label === 'Method' ||
    label === 'Constructor' ||
    label === 'Class' ||
    label === 'Interface' ||
    label === 'Struct' ||
    label === 'Enum'
  );
}

/**
 * Translate the resolved `ReferenceIndex` into legacy graph edges.
 *
 * Per reference:
 *   1. Resolve `fromScope` → caller graph-node id by walking the scope
 *      chain looking for an enclosing Function/Method/Class.
 *   2. Resolve `toDef` → target graph-node id via `nodeLookup`.
 *   3. Emit the edge (`CALLS` / `READS` / `WRITES` / `EXTENDS` / `USES`)
 *      with the standard reason format.
 *
 * Skips (without throwing) when either side fails to map — either side
 * may legitimately not exist as a graph node (e.g., a resolved target
 * lives in an external file that wasn't ingested into the graph).
 */
function emitReferencesViaLookup(
  graph: KnowledgeGraph,
  scopes: ScopeResolutionIndexes,
  referenceIndex: { readonly bySourceScope: ReadonlyMap<ScopeId, readonly Reference[]> },
  nodeLookup: GraphNodeLookup,
): { emitted: number; skipped: number } {
  let emitted = 0;
  let skipped = 0;
  const seen = new Set<string>();

  for (const [fromScope, refs] of referenceIndex.bySourceScope) {
    const callerGraphId = resolveCallerGraphId(fromScope, scopes, nodeLookup);
    if (callerGraphId === undefined) {
      skipped += refs.length;
      continue;
    }

    for (const ref of refs) {
      const targetDef = scopes.defs.get(ref.toDef);
      if (targetDef === undefined) {
        skipped++;
        continue;
      }
      const targetGraphId = resolveDefGraphId(targetDef.filePath, targetDef, nodeLookup);
      if (targetGraphId === undefined) {
        skipped++;
        continue;
      }

      const edgeType = mapReferenceKindToEdgeType(ref.kind);
      if (edgeType === undefined) {
        skipped++;
        continue;
      }

      const dedupKey = `${edgeType}:${callerGraphId}->${targetGraphId}:${ref.atRange.startLine}:${ref.atRange.startCol}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);

      graph.addRelationship({
        id: `rel:${dedupKey}`,
        sourceId: callerGraphId,
        targetId: targetGraphId,
        type: edgeType,
        confidence: ref.confidence,
        reason: `python-scope: ${ref.kind}`,
      });
      emitted++;
    }
  }
  return { emitted, skipped };
}

/**
 * Walk the scope chain from `startScope` upward looking for the first
 * scope whose `ownedDefs` contains a Function/Method/Class — that's
 * our caller anchor. Translate via `nodeLookup` to the graph-node ID.
 */
function resolveCallerGraphId(
  startScope: ScopeId,
  scopes: ScopeResolutionIndexes,
  nodeLookup: GraphNodeLookup,
): string | undefined {
  let current: ScopeId | null = startScope;
  const visited = new Set<ScopeId>();
  while (current !== null) {
    if (visited.has(current)) return undefined;
    visited.add(current);
    const scope = scopes.scopeTree.getScope(current);
    if (scope === undefined) return undefined;

    // Prefer Function/Method anchors; fall back to Class.
    const fnDef = scope.ownedDefs.find(
      (d) => d.type === 'Function' || d.type === 'Method' || d.type === 'Constructor',
    );
    if (fnDef !== undefined) {
      const id = resolveDefGraphId(scope.filePath, fnDef, nodeLookup);
      if (id !== undefined) return id;
    }
    const classDef = scope.ownedDefs.find((d) => isLinkableLabel(d.type));
    if (classDef !== undefined) {
      const id = resolveDefGraphId(scope.filePath, classDef, nodeLookup);
      if (id !== undefined) return id;
    }
    current = scope.parent;
  }
  return undefined;
}

/** Look up a `SymbolDefinition` in the graph node lookup by file+name. */
function resolveDefGraphId(
  filePath: string,
  def: { qualifiedName?: string },
  nodeLookup: GraphNodeLookup,
): string | undefined {
  const qn = def.qualifiedName;
  if (qn === undefined || qn.length === 0) return undefined;
  const simpleName = qn.lastIndexOf('.') === -1 ? qn : qn.slice(qn.lastIndexOf('.') + 1);
  return nodeLookup.get(`${filePath}::${simpleName}`);
}

/**
 * Map a `Reference.kind` to a graph edge type. `import-use` is dropped
 * (no edge type today — provenance lives on the IMPORTS edge already
 * emitted by `emitImportEdges`).
 */
function mapReferenceKindToEdgeType(
  kind: Reference['kind'],
): 'CALLS' | 'ACCESSES' | 'EXTENDS' | 'USES' | undefined {
  switch (kind) {
    case 'call':
      return 'CALLS';
    case 'read':
    case 'write':
      return 'ACCESSES';
    case 'inherits':
      return 'EXTENDS';
    case 'type-reference':
      return 'USES';
    case 'import-use':
      return undefined;
    default:
      return undefined;
  }
}

/**
 * Populate `ownerId` on Method/Function/Field defs that live structurally
 * inside a `Class` scope.
 *
 * The scope extractor explicitly does NOT set `ownerId` (see
 * `scope-extractor.ts:449-457`); the design comment defers it to a
 * "finalize follow-up pass that sees every def already in place." That
 * pass doesn't exist yet centrally — building it generically here would
 * require knowing per-language ownership rules (Python: methods belong
 * to the lexically enclosing class; Ruby: explicit `class << self`;
 * etc.).
 *
 * Python's rule is simple — direct lexical containment — so we apply it
 * locally before finalize runs. Without this, `MethodRegistry.lookup`
 * Step 2 (`collectOwnedMembers`) returns no candidates because no def
 * has the receiver class as its owner, and receiver-typed calls like
 * `model.validate()` resolve to nothing.
 *
 * Mutates `parsed.localDefs` in place via type cast — `SymbolDefinition`
 * is `readonly` for consumers but the extractor returns plain objects.
 * Defs are shared by reference between `localDefs` and `Scope.ownedDefs`,
 * so this single mutation is visible from both sides.
 */
function populateMethodOwnerIds(parsed: ParsedFile): void {
  // Build a `(parent scope id) → (class def in that parent's chain)` map.
  // Python scope topology (per the extractor):
  //   Module
  //     └─ Class scope     ← `ownedDefs: [Class def]`
  //          └─ Function scope ← `ownedDefs: [Function def]`
  // So a method's `ownerId` is the Class def owned by its **parent**
  // scope (when that parent is a Class scope).
  const scopesById = new Map<ScopeId, Scope>();
  for (const scope of parsed.scopes) scopesById.set(scope.id, scope);

  for (const scope of parsed.scopes) {
    if (scope.parent === null) continue;
    const parentScope = scopesById.get(scope.parent);
    if (parentScope === undefined || parentScope.kind !== 'Class') continue;

    // The parent Class scope owns the Class def itself. Pick the first
    // class-kind def in that scope (Python only has one class-def per
    // class scope).
    const classDef = parentScope.ownedDefs.find((d) => d.type === 'Class');
    if (classDef === undefined) continue;

    // Mutate `ownerId` in place on every def owned by this scope. Defs
    // are referenced from both `parsed.localDefs` and `Scope.ownedDefs`
    // — one write covers both.
    for (const def of scope.ownedDefs) {
      (def as { ownerId?: string }).ownerId = classDef.nodeId;
    }
  }
}

/**
 * Emit one File→File IMPORTS edge per linked `ImportEdge`. Deduplicates
 * by `(sourceFile, targetFile)` so multi-symbol imports from the same
 * module collapse to a single edge — matching the legacy schema.
 */
function emitImportEdges(
  graph: KnowledgeGraph,
  imports: ReadonlyMap<ScopeId, readonly ImportEdge[]>,
  scopeTree: ReturnType<typeof finalizeScopeModel>['scopeTree'],
): number {
  const seen = new Set<string>();
  let emitted = 0;

  for (const [scopeId, edges] of imports) {
    const scope = scopeTree.getScope(scopeId);
    if (scope === undefined) continue;
    const sourceFile = scope.filePath;

    for (const edge of edges) {
      if (edge.targetFile === null) continue;
      if (edge.targetFile === sourceFile) continue;

      const dedupKey = `${sourceFile}->${edge.targetFile}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);

      const sourceId = generateId('File', sourceFile);
      const targetId = generateId('File', edge.targetFile);
      graph.addRelationship({
        id: generateId('IMPORTS', dedupKey),
        sourceId,
        targetId,
        type: 'IMPORTS',
        confidence: 1.0,
        reason: 'python-scope: import',
      });
      emitted++;
    }
  }

  return emitted;
}

// `BindingRef` is intentionally exported back through the public surface
// so callers extending the orchestrator's hook adapters don't have to
// chase the import to `gitnexus-shared`. Pass-through only.
export type { BindingRef };
