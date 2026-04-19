/**
 * Python scope-resolution hooks (RFC #909 Ring 3, RFC §5).
 *
 * Implements every `LanguageProvider` scope hook used by the central
 * `ScopeExtractor` + finalize pipeline + `Registry.lookup` for Python.
 * Python is the **first** language to migrate to scope-based registry
 * resolution; the canonical capture vocabulary lives in `./scopes.scm`
 * (kept in source for human-readable spec) and is mirrored into the
 * `PYTHON_SCOPE_QUERY` template literal below (the runtime path —
 * matches the existing convention in `tree-sitter-queries.ts`).
 *
 * ## Hook coverage
 *
 *   - `emitScopeCaptures`  — owns its own `Parser` instance; runs the
 *     scope query against `tree-sitter-python` and groups raw query
 *     matches into `CaptureMatch[]` for the central extractor. Also
 *     synthesizes captures the static query can't easily express:
 *       * `@type-binding.self` for `self` inside instance methods
 *       * `@type-binding.cls`  for `cls`  inside `@classmethod`-decorated methods
 *       * One `@import.statement` per imported name in `import a, b` /
 *         `from m import x, y` so `interpretImport` sees a single name
 *         per match (the central extractor expects one `ParsedImport`
 *         per match).
 *   - `interpretImport`    — covers `import X`, `import X as Y`,
 *     `from X import Y`, `from X import Y as Z`, `from X import *`,
 *     PEP-328 dotted relative imports, and `importlib.import_module(...)`
 *     (emitted as `dynamic-unresolved`).
 *   - `interpretTypeBinding` — converts parameter annotations and
 *     synthesized `self`/`cls` captures into `ParsedTypeBinding`s.
 *   - `shouldCreateScope`  — Python has no block scope; we never emit
 *     `@scope.block` so this hook is a defensive no-op (returns `true`
 *     for everything that does survive).
 *   - `bindingScopeFor`    — `null` for every declaration: the default
 *     "innermost enclosing scope" is correct for Python because we
 *     suppress block scopes at emit time, so `for`-targets and
 *     comprehension variables already resolve to the enclosing function.
 *   - `importOwningScope`  — function-local `from x import Y` attaches
 *     to the innermost Function/Module/Class scope (default walks to
 *     Module; we override to keep function-local imports local).
 *   - `mergeBindings`      — Python LEGB precedence: local > import >
 *     wildcard. Local declarations shadow imports; explicit imports
 *     shadow `from x import *`.
 *   - `shouldShadow`       — `true` (Python's standard lexical-scoping
 *     behavior is the central default; the hook exists for `from x
 *     import *` transparency, which is handled in `mergeBindings` by
 *     dropping wildcard bindings when a local exists, *not* by toggling
 *     shadowing). Documented as the explicit no-op so reviewers don't
 *     re-derive the analysis.
 *   - `receiverBinding`    — looks up `self` / `cls` in the function
 *     scope's `typeBindings`. Returns the `TypeRef` so `Registry.lookup`
 *     Step 2 can resolve owner-scoped method dispatch. Today
 *     `lookupReceiverType` reads the same map directly via
 *     `IMPLICIT_RECEIVERS`; this hook supplies the same answer through
 *     the named contract, future-proofing against languages where the
 *     receiver name is something other than `self`/`this`.
 *   - `arityCompatibility` — Python `*args`, `**kwargs`, defaults,
 *     keyword-only params: returns `'compatible'` when the call's
 *     positional count fits between `requiredParameterCount` and
 *     `parameterCount` (or there's a `*args`); `'incompatible'` for a
 *     hard miss; `'unknown'` when the def's metadata is incomplete.
 *   - `resolveImportTarget` — adapter that delegates to the existing
 *     `pythonImportConfig` import resolver chain (PEP-328 relative
 *     resolution + standard suffix matching). Mirrors the wiring in
 *     `import-target-adapter.ts` for the other languages.
 *
 * ## `global` / `nonlocal`
 *
 * Python's `global` and `nonlocal` declarations *re-direct* a name's
 * binding scope without changing visibility: a `global x` inside `f()`
 * means writes to `x` mutate the module-scope `x`, not a local. From a
 * **read-side / call-resolution** point of view this is invisible — the
 * name still resolves via LEGB scope-chain walk, and the local-write
 * inside `f` is functionally identical to a write-through-alias to the
 * module's `x`.
 *
 * For Ring 3 we therefore treat both as no-ops: `global x` and
 * `nonlocal x` produce no `@declaration.*` capture, no `BindingRef`
 * shadow, no `mergeBindings` override. Calls and reads of `x` resolve
 * via the standard scope-chain walk to the module/enclosing-function
 * binding, which is what every reasonable consumer of the call graph
 * expects. Edge case: `global x` followed by `x = 1` in a function with
 * no module-scope `x` is a *new* module binding at runtime; we under-
 * report this (the `@declaration.variable` lands in the function scope
 * because that's where the assignment lexically lives). Documenting
 * the gap; fix is a Ring 4 concern when `global`/`nonlocal` get first-
 * class capture support.
 */

