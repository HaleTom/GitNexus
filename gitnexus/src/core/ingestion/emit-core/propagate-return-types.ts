/**
 * Cross-file return-type typeBinding propagation + post-finalize
 * chain re-follow.
 *
 * **Why this lives in emit-core:** the algorithm is language-agnostic.
 * Every language with cross-file callable imports needs the same
 * mirror-binding step, otherwise `u = f(); u.save()` only resolves
 * when `f` is in the same file as the call.
 *
 * **Mutation contract (Contract Invariant I3 + I6):**
 *   - Mutates `Scope.typeBindings` (a plain `new Map(...)` from
 *     `draftToScope`, NOT frozen — intentional, do not freeze).
 *   - MUST run AFTER `finalizeScopeModel` (so `indexes.bindings` is
 *     populated) but BEFORE `resolveReferenceSites` (so resolution
 *     sees the propagated types).
 *
 * Generic; promoted from `python-scope-emit.ts` per the emit-core
 * generalization plan.
 */

import type { ParsedFile, Scope, ScopeId, TypeRef } from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../model/scope-resolution-indexes.js';

/** Max chain depth for the post-finalize re-follow. */
const RECHAIN_MAX_DEPTH = 8;

/** Walk `ref.rawName` through the scope chain's typeBindings looking
 *  for a terminal class-like rawName. Mirrors the in-extractor
 *  `followChainedRef` but operates on post-finalize Scope objects so
 *  it can see imported return-types propagated by
 *  `propagateImportedReturnTypes`. */
export function followChainPostFinalize(
  start: TypeRef,
  fromScopeId: ScopeId,
  scopes: ScopeResolutionIndexes,
): TypeRef {
  let current = start;
  const visited = new Set<string>();
  for (let depth = 0; depth < RECHAIN_MAX_DEPTH; depth++) {
    if (current.rawName.includes('.')) return current;
    let scopeId: ScopeId | null = fromScopeId;
    let next: TypeRef | undefined;
    while (scopeId !== null) {
      const scope = scopes.scopeTree.getScope(scopeId);
      if (scope === undefined) break;
      next = scope.typeBindings.get(current.rawName);
      if (next !== undefined && next !== current) break;
      next = undefined;
      scopeId = scope.parent;
    }
    if (next === undefined) return current;
    if (visited.has(next.rawName)) return current;
    visited.add(next.rawName);
    current = next;
  }
  return current;
}

/**
 * Copy return-type typeBindings across module boundaries via import
 * bindings. For each module-scope import like `from x import f`, look
 * up `f` in the source file's module-scope typeBindings (which carries
 * `f → ReturnType` from the language's return-type annotation
 * capture) and mirror that binding into the importer's module scope.
 *
 * After propagation, re-runs the chain-follow on every scope's
 * typeBindings — the in-extractor pass-4 ran before propagation and
 * missed any chain whose terminal lived in a foreign file.
 */
export function propagateImportedReturnTypes(
  parsedFiles: readonly ParsedFile[],
  indexes: ScopeResolutionIndexes,
): void {
  // Index module scopes by filePath for fast cross-file lookup.
  const moduleScopeByFile = new Map<string, Scope>();
  for (const parsed of parsedFiles) {
    const moduleScope = parsed.scopes.find((s) => s.kind === 'Module');
    if (moduleScope !== undefined) moduleScopeByFile.set(parsed.filePath, moduleScope);
  }

  for (const parsed of parsedFiles) {
    const importerModule = moduleScopeByFile.get(parsed.filePath);
    if (importerModule === undefined) continue;
    const finalizedBindings = indexes.bindings.get(importerModule.id);
    if (finalizedBindings === undefined) continue;

    for (const [localName, refs] of finalizedBindings) {
      // Skip if importer already has a typeBinding for this name (e.g.
      // an explicit local annotation should win over import-derived).
      if (importerModule.typeBindings.has(localName)) continue;

      for (const ref of refs) {
        if (ref.origin !== 'import' && ref.origin !== 'reexport') continue;
        const sourceModule = moduleScopeByFile.get(ref.def.filePath);
        if (sourceModule === undefined) continue;

        // The source file's typeBinding is keyed by the def's simple
        // name (e.g. `get_user`), not the importer's local alias. Use
        // the def's qualifiedName tail.
        const qn = ref.def.qualifiedName;
        if (qn === undefined) continue;
        const dot = qn.lastIndexOf('.');
        const sourceName = dot === -1 ? qn : qn.slice(dot + 1);

        const sourceTypeRef = sourceModule.typeBindings.get(sourceName);
        if (sourceTypeRef === undefined) continue;

        // Mirror the binding under the importer's local alias —
        // mutating typeBindings is safe because draftToScope produced
        // a non-frozen Map.
        (importerModule.typeBindings as Map<string, TypeRef>).set(localName, sourceTypeRef);
        break;
      }
    }
  }

  // Re-follow chains across every scope so chains terminating in a
  // freshly-propagated import binding resolve to their terminal type.
  for (const parsed of parsedFiles) {
    for (const scope of parsed.scopes) {
      for (const [name, ref] of scope.typeBindings) {
        const resolved = followChainPostFinalize(ref, scope.id, indexes);
        if (resolved !== ref) {
          (scope.typeBindings as Map<string, TypeRef>).set(name, resolved);
        }
      }
    }
  }
}
