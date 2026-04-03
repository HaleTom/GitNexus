/**
 * MRO (Method Resolution Order) Processor
 *
 * Walks the inheritance DAG (EXTENDS/IMPLEMENTS edges), collects methods from
 * each ancestor via HAS_METHOD edges, detects method-name collisions across
 * parents, and applies language-specific resolution rules to emit METHOD_OVERRIDES edges.
 *
 * Language-specific rules:
 * - C++:       leftmost base class in declaration order wins
 * - C#/Java:   class method wins over interface default; multiple interface
 *              methods with same name are ambiguous (null resolution)
 * - Python:    C3 linearization determines MRO; first in linearized order wins
 * - Rust:      no auto-resolution — requires qualified syntax, resolvedTo = null
 * - Default:   single inheritance — first definition wins
 *
 * METHOD_OVERRIDES edge direction: Class → Method (not Method → Method).
 * The source is the child class that inherits conflicting methods,
 * the target is the winning ancestor method node.
 * Cypher: MATCH (c:Class)-[r:CodeRelation {type: 'METHOD_OVERRIDES'}]->(m:Method)
 */

import { KnowledgeGraph } from '../graph/types.js';
import { generateId } from '../../lib/utils.js';
import { SupportedLanguages } from 'gitnexus-shared';
import { getProvider } from './languages/index.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface MROEntry {
  classId: string;
  className: string;
  language: SupportedLanguages;
  mro: string[]; // linearized parent names
  ambiguities: MethodAmbiguity[];
}

export interface MethodAmbiguity {
  methodName: string;
  definedIn: Array<{ classId: string; className: string; methodId: string }>;
  resolvedTo: string | null; // winning methodId or null if truly ambiguous
  reason: string;
}

export interface MROResult {
  entries: MROEntry[];
  overrideEdges: number;
  ambiguityCount: number;
  methodImplementsEdges: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Collect EXTENDS, IMPLEMENTS, and HAS_METHOD adjacency from the graph. */
function buildAdjacency(graph: KnowledgeGraph) {
  // parentMap: childId → parentIds[] (in insertion / declaration order)
  const parentMap = new Map<string, string[]>();
  // methodMap: classId → methodIds[]
  const methodMap = new Map<string, string[]>();
  // Track which edge type each parent link came from
  const parentEdgeType = new Map<string, Map<string, 'EXTENDS' | 'IMPLEMENTS'>>();

  graph.forEachRelationship((rel) => {
    if (rel.type === 'EXTENDS' || rel.type === 'IMPLEMENTS') {
      let parents = parentMap.get(rel.sourceId);
      if (!parents) {
        parents = [];
        parentMap.set(rel.sourceId, parents);
      }
      parents.push(rel.targetId);

      let edgeTypes = parentEdgeType.get(rel.sourceId);
      if (!edgeTypes) {
        edgeTypes = new Map();
        parentEdgeType.set(rel.sourceId, edgeTypes);
      }
      edgeTypes.set(rel.targetId, rel.type);
    }

    if (rel.type === 'HAS_METHOD') {
      let methods = methodMap.get(rel.sourceId);
      if (!methods) {
        methods = [];
        methodMap.set(rel.sourceId, methods);
      }
      methods.push(rel.targetId);
    }
  });

  return { parentMap, methodMap, parentEdgeType };
}

/**
 * Gather all ancestor IDs in BFS / topological order.
 * Returns the linearized list of ancestor IDs (excluding the class itself).
 */
function gatherAncestors(classId: string, parentMap: Map<string, string[]>): string[] {
  const visited = new Set<string>();
  const order: string[] = [];
  const queue: string[] = [...(parentMap.get(classId) ?? [])];

  while (queue.length > 0) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    order.push(id);
    const grandparents = parentMap.get(id);
    if (grandparents) {
      for (const gp of grandparents) {
        if (!visited.has(gp)) queue.push(gp);
      }
    }
  }

  return order;
}

// ---------------------------------------------------------------------------
// C3 linearization (Python MRO)
// ---------------------------------------------------------------------------