import Parser from 'tree-sitter';
import Python from 'tree-sitter-python';
import {
  type Capture,
  type CaptureMatch,
  type ParsedImport,
  type ParsedTypeBinding,
  type Scope,
  type ScopeId,
  type ScopeTree,
  type SymbolDefinition,
  type Callsite,
  type TypeRef,
  type BindingRef,
  type WorkspaceIndex,
} from 'gitnexus-shared';
import type { SyntaxNode } from '../../utils/ast-helpers.js';
import { resolvePythonImportInternal } from '../../import-resolvers/python.js';

// ─── Tree-sitter query string ──────────────────────────────────────────────
//
// Mirrors `./scopes.scm` (kept in source for spec/readability). When you
// edit one, edit both — both must agree because tests reference the
// embedded constant and the file documents the contract.

export const PYTHON_SCOPE_QUERY = `
;; Scopes
(module) @scope.module
(class_definition) @scope.class
(function_definition) @scope.function

;; Declarations
(class_definition
  name: (identifier) @declaration.name) @declaration.class

(function_definition
  name: (identifier) @declaration.name) @declaration.function

(assignment
  left: (identifier) @declaration.name) @declaration.variable

;; Declarations: for-loop target — Python for-statements do NOT introduce
;; a new scope, so the loop variable binds in the enclosing function/module
;; scope. We emit it as a Variable declaration so Pass-2 attaches it.
(for_statement
  left: (identifier) @declaration.name) @declaration.variable

;; Imports — single anchor per statement; interpretImport decomposes
(import_statement) @import.statement
(import_from_statement) @import.statement

;; Type bindings (parameter annotations)
(typed_parameter
  (identifier) @type-binding.name
  type: (type) @type-binding.type) @type-binding.parameter

(typed_default_parameter
  name: (identifier) @type-binding.name
  type: (type) @type-binding.type) @type-binding.parameter

;; References — calls
(call
  function: (identifier) @reference.name) @reference.call.free

(call
  function: (attribute
    object: (_) @reference.receiver
    attribute: (identifier) @reference.name)) @reference.call.member
`;

// ─── Lazy parser singleton ─────────────────────────────────────────────────

let _parser: Parser | null = null;
let _query: Parser.Query | null = null;

function getParser(): Parser {
  if (_parser === null) {
    _parser = new Parser();
    _parser.setLanguage(Python as Parameters<Parser['setLanguage']>[0]);
  }
  return _parser;
}

function getQuery(): Parser.Query {
  if (_query === null) {
    _query = new Parser.Query(
      Python as Parameters<Parser['setLanguage']>[0],
      PYTHON_SCOPE_QUERY,
    );
  }
  return _query;
}

// ─── emitScopeCaptures ─────────────────────────────────────────────────────

/**
 * Parse a Python source file with tree-sitter-python and emit
 * `CaptureMatch[]` matching RFC §5.1 conventions. One match per query
 * pattern firing, plus synthesized matches that the static query can't
 * conveniently express:
 *
 *   * `@import.statement` per imported name (split out from
 *     `import a, b` and `from m import x, y`)
 *   * `@type-binding.self` and `@type-binding.cls` from method first
 *     parameters
 *
 * Pure given the input source text. No I/O, no globals consulted.
 */
