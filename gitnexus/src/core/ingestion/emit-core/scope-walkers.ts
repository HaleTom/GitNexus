/**
 * Scope-chain lookup primitives shared across language providers.
 *
 * Four functions:
 *   - `findReceiverTypeBinding` — walk scope.typeBindings up the chain
 *     for a receiver name.
 *   - `findClassBindingInScope` — walk scope.bindings + indexes.bindings
 *     (pre-finalize + post-finalize) for a class-kind binding. Dual-
 *     source is required because the cross-file finalize pass produces
 *     a separate bindings map that is not merged back into scope.bindings.
 *   - `findOwnedMember` — find a method/field owned by a class def
 *     across all parsed files by (ownerId, simpleName).
 *   - `findExportedDef` — find a file-level exported def (top-of-module
 *     class / function) by simpleName.
 *
 * Next-consumer contract: every OO or module-capable language hits the
 * same pre-finalize / post-finalize binding split and the same
 * "resolve member on owner with MRO" pattern. All four are reusable
 * as-is for TypeScript, Java, Kotlin, Ruby, etc.
 */

import type { ParsedFile, ScopeId, SymbolDefinition, TypeRef } from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../model/scope-resolution-indexes.js';
import { simpleQualifiedName } from './graph-id.js';

/**
 * Walk the scope chain from `startScope` looking for a typeBinding
 * named `receiverName`. Returns the TypeRef or undefined if no binding
 * exists in the chain.
 */
export function findReceiverTypeBinding(
  startScope: ScopeId,
  receiverName: string,
  scopes: ScopeResolutionIndexes,
): TypeRef | undefined {
  let currentId: ScopeId | null = startScope;
  const visited = new Set<ScopeId>();
  while (currentId !== null) {
    if (visited.has(currentId)) return undefined;
    visited.add(currentId);
    const scope = scopes.scopeTree.getScope(currentId);
    if (scope === undefined) return undefined;
    const typeRef = scope.typeBindings.get(receiverName);
    if (typeRef !== undefined) return typeRef;
    currentId = scope.parent;
  }
  return undefined;
}

/**
 * Look up a class-kind binding by name in the given scope's chain.
 *
 * Walks the scope chain upward and consults TWO sources at each step:
 *   1. `scope.bindings` — populated during scope-extraction Pass 2 with
 *      local declarations (`origin: 'local'`).
 *   2. `indexes.bindings` — populated by the cross-file finalize pass
 *      with import/namespace/wildcard/reexport origins.
 *
 * Without (2) we'd miss every cross-file class-receiver call.
 */
export function findClassBindingInScope(
  startScope: ScopeId,
  receiverName: string,
  scopes: ScopeResolutionIndexes,
): SymbolDefinition | undefined {
  let currentId: ScopeId | null = startScope;
  const visited = new Set<ScopeId>();
  while (currentId !== null) {
    if (visited.has(currentId)) return undefined;
    visited.add(currentId);
    const scope = scopes.scopeTree.getScope(currentId);
    if (scope === undefined) return undefined;

    const localBindings = scope.bindings.get(receiverName);
    if (localBindings !== undefined) {
      for (const b of localBindings) {
        if (b.def.type === 'Class' || b.def.type === 'Interface') return b.def;
      }
    }

    const finalizedScopeBindings = scopes.bindings.get(currentId);
    const importedBindings = finalizedScopeBindings?.get(receiverName);
    if (importedBindings !== undefined) {
      for (const b of importedBindings) {
        if (b.def.type === 'Class' || b.def.type === 'Interface') return b.def;
      }
    }

    currentId = scope.parent;
  }
  return undefined;
}

/**
 * Look up a callable (Function/Method/Constructor) by name in the
 * given scope's chain. Uses the dual-source pattern (scope.bindings +
 * indexes.bindings) so cross-file imports are visible — without it
 * free calls to imported functions never resolve via the post-pass.
 *
 * Mirrors `findClassBindingInScope` exactly; only the accepted
 * def-type predicate differs.
 */
