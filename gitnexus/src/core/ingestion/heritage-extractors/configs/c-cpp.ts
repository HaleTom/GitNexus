// gitnexus/src/core/ingestion/heritage-extractors/configs/c-cpp.ts

import { SupportedLanguages } from 'gitnexus-shared';
import type { HeritageExtractionConfig } from '../../heritage-types.js';

/**
 * C heritage extraction config.
 *
 * C has no class inheritance — no heritage captures expected.
 * Config exists for completeness in the provider wiring.
 */
export const cHeritageConfig: HeritageExtractionConfig = {
  language: SupportedLanguages.C,
};

/**
 * C++ heritage extraction config.
 *
 * C++ has standard extends heritage through tree-sitter captures
 * (class A : public B). Multiple inheritance uses leftmost-base MRO
 * at the resolution layer. No special extraction hooks needed.
 */
export const cppHeritageConfig: HeritageExtractionConfig = {
  language: SupportedLanguages.CPlusPlus,
};