export function emitPythonScopeCaptures(
  sourceText: string,
  _filePath: string,
): readonly CaptureMatch[] {
  const parser = getParser();
  const query = getQuery();

  const tree = parser.parse(sourceText);
  const rawMatches = query.matches(tree.rootNode);

  const out: CaptureMatch[] = [];

  for (const m of rawMatches) {
    // Group captures by their tag name. Tree-sitter `Match.captures` is
    // already structured as `{ name: string; node: SyntaxNode }[]`.
    const grouped: Record<string, Capture> = {};
    for (const c of m.captures) {
      // The central extractor expects capture names to be prefixed with
      // `@`. tree-sitter strips the leading `@`, so we put it back.
      const tag = '@' + c.name;
      grouped[tag] = nodeToCapture(tag, c.node);
    }
    // Anchor topic guard — empty matches (no captures whose name we
    // recognize) are silently skipped; the central extractor would
    // bucket them as `'unknown'` and drop them anyway.
    if (Object.keys(grouped).length === 0) continue;

    // ── Import-statement decomposition ────────────────────────────────
    //
    // `interpretImport` returns ONE `ParsedImport` per call. To honor
    // that contract for `import a, b` and `from m import x, y`, we
    // split here: emit one import-statement match per imported name,
    // each carrying the full statement node text + a synthesized
    // `@import.name` capture pointing at the per-name fragment.
    if (grouped['@import.statement'] !== undefined) {
      const stmtCapture = grouped['@import.statement'];
      // The statement node — both `import_statement` and
      // `import_from_statement` share the same range as the matched
      // capture, so try both type filters.
      const stmtNode =
        findNodeAtRange(tree.rootNode, stmtCapture.range, 'import_from_statement') ??
        findNodeAtRange(tree.rootNode, stmtCapture.range, 'import_statement');
      if (stmtNode !== null) {
        const split = splitImportStatement(stmtNode);
        for (const piece of split) out.push(piece);
      } else {
        // Defensive fallback: emit the raw match.
        out.push(grouped);
      }
      continue;
    }

    // ── Function-scope synthesized captures ───────────────────────────
    //
    // For each `@scope.function` we emit, we ALSO walk its first
    // parameter to detect `self` / `cls` and emit a
    // `@type-binding.self` / `@type-binding.cls` match so the central
    // Pass-4 attaches a TypeRef to the function scope's typeBindings.
    if (grouped['@scope.function'] !== undefined) {
      out.push(grouped);
      const fnNode = findNodeAtRange(
        tree.rootNode,
        grouped['@scope.function']!.range,
        'function_definition',
      );
      if (fnNode !== null) {
        const synth = synthesizeReceiverTypeBinding(fnNode);
        if (synth !== null) out.push(synth);
      }
      continue;
    }

    out.push(grouped);
  }

  return out;
}

// ─── interpretImport ───────────────────────────────────────────────────────

/**
 * Convert a `@import.statement` `CaptureMatch` (already decomposed by
 * `emitPythonScopeCaptures` — one imported name per match) into a
 * `ParsedImport`. Returns `null` if the match is malformed (wildcard
 * captures may carry only `targetRaw`).
 */
