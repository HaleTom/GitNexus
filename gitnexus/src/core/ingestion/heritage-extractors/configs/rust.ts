// gitnexus/src/core/ingestion/heritage-extractors/configs/rust.ts

import { SupportedLanguages } from 'gitnexus-shared';
import type { HeritageExtractionConfig } from '../../heritage-types.js';

/**
 * Rust heritage extraction config.
 *
 * Rust uses impl Trait for Struct syntax. Heritage captures include
 * heritage.trait for trait implementations. No special extraction
 * hooks needed beyond the standard capture handling.
 */
export const rustHeritageConfig: HeritageExtractionConfig = {
  language: SupportedLanguages.Rust,
};
