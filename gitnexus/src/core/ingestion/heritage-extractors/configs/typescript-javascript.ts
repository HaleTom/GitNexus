// gitnexus/src/core/ingestion/heritage-extractors/configs/typescript-javascript.ts

import { SupportedLanguages } from 'gitnexus-shared';
import type { HeritageExtractionConfig } from '../../heritage-types.js';

/**
 * TypeScript heritage extraction config.
 *
 * TypeScript has standard extends/implements heritage through tree-sitter
 * captures. No special extraction hooks needed.
 */
export const typescriptHeritageConfig: HeritageExtractionConfig = {
  language: SupportedLanguages.TypeScript,
};

/**
 * JavaScript heritage extraction config.
 *
 * JavaScript has extends heritage (class A extends B). No implements
 * keyword in plain JS. No special extraction hooks needed.
 */
export const javascriptHeritageConfig: HeritageExtractionConfig = {
  language: SupportedLanguages.JavaScript,
};