export function interpretPythonImport(captures: CaptureMatch): ParsedImport | null {
  // Markers attached by `splitImportStatement` (synthesized below):
  //   `@import.kind`  : 'plain' | 'aliased' | 'from' | 'from-alias' | 'wildcard' | 'dynamic'
  //   `@import.name`  : the imported symbol name (or module name for plain imports)
  //   `@import.alias` : the local alias name (for `as` forms)
  //   `@import.source`: the module path (always present except for `dynamic`)
  const kindCap = captures['@import.kind'];
  const nameCap = captures['@import.name'];
  const aliasCap = captures['@import.alias'];
  const sourceCap = captures['@import.source'];

  const kind = kindCap?.text;
  if (kind === undefined) return null;

  switch (kind) {
    case 'plain': {
      // `import numpy`
      if (sourceCap === undefined) return null;
      return {
        kind: 'namespace',
        localName: sourceCap.text.split('.')[0]!, // `import a.b.c` exposes `a`
        importedName: sourceCap.text,
        targetRaw: sourceCap.text,
      };
    }
    case 'aliased': {
      // `import numpy as np`
      if (sourceCap === undefined || aliasCap === undefined) return null;
      return {
        kind: 'namespace',
        localName: aliasCap.text,
        importedName: sourceCap.text,
        targetRaw: sourceCap.text,
      };
    }
    case 'from': {
      // `from m import x`
      if (sourceCap === undefined || nameCap === undefined) return null;
      return {
        kind: 'named',
        localName: nameCap.text,
        importedName: nameCap.text,
        targetRaw: sourceCap.text,
      };
    }
    case 'from-alias': {
      // `from m import x as y`
      if (sourceCap === undefined || nameCap === undefined || aliasCap === undefined) return null;
      return {
        kind: 'alias',
        localName: aliasCap.text,
        importedName: nameCap.text,
        alias: aliasCap.text,
        targetRaw: sourceCap.text,
      };
    }
    case 'wildcard': {
      // `from m import *`
      if (sourceCap === undefined) return null;
      return { kind: 'wildcard', targetRaw: sourceCap.text };
    }
    case 'dynamic': {
      // `importlib.import_module(...)` — preserved for diagnostics.
      return {
        kind: 'dynamic-unresolved',
        localName: '',
        targetRaw: sourceCap?.text ?? null,
      };
    }
    default:
      return null;
  }
}

// ─── interpretTypeBinding ──────────────────────────────────────────────────

/**
 * Build a `ParsedTypeBinding` from `@type-binding.parameter`,
 * `@type-binding.self`, or `@type-binding.cls` captures.
 */
export function interpretPythonTypeBinding(captures: CaptureMatch): ParsedTypeBinding | null {
  // Synthesized `self` / `cls` captures carry `@type-binding.name` and
  // `@type-binding.type` directly — same shape as parameter
  // annotations, source differs. The shared `@type-binding.name` and
  // `@type-binding.type` carry text we trust verbatim.
  const nameCap = captures['@type-binding.name'];
  const typeCap = captures['@type-binding.type'];
  if (nameCap === undefined || typeCap === undefined) return null;

  // Strip leading/trailing whitespace and surrounding quotes (PEP 484
  // forward references: `def f(x: "User")`).
  const rawType = stripForwardRefQuotes(typeCap.text.trim());

  let source: TypeRef['source'] = 'parameter-annotation';
  if (captures['@type-binding.self'] !== undefined) source = 'self';
  else if (captures['@type-binding.cls'] !== undefined) source = 'self'; // `cls` is a self-like receiver

  return { boundName: nameCap.text, rawTypeName: rawType, source };
}

// ─── shouldCreateScope ─────────────────────────────────────────────────────

/**
 * Defensive: we never emit `@scope.block`, so this hook only ever sees
 * scopes we explicitly want to materialize. Returns `true` for everything.
 */
export function pythonShouldCreateScope(_captures: CaptureMatch): boolean {
  return true;
}

// ─── bindingScopeFor ───────────────────────────────────────────────────────

/**
 * Python has no block scope, so the central extractor's "innermost
 * enclosing scope" default is already correct: `for x in ...` creates
 * `x` in the enclosing function/module scope (because we don't emit a
 * `@scope.block` for the for-loop), comprehension variables stay in
 * their expression context, etc.
 *
 * Returns `null` to delegate to the default in every case.
 */
export function pythonBindingScopeFor(
  _decl: CaptureMatch,
  _innermost: Scope,
  _tree: ScopeTree,
): ScopeId | null {
  return null;
}

// ─── importOwningScope ─────────────────────────────────────────────────────

/**
 * Function-local `from x import Y` should attach the binding to the
 * function scope, not the module. The central default walks to the
 * nearest Module/Namespace scope; we override to keep `Function`-local
 * imports inside the function.
 *
 * Class-body imports are unusual but legal: `class A: import x` — by
 * Python's semantics `x` is a class attribute. We attach to the class
 * scope.
 */
