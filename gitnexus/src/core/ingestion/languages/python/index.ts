/**
 * Python scope-resolution hooks (RFC #909 Ring 3, RFC §5).
 *
 * Public API barrel. Consumers should import from this file rather than
 * the individual modules — that keeps the per-hook organization an
 * implementation detail we can refactor without touching the provider
 * wiring.
 *
 * Module layout (each file is a single concern):
 *
 *   - `query.ts`                — tree-sitter query string + lazy parser/query singletons
 *   - `ast-utils.ts`            — generic `SyntaxNode` helpers
 *   - `import-decomposer.ts`    — `import a, b` / `from m import x, y` → one match per name
 *   - `receiver-binding.ts`     — synthesize `self`/`cls` type bindings on methods
 *   - `captures.ts`        — `emitPythonScopeCaptures` (top-level orchestrator)
 *   - `interpret.ts`            — capture-match → `ParsedImport` / `ParsedTypeBinding`
 *   - `merge-bindings.ts`       — Python LEGB precedence
 *   - `arity.ts`                — Python arity check (`*args`, `**kwargs`, defaults)
 *   - `import-target.ts`        — `(ParsedImport, WorkspaceIndex) → file path` adapter
 *   - `simple-hooks.ts`         — small/no-op hooks made explicit
 */

export { PYTHON_SCOPE_QUERY } from './query.js';
export { emitPythonScopeCaptures } from './captures.js';
export { interpretPythonImport, interpretPythonTypeBinding } from './interpret.js';
export { pythonMergeBindings } from './merge-bindings.js';
export { pythonArityCompatibility } from './arity.js';
export { resolvePythonImportTarget, type PythonResolveContext } from './import-target.js';
export {
  pythonShouldCreateScope,
  pythonBindingScopeFor,
  pythonImportOwningScope,
  pythonShouldShadow,
  pythonReceiverBinding,
} from './simple-hooks.js';