/**
 * Compute C3 linearization for a class given a parentMap.
 * Returns an array of ancestor IDs in C3 order (excluding the class itself),
 * or null if linearization fails (inconsistent or cyclic hierarchy).
 */
function c3Linearize(
  classId: string,
  parentMap: Map<string, string[]>,
  cache: Map<string, string[] | null>,
  inProgress?: Set<string>,
): string[] | null {
  if (cache.has(classId)) return cache.get(classId)!;

  // Cycle detection: if we're already computing this class, the hierarchy is cyclic
  const visiting = inProgress ?? new Set<string>();
  if (visiting.has(classId)) {
    cache.set(classId, null);
    return null;
  }
  visiting.add(classId);

  const directParents = parentMap.get(classId);
  if (!directParents || directParents.length === 0) {
    visiting.delete(classId);
    cache.set(classId, []);
    return [];
  }

  // Compute linearization for each parent first
  const parentLinearizations: string[][] = [];
  for (const pid of directParents) {
    const pLin = c3Linearize(pid, parentMap, cache, visiting);
    if (pLin === null) {
      visiting.delete(classId);
      cache.set(classId, null);
      return null;
    }
    parentLinearizations.push([pid, ...pLin]);
  }

  // Add the direct parents list as the final sequence
  const sequences = [...parentLinearizations, [...directParents]];
  const result: string[] = [];

  while (sequences.some((s) => s.length > 0)) {
    // Find a good head: one that doesn't appear in the tail of any other sequence
    let head: string | null = null;
    for (const seq of sequences) {
      if (seq.length === 0) continue;
      const candidate = seq[0];
      const inTail = sequences.some(
        (other) => other.length > 1 && other.indexOf(candidate, 1) !== -1,
      );
      if (!inTail) {
        head = candidate;
        break;
      }
    }

    if (head === null) {
      // Inconsistent hierarchy
      visiting.delete(classId);
      cache.set(classId, null);
      return null;
    }

    result.push(head);

    // Remove the chosen head from all sequences
    for (const seq of sequences) {
      if (seq.length > 0 && seq[0] === head) {
        seq.shift();
      }
    }
  }

  visiting.delete(classId);
  cache.set(classId, result);
  return result;
}

// ---------------------------------------------------------------------------
// Language-specific resolution
// ---------------------------------------------------------------------------

type MethodDef = { classId: string; className: string; methodId: string };
type Resolution = { resolvedTo: string | null; reason: string; confidence: number };

/** Resolve by MRO order — first ancestor in linearized order wins. */
function resolveByMroOrder(
  methodName: string,
  defs: MethodDef[],
  mroOrder: string[],
  reasonPrefix: string,
): Resolution {
  for (const ancestorId of mroOrder) {
    const match = defs.find((d) => d.classId === ancestorId);
    if (match) {
      return {
        resolvedTo: match.methodId,
        reason: `${reasonPrefix}: ${match.className}::${methodName}`,
        confidence: 0.9, // MRO-ordered resolution
      };
    }
  }
  return {
    resolvedTo: defs[0].methodId,
    reason: `${reasonPrefix} fallback: first definition`,
    confidence: 0.7,
  };
}

