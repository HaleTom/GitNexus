// gitnexus/src/core/ingestion/heritage-extractors/generic.ts

/**
 * Generic table-driven heritage extractor factory.
 *
 * Follows the same config+factory pattern as method-extractors/generic.ts,
 * field-extractors/generic.ts, call-extractors/generic.ts, and
 * variable-extractors/generic.ts.
 *
 * Define a HeritageExtractionConfig per language and generate extractors
 * from configs.  The factory creates a HeritageExtractor whose behaviour
 * is entirely driven by HeritageExtractionConfig.
 */

import type { CaptureMap } from '../language-provider.js';
import type {
  HeritageExtractionConfig,
  HeritageExtractor,
  HeritageExtractorContext,
  HeritageInfo,
} from '../heritage-types.js';
import type { SyntaxNode } from '../utils/ast-helpers.js';

/**
 * Create a HeritageExtractor from a declarative config.
 */
export function createHeritageExtractor(config: HeritageExtractionConfig): HeritageExtractor {
  const callNameSet = config.callBasedHeritage?.callNames;

  return {
    language: config.language,

    extract(captureMap: CaptureMap, context: HeritageExtractorContext): HeritageInfo[] {
      const classNode = captureMap['heritage.class'];
      if (!classNode) return [];

      const className = classNode.text;
      const results: HeritageInfo[] = [];

      const extendsNode = captureMap['heritage.extends'];
      if (extendsNode) {
        if (!config.shouldSkipExtends?.(extendsNode)) {
          results.push({ className, parentName: extendsNode.text, kind: 'extends' });
        }
      }

      const implementsNode = captureMap['heritage.implements'];
      if (implementsNode) {
        results.push({ className, parentName: implementsNode.text, kind: 'implements' });
      }

      const traitNode = captureMap['heritage.trait'];
      if (traitNode) {
        results.push({ className, parentName: traitNode.text, kind: 'trait-impl' });
      }

      return results;
    },

    ...(callNameSet
      ? {
          extractFromCall(
            calledName: string,
            callNode: SyntaxNode,
            context: HeritageExtractorContext,
          ): HeritageInfo[] | null {
            if (!callNameSet.has(calledName)) return null;
            return config.callBasedHeritage!.extract(calledName, callNode, context.filePath);
          },
        }
      : {}),
  };
}
