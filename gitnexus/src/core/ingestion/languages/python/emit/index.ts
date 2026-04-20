/**
 * Python `EmitProvider` and the `runPythonScopeResolution` entry point.
 *
 * The provider is a thin wiring object — Python's specific bits
 * (super recognizer, LEGB merge precedence, Python's relative-import
 * resolver, the simplified MRO walk) plug into the generic
 * `runScopeResolution` orchestrator from `emit-core/`.
 *
 * Migration reference: when bringing up the next language
 * (TypeScript / Java / Kotlin / Ruby), copy this file's structure —
 * implement the 6 required `EmitProvider` fields, optionally toggle
 * the 2 booleans, and call `runScopeResolution(input, provider)`.
 */

import type { ParsedFile, Scope, WorkspaceIndex } from 'gitnexus-shared';
import { SupportedLanguages } from 'gitnexus-shared';
import {
  buildMro,
  defaultLinearize,
  populateClassOwnedMembers,
  runScopeResolution,
  type EmitProvider,
  type RunScopeResolutionInput,
  type RunScopeResolutionStats,
} from '../../../emit-core/index.js';
import { pythonProvider } from '../../python.js';
import {
  pythonArityCompatibility,
  pythonMergeBindings,
  resolvePythonImportTarget,
  type PythonResolveContext,
} from '../index.js';

const pythonEmitProvider: EmitProvider = {
  language: SupportedLanguages.Python,
  languageProvider: pythonProvider,
  importEdgeReason: 'python-scope: import',

  resolveImportTarget: (targetRaw, fromFile, allFilePaths) => {
    // PythonResolveContext expects a mutable Set; orchestrator hands us
    // a ReadonlySet — safe to widen since the resolver only reads.
    const ws: PythonResolveContext = {
      fromFile,
      allFilePaths: allFilePaths as Set<string>,
    };
    return resolvePythonImportTarget(
      { kind: 'named', localName: '_', importedName: '_', targetRaw },
      ws as unknown as WorkspaceIndex,
    );
  },

  // Python LEGB precedence: local > import/namespace/reexport > wildcard.
  mergeBindings: (existing, incoming, scopeId) => {
    // pythonMergeBindings(scope, bindings) only consults BindingRef.origin
    // for tier ordering, not scope.kind. A shape-stub satisfies the type
    // contract without falsifying behavior. Widen the readonly result
    // to a mutable BindingRef[] for the orchestrator's hook signature.
    const fakeScope = { id: scopeId } as unknown as Scope;
    return [...pythonMergeBindings(fakeScope, [...existing, ...incoming])];
  },

  // Adapter: pythonArityCompatibility predates RegistryProviders and
  // uses (def, callsite). Contract is (callsite, def).
  arityCompatibility: (callsite, def) => pythonArityCompatibility(def, callsite),

  buildMro: (graph, parsedFiles, nodeLookup) =>
    buildMro(graph, parsedFiles, nodeLookup, defaultLinearize),

  populateOwners: (parsed: ParsedFile) => populateClassOwnedMembers(parsed),

  isSuperReceiver: (text) => /^super\s*\(/.test(text),

  // Python is dynamically typed — field-fallback heuristic on, return-
  // type propagation across imports on. Both default to true; listed
  // explicitly here for documentation.
  fieldFallbackOnMethodLookup: true,
  propagatesReturnTypesAcrossImports: true,
};

export { pythonEmitProvider };

export interface RunPythonScopeResolutionInput extends RunScopeResolutionInput {}
export interface RunPythonScopeResolutionStats extends RunScopeResolutionStats {}

export function runPythonScopeResolution(
  input: RunPythonScopeResolutionInput,
): RunPythonScopeResolutionStats {
  return runScopeResolution(input, pythonEmitProvider);
}
