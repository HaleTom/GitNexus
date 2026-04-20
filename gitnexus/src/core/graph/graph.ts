import type { GraphNode, GraphRelationship, RelationshipType } from 'gitnexus-shared';
import { KnowledgeGraph } from './types.js';

/** Fresh empty iterator per call — `[].values()` returns a new
 *  exhausted iterator each invocation, so empty-type lookups don't
 *  share a single already-exhausted iterator across callers. */
function emptyRelIter(): IterableIterator<GraphRelationship> {
  return ([] as GraphRelationship[]).values();
}

export const createKnowledgeGraph = (): KnowledgeGraph => {
  const nodeMap = new Map<string, GraphNode>();
  const relationshipMap = new Map<string, GraphRelationship>();
  // Per-type index maintained alongside `relationshipMap`. Bucket
  // values are `Map<id, Relationship>` so per-type iteration is cheap
  // and per-edge removal is O(1). See plan
  // docs/plans/2026-04-20-002-perf-parse-heritage-mro-plan.md (Unit 1).
  const relationshipsByType = new Map<RelationshipType, Map<string, GraphRelationship>>();

  const addNode = (node: GraphNode) => {
    if (!nodeMap.has(node.id)) {
      nodeMap.set(node.id, node);
    }
  };

  const addRelationship = (relationship: GraphRelationship) => {
    if (relationshipMap.has(relationship.id)) return;
    relationshipMap.set(relationship.id, relationship);
    let bucket = relationshipsByType.get(relationship.type);
    if (bucket === undefined) {
      bucket = new Map();
      relationshipsByType.set(relationship.type, bucket);
    }
    bucket.set(relationship.id, relationship);
  };

  /**
   * Remove a single node and all relationships involving it
   */
  const removeNode = (nodeId: string): boolean => {
    if (!nodeMap.has(nodeId)) return false;

    nodeMap.delete(nodeId);

    // Remove all relationships involving this node — clean up both
    // indexes in lockstep so the per-type buckets never drift.
    for (const [relId, rel] of relationshipMap) {
      if (rel.sourceId === nodeId || rel.targetId === nodeId) {
        relationshipMap.delete(relId);
        relationshipsByType.get(rel.type)?.delete(relId);
      }
    }
    return true;
  };

  /**
   * Remove a single relationship by id.
   * Returns true if the relationship existed and was removed, false otherwise.
   */
  const removeRelationship = (relationshipId: string): boolean => {
    const rel = relationshipMap.get(relationshipId);
    if (rel === undefined) return false;
    relationshipMap.delete(relationshipId);
    relationshipsByType.get(rel.type)?.delete(relationshipId);
    return true;
  };

  /**
   * Remove all nodes (and their relationships) belonging to a file.
   */
  const removeNodesByFile = (filePath: string): number => {
    let removed = 0;
    for (const [nodeId, node] of nodeMap) {
      if (node.properties?.filePath === filePath) {
        removeNode(nodeId);
        removed++;
      }
    }
    return removed;
  };

  return {
    get nodes() {
      return Array.from(nodeMap.values());
    },

    get relationships() {
      return Array.from(relationshipMap.values());
    },

    iterNodes: () => nodeMap.values(),
    iterRelationships: () => relationshipMap.values(),
    iterRelationshipsByType: (type: RelationshipType) => {
      const bucket = relationshipsByType.get(type);
      return bucket === undefined ? emptyRelIter() : bucket.values();
    },
    forEachNode(fn: (node: GraphNode) => void) {
      nodeMap.forEach(fn);
    },
    forEachRelationship(fn: (rel: GraphRelationship) => void) {
      relationshipMap.forEach(fn);
    },
    getNode: (id: string) => nodeMap.get(id),

    // O(1) count getters - avoid creating arrays just for length
    get nodeCount() {
      return nodeMap.size;
    },

    get relationshipCount() {
      return relationshipMap.size;
    },

    addNode,
    addRelationship,
    removeNode,
    removeNodesByFile,
    removeRelationship,
  };
};
