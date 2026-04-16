// gitnexus/src/core/ingestion/heritage-extractors/configs/php.ts

import { SupportedLanguages } from 'gitnexus-shared';
import type { HeritageExtractionConfig } from '../../heritage-types.js';

/**
 * PHP heritage extraction config.
 *
 * PHP has standard extends/implements heritage through tree-sitter
 * captures. No special extraction hooks needed.
 */
export const phpHeritageConfig: HeritageExtractionConfig = {
  language: SupportedLanguages.PHP,
};
