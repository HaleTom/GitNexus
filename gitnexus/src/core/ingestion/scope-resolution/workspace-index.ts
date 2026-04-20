/**
 * `WorkspaceResolutionIndex` — pre-computed lookup tables built ONCE
 * per resolution run, after `populateOwners` and before any
 * resolution pass.
 *
 * Why: the resolution passes hammer the same lookup patterns
 * thousands of times per run. Without an index, every
 * `findOwnedMember` / `findExportedDef` / scope-by-defId lookup
 * walks `parsedFiles` linearly — O(N × D) per call, multiplied by
 * the (N × S × M) call count from the receiver-bound MRO chain.
 * One pre-built index turns those into O(1) `Map.get`.
 *
 * Build cost is one O(totalDefs) pass over `parsedFiles`. Pays for
 * itself on the very first MRO walk.
 *
 * The index is read-only after construction — passes that create
 * defs (e.g. provider.populateOwners) MUST run before the index is
 * built.
 */

import type { ParsedFile, Scope, SymbolDefinition } from 'gitnexus-shared';
import { simpleQualifiedName } from './graph-bridge/ids.js';

export interface WorkspaceResolutionIndex {
  /** Class def `nodeId` → that class's `Scope`. */
  readonly classScopeByDefId: ReadonlyMap<string, Scope>;

  /** Owner def `nodeId` → (simple-member-name → owned `SymbolDefinition`).
   *  Replaces `findOwnedMember`'s O(N × D) walk with O(1) lookup. */
  readonly memberByOwner: ReadonlyMap<string, ReadonlyMap<string, SymbolDefinition>>;

  /** File path → (simple-name → first matching `SymbolDefinition`).
   *  Replaces `findExportedDef`'s O(N × D) walk. */
  readonly defsByFileAndName: ReadonlyMap<string, ReadonlyMap<string, SymbolDefinition>>;

  /** Workspace-wide simple-name fallback: simple-name → all matching
   *  Function/Method/Constructor defs. Backs the
   *  `findExportedDefByName` fallback scan. */
  readonly callablesBySimpleName: ReadonlyMap<string, readonly SymbolDefinition[]>;

  /** Module scope by file path — used by cross-file return-type
   *  propagation and by per-file imports lookup. */
  readonly moduleScopeByFile: ReadonlyMap<string, Scope>;
}

export function buildWorkspaceResolutionIndex(
  parsedFiles: readonly ParsedFile[],
): WorkspaceResolutionIndex {
  const classScopeByDefId = new Map<string, Scope>();
  const moduleScopeByFile = new Map<string, Scope>();
  const memberByOwner = new Map<string, Map<string, SymbolDefinition>>();
  const defsByFileAndName = new Map<string, Map<string, SymbolDefinition>>();
  const callablesBySimpleName = new Map<string, SymbolDefinition[]>();

  for (const parsed of parsedFiles) {
    // module scope by file
    const moduleScope = parsed.scopes.find((s) => s.kind === 'Module');
    if (moduleScope !== undefined) moduleScopeByFile.set(parsed.filePath, moduleScope);

    // class scopes
    for (const scope of parsed.scopes) {
      if (scope.kind !== 'Class') continue;
      const cd = scope.ownedDefs.find((d) => d.type === 'Class');
      if (cd !== undefined) classScopeByDefId.set(cd.nodeId, scope);
    }

    // per-file by-simple-name index + callable fallback
    let fileBucket = defsByFileAndName.get(parsed.filePath);
    if (fileBucket === undefined) {
      fileBucket = new Map();
      defsByFileAndName.set(parsed.filePath, fileBucket);
    }
    for (const def of parsed.localDefs) {
      const simple = simpleQualifiedName(def);
      if (simple === undefined) continue;
      // First-seen wins to match `findExportedDef` semantics.
      if (!fileBucket.has(simple)) fileBucket.set(simple, def);

      if (def.type === 'Function' || def.type === 'Method' || def.type === 'Constructor') {
        let bucket = callablesBySimpleName.get(simple);
        if (bucket === undefined) {
          bucket = [];
          callablesBySimpleName.set(simple, bucket);
        }
        bucket.push(def);
      }

      // member-by-owner: requires populateOwners to have run first.
      const ownerId = (def as { ownerId?: string }).ownerId;
      if (ownerId !== undefined) {
        let memberBucket = memberByOwner.get(ownerId);
        if (memberBucket === undefined) {
          memberBucket = new Map();
          memberByOwner.set(ownerId, memberBucket);
        }
        // First-seen wins to match `findOwnedMember` semantics.
        if (!memberBucket.has(simple)) memberBucket.set(simple, def);
      }
    }
  }

  return {
    classScopeByDefId,
    memberByOwner,
    defsByFileAndName,
    callablesBySimpleName,
    moduleScopeByFile,
  };
}