function resolveCsharpJava(
  methodName: string,
  defs: MethodDef[],
  parentEdgeTypes: Map<string, 'EXTENDS' | 'IMPLEMENTS'> | undefined,
): Resolution {
  const classDefs: MethodDef[] = [];
  const interfaceDefs: MethodDef[] = [];

  for (const def of defs) {
    const edgeType = parentEdgeTypes?.get(def.classId);
    if (edgeType === 'IMPLEMENTS') {
      interfaceDefs.push(def);
    } else {
      classDefs.push(def);
    }
  }

  if (classDefs.length > 0) {
    return {
      resolvedTo: classDefs[0].methodId,
      reason: `class method wins: ${classDefs[0].className}::${methodName}`,
      confidence: 0.95, // Class method is authoritative
    };
  }

  if (interfaceDefs.length > 1) {
    return {
      resolvedTo: null,
      reason: `ambiguous: ${methodName} defined in multiple interfaces: ${interfaceDefs.map((d) => d.className).join(', ')}`,
      confidence: 0.5,
    };
  }

  if (interfaceDefs.length === 1) {
    return {
      resolvedTo: interfaceDefs[0].methodId,
      reason: `single interface default: ${interfaceDefs[0].className}::${methodName}`,
      confidence: 0.85, // Single interface, unambiguous
    };
  }

  return { resolvedTo: null, reason: 'no resolution found', confidence: 0.5 };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export function computeMRO(graph: KnowledgeGraph): MROResult {
  const { parentMap, methodMap, parentEdgeType } = buildAdjacency(graph);
  const c3Cache = new Map<string, string[] | null>();

  const entries: MROEntry[] = [];
  let overrideEdges = 0;
  let ambiguityCount = 0;

  // Process every class that has at least one parent
  for (const [classId, directParents] of parentMap) {
    if (directParents.length === 0) continue;

    const classNode = graph.getNode(classId);
    if (!classNode) continue;

    const language = classNode.properties.language as SupportedLanguages | undefined;
    if (!language) continue;
    const className = classNode.properties.name;

    // Compute linearized MRO depending on language strategy
    const provider = getProvider(language);
    let mroOrder: string[];
    if (provider.mroStrategy === 'c3') {
      const c3Result = c3Linearize(classId, parentMap, c3Cache);
      mroOrder = c3Result ?? gatherAncestors(classId, parentMap);
    } else {
      mroOrder = gatherAncestors(classId, parentMap);
    }

    // Get the parent names for the MRO entry
    const mroNames: string[] = mroOrder
      .map((id) => graph.getNode(id)?.properties.name)
      .filter((n): n is string => n !== undefined);

    // Collect methods from all ancestors, grouped by method name
    const methodsByName = new Map<string, MethodDef[]>();
    for (const ancestorId of mroOrder) {
      const ancestorNode = graph.getNode(ancestorId);
      if (!ancestorNode) continue;

      const methods = methodMap.get(ancestorId) ?? [];
      for (const methodId of methods) {
        const methodNode = graph.getNode(methodId);
        if (!methodNode) continue;
        // Properties don't participate in method resolution order
        if (methodNode.label === 'Property') continue;

        const methodName = methodNode.properties.name;
        let defs = methodsByName.get(methodName);
        if (!defs) {
          defs = [];
          methodsByName.set(methodName, defs);
        }
        // Avoid duplicates (same method seen via multiple paths)
        if (!defs.some((d) => d.methodId === methodId)) {
          defs.push({
            classId: ancestorId,
            className: ancestorNode.properties.name,
            methodId,
          });
        }
      }
    }

    // Detect collisions: methods defined in 2+ different ancestors
    const ambiguities: MethodAmbiguity[] = [];

    // Compute transitive edge types once per class (only needed for implements-split languages)
    const needsEdgeTypes = provider.mroStrategy === 'implements-split';
    const classEdgeTypes = needsEdgeTypes
      ? buildTransitiveEdgeTypes(classId, parentMap, parentEdgeType)
      : undefined;

    for (const [methodName, defs] of methodsByName) {
      if (defs.length < 2) continue;

      // Own method shadows inherited — no ambiguity
      const ownMethods = methodMap.get(classId) ?? [];
      const ownDefinesIt = ownMethods.some((mid) => {
        const mn = graph.getNode(mid);
        return mn?.properties.name === methodName;
      });
      if (ownDefinesIt) continue;

      let resolution: Resolution;

      switch (provider.mroStrategy) {
        case 'leftmost-base':
          resolution = resolveByMroOrder(methodName, defs, mroOrder, 'leftmost base');
          break;
        case 'implements-split':
          resolution = resolveCsharpJava(methodName, defs, classEdgeTypes);
          break;
        case 'c3':
          resolution = resolveByMroOrder(methodName, defs, mroOrder, 'C3 MRO');
          break;
        case 'qualified-syntax':
          resolution = {
            resolvedTo: null,
            reason: `requires qualified syntax: <Type as Trait>::${methodName}()`,
            confidence: 0.5,
          };
          break;
        default:
          resolution = resolveByMroOrder(methodName, defs, mroOrder, 'first definition');
          break;
      }

      const ambiguity: MethodAmbiguity = {
        methodName,
        definedIn: defs,
        resolvedTo: resolution.resolvedTo,
        reason: resolution.reason,
      };
      ambiguities.push(ambiguity);

      if (resolution.resolvedTo === null) {
        ambiguityCount++;
      }

      // Emit METHOD_OVERRIDES edge if resolution found
      if (resolution.resolvedTo !== null) {
        graph.addRelationship({
          id: generateId('METHOD_OVERRIDES', `${classId}->${resolution.resolvedTo}`),
          sourceId: classId,
          targetId: resolution.resolvedTo,
          type: 'METHOD_OVERRIDES',
          confidence: resolution.confidence,
          reason: resolution.reason,
        });
        overrideEdges++;
      }
    }

    entries.push({
      classId,
      className,
      language,
      mro: mroNames,
      ambiguities,
    });
  }

  const methodImplementsEdges = emitMethodImplementsEdges(
    graph,
    parentMap,
    methodMap,
    parentEdgeType,
  );

  return { entries, overrideEdges, ambiguityCount, methodImplementsEdges };
}

// ---------------------------------------------------------------------------
// METHOD_IMPLEMENTS edge emission
// ---------------------------------------------------------------------------

/**
 * Check if two parameter type arrays match.
 * When either side has no type info, fall back to parameterCount comparison
 * (arity-compatible matching). If both have parameterCount and they differ,
 * return false. If counts match or either is undefined, return true (lenient).
 */
function parameterTypesMatch(
  a: string[],
  b: string[],
  aParamCount?: number,
  bParamCount?: number,
): boolean {
  if (a.length === 0 || b.length === 0) {
    // Fall back to arity check when type info is missing
    if (aParamCount !== undefined && bParamCount !== undefined) {
      return aParamCount === bParamCount;
    }
    return true; // lenient when either count is unknown
  }
  if (a.length !== b.length) return false;
  return a.every((t, i) => t === b[i]);
}

/**
 * For each concrete class that implements/extends an interface or trait,
 * find methods in the class that implement methods defined in the interface
 * and emit METHOD_IMPLEMENTS edges: ConcreteMethod → InterfaceMethod.
 */
function emitMethodImplementsEdges(
  graph: KnowledgeGraph,
  parentMap: Map<string, string[]>,
  methodMap: Map<string, string[]>,
  parentEdgeType: Map<string, Map<string, 'EXTENDS' | 'IMPLEMENTS'>>,
): number {
  let edgeCount = 0;

  for (const [classId, parentIds] of parentMap) {
    const classNode = graph.getNode(classId);
    if (!classNode) continue;

    // Interfaces and traits declare contracts — they don't implement them
    if (classNode.label === 'Interface' || classNode.label === 'Trait') continue;

    // Get this class's own methods
    const ownMethodIds = methodMap.get(classId) ?? [];

    // Build a lookup: methodName → Array<{methodId, parameterTypes, parameterCount}> for own methods
    const ownMethodsByName = new Map<
      string,
      Array<{ methodId: string; parameterTypes: string[]; parameterCount?: number }>
    >();
    for (const methodId of ownMethodIds) {
      const methodNode = graph.getNode(methodId);
      if (!methodNode || methodNode.label === 'Property') continue;
      // Abstract methods don't satisfy interface contracts
      if (methodNode.properties.isAbstract === true) continue;
      const name = methodNode.properties.name as string;
      const parameterTypes = (methodNode.properties.parameterTypes as string[] | undefined) ?? [];
      const parameterCount = methodNode.properties.parameterCount as number | undefined;
      let bucket = ownMethodsByName.get(name);
      if (!bucket) {
        bucket = [];
        ownMethodsByName.set(name, bucket);
      }
      bucket.push({ methodId, parameterTypes, parameterCount });
    }

    // Collect ALL transitive ancestors and classify each as EXTENDS or IMPLEMENTS
    const allAncestors = gatherAncestors(classId, parentMap);
    const ancestorEdgeTypes = buildTransitiveEdgeTypes(classId, parentMap, parentEdgeType);

    // Dedup set: avoid duplicate edges from diamond paths
    const emitted = new Set<string>();

    // For each ancestor, check if it's an interface/trait or classified as IMPLEMENTS
    for (const ancestorId of allAncestors) {
      const ancestorNode = graph.getNode(ancestorId);
      if (!ancestorNode) continue;

      const isInterfaceLike = ancestorNode.label === 'Interface' || ancestorNode.label === 'Trait';
      const classifiedEdgeType = ancestorEdgeTypes.get(ancestorId);
      if (!isInterfaceLike && classifiedEdgeType !== 'IMPLEMENTS') continue;

      // Get ancestor's methods
      const ancestorMethodIds = methodMap.get(ancestorId) ?? [];

      for (const ancestorMethodId of ancestorMethodIds) {
        const ancestorMethodNode = graph.getNode(ancestorMethodId);
        if (!ancestorMethodNode || ancestorMethodNode.label === 'Property') continue;

        const ancestorName = ancestorMethodNode.properties.name as string;
        const ancestorParamTypes =
          (ancestorMethodNode.properties.parameterTypes as string[] | undefined) ?? [];
        const ancestorParamCount = ancestorMethodNode.properties.parameterCount as
          | number
          | undefined;

        // Find matching method in own class by name + parameterTypes/arity
        const candidates = ownMethodsByName.get(ancestorName);

        // Unit 3: If no own method matches, walk the EXTENDS chain to find inherited concrete method
        if (!candidates || candidates.length === 0) {
          const inherited = findInheritedMethod(
            classId,
            ancestorName,
            ancestorParamTypes,
            ancestorParamCount,
            graph,
            parentMap,
            methodMap,
            parentEdgeType,
          );
          if (inherited) {
            const edgeKey = `${inherited.methodId}->${ancestorMethodId}`;
            if (!emitted.has(edgeKey)) {
              emitted.add(edgeKey);
              graph.addRelationship({
                id: generateId('METHOD_IMPLEMENTS', edgeKey),
                sourceId: inherited.methodId,
                targetId: ancestorMethodId,
                type: 'METHOD_IMPLEMENTS',
                confidence: 1.0,
                reason: '',
              });
              edgeCount++;
            }
          }
          continue;
        }

        // Unit 4: Filter candidates by type/arity match, then check for ambiguity
        const matching = candidates.filter((c) =>
          parameterTypesMatch(
            c.parameterTypes,
            ancestorParamTypes,
            c.parameterCount,
            ancestorParamCount,
          ),
        );

        if (matching.length === 0) continue;

        // If multiple candidates match at name+arity level, emit no edge (ambiguous)
        if (matching.length > 1) continue;

        const winner = matching[0];
        const edgeKey = `${winner.methodId}->${ancestorMethodId}`;
        if (emitted.has(edgeKey)) continue;
        emitted.add(edgeKey);

        graph.addRelationship({
          id: generateId('METHOD_IMPLEMENTS', edgeKey),
          sourceId: winner.methodId,
          targetId: ancestorMethodId,
          type: 'METHOD_IMPLEMENTS',
          confidence: 1.0,
          reason: '',
        });
        edgeCount++;
      }
    }
  }

  return edgeCount;
}

/**
 * Walk the class's EXTENDS chain (not IMPLEMENTS) to find the nearest
 * concrete method matching the given name and parameter signature.
 * Returns the first matching method found in BFS order, or null.
 */
function findInheritedMethod(
  classId: string,
  methodName: string,
  targetParamTypes: string[],
  targetParamCount: number | undefined,
  graph: KnowledgeGraph,
  parentMap: Map<string, string[]>,
  methodMap: Map<string, string[]>,
  parentEdgeType: Map<string, Map<string, 'EXTENDS' | 'IMPLEMENTS'>>,
): { methodId: string; parameterTypes: string[] } | null {
  const visited = new Set<string>();
  const queue: string[] = [];

  // Seed with direct EXTENDS parents only
  const directParents = parentMap.get(classId) ?? [];
  const directEdges = parentEdgeType.get(classId);
  for (const pid of directParents) {
    const et = directEdges?.get(pid);
    if (et === 'EXTENDS') {
      // Also check that the parent is not an Interface/Trait
      const parentNode = graph.getNode(pid);
      if (parentNode && parentNode.label !== 'Interface' && parentNode.label !== 'Trait') {
        queue.push(pid);
      }
    }
  }

  // Level-order BFS: process all ancestors at the current depth before
  // advancing. Once any match is found at depth D, finish that depth and stop.
  // Diamond dedup: same methodId via two paths at the same depth = 1 match.
  let currentLevel = [...queue];

  while (currentLevel.length > 0) {
    const matches = new Map<string, { methodId: string; parameterTypes: string[] }>();
    const nextLevel: string[] = [];

    for (const ancestorId of currentLevel) {
      if (visited.has(ancestorId)) continue;
      visited.add(ancestorId);

      // Check this ancestor's methods
      const methods = methodMap.get(ancestorId) ?? [];
      for (const mid of methods) {
        const mNode = graph.getNode(mid);
        if (!mNode || mNode.label === 'Property') continue;
        // Abstract inherited methods don't count as concrete implementations
        if (mNode.properties.isAbstract === true) continue;
        if (mNode.properties.name !== methodName) continue;

        const mParamTypes = (mNode.properties.parameterTypes as string[] | undefined) ?? [];
        const mParamCount = mNode.properties.parameterCount as number | undefined;
        if (parameterTypesMatch(mParamTypes, targetParamTypes, mParamCount, targetParamCount)) {
          matches.set(mid, { methodId: mid, parameterTypes: mParamTypes });
        }
      }

      // Collect EXTENDS parents for the next depth level
      const grandparents = parentMap.get(ancestorId) ?? [];
      const ancestorEdges = parentEdgeType.get(ancestorId);
      for (const gp of grandparents) {
        if (visited.has(gp)) continue;
        const gpEdge = ancestorEdges?.get(gp);
        if (gpEdge === 'EXTENDS') {
          const gpNode = graph.getNode(gp);
          if (gpNode && gpNode.label !== 'Interface' && gpNode.label !== 'Trait') {
            nextLevel.push(gp);
          }
        }
      }
    }

    // If any matches found at this depth, decide and stop
    if (matches.size === 1) return matches.values().next().value!;
    if (matches.size > 1) return null; // ambiguous at same depth

    currentLevel = nextLevel;
  }

  return null; // no matches found
}

/**
 * Build transitive edge types for a class using BFS from the class to all ancestors.
 *
 * Known limitation: BFS first-reach heuristic can misclassify an interface as
 * EXTENDS if it's reachable via a class chain before being seen via IMPLEMENTS.
 * E.g. if BaseClass also implements IFoo, IFoo may be classified as EXTENDS.
 * This affects C#/Java/Kotlin conflict resolution in rare diamond hierarchies.
 */
function buildTransitiveEdgeTypes(
  classId: string,
  parentMap: Map<string, string[]>,
  parentEdgeType: Map<string, Map<string, 'EXTENDS' | 'IMPLEMENTS'>>,
): Map<string, 'EXTENDS' | 'IMPLEMENTS'> {
  const result = new Map<string, 'EXTENDS' | 'IMPLEMENTS'>();
  const directEdges = parentEdgeType.get(classId);
  if (!directEdges) return result;

  // BFS: propagate edge type from direct parents
  const queue: Array<{ id: string; edgeType: 'EXTENDS' | 'IMPLEMENTS' }> = [];
  const directParents = parentMap.get(classId) ?? [];

  for (const pid of directParents) {
    const et = directEdges.get(pid) ?? 'EXTENDS';
    if (!result.has(pid)) {
      result.set(pid, et);
      queue.push({ id: pid, edgeType: et });
    }
  }

  while (queue.length > 0) {
    const { id, edgeType } = queue.shift()!;
    const grandparents = parentMap.get(id) ?? [];
    for (const gp of grandparents) {
      if (!result.has(gp)) {
        result.set(gp, edgeType);
        queue.push({ id: gp, edgeType });
      }
    }
  }

  return result;
}
