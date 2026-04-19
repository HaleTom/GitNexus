/**
 * Tree-sitter query for Python scope captures (RFC §5.1).
 *
 * The `.scm` sibling file is the human-readable spec; this module
 * mirrors it at runtime. **Edit both together** — the unit/integration
 * tests reference the embedded constant, and the file documents the
 * contract.
 *
 * Also exposes lazy `Parser` and `Query` singletons so callers don't
 * pay tree-sitter init cost per file.
 */

import Parser from 'tree-sitter';
import Python from 'tree-sitter-python';

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

let _parser: Parser | null = null;
let _query: Parser.Query | null = null;

export function getPythonParser(): Parser {
  if (_parser === null) {
    _parser = new Parser();
    _parser.setLanguage(Python as Parameters<Parser['setLanguage']>[0]);
  }
  return _parser;
}

export function getPythonScopeQuery(): Parser.Query {
  if (_query === null) {
    _query = new Parser.Query(
      Python as Parameters<Parser['setLanguage']>[0],
      PYTHON_SCOPE_QUERY,
    );
  }
  return _query;
}