export function pythonImportOwningScope(
  _imp: ParsedImport,
  innermost: Scope,
  _tree: ScopeTree,
): ScopeId | null {
  if (innermost.kind === 'Function' || innermost.kind === 'Class') return innermost.id;
  // Module / Namespace / Block / Expression — fall through to default.
  return null;
}

// ─── mergeBindings ─────────────────────────────────────────────────────────

/**
 * Python LEGB precedence: a local binding shadows imports, an explicit
 * import shadows a `from x import *` wildcard. Within a tier the last
 * write wins (Python semantics).
 *
 * The `LanguageProvider.mergeBindings(scope, bindings)` contract gives
 * us every `BindingRef` for a single (scope, name) pair; we return the
 * survivors after applying the LEGB tier filter and de-duping by
 * `DefId`.
 */
export function pythonMergeBindings(
  _scope: Scope,
  bindings: readonly BindingRef[],
): readonly BindingRef[] {
  const all: BindingRef[] = [...bindings];
  if (all.length === 0) return all;

  // Tier ranking — lower wins in shadowing.
  const tier = (b: BindingRef): number => {
    switch (b.origin) {
      case 'local':
        return 0;
      case 'reexport':
      case 'import':
      case 'namespace':
        return 1;
      case 'wildcard':
        return 2;
      default:
        return 3;
    }
  };

  let bestTier = Number.POSITIVE_INFINITY;
  for (const b of all) bestTier = Math.min(bestTier, tier(b));
  const survivors = all.filter((b) => tier(b) === bestTier);

  // Dedupe by DefId — last write wins.
  const seen = new Map<string, BindingRef>();
  for (const b of survivors) seen.set(b.def.nodeId, b);
  return [...seen.values()];
}

// ─── shouldShadow ──────────────────────────────────────────────────────────

/**
 * Standard Python lexical scoping. The central default (`true` — any
 * binding shadows) is correct. Wildcard transparency is handled by
 * `mergeBindings` (drop wildcard origins when a local exists), not by
 * toggling shadowing here.
 *
 * Implemented as an explicit pass-through so reviewers don't have to
 * re-derive the analysis from absence.
 */
export function pythonShouldShadow(_scope: Scope, _bindings: readonly BindingRef[]): boolean {
  return true;
}

// ─── receiverBinding ───────────────────────────────────────────────────────

/**
 * Look up `self` or `cls` in the function scope's type bindings. Returns
 * `null` for free functions (no `self`/`cls`) and for non-Function scopes.
 */
export function pythonReceiverBinding(functionScope: Scope): TypeRef | null {
  if (functionScope.kind !== 'Function') return null;
  return (
    functionScope.typeBindings.get('self') ?? functionScope.typeBindings.get('cls') ?? null
  );
}

// ─── arityCompatibility ────────────────────────────────────────────────────

/**
 * Python arity check, accommodating `*args`, `**kwargs`, and defaults.
 *
 * The `def` metadata we care about (set by the existing Python method/
 * function extractor):
 *   - `parameterCount`         — total positional + keyword params
 *   - `requiredParameterCount` — min required (excludes defaults / `*args` / `**kwargs`)
 *   - `parameterTypes`         — present when types are known; we also use it
 *                                as a "we have varargs" hint (`'*args'`,
 *                                `'**kwargs'` literals appear in the array).
 *
 * Verdicts:
 *   - `'compatible'`   — `requiredParameterCount <= argCount <= parameterCount`,
 *                        OR the def takes `*args` (then any `argCount >= required` ok).
 *   - `'incompatible'` — argCount is below required, OR above max with no `*args`.
 *   - `'unknown'`      — def metadata is absent / incomplete.
 *
 * `'incompatible'` is a soft signal in `Registry.lookup` (penalized but
 * still considered when no compatible candidate exists), per RFC §4.
 */
