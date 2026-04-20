; Tree-sitter Python query — RFC §5.1 captures for scope-based resolution
; (RFC #909 Ring 3, language: Python — first migration).
;
; Capture vocabulary consumed by the central `ScopeExtractor`:
;
;   @scope.module       — file root
;   @scope.class        — class body
;   @scope.function     — def / async def body (functions, methods, lambdas)
;
;   @declaration.class      + @declaration.name
;   @declaration.function   + @declaration.name
;   @declaration.method     + @declaration.name (functions inside class bodies)
;   @declaration.variable   + @declaration.name (module/class/function-level assignments)
;
;   @import.statement       — anchor for `interpretImport`. The hook reads
;                             the captured source text and tokenizes it into
;                             a `ParsedImport`. We do NOT decompose
;                             `import X, Y` here at query time — `interpretImport`
;                             splits multi-target statements into N matches.
;
;   @type-binding.parameter + @type-binding.name + @type-binding.type
;
;   @reference.call.free    + @reference.name      (e.g. `print(x)`)
;   @reference.call.member  + @reference.name + @reference.receiver
;                                                  (e.g. `obj.save()`)
;
; Python has NO block scope: `if`, `for`, `while`, `try`, `with`, `match`
; bodies do NOT introduce a new lexical scope (PEP 8 / language reference).
; We therefore do NOT emit `@scope.block` captures for those constructs;
; their contained declarations land in the enclosing function/class/module
; scope automatically (RFC §5.1 "transparent block" behavior).
;
; `@reference.call.constructor` is intentionally absent: Python has no
; `new` keyword. A call to a class is syntactically identical to a call to
; a free function; the registry decides constructor-vs-call by inspecting
; the resolved `def.type`. Stays out of the parser to avoid duplicating
; that logic in tree-sitter.

; ─── Scopes ────────────────────────────────────────────────────────────────

(module) @scope.module

(class_definition) @scope.class

(function_definition) @scope.function

; ─── Declarations: class / function ────────────────────────────────────────

(class_definition
  name: (identifier) @declaration.name) @declaration.class

(function_definition
  name: (identifier) @declaration.name) @declaration.function

; ─── Declarations: assignments (module-, class-, function-level variables)
;
; Note: tree-sitter-python parses both annotated and plain assignments as
; `(assignment left: ...)` — typed and untyped both surface here. The
; central extractor de-dupes by `nodeId` (file#line:col:type:name).

(assignment
  left: (identifier) @declaration.name) @declaration.variable

; for-loop target — Python `for` does NOT introduce a new scope; the
; loop variable binds in the enclosing function/module scope.
(for_statement
  left: (identifier) @declaration.name) @declaration.variable

; ─── Imports ───────────────────────────────────────────────────────────────
;
; The whole statement is the anchor — `interpretImport` decomposes it.
; We tag both shapes so the hook sees a single capture name (`@import.statement`).

(import_statement) @import.statement

(import_from_statement) @import.statement

; ─── Type bindings: parameter annotations ──────────────────────────────────
;
; `def f(x: User)` — `x` is bound to `User` in `f`'s scope.
;
; `interpretTypeBinding` reads `@type-binding.name` (the parameter name)
; and `@type-binding.type` (the annotation source text) to produce a
; `ParsedTypeBinding { boundName, rawTypeName, source: 'parameter-annotation' }`.

(typed_parameter
  (identifier) @type-binding.name
  type: (type) @type-binding.type) @type-binding.parameter

(typed_default_parameter
  name: (identifier) @type-binding.name
  type: (type) @type-binding.type) @type-binding.parameter

; ─── Type bindings: constructor-inferred assignments ───────────────────────
;
; `u = User("alice")` — `u`'s type is inferred from the RHS call's target.
; Python has no `new` keyword, so the pattern matches any `assignment`
; whose RHS is a `call` with a bare-identifier function (constructor-
; shaped). The registry resolves the raw name through the scope chain at
; lookup time, so imported classes, local classes, and aliased imports
; all work without query-time knowledge.
;
; Emits `source: 'constructor-inferred'`.
;
; Listed BEFORE the annotation pattern so `u: User = find()` — which
; matches both patterns — has the annotation (later-processed match)
; overwrite the constructor-inferred guess. Explicit user intent wins.

(assignment
  left: (identifier) @type-binding.name
  right: (call
    function: (identifier) @type-binding.type)) @type-binding.constructor

; ─── Type bindings: variable annotations ───────────────────────────────────
;
; `u: User` or `u: User = some_value` — `u` is explicitly annotated. Both
; forms parse under tree-sitter-python as `(assignment left: type:)` with
; an optional `right:`. Module-, class-, and function-scope annotations
; all land here; scope attachment is handled by the central extractor
; via the anchor's innermost-containing scope.
;
; Emits `source: 'annotation'`.

(assignment
  left: (identifier) @type-binding.name
  type: (type) @type-binding.type) @type-binding.annotation

; For-loop iterable of a free-call result: `for u in get_users()` —
; binds `u → get_users` so the chain post-pass follows it through
; `get_users`'s return-type annotation (cross-file via
; `propagateImportedReturnTypes`).
(for_statement
  left: (identifier) @type-binding.name
  right: (call
    function: (identifier) @type-binding.type)) @type-binding.alias

; for (i, u) in enumerate(X) and for i, u in enumerate(X) — bind the
; second tuple element to X. enumerate yields (int, X-element); the
; chain-follow unwraps X via generic-strip when X is an annotated
; collection.
(for_statement
  left: (tuple_pattern
    (identifier)
    (identifier) @type-binding.name)
  right: (call
    function: (identifier) @_enum
    arguments: (argument_list
      (identifier) @type-binding.type))
  (#eq? @_enum "enumerate")) @type-binding.alias

(for_statement
  left: (pattern_list
    (identifier)
    (identifier) @type-binding.name)
  right: (call
    function: (identifier) @_enum
    arguments: (argument_list
      (identifier) @type-binding.type))
  (#eq? @_enum "enumerate")) @type-binding.alias

; for k, v in d.items() — bind v to d. The chain-follow unwraps d's
; dict[K, V] annotation to V via the dict-aware stripGeneric.
(for_statement
  left: (pattern_list
    (identifier)
    (identifier) @type-binding.name)
  right: (call
    function: (attribute
      object: (identifier) @type-binding.type
      attribute: (identifier) @_items))
  (#eq? @_items "items")) @type-binding.alias

(for_statement
  left: (tuple_pattern
    (identifier)
    (identifier) @type-binding.name)
  right: (call
    function: (attribute
      object: (identifier) @type-binding.type
      attribute: (identifier) @_items))
  (#eq? @_items "items")) @type-binding.alias

; ─── Type bindings: function return-type annotations ─────────────────────
;
; `def get_user() -> User:` — binds the function's NAME to its return
; type in the enclosing scope. Combined with the constructor-inferred +
; chain-follow path, `u = get_user()` then resolves `u: User` cross-
; call. Python provider hoists the binding via `pythonBindingScopeFor`
; to the function's parent scope so callers in module/class scope see it.

(function_definition
  name: (identifier) @type-binding.name
  return_type: (type) @type-binding.type) @type-binding.return

; ─── References: calls ─────────────────────────────────────────────────────
;
; Free call:   `print(x)`     — function is a bare identifier
; Member call: `obj.save()`   — function is an attribute access

(call
  function: (identifier) @reference.name) @reference.call.free

(call
  function: (attribute
    object: (_) @reference.receiver
    attribute: (identifier) @reference.name)) @reference.call.member
