/**
 * Build a `(filePath, simpleName) → graphNodeId` lookup over the
 * graph's Function/Method/Class/Constructor nodes.
 *
 * Language-agnostic seam. Any language provider migrating to the
 * registry-primary path can consume this to translate scope-resolution
 * `SymbolDefinition.nodeId` values into the legacy graph-node ID
 * format that downstream consumers (queries, edges, MCP) expect.
 *
 * Next-consumer contract: a TypeScript or Java provider imports this
 * module unchanged — the lookup is keyed by (filePath, name) which
 * every language produces.
 */

import type { NodeLabel } from 'gitnexus-shared';
import type { KnowledgeGraph } from '../../../graph/types.js';

export type GraphNodeLookup = ReadonlyMap<string, string>;

export function buildGraphNodeLookup(graph: KnowledgeGraph): GraphNodeLookup {
  const lookup = new Map<string, string>();
  for (const node of graph.iterNodes()) {
    const props = node.properties as { filePath?: string; name?: string };
    if (props.filePath === undefined || props.name === undefined) continue;
    if (!isLinkableLabel(node.label)) continue;
    // Keyed by (filePath, simpleName). Class kinds and method kinds
    // share the same simple-name space within a file — a `class Foo`
    // and `def Foo()` at the same level is disallowed by Python (and
    // most languages), so a single key per (file, name) is unambiguous
    // in practice. Method-vs-class disambiguation for resolved
    // references happens earlier inside `MethodRegistry.lookup`
    // (Step 1 + Step 2).
    const key = `${props.filePath}::${props.name}`;
    if (!lookup.has(key)) lookup.set(key, node.id);
  }
  return lookup;
}

export function isLinkableLabel(label: NodeLabel): boolean {
  return (
    label === 'Function' ||
    label === 'Method' ||
    label === 'Constructor' ||
    label === 'Class' ||
    label === 'Interface' ||
    label === 'Struct' ||
    label === 'Enum' ||
    // Variable / Property are linkable too — receiver-bound write/read
    // ACCESSES edges target field nodes (e.g. `user.name = "x"` →
    // ACCESSES edge to User's `name` Variable/Property node).
    label === 'Variable' ||
    label === 'Property'
  );
}
