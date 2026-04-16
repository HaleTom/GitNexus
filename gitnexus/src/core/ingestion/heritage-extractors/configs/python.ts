// gitnexus/src/core/ingestion/heritage-extractors/configs/python.ts

import { SupportedLanguages } from 'gitnexus-shared';
import type { HeritageExtractionConfig } from '../../heritage-types.js';

/**
 * Python heritage extraction config.
 *
 * Python has standard extends heritage through tree-sitter captures
 * (class A(B, C)). Multiple inheritance is handled by C3 MRO at
 * the resolution layer. No special extraction hooks needed.
 */
export const pythonHeritageConfig: HeritageExtractionConfig = {
  language: SupportedLanguages.Python,
};