export function findCallableBindingInScope(
  startScope: ScopeId,
  callableName: string,
  scopes: ScopeResolutionIndexes,
): SymbolDefinition | undefined {
  let currentId: ScopeId | null = startScope;
  const visited = new Set<ScopeId>();
  while (currentId !== null) {
    if (visited.has(currentId)) return undefined;
    visited.add(currentId);
    const scope = scopes.scopeTree.getScope(currentId);
    if (scope === undefined) return undefined;

    const localBindings = scope.bindings.get(callableName);
    if (localBindings !== undefined) {
      for (const b of localBindings) {
        if (b.def.type === 'Function' || b.def.type === 'Method' || b.def.type === 'Constructor') {
          return b.def;
        }
      }
    }

    const finalizedScopeBindings = scopes.bindings.get(currentId);
    const importedBindings = finalizedScopeBindings?.get(callableName);
    if (importedBindings !== undefined) {
      for (const b of importedBindings) {
        if (b.def.type === 'Function' || b.def.type === 'Method' || b.def.type === 'Constructor') {
          return b.def;
        }
      }
    }

    currentId = scope.parent;
  }
  return undefined;
}

/**
 * Walk a scope chain upward looking for the innermost enclosing
 * Class scope and return that class's def. Used by per-language
 * `super` receiver branches to discover the dispatch base.
 */
export function findEnclosingClassDef(
  startScope: ScopeId,
  scopes: ScopeResolutionIndexes,
): SymbolDefinition | undefined {
  let currentId: ScopeId | null = startScope;
  const visited = new Set<ScopeId>();
  while (currentId !== null) {
    if (visited.has(currentId)) return undefined;
    visited.add(currentId);
    const scope = scopes.scopeTree.getScope(currentId);
    if (scope === undefined) return undefined;
    if (scope.kind === 'Class') {
      const cd = scope.ownedDefs.find((d) => d.type === 'Class');
      if (cd !== undefined) return cd;
    }
    currentId = scope.parent;
  }
  return undefined;
}

/**
 * Find a free-function def by simple name across all parsed files,
 * preferring scope-chain-visible bindings (import + finalized scope
 * bindings) before falling back to a workspace-wide simple-name scan.
 *
 * The fallback scan is intentionally loose so per-language compound
 * resolvers can find a callable target even when the binding chain
 * doesn't surface it (e.g. cross-package re-exports the finalize
 * pass missed). Strictly-typed languages may want to disable the
 * fallback by simply not calling this helper from their compound
 * resolver.
 */
export function findExportedDefByName(
  name: string,
  inScope: ScopeId,
  scopes: ScopeResolutionIndexes,
  parsedFiles: readonly ParsedFile[],
): SymbolDefinition | undefined {
  let currentId: ScopeId | null = inScope;
  const visited = new Set<ScopeId>();
  while (currentId !== null) {
    if (visited.has(currentId)) break;
    visited.add(currentId);
    const scope = scopes.scopeTree.getScope(currentId);
    if (scope === undefined) break;
    const local = scope.bindings.get(name);
    if (local !== undefined) {
      for (const b of local) {
        if (b.def.type === 'Function' || b.def.type === 'Method') return b.def;
      }
    }
    const finalized = scopes.bindings.get(currentId)?.get(name);
    if (finalized !== undefined) {
      for (const b of finalized) {
        if (b.def.type === 'Function' || b.def.type === 'Method') return b.def;
      }
    }
    currentId = scope.parent;
  }
  // Fallback: scan parsed files for any matching simple-name def.
  for (const f of parsedFiles) {
    for (const def of f.localDefs) {
      if (def.type !== 'Function' && def.type !== 'Method') continue;
      const qn = def.qualifiedName;
      if (qn === undefined) continue;
      const simple = qn.lastIndexOf('.') === -1 ? qn : qn.slice(qn.lastIndexOf('.') + 1);
      if (simple === name) return def;
    }
  }
  return undefined;
}

/**
 * Find a member of a class by simple name — a def whose `ownerId`
 * matches the class's nodeId and whose simple name matches `memberName`.
 */
export function findOwnedMember(
  ownerDefId: string,
  memberName: string,
  parsedFiles: readonly ParsedFile[],
): SymbolDefinition | undefined {
  for (const f of parsedFiles) {
    for (const def of f.localDefs) {
      if (def.ownerId !== ownerDefId) continue;
      if (simpleQualifiedName(def) !== memberName) continue;
      return def;
    }
  }
  return undefined;
}

/**
 * Find a file-level exported def (top-of-module class / function /
 * variable) by `simpleName` in a given target file's `parsedFile.localDefs`.
 */
export function findExportedDef(
  targetFile: string,
  memberName: string,
  parsedFiles: readonly ParsedFile[],
): SymbolDefinition | undefined {
  for (const f of parsedFiles) {
    if (f.filePath !== targetFile) continue;
    for (const def of f.localDefs) {
      if (simpleQualifiedName(def) !== memberName) continue;
      return def;
    }
    return undefined;
  }
  return undefined;
}
