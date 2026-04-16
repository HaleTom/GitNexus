// gitnexus/src/core/ingestion/heritage-extractors/configs/swift.ts

import { SupportedLanguages } from 'gitnexus-shared';
import type { HeritageExtractionConfig } from '../../heritage-types.js';

/**
 * Swift heritage extraction config.
 *
 * Swift uses ':' for protocol conformance and class inheritance.
 * The heritageDefaultEdge ('IMPLEMENTS') and resolution strategy
 * are handled at the provider/resolution layer. No special
 * extraction hooks needed.
 */
export const swiftHeritageConfig: HeritageExtractionConfig = {
  language: SupportedLanguages.Swift,
};