export function pythonArityCompatibility(
  def: SymbolDefinition,
  callsite: Callsite,
): 'compatible' | 'unknown' | 'incompatible' {
  const max = def.parameterCount;
  const min = def.requiredParameterCount;
  if (max === undefined && min === undefined) return 'unknown';

  const argCount = callsite.arity;
  if (!Number.isFinite(argCount) || argCount < 0) return 'unknown';

  // Detect varargs/kwargs from parameterTypes if present (the Python
  // method extractor stores `'*args'`/`'**kwargs'` in this list).
  const hasVarArgs =
    def.parameterTypes !== undefined &&
    def.parameterTypes.some((t) => t === '*args' || t === '**kwargs' || t.startsWith('*'));

  if (min !== undefined && argCount < min) return 'incompatible';

  if (max !== undefined && argCount > max && !hasVarArgs) return 'incompatible';

  return 'compatible';
}

// ─── resolveImportTarget ───────────────────────────────────────────────────

/**
 * Adapter from `(ParsedImport, WorkspaceIndex)` → concrete file path.
 * Delegates to the existing `resolvePythonImportInternal` (PEP-328
 * relative resolution + standard suffix matching). The
 * `WorkspaceIndex` is opaque at this layer; consumers wire a
 * `PythonResolveContext` shape carrying `fromFile` + `allFilePaths`.
 *
 * Returning `null` lets the finalize algorithm mark the edge as
 * `linkStatus: 'unresolved'`.
 */
export interface PythonResolveContext {
  readonly fromFile: string;
  readonly allFilePaths: Set<string>;
}

export function resolvePythonImportTarget(
  parsedImport: ParsedImport,
  workspaceIndex: WorkspaceIndex,
): string | null {
  const ctx = workspaceIndex as PythonResolveContext | undefined;
  if (
    ctx === undefined ||
    typeof (ctx as { fromFile?: unknown }).fromFile !== 'string' ||
    !((ctx as { allFilePaths?: unknown }).allFilePaths instanceof Set)
  ) {
    return null;
  }
  if (parsedImport.kind === 'dynamic-unresolved') return null;
  if (parsedImport.targetRaw === null || parsedImport.targetRaw === '') return null;

  return resolvePythonImportInternal(ctx.fromFile, parsedImport.targetRaw, ctx.allFilePaths);
}

// ─── Internal helpers ──────────────────────────────────────────────────────

function nodeToCapture(name: string, node: SyntaxNode): Capture {
  return {
    name,
    range: {
      startLine: node.startPosition.row + 1, // 1-based per RFC §2.1
      startCol: node.startPosition.column,
      endLine: node.endPosition.row + 1,
      endCol: node.endPosition.column,
    },
    text: node.text,
  };
}

function rangeMatches(
  node: SyntaxNode,
  range: { startLine: number; startCol: number; endLine: number; endCol: number },
): boolean {
  return (
    node.startPosition.row + 1 === range.startLine &&
    node.startPosition.column === range.startCol &&
    node.endPosition.row + 1 === range.endLine &&
    node.endPosition.column === range.endCol
  );
}

/** Walk subtree to find a node whose range exactly matches AND whose type
 *  matches `expectedType` (when given). When multiple nodes share the
 *  range (e.g., `function_definition` and its inner `block` body for a
 *  one-liner), the type filter disambiguates to the right one.
 *  O(n) over the candidate subtree — fine for the small subset of
 *  synthesizable matches per file. */
function findNodeAtRange(
  root: SyntaxNode,
  range: { startLine: number; startCol: number; endLine: number; endCol: number },
  expectedType?: string,
): SyntaxNode | null {
  if (rangeMatches(root, range) && (expectedType === undefined || root.type === expectedType)) {
    return root;
  }
  // Walk only into subtrees whose span covers the target range — keeps
  // this from being O(file size) per call in practice.
  const startRow = range.startLine - 1;
  const endRow = range.endLine - 1;
  for (let i = 0; i < root.namedChildCount; i++) {
    const child = root.namedChild(i);
    if (child === null) continue;
    if (child.endPosition.row < startRow) continue;
    if (child.startPosition.row > endRow) break;
    const hit = findNodeAtRange(child, range, expectedType);
    if (hit !== null) return hit;
  }
  return null;
}

