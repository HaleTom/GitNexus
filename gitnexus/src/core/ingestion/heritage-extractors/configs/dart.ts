// gitnexus/src/core/ingestion/heritage-extractors/configs/dart.ts

import { SupportedLanguages } from 'gitnexus-shared';
import type { HeritageExtractionConfig } from '../../heritage-types.js';

/**
 * Dart heritage extraction config.
 *
 * Dart has standard extends/implements/with heritage through tree-sitter
 * captures. No special extraction hooks needed.
 */
export const dartHeritageConfig: HeritageExtractionConfig = {
  language: SupportedLanguages.Dart,
};
