/**
 * BindingAccumulator — read-append-only accumulator that collects TypeEnv
 * bindings across all files in the GitNexus analyzer pipeline.
 *
 * **Quality asymmetry between execution paths (PR #743 review):** Entries in
 * this accumulator are NOT homogeneous in resolution quality. The pipeline
 * feeds bindings through two paths:
 *
 * - **Sequential path** (`call-processor.ts` → `typeEnv.flush()`): files
 *   processed on the main thread have access to the full `SymbolTable` and
 *   `importedBindings` at build time, so their bindings benefit from Tier 2
 *   cross-file propagation (e.g. an imported constructor's return type
 *   flows into the variable binding).
 *
 * - **Worker path** (`parse-worker.ts` → IPC tuple → pipeline adapter): files
 *   processed in worker threads run without the main-thread `SymbolTable`
 *   and without `importedBindings`, so they can only produce Tier 0
 *   (annotation-declared) and local Tier 1 (same-file constructor
 *   inference) bindings. Cross-file type flow is not visible to the worker.
 *
 * Implication: Phase 9 consumers that trust every accumulator entry equally
 * will silently produce worse results for large repos (worker path dominates)
 * than for small ones (sequential path dominates). The asymmetry is
 * structural — workers cannot see the SymbolTable without either shipping a
 * copy over IPC or synchronizing after parse. If Phase 9 needs homogeneous
 * quality, it should either (a) tag entries with their tier at insert time
 * so consumers can filter, or (b) post-process worker-path entries through a
 * follow-up resolution pass once the main-thread SymbolTable is complete.
 *
 * **PR #743 review — IPC narrowing:** The worker path currently only
 * serializes file-scope (`scope = ''`) entries through the IPC boundary.
 * Function-scope bindings are stripped at `parse-worker.ts` to avoid paying
 * a ~4.9 MB live memory cost for data that has no current consumer. The
 * sequential path's `flush()` still writes all scopes (file-scope and
 * function-scope). See `FileAllScopeBindings` JSDoc in `parse-worker.ts`
 * for the Phase 9 reversion path.
 */

export interface BindingEntry {
  readonly scope: string; // '' for file-level, 'funcName@startIndex' for function-local
  readonly varName: string;
  readonly typeName: string;
}

const ENTRY_OVERHEAD = 64; // bytes per entry (object overhead + property refs)
const MAP_ENTRY_OVERHEAD = 80; // bytes per file entry in the map

export class BindingAccumulator {
  // PR #743 review (Low finding #1): storage is split into two parallel
  // maps so fileScopeEntries() is O(n_file_scope) instead of O(n_total).
  // - _allByFile holds every BindingEntry (used by getFile, memory estimate).
  // - _fileScopeByFile caches the flat [varName, typeName] view of the
  //   `scope === ''` subset, populated at insert time so reads are O(1) map
  //   lookup + O(n_file_scope) array return. Both maps carry the same key
  //   set modulo the `scope === ''` precondition: _allByFile has a key as
  //   soon as any entry is appended; _fileScopeByFile only has a key once a
  //   file-scope entry arrives. Code that iterates via files() uses
  //   _allByFile so files with only function-scope entries remain visible.
  private readonly _allByFile = new Map<string, BindingEntry[]>();
  private readonly _fileScopeByFile = new Map<string, [string, string][]>();
  private _totalBindings = 0;
  private _finalized = false;
  private _disposed = false;

  /**
   * Append bindings for a file. Safe to call multiple times for the same file.
   * Throws if the accumulator has been finalized. Skips if entries is empty.
   */
  appendFile(filePath: string, entries: BindingEntry[]): void {
    if (this._finalized) {
      throw new Error('BindingAccumulator is finalized — no further appends allowed');
    }
    if (entries.length === 0) {
      return;
    }
    // All-scope store.
    const existingAll = this._allByFile.get(filePath);
    if (existingAll !== undefined) {
      for (const e of entries) {
        existingAll.push(e);
      }
    } else {
      this._allByFile.set(filePath, entries.slice());
    }
    // File-scope fast-path store. Populated lazily on first file-scope entry.
    let existingFileScope = this._fileScopeByFile.get(filePath);
    for (const e of entries) {
      if (e.scope === '') {
        if (existingFileScope === undefined) {
          existingFileScope = [];
          this._fileScopeByFile.set(filePath, existingFileScope);
        }
        existingFileScope.push([e.varName, e.typeName]);
      }
    }
    this._totalBindings += entries.length;
  }