/**
 * Synthesize `@type-binding.self` / `@type-binding.cls` captures for the
 * first parameter of a `function_definition` that lives directly inside
 * a `class_definition`. Returns `null` for free functions, lambdas, or
 * static methods.
 */
function synthesizeReceiverTypeBinding(fnNode: SyntaxNode): CaptureMatch | null {
  // Walk up to the enclosing class_definition, ignoring decorators.
  const enclosingClass = findEnclosingClassDefinition(fnNode);
  if (enclosingClass === null) return null;

  // Skip @staticmethod-decorated methods (no implicit receiver).
  const isStatic = hasDecorator(fnNode, 'staticmethod');
  if (isStatic) return null;
  const isClassmethod = hasDecorator(fnNode, 'classmethod');

  const params = fnNode.childForFieldName('parameters');
  if (params === null) return null;
  const first = firstNamedParameter(params);
  if (first === null) return null;

  const className = classDefinitionName(enclosingClass);
  if (className === null) return null;

  const firstName = firstParameterName(first);
  if (firstName === null) return null;

  // Receiver convention: instance methods get `self`, classmethods get `cls`.
  // We trust the AST literal name (Python convention is strict in practice).
  if (isClassmethod) {
    return {
      '@type-binding.cls': nodeToCapture('@type-binding.cls', first),
      '@type-binding.name': syntheticCapture('@type-binding.name', first, firstName),
      '@type-binding.type': syntheticCapture('@type-binding.type', first, className),
    };
  }
  return {
    '@type-binding.self': nodeToCapture('@type-binding.self', first),
    '@type-binding.name': syntheticCapture('@type-binding.name', first, firstName),
    '@type-binding.type': syntheticCapture('@type-binding.type', first, className),
  };
}

function syntheticCapture(name: string, atNode: SyntaxNode, text: string): Capture {
  return {
    name,
    range: {
      startLine: atNode.startPosition.row + 1,
      startCol: atNode.startPosition.column,
      endLine: atNode.endPosition.row + 1,
      endCol: atNode.endPosition.column,
    },
    text,
  };
}

function findEnclosingClassDefinition(node: SyntaxNode): SyntaxNode | null {
  let cur: SyntaxNode | null = node.parent;
  while (cur !== null) {
    if (cur.type === 'class_definition') return cur;
    if (cur.type === 'function_definition') return null; // nested fn — not a method
    cur = cur.parent;
  }
  return null;
}

function classDefinitionName(classNode: SyntaxNode): string | null {
  const nameField = classNode.childForFieldName('name');
  return nameField?.text ?? null;
}

function hasDecorator(fnNode: SyntaxNode, decoratorName: string): boolean {
  // Decorators are siblings BEFORE function_definition under decorated_definition,
  // OR they're children of the parent decorated_definition.
  const parent = fnNode.parent;
  if (parent === null || parent.type !== 'decorated_definition') return false;
  for (let i = 0; i < parent.namedChildCount; i++) {
    const child = parent.namedChild(i);
    if (child === null || child.type !== 'decorator') continue;
    // Decorator text starts with `@`. Strip it and split off any call args.
    const text = child.text.replace(/^@/, '').split('(')[0]!.trim();
    // Match `staticmethod`, `classmethod`, `<module>.staticmethod`, etc.
    const tail = text.split('.').pop();
    if (tail === decoratorName) return true;
  }
  return false;
}

function firstNamedParameter(parameters: SyntaxNode): SyntaxNode | null {
  for (let i = 0; i < parameters.namedChildCount; i++) {
    const child = parameters.namedChild(i);
    if (child === null) continue;
    // Skip `*` / `/` markers.
    if (child.type === 'positional_separator' || child.type === 'keyword_separator') continue;
    return child;
  }
  return null;
}

function firstParameterName(param: SyntaxNode): string | null {
  // identifier — bare param: `def f(self): ...`
  if (param.type === 'identifier') return param.text;
  // typed_parameter / default_parameter / typed_default_parameter:
  // first child holds the identifier / pattern.
  const ident = param.childForFieldName('name') ?? findIdentifierChild(param);
  return ident?.text ?? null;
}

