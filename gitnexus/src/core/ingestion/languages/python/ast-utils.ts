/**
 * Tree-sitter `SyntaxNode` helpers used by the Python scope-resolution
 * hooks. Pure utilities — no Python-specific knowledge — but kept local
 * to the `python/` package because they're only consumed here today.
 */

import type { Capture } from 'gitnexus-shared';
import type { SyntaxNode } from '../../utils/ast-helpers.js';

/** Convert a tree-sitter node to a `Capture` with 1-based line numbers
 *  (matching RFC §2.1). The tag includes the leading `@`. */
export function nodeToCapture(name: string, node: SyntaxNode): Capture {
  return {
    name,
    range: {
      startLine: node.startPosition.row + 1,
      startCol: node.startPosition.column,
      endLine: node.endPosition.row + 1,
      endCol: node.endPosition.column,
    },
    text: node.text,
  };
}

/** Build a `Capture` whose range mirrors `atNode` but whose `text` is
 *  caller-supplied. Used to synthesize markers like `@import.kind` that
 *  don't have a corresponding source token. */
export function syntheticCapture(name: string, atNode: SyntaxNode, text: string): Capture {
  return {
    name,
    range: {
      startLine: atNode.startPosition.row + 1,
      startCol: atNode.startPosition.column,
      endLine: atNode.endPosition.row + 1,
      endCol: atNode.endPosition.column,
    },
    text,
  };
}

function rangeMatches(
  node: SyntaxNode,
  range: { startLine: number; startCol: number; endLine: number; endCol: number },
): boolean {
  return (
    node.startPosition.row + 1 === range.startLine &&
    node.startPosition.column === range.startCol &&
    node.endPosition.row + 1 === range.endLine &&
    node.endPosition.column === range.endCol
  );
}

/** Walk subtree to find a node whose range exactly matches AND whose
 *  type matches `expectedType` (when given). When multiple nodes share
 *  the range — e.g., `function_definition` and its inner `block` body
 *  for a one-liner — the type filter disambiguates. O(n) over the
 *  candidate subtree; only descends into spans that cover the target,
 *  so in practice it's near-O(depth). */
export function findNodeAtRange(
  root: SyntaxNode,
  range: { startLine: number; startCol: number; endLine: number; endCol: number },
  expectedType?: string,
): SyntaxNode | null {
  if (rangeMatches(root, range) && (expectedType === undefined || root.type === expectedType)) {
    return root;
  }
  const startRow = range.startLine - 1;
  const endRow = range.endLine - 1;
  for (let i = 0; i < root.namedChildCount; i++) {
    const child = root.namedChild(i);
    if (child === null) continue;
    if (child.endPosition.row < startRow) continue;
    if (child.startPosition.row > endRow) break;
    const hit = findNodeAtRange(child, range, expectedType);
    if (hit !== null) return hit;
  }
  return null;
}

/** Find the first named child of `node` whose `type` matches `type`. */
export function findChildOfType(node: SyntaxNode, type: string): SyntaxNode | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child !== null && child.type === type) return child;
  }
  return null;
}

/** First named `identifier` child of `node`, or `null`. */
export function findIdentifierChild(node: SyntaxNode): SyntaxNode | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child !== null && child.type === 'identifier') return child;
  }
  return null;
}