  /** Lock the accumulator — no further appends. Idempotent. */
  finalize(): void {
    this._finalized = true;
  }

  /**
   * Release the accumulator's heap footprint. Clears both internal storage
   * maps and resets `_totalBindings` to zero. Idempotent and orthogonal to
   * `finalize()` — calling `dispose()` does not change the finalized state.
   *
   * Post-dispose contract: all read methods return empty/undefined state
   * matching a never-appended-to accumulator. Specifically:
   *   - `fileCount === 0`
   *   - `totalBindings === 0`
   *   - `files()` yields an empty iterator
   *   - `getFile(x)` returns `undefined` for all `x`
   *   - `fileScopeEntries(x)` returns `[]` for all `x`
   *   - `estimateMemoryBytes()` returns `0`
   *
   * If `dispose()` is called **before** `finalize()`, subsequent `appendFile`
   * calls succeed — the accumulator behaves like a fresh one. If called
   * **after** `finalize()`, subsequent `appendFile` calls throw the existing
   * "finalized" error.
   *
   * Added in response to PR #743 Codex adversarial review (plan
   * 2026-04-09-005): the pipeline disposes the accumulator after the
   * ExportedTypeMap enrichment loop consumes its file-scope entries, so
   * the heap is released before Phase 14 (`runCrossFileBindingPropagation`)
   * and `runGraphAnalysisPhases` begin their long-running work. When Phase 9
   * wires a consumer into that stage, the dispose call should move later in
   * the pipeline or be removed entirely.
   */
  dispose(): void {
    this._allByFile.clear();
    this._fileScopeByFile.clear();
    this._totalBindings = 0;
    this._disposed = true;
  }

  /** Get all bindings for a file, or undefined if the file is unknown. */
  getFile(filePath: string): readonly BindingEntry[] | undefined {
    return this._allByFile.get(filePath);
  }

  /**
   * Get only scope='' (file-level) entries as [varName, typeName] tuples.
   * Backward-compatible with the old workerTypeEnvBindings pattern.
   * Returns an empty array for an unknown file.
   *
   * O(1) map lookup + O(n_file_scope) array construction — does NOT walk
   * function-scope entries. See the `_fileScopeByFile` field comment for
   * the storage split rationale (PR #743 review Low finding #1).
   */
  fileScopeEntries(filePath: string): [string, string][] {
    const cached = this._fileScopeByFile.get(filePath);
    return cached ?? [];
  }

  /** Iterate over all file paths in insertion order. */
  files(): IterableIterator<string> {
    return this._allByFile.keys();
  }

  /** Number of distinct files with at least one binding. */
  get fileCount(): number {
    return this._allByFile.size;
  }

  /** Total number of binding entries across all files. */
  get totalBindings(): number {
    return this._totalBindings;
  }

  /** Whether the accumulator has been finalized. */
  get finalized(): boolean {
    return this._finalized;
  }

  /**
   * Whether the accumulator has been disposed. Exposed for symmetry with
   * `finalized` so debug tooling and future Phase 9 consumers can detect a
   * disposed accumulator without inspecting empty state heuristically.
   *
   * Disposal and finalization are orthogonal: a disposed accumulator may or
   * may not be finalized, and vice versa. See `dispose()` for the full
   * lifecycle contract.
   */
  get disposed(): boolean {
    return this._disposed;
  }

  /**
   * Rough memory estimate in bytes (intentionally pessimistic).
   * Formula: sum of (ENTRY_OVERHEAD + char bytes of scope+varName+typeName) per entry
   *          + MAP_ENTRY_OVERHEAD + char bytes of filePath per file.
   *
   * Note: V8 stores all-ASCII strings as Latin-1 (1 byte/char) and only upgrades
   * to UCS-2 (2 bytes/char) for non-Latin-1 code points. Source paths and type names
   * are typically all-ASCII, so actual heap cost is roughly half what this returns.
   * The pessimistic factor is intentional — better to over-budget than under-budget.
   */
  estimateMemoryBytes(): number {
    let total = 0;
    for (const [filePath, entries] of this._allByFile) {
      total += MAP_ENTRY_OVERHEAD + filePath.length * 2;
      for (const e of entries) {
        total += ENTRY_OVERHEAD + (e.scope.length + e.varName.length + e.typeName.length) * 2;
      }
    }
    return total;
  }
}
