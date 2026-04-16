// gitnexus/src/core/ingestion/heritage-extractors/configs/csharp.ts

import { SupportedLanguages } from 'gitnexus-shared';
import type { HeritageExtractionConfig } from '../../heritage-types.js';

/**
 * C# heritage extraction config.
 *
 * C# has standard extends/implements heritage through tree-sitter
 * captures. Interface detection uses I-prefix convention (handled
 * by heritage resolution strategy, not here).
 */
export const csharpHeritageConfig: HeritageExtractionConfig = {
  language: SupportedLanguages.CSharp,
};
