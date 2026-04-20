/**
 * Trivial / no-op-ish hooks for the Python provider. Kept together
 * because each is a few lines and they share a common theme: they exist
 * to make the provider's choice explicit (rather than relying on
 * "absence == default") so reviewers don't have to re-derive the
 * analysis.
 */

import type {
  BindingRef,
  CaptureMatch,
  ParsedImport,
  Scope,
  ScopeId,
  ScopeTree,
  TypeRef,
} from 'gitnexus-shared';

// ─── shouldCreateScope ────────────────────────────────────────────────────

/** We never emit `@scope.block` for Python (no block scope in the
 *  language), so this hook only ever sees scopes we explicitly want to
 *  materialize. Always-on. */
export function pythonShouldCreateScope(_captures: CaptureMatch): boolean {
  return true;
}

// ─── bindingScopeFor ──────────────────────────────────────────────────────

/** Python has no block scope, so the central extractor's "innermost
 *  enclosing scope" default is already correct: `for x in …` creates
 *  `x` in the enclosing function/module scope (because we never emit a
 *  `@scope.block` for the for-loop body), comprehension variables stay
 *  in their expression context, etc. Returns `null` to delegate. */
export function pythonBindingScopeFor(
  _decl: CaptureMatch,
  _innermost: Scope,
  _tree: ScopeTree,
): ScopeId | null {
  return null;
}

// ─── importOwningScope ────────────────────────────────────────────────────

/** Function-local `from x import Y` should attach the binding to the
 *  function scope, not the module. Class-body imports (rare but legal —
 *  `class A: import x` makes `x` a class attribute) attach to the class.
 *  Module-level imports delegate to the central default. */
export function pythonImportOwningScope(
  _imp: ParsedImport,
  innermost: Scope,
  _tree: ScopeTree,
): ScopeId | null {
  if (innermost.kind === 'Function' || innermost.kind === 'Class') return innermost.id;
  return null;
}

// ─── shouldShadow ─────────────────────────────────────────────────────────

/** Standard Python lexical scoping. The central default (`true` — any
 *  binding shadows) is correct. Wildcard transparency is handled by
 *  `pythonMergeBindings`, not by toggling shadowing here.
 *
 *  Implemented as an explicit pass-through so reviewers don't have to
 *  re-derive the analysis from absence. */
export function pythonShouldShadow(_scope: Scope, _bindings: readonly BindingRef[]): boolean {
  return true;
}

// ─── receiverBinding ──────────────────────────────────────────────────────

/** Look up `self` or `cls` in the function scope's type bindings.
 *  Returns `null` for free functions (no `self`/`cls`) and for
 *  non-Function scopes. */
export function pythonReceiverBinding(functionScope: Scope): TypeRef | null {
  if (functionScope.kind !== 'Function') return null;
  return functionScope.typeBindings.get('self') ?? functionScope.typeBindings.get('cls') ?? null;
}
