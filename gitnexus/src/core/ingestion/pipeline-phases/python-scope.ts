/**
 * Phase: pythonScope
 *
 * Registry-primary resolution for Python files (RFC #909 Ring 4).
 *
 * Gated by `REGISTRY_PRIMARY_PYTHON=1` (via `isRegistryPrimary`). When
 * the flag is OFF (default), this phase is a no-op: the legacy paths in
 * `import-processor.ts` and `call-processor.ts` continue to handle
 * Python imports + calls and this phase contributes nothing to the
 * graph.
 *
 * When the flag is ON, this phase:
 *   1. Reads every `.py` file in the workspace.
 *   2. Drives the scope-based pipeline end-to-end (extract → finalize →
 *      resolve → emit) via `runPythonScopeResolution`.
 *   3. Emits IMPORTS / CALLS / ACCESSES / INHERITS / USES edges directly.
 *
 * Pairs with the matching gates in `import-processor.ts` and
 * `call-processor.ts` that skip Python files when this phase is active —
 * so we don't double-emit edges from both code paths.
 *
 * @deps    parse  (needs Symbol nodes already in the graph so emit-references
 *                  can attach edges to existing Function/Method/Class nodes)
 * @reads   scannedFiles
 * @writes  graph (IMPORTS, CALLS, ACCESSES, INHERITS, USES)
 */

import type { PipelinePhase, PipelineContext, PhaseResult } from './types.js';
import { getPhaseOutput } from './types.js';
import type { StructureOutput } from './structure.js';
import { isRegistryPrimary } from '../registry-primary-flag.js';
import { SupportedLanguages, getLanguageFromFilename } from 'gitnexus-shared';
import { readFileContents } from '../filesystem-walker.js';
import { runPythonScopeResolution } from '../python-scope-emit.js';
import { isDev } from '../utils/env.js';

export interface PythonScopeOutput {
  /** True when the flag was on and the phase actually ran. */
  readonly ran: boolean;
  /** Python files seen by the phase. `0` when `ran === false`. */
  readonly filesProcessed: number;
  /** IMPORTS edges emitted by this phase. */
  readonly importsEmitted: number;
  /** Reference (CALLS/ACCESSES/INHERITS/USES) edges emitted. */
  readonly referenceEdgesEmitted: number;
}

const NOOP_OUTPUT: PythonScopeOutput = Object.freeze({
  ran: false,
  filesProcessed: 0,
  importsEmitted: 0,
  referenceEdgesEmitted: 0,
});

export const pythonScopePhase: PipelinePhase<PythonScopeOutput> = {
  name: 'pythonScope',
  // Depends on `parse` because emit-references attaches edges to
  // already-existing Symbol nodes (Function/Method/Class). The legacy
  // `parse` phase still creates those nodes; we only replace the
  // import + call resolution layer.
  deps: ['parse', 'structure'],

  async execute(
    ctx: PipelineContext,
    deps: ReadonlyMap<string, PhaseResult<unknown>>,
  ): Promise<PythonScopeOutput> {
    if (!isRegistryPrimary(SupportedLanguages.Python)) {
      return NOOP_OUTPUT;
    }

    const { scannedFiles } = getPhaseOutput<StructureOutput>(deps, 'structure');

    // Only `.py` files; the per-language flag scopes by extension via
    // `getLanguageFromFilename`.
    const pythonScanned = scannedFiles.filter(
      (f) => getLanguageFromFilename(f.path) === SupportedLanguages.Python,
    );
    if (pythonScanned.length === 0) return NOOP_OUTPUT;

    // Read source for every Python file. `runPythonScopeResolution`
    // re-parses each file via `pythonProvider.emitScopeCaptures`; we
    // accept the duplicate parse cost in this first cut and can revisit
    // by sharing `astCache` across phases if needed.
    const filePaths = pythonScanned.map((f) => f.path);
    const contents = await readFileContents(ctx.repoPath, filePaths);
    const files: { path: string; content: string }[] = [];
    for (const fp of filePaths) {
      const content = contents.get(fp);
      if (content !== undefined) files.push({ path: fp, content });
    }

    const stats = runPythonScopeResolution({
      graph: ctx.graph,
      files,
      onWarn: (msg) => {
        if (isDev) console.warn(`[python-scope] ${msg}`);
      },
    });

    if (isDev) {
      console.log(
        `🐍 python-scope: ${stats.filesProcessed} files → ${stats.importsEmitted} IMPORTS + ${stats.referenceEdgesEmitted} reference edges (${stats.resolve.unresolved} unresolved sites, ${stats.referenceSkipped} skipped)`,
      );
    }

    return {
      ran: true,
      filesProcessed: stats.filesProcessed,
      importsEmitted: stats.importsEmitted,
      referenceEdgesEmitted: stats.referenceEdgesEmitted,
    };
  },
};
