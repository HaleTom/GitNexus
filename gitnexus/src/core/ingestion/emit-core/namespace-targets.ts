/**
 * Build a per-file `localName → targetFilePath` map over the file's
 * module-scope namespace-kind import edges.
 *
 * Namespace imports (`import X`, `import X as Y`) bind a name that can
 * appear as a receiver in member calls (`X.foo()`, `Y.foo()`). Named
 * imports (`from X import foo`) bind `foo` directly and are a different
 * resolution path.
 *
 * Why not consult `scope.bindings` directly? For namespace imports
 * where the target module has no self-named def,
 * `finalize-algorithm.ts:540` skips binding creation entirely, so
 * `scope.bindings.get('X')` returns undefined. We iterate
 * `indexes.imports` to recover those targets.
 *
 * Next-consumer contract: any language with namespace-style imports
 * (TypeScript `import * as X`, Java static import, Ruby `require`)
 * uses this directly. `ParsedImport.kind === 'namespace'` is the
 * cross-language hook.
 */

import type { ParsedFile } from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../model/scope-resolution-indexes.js';

export function collectNamespaceTargets(
  parsed: ParsedFile,
  scopes: ScopeResolutionIndexes,
): Map<string, string> {
  const out = new Map<string, string>();
  const moduleEdges = scopes.imports.get(parsed.moduleScope);
  if (moduleEdges === undefined) return out;

  const namespaceLocals = new Set<string>();
  for (const imp of parsed.parsedImports) {
    if (imp.kind === 'namespace') namespaceLocals.add(imp.localName);
  }

  for (const edge of moduleEdges) {
    if (edge.targetFile === null) continue;
    if (!namespaceLocals.has(edge.localName)) continue;
    out.set(edge.localName, edge.targetFile);
  }
  return out;
}
