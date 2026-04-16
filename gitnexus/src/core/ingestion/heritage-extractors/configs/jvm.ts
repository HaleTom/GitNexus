// gitnexus/src/core/ingestion/heritage-extractors/configs/jvm.ts

import { SupportedLanguages } from 'gitnexus-shared';
import type { HeritageExtractionConfig } from '../../heritage-types.js';

/**
 * Java heritage extraction config.
 *
 * Java has standard extends/implements heritage through tree-sitter
 * captures. No special extraction hooks needed.
 */
export const javaHeritageConfig: HeritageExtractionConfig = {
  language: SupportedLanguages.Java,
};

/**
 * Kotlin heritage extraction config.
 *
 * Kotlin uses ':' for both extends and implements (delegation markers
 * are tree-sitter captures). No special extraction hooks needed.
 */
export const kotlinHeritageConfig: HeritageExtractionConfig = {
  language: SupportedLanguages.Kotlin,
};