function findIdentifierChild(node: SyntaxNode): SyntaxNode | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child !== null && child.type === 'identifier') return child;
  }
  return null;
}

/**
 * Decompose a `tree-sitter-python` import statement into one
 * `CaptureMatch` per imported name. Carries `@import.kind` /
 * `@import.name` / `@import.alias` / `@import.source` markers that
 * `interpretPythonImport` reads.
 */
function splitImportStatement(stmtNode: SyntaxNode): CaptureMatch[] {
  const out: CaptureMatch[] = [];

  if (stmtNode.type === 'import_statement') {
    // `import a, b as c, d.e`
    for (let i = 0; i < stmtNode.namedChildCount; i++) {
      const child = stmtNode.namedChild(i);
      if (child === null) continue;
      if (child.type === 'dotted_name') {
        out.push(buildImportMatch(stmtNode, {
          kind: 'plain',
          source: child.text,
          name: child.text.split('.')[0]!,
          atNode: child,
        }));
      } else if (child.type === 'aliased_import') {
        const dotted = findChildOfType(child, 'dotted_name');
        const alias = findChildOfType(child, 'identifier');
        if (dotted !== null && alias !== null) {
          out.push(buildImportMatch(stmtNode, {
            kind: 'aliased',
            source: dotted.text,
            name: dotted.text,
            alias: alias.text,
            atNode: child,
          }));
        }
      }
    }
    return out;
  }

  if (stmtNode.type === 'import_from_statement') {
    // `from m import a, b as c` / `from m import *` / `from . import x`
    const moduleField = stmtNode.childForFieldName('module_name');
    const moduleText = moduleField?.text ?? '';

    // Wildcard? tree-sitter-python represents `*` as a `wildcard_import` child.
    const wildcardChild = findChildOfType(stmtNode, 'wildcard_import');
    if (wildcardChild !== null) {
      out.push(buildImportMatch(stmtNode, {
        kind: 'wildcard',
        source: moduleText,
        name: '*',
        atNode: wildcardChild,
      }));
      return out;
    }

    // Names = every dotted_name / aliased_import that isn't the module.
    for (let i = 0; i < stmtNode.namedChildCount; i++) {
      const child = stmtNode.namedChild(i);
      if (child === null) continue;
      if (moduleField !== null && child.startIndex === moduleField.startIndex) continue;

      if (child.type === 'dotted_name') {
        out.push(buildImportMatch(stmtNode, {
          kind: 'from',
          source: moduleText,
          name: child.text,
          atNode: child,
        }));
      } else if (child.type === 'aliased_import') {
        const dotted = findChildOfType(child, 'dotted_name');
        const alias = findChildOfType(child, 'identifier');
        if (dotted !== null && alias !== null) {
          out.push(buildImportMatch(stmtNode, {
            kind: 'from-alias',
            source: moduleText,
            name: dotted.text,
            alias: alias.text,
            atNode: child,
          }));
        }
      }
    }
    return out;
  }

  return out;
}

function findChildOfType(node: SyntaxNode, type: string): SyntaxNode | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child !== null && child.type === type) return child;
  }
  return null;
}

function buildImportMatch(
  stmtNode: SyntaxNode,
  spec: {
    kind: 'plain' | 'aliased' | 'from' | 'from-alias' | 'wildcard' | 'dynamic';
    source: string;
    name: string;
    alias?: string;
    atNode: SyntaxNode;
  },
): CaptureMatch {
  const stmtCap = nodeToCapture('@import.statement', stmtNode);
  const m: Record<string, Capture> = {
    '@import.statement': stmtCap,
    '@import.kind': syntheticCapture('@import.kind', spec.atNode, spec.kind),
    '@import.source': syntheticCapture('@import.source', spec.atNode, spec.source),
    '@import.name': syntheticCapture('@import.name', spec.atNode, spec.name),
  };
  if (spec.alias !== undefined) {
    m['@import.alias'] = syntheticCapture('@import.alias', spec.atNode, spec.alias);
  }
  return m;
}

function stripForwardRefQuotes(text: string): string {
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    return text.slice(1, -1);
  }
  return text;
}
