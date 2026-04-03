import { describe, it, expect } from 'vitest';
import { computeMRO } from '../../src/core/ingestion/mro-processor.js';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import type { KnowledgeGraph } from '../../src/core/graph/types.js';
import { generateId } from '../../src/lib/utils.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function addClass(
  graph: KnowledgeGraph,
  name: string,
  language: string,
  label: 'Class' | 'Interface' | 'Struct' | 'Trait' = 'Class',
) {
  const id = generateId(label, name);
  graph.addNode({
    id,
    label,
    properties: { name, filePath: `src/${name}.ts`, language },
  });
  return id;
}

function addMethod(
  graph: KnowledgeGraph,
  className: string,
  methodName: string,
  classLabel: 'Class' | 'Interface' | 'Struct' | 'Trait' = 'Class',
  parameterTypes?: string[],
) {
  const classId = generateId(classLabel, className);
  const methodId = generateId('Method', `${className}.${methodName}`);
  graph.addNode({
    id: methodId,
    label: 'Method',
    properties: {
      name: methodName,
      filePath: `src/${className}.ts`,
      ...(parameterTypes ? { parameterTypes } : {}),
    },
  });
  graph.addRelationship({
    id: generateId('HAS_METHOD', `${classId}->${methodId}`),
    sourceId: classId,
    targetId: methodId,
    type: 'HAS_METHOD',
    confidence: 1.0,
    reason: '',
  });
  return methodId;
}

function addExtends(
  graph: KnowledgeGraph,
  childName: string,
  parentName: string,
  childLabel: 'Class' | 'Struct' = 'Class',
  parentLabel: 'Class' | 'Interface' | 'Trait' = 'Class',
) {
  const childId = generateId(childLabel, childName);
  const parentId = generateId(parentLabel, parentName);
  graph.addRelationship({
    id: generateId('EXTENDS', `${childId}->${parentId}`),
    sourceId: childId,
    targetId: parentId,
    type: 'EXTENDS',
    confidence: 1.0,
    reason: '',
  });
}

function addInterfaceExtends(
  graph: KnowledgeGraph,
  childName: string,
  parentName: string,
  childLabel: 'Interface' | 'Trait' = 'Interface',
  parentLabel: 'Interface' | 'Trait' = 'Interface',
) {
  const childId = generateId(childLabel, childName);
  const parentId = generateId(parentLabel, parentName);
  graph.addRelationship({
    id: generateId('EXTENDS', `${childId}->${parentId}`),
    sourceId: childId,
    targetId: parentId,
    type: 'EXTENDS',
    confidence: 1.0,
    reason: '',
  });
}

function addImplements(
  graph: KnowledgeGraph,
  childName: string,
  parentName: string,
  childLabel: 'Class' | 'Struct' = 'Class',
  parentLabel: 'Interface' | 'Trait' = 'Interface',
) {
  const childId = generateId(childLabel, childName);
  const parentId = generateId(parentLabel, parentName);
  graph.addRelationship({
    id: generateId('IMPLEMENTS', `${childId}->${parentId}`),
    sourceId: childId,
    targetId: parentId,
    type: 'IMPLEMENTS',
    confidence: 1.0,
    reason: '',
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('computeMRO', () => {
  // ---- C++ diamond --------------------------------------------------------
  describe('C++ diamond inheritance', () => {
    it('leftmost base wins when both B and C override foo', () => {
      // Diamond: A <- B, A <- C, B <- D, C <- D
      const graph = createKnowledgeGraph();
      const aId = addClass(graph, 'A', 'cpp');
      const bId = addClass(graph, 'B', 'cpp');
      const cId = addClass(graph, 'C', 'cpp');
      const dId = addClass(graph, 'D', 'cpp');

      addExtends(graph, 'B', 'A');
      addExtends(graph, 'C', 'A');
      addExtends(graph, 'D', 'B'); // B is leftmost
      addExtends(graph, 'D', 'C');

      // A has foo, B overrides foo, C overrides foo
      addMethod(graph, 'A', 'foo');
      const bFoo = addMethod(graph, 'B', 'foo');
      const cFoo = addMethod(graph, 'C', 'foo');

      const result = computeMRO(graph);

      // D should have an entry with ambiguity on foo
      const dEntry = result.entries.find((e) => e.className === 'D');
      expect(dEntry).toBeDefined();
      expect(dEntry!.language).toBe('cpp');

      const fooAmbiguity = dEntry!.ambiguities.find((a) => a.methodName === 'foo');
      expect(fooAmbiguity).toBeDefined();
      expect(fooAmbiguity!.definedIn.length).toBeGreaterThanOrEqual(2);

      // Leftmost base (B) wins
      expect(fooAmbiguity!.resolvedTo).toBe(bFoo);
      expect(fooAmbiguity!.reason).toContain('leftmost base');
      expect(fooAmbiguity!.reason).toContain('B');

      // OVERRIDES edge emitted
      expect(result.overrideEdges).toBeGreaterThanOrEqual(1);
      const overrides = graph.relationships.filter((r) => r.type === 'METHOD_OVERRIDES');
      expect(overrides.some((r) => r.sourceId === dId && r.targetId === bFoo)).toBe(true);
    });

    it('no ambiguity when foo only in A (diamond no override)', () => {
      // Diamond: A <- B, A <- C, B <- D, C <- D, but only A has foo
      const graph = createKnowledgeGraph();
      addClass(graph, 'A', 'cpp');
      addClass(graph, 'B', 'cpp');
      addClass(graph, 'C', 'cpp');
      addClass(graph, 'D', 'cpp');

      addExtends(graph, 'B', 'A');
      addExtends(graph, 'C', 'A');
      addExtends(graph, 'D', 'B');
      addExtends(graph, 'D', 'C');

      // Only A has foo
      addMethod(graph, 'A', 'foo');

      const result = computeMRO(graph);

      const dEntry = result.entries.find((e) => e.className === 'D');
      expect(dEntry).toBeDefined();
      // A::foo appears only once across ancestors — no collision
      // (B and C don't have their own foo, the duplicate is A::foo seen through both paths)
      const fooAmbiguity = dEntry!.ambiguities.find((a) => a.methodName === 'foo');
      expect(fooAmbiguity).toBeUndefined();
    });
  });

  // ---- C# class + interface -----------------------------------------------
  describe('C# class + interface', () => {
    it('class method beats interface default', () => {
      const graph = createKnowledgeGraph();
      const classId = addClass(graph, 'MyClass', 'csharp');
      const baseId = addClass(graph, 'BaseClass', 'csharp');
      const ifaceId = addClass(graph, 'IDoSomething', 'csharp', 'Interface');

      addExtends(graph, 'MyClass', 'BaseClass');
      addImplements(graph, 'MyClass', 'IDoSomething');

      const baseDoIt = addMethod(graph, 'BaseClass', 'doIt');
      const ifaceDoIt = addMethod(graph, 'IDoSomething', 'doIt', 'Interface');

      const result = computeMRO(graph);

      const entry = result.entries.find((e) => e.className === 'MyClass');
      expect(entry).toBeDefined();

      const doItAmbiguity = entry!.ambiguities.find((a) => a.methodName === 'doIt');
      expect(doItAmbiguity).toBeDefined();
      // Class method wins
      expect(doItAmbiguity!.resolvedTo).toBe(baseDoIt);
      expect(doItAmbiguity!.reason).toContain('class method wins');
    });

    it('multiple interface methods with same name are ambiguous', () => {
      const graph = createKnowledgeGraph();
      addClass(graph, 'MyClass', 'csharp');
      addClass(graph, 'IFoo', 'csharp', 'Interface');
      addClass(graph, 'IBar', 'csharp', 'Interface');

      addImplements(graph, 'MyClass', 'IFoo');
      addImplements(graph, 'MyClass', 'IBar');

      addMethod(graph, 'IFoo', 'process', 'Interface');
      addMethod(graph, 'IBar', 'process', 'Interface');

      const result = computeMRO(graph);

      const entry = result.entries.find((e) => e.className === 'MyClass');
      expect(entry).toBeDefined();

      const processAmbiguity = entry!.ambiguities.find((a) => a.methodName === 'process');
      expect(processAmbiguity).toBeDefined();
      expect(processAmbiguity!.resolvedTo).toBeNull();
      expect(processAmbiguity!.reason).toContain('ambiguous');
      expect(result.ambiguityCount).toBeGreaterThanOrEqual(1);
    });
  });

  // ---- Python C3 ----------------------------------------------------------
  describe('Python C3 linearization', () => {
    it('C3 order determines winner in diamond with overrides', () => {
      // Diamond: A <- B, A <- C, B <- D, C <- D
      // class D(B, C) → C3 MRO: B, C, A
      const graph = createKnowledgeGraph();
      addClass(graph, 'A', 'python');
      addClass(graph, 'B', 'python');
      addClass(graph, 'C', 'python');
      const dId = addClass(graph, 'D', 'python');

      addExtends(graph, 'B', 'A');
      addExtends(graph, 'C', 'A');
      addExtends(graph, 'D', 'B'); // B first → leftmost in C3
      addExtends(graph, 'D', 'C');

      addMethod(graph, 'A', 'foo');
      const bFoo = addMethod(graph, 'B', 'foo');
      addMethod(graph, 'C', 'foo');

      const result = computeMRO(graph);

      const dEntry = result.entries.find((e) => e.className === 'D');
      expect(dEntry).toBeDefined();

      const fooAmbiguity = dEntry!.ambiguities.find((a) => a.methodName === 'foo');
      expect(fooAmbiguity).toBeDefined();
      // C3 linearization for D(B, C): B comes first
      expect(fooAmbiguity!.resolvedTo).toBe(bFoo);
      expect(fooAmbiguity!.reason).toContain('C3 MRO');
    });
  });

  // ---- Java class + interface ---------------------------------------------
  describe('Java class + interface', () => {
    it('class method beats interface default', () => {
      const graph = createKnowledgeGraph();
      addClass(graph, 'Service', 'java');
      addClass(graph, 'BaseService', 'java');
      addClass(graph, 'Runnable', 'java', 'Interface');

      addExtends(graph, 'Service', 'BaseService');
      addImplements(graph, 'Service', 'Runnable');

      const baseRun = addMethod(graph, 'BaseService', 'run');
      addMethod(graph, 'Runnable', 'run', 'Interface');

      const result = computeMRO(graph);

      const entry = result.entries.find((e) => e.className === 'Service');
      expect(entry).toBeDefined();

      const runAmbiguity = entry!.ambiguities.find((a) => a.methodName === 'run');
      expect(runAmbiguity).toBeDefined();
      expect(runAmbiguity!.resolvedTo).toBe(baseRun);
      expect(runAmbiguity!.reason).toContain('class method wins');
    });
  });

  // ---- Rust trait conflicts -----------------------------------------------
  describe('Rust trait conflicts', () => {
    it('trait conflicts result in null resolution with qualified syntax reason', () => {
      const graph = createKnowledgeGraph();
      addClass(graph, 'MyStruct', 'rust', 'Struct');
      addClass(graph, 'TraitA', 'rust', 'Trait');
      addClass(graph, 'TraitB', 'rust', 'Trait');

      addImplements(graph, 'MyStruct', 'TraitA', 'Struct', 'Trait');
      addImplements(graph, 'MyStruct', 'TraitB', 'Struct', 'Trait');

      addMethod(graph, 'TraitA', 'execute', 'Trait');
      addMethod(graph, 'TraitB', 'execute', 'Trait');

      const result = computeMRO(graph);

      const entry = result.entries.find((e) => e.className === 'MyStruct');
      expect(entry).toBeDefined();

      const execAmbiguity = entry!.ambiguities.find((a) => a.methodName === 'execute');
      expect(execAmbiguity).toBeDefined();
      expect(execAmbiguity!.resolvedTo).toBeNull();
      expect(execAmbiguity!.reason).toContain('qualified syntax');
      expect(result.ambiguityCount).toBeGreaterThanOrEqual(1);

      // No OVERRIDES edge emitted for Rust ambiguity
      const overrides = graph.relationships.filter(
        (r) => r.type === 'METHOD_OVERRIDES' && r.sourceId === generateId('Struct', 'MyStruct'),
      );
      expect(overrides).toHaveLength(0);
    });
  });

  // ---- Property collisions don't trigger OVERRIDES ------------------------
  describe('Property nodes excluded from OVERRIDES', () => {
    it('property name collision across parents does not emit OVERRIDES edge', () => {
      const graph = createKnowledgeGraph();
      const parentA = addClass(graph, 'ParentA', 'typescript');
      const parentB = addClass(graph, 'ParentB', 'typescript');
      const child = addClass(graph, 'Child', 'typescript');

      addExtends(graph, 'Child', 'ParentA');
      addExtends(graph, 'Child', 'ParentB');

      // Add Property nodes (same name 'name') to both parents via HAS_PROPERTY
      const propA = generateId('Property', 'ParentA.name');
      graph.addNode({
        id: propA,
        label: 'Property',
        properties: { name: 'name', filePath: 'src/ParentA.ts' },
      });
      graph.addRelationship({
        id: generateId('HAS_PROPERTY', `${parentA}->${propA}`),
        sourceId: parentA,
        targetId: propA,
        type: 'HAS_PROPERTY',
        confidence: 1.0,
        reason: '',
      });

      const propB = generateId('Property', 'ParentB.name');
      graph.addNode({
        id: propB,
        label: 'Property',
        properties: { name: 'name', filePath: 'src/ParentB.ts' },
      });
      graph.addRelationship({
        id: generateId('HAS_PROPERTY', `${parentB}->${propB}`),
        sourceId: parentB,
        targetId: propB,
        type: 'HAS_PROPERTY',
        confidence: 1.0,
        reason: '',
      });

      const result = computeMRO(graph);

      // No OVERRIDES edge should be emitted for properties
      const overrides = graph.relationships.filter((r) => r.type === 'METHOD_OVERRIDES');
      expect(overrides).toHaveLength(0);
      expect(result.overrideEdges).toBe(0);
    });

    it('method collision still triggers OVERRIDES even when properties also collide', () => {
      const graph = createKnowledgeGraph();
      const parentA = addClass(graph, 'PA', 'cpp');
      const parentB = addClass(graph, 'PB', 'cpp');
      addClass(graph, 'Ch', 'cpp');

      addExtends(graph, 'Ch', 'PA');
      addExtends(graph, 'Ch', 'PB');

      // Method collision (should trigger OVERRIDES)
      const methodA = addMethod(graph, 'PA', 'doWork');
      addMethod(graph, 'PB', 'doWork');

      // Property collision (should NOT trigger OVERRIDES — properties use HAS_PROPERTY, not HAS_METHOD)
      const propA = generateId('Property', 'PA.id');
      graph.addNode({
        id: propA,
        label: 'Property',
        properties: { name: 'id', filePath: 'src/PA.ts' },
      });
      graph.addRelationship({
        id: generateId('HAS_PROPERTY', `${parentA}->${propA}`),
        sourceId: parentA,
        targetId: propA,
        type: 'HAS_PROPERTY',
        confidence: 1.0,
        reason: '',
      });

      const propB = generateId('Property', 'PB.id');
      graph.addNode({
        id: propB,
        label: 'Property',
        properties: { name: 'id', filePath: 'src/PB.ts' },
      });
      graph.addRelationship({
        id: generateId('HAS_PROPERTY', `${parentB}->${propB}`),
        sourceId: parentB,
        targetId: propB,
        type: 'HAS_PROPERTY',
        confidence: 1.0,
        reason: '',
      });

      const result = computeMRO(graph);

      // Only 1 OVERRIDES edge (for the method, not the property)
      const overrides = graph.relationships.filter((r) => r.type === 'METHOD_OVERRIDES');
      expect(overrides).toHaveLength(1);
      expect(overrides[0].targetId).toBe(methodA); // leftmost base wins for C++
      expect(result.overrideEdges).toBe(1);
    });
  });

  // ---- No ambiguity: single parent ----------------------------------------
  describe('single parent, no ambiguity', () => {
    it('single parent with unique methods produces no ambiguities', () => {
      const graph = createKnowledgeGraph();
      addClass(graph, 'Parent', 'typescript');
      addClass(graph, 'Child', 'typescript');

      addExtends(graph, 'Child', 'Parent');

      addMethod(graph, 'Parent', 'foo');
      addMethod(graph, 'Parent', 'bar');

      const result = computeMRO(graph);

      const entry = result.entries.find((e) => e.className === 'Child');
      expect(entry).toBeDefined();
      expect(entry!.ambiguities).toHaveLength(0);
    });
  });

  // ---- No parents: standalone class not in entries ------------------------
  describe('standalone class', () => {
    it('class with no parents is not included in entries', () => {
      const graph = createKnowledgeGraph();
      addClass(graph, 'Standalone', 'typescript');
      addMethod(graph, 'Standalone', 'doStuff');

      const result = computeMRO(graph);

      const entry = result.entries.find((e) => e.className === 'Standalone');
      expect(entry).toBeUndefined();
      expect(result.overrideEdges).toBe(0);
      expect(result.ambiguityCount).toBe(0);
    });
  });

  // ---- Own method shadows ancestor ----------------------------------------
  describe('own method shadows ancestor', () => {
    it('class defining its own method suppresses ambiguity', () => {
      const graph = createKnowledgeGraph();
      addClass(graph, 'Base1', 'cpp');
      addClass(graph, 'Base2', 'cpp');
      addClass(graph, 'Child', 'cpp');

      addExtends(graph, 'Child', 'Base1');
      addExtends(graph, 'Child', 'Base2');

      addMethod(graph, 'Base1', 'foo');
      addMethod(graph, 'Base2', 'foo');
      addMethod(graph, 'Child', 'foo'); // own method

      const result = computeMRO(graph);

      const entry = result.entries.find((e) => e.className === 'Child');
      expect(entry).toBeDefined();
      // No ambiguity because Child defines its own foo
      const fooAmbiguity = entry!.ambiguities.find((a) => a.methodName === 'foo');
      expect(fooAmbiguity).toBeUndefined();
    });
  });

  // ---- Empty graph --------------------------------------------------------
  describe('empty graph', () => {
    it('returns empty result for graph with no classes', () => {
      const graph = createKnowledgeGraph();
      const result = computeMRO(graph);
      expect(result.entries).toHaveLength(0);
      expect(result.overrideEdges).toBe(0);
      expect(result.ambiguityCount).toBe(0);
    });
  });

  // ---- Cyclic inheritance (P1 fix) ----------------------------------------
  describe('cyclic inheritance', () => {
    it('does not stack overflow on cyclic Python hierarchy', () => {
      // A extends B, B extends A — cyclic
      const graph = createKnowledgeGraph();
      addClass(graph, 'A', 'python');
      addClass(graph, 'B', 'python');
      addExtends(graph, 'A', 'B');
      addExtends(graph, 'B', 'A');
      addMethod(graph, 'A', 'foo');
      addMethod(graph, 'B', 'foo');

      // Should NOT throw — c3Linearize returns null, falls back to BFS
      const result = computeMRO(graph);
      expect(result).toBeDefined();
      // Both A and B have parents, so both get entries
      expect(result.entries.length).toBeGreaterThanOrEqual(1);
    });

    it('handles 3-node cycle gracefully', () => {
      // A → B → C → A
      const graph = createKnowledgeGraph();
      addClass(graph, 'X', 'python');
      addClass(graph, 'Y', 'python');
      addClass(graph, 'Z', 'python');
      addExtends(graph, 'X', 'Y');
      addExtends(graph, 'Y', 'Z');
      addExtends(graph, 'Z', 'X');

      const result = computeMRO(graph);
      expect(result).toBeDefined();
    });
  });

  // ---- METHOD_IMPLEMENTS edges -----------------------------------------------
  describe('METHOD_IMPLEMENTS edges', () => {
    it('emits METHOD_IMPLEMENTS for class implementing interface method', () => {
      // IAnimal { speak() } <-- Dog { speak() }
      const graph = createKnowledgeGraph();
      addClass(graph, 'IAnimal', 'java', 'Interface');
      addClass(graph, 'Dog', 'java');
      addImplements(graph, 'Dog', 'IAnimal');
      const ifaceMethod = addMethod(graph, 'IAnimal', 'speak', 'Interface');
      const classMethod = addMethod(graph, 'Dog', 'speak');

      const result = computeMRO(graph);
      expect(result.methodImplementsEdges).toBe(1);

      // Verify the edge exists: ConcreteMethod → InterfaceMethod
      const edges: any[] = [];
      graph.forEachRelationship((rel) => {
        if (rel.type === 'METHOD_IMPLEMENTS') edges.push(rel);
      });
      expect(edges).toHaveLength(1);
      expect(edges[0].sourceId).toBe(classMethod);
      expect(edges[0].targetId).toBe(ifaceMethod);
      expect(edges[0].confidence).toBe(1.0);
    });

    it('emits METHOD_IMPLEMENTS for Rust struct implementing trait', () => {
      // Drawable { draw() } <-- Circle { draw() }
      const graph = createKnowledgeGraph();
      addClass(graph, 'Drawable', 'rust', 'Trait');
      addClass(graph, 'Circle', 'rust', 'Struct');
      addImplements(graph, 'Circle', 'Drawable', 'Struct', 'Trait');
      const traitMethod = addMethod(graph, 'Drawable', 'draw', 'Trait');
      const structMethod = addMethod(graph, 'Circle', 'draw', 'Struct');

      const result = computeMRO(graph);
      expect(result.methodImplementsEdges).toBe(1);

      const edges: any[] = [];
      graph.forEachRelationship((rel) => {
        if (rel.type === 'METHOD_IMPLEMENTS') edges.push(rel);
      });
      expect(edges[0].sourceId).toBe(structMethod);
      expect(edges[0].targetId).toBe(traitMethod);
    });

    it('matches overloaded interface methods by parameterTypes', () => {
      // IRepo { find(String), find(String, int) } <-- SqlRepo { find(String), find(String, int) }
      const graph = createKnowledgeGraph();
      addClass(graph, 'IRepo', 'java', 'Interface');
      addClass(graph, 'SqlRepo', 'java');
      addImplements(graph, 'SqlRepo', 'IRepo');

      // Use manual IDs to avoid overloaded-name collision (same name, different types)
      const ifaceFind1 = generateId('Method', 'IRepo.find.1');
      graph.addNode({
        id: ifaceFind1,
        label: 'Method',
        properties: { name: 'find', filePath: 'src/IRepo.ts', parameterTypes: ['String'] },
      });
      graph.addRelationship({
        id: generateId('HAS_METHOD', `${generateId('Interface', 'IRepo')}->${ifaceFind1}`),
        sourceId: generateId('Interface', 'IRepo'),
        targetId: ifaceFind1,
        type: 'HAS_METHOD',
        confidence: 1.0,
        reason: '',
      });

      const ifaceFind2 = generateId('Method', 'IRepo.find.2');
      graph.addNode({
        id: ifaceFind2,
        label: 'Method',
        properties: { name: 'find', filePath: 'src/IRepo.ts', parameterTypes: ['String', 'int'] },
      });
      graph.addRelationship({
        id: generateId('HAS_METHOD', `${generateId('Interface', 'IRepo')}->${ifaceFind2}`),
        sourceId: generateId('Interface', 'IRepo'),
        targetId: ifaceFind2,
        type: 'HAS_METHOD',
        confidence: 1.0,
        reason: '',
      });

      const sqlFind1Id = generateId('Method', 'SqlRepo.find.1');
      graph.addNode({
        id: sqlFind1Id,
        label: 'Method',
        properties: { name: 'find', filePath: 'src/SqlRepo.ts', parameterTypes: ['String'] },
      });
      graph.addRelationship({
        id: generateId('HAS_METHOD', `${generateId('Class', 'SqlRepo')}->${sqlFind1Id}`),
        sourceId: generateId('Class', 'SqlRepo'),
        targetId: sqlFind1Id,
        type: 'HAS_METHOD',
        confidence: 1.0,
        reason: '',
      });

      const sqlFind2Id = generateId('Method', 'SqlRepo.find.2');
      graph.addNode({
        id: sqlFind2Id,
        label: 'Method',
        properties: { name: 'find', filePath: 'src/SqlRepo.ts', parameterTypes: ['String', 'int'] },
      });
      graph.addRelationship({
        id: generateId('HAS_METHOD', `${generateId('Class', 'SqlRepo')}->${sqlFind2Id}`),
        sourceId: generateId('Class', 'SqlRepo'),
        targetId: sqlFind2Id,
        type: 'HAS_METHOD',
        confidence: 1.0,
        reason: '',
      });

      const result = computeMRO(graph);
      expect(result.methodImplementsEdges).toBe(2);

      const edges: any[] = [];
      graph.forEachRelationship((rel) => {
        if (rel.type === 'METHOD_IMPLEMENTS') edges.push(rel);
      });
      expect(edges).toHaveLength(2);
      // find(String) → find(String) and find(String, int) → find(String, int)
      const edge1 = edges.find((e) => e.targetId === ifaceFind1);
      const edge2 = edges.find((e) => e.targetId === ifaceFind2);
      expect(edge1).toBeDefined();
      expect(edge1!.sourceId).toBe(sqlFind1Id);
      expect(edge2).toBeDefined();
      expect(edge2!.sourceId).toBe(sqlFind2Id);
    });

    it('includes default interface methods (not just abstract)', () => {
      // Java 8 default method: IFoo { bar() } <-- Baz { bar() }
      const graph = createKnowledgeGraph();
      addClass(graph, 'IFoo', 'java', 'Interface');
      addClass(graph, 'Baz', 'java');
      addImplements(graph, 'Baz', 'IFoo');
      // Default method (has body, not abstract) — should still get METHOD_IMPLEMENTS
      addMethod(graph, 'IFoo', 'bar', 'Interface');
      addMethod(graph, 'Baz', 'bar');

      const result = computeMRO(graph);
      expect(result.methodImplementsEdges).toBe(1);
    });

    it('does not emit METHOD_IMPLEMENTS for class extending another class', () => {
      // Animal { speak() } <-- Dog { speak() } — EXTENDS, not IMPLEMENTS
      const graph = createKnowledgeGraph();
      addClass(graph, 'Animal', 'java');
      addClass(graph, 'Dog', 'java');
      addExtends(graph, 'Dog', 'Animal');
      addMethod(graph, 'Animal', 'speak');
      addMethod(graph, 'Dog', 'speak');

      const result = computeMRO(graph);
      expect(result.methodImplementsEdges).toBe(0);
    });

    it('does not emit METHOD_IMPLEMENTS when class has no matching method', () => {
      // IAnimal { speak() } <-- Dog { bark() } — no name match
      const graph = createKnowledgeGraph();
      addClass(graph, 'IAnimal', 'java', 'Interface');
      addClass(graph, 'Dog', 'java');
      addImplements(graph, 'Dog', 'IAnimal');
      addMethod(graph, 'IAnimal', 'speak', 'Interface');
      addMethod(graph, 'Dog', 'bark');

      const result = computeMRO(graph);
      expect(result.methodImplementsEdges).toBe(0);
    });

    it('skips Property nodes on interface', () => {
      const graph = createKnowledgeGraph();
      addClass(graph, 'IFoo', 'csharp', 'Interface');
      addClass(graph, 'Bar', 'csharp');
      addImplements(graph, 'Bar', 'IFoo');

      // Add a Property to the interface (not a Method)
      const propId = generateId('Property', 'IFoo.name');
      graph.addNode({
        id: propId,
        label: 'Property',
        properties: { name: 'name', filePath: 'src/IFoo.ts' },
      });
      graph.addRelationship({
        id: generateId('HAS_METHOD', `${generateId('Interface', 'IFoo')}->${propId}`),
        sourceId: generateId('Interface', 'IFoo'),
        targetId: propId,
        type: 'HAS_METHOD',
        confidence: 1.0,
        reason: '',
      });
      addMethod(graph, 'Bar', 'name');

      const result = computeMRO(graph);
      expect(result.methodImplementsEdges).toBe(0);
    });

    describe('METHOD_IMPLEMENTS transitive ancestors', () => {
      it('transitive interface chain: C.foo links to both B.foo and A.foo', () => {
        // A (Interface) has foo, B (Interface) has foo extends A, C (Class) implements B
        const graph = createKnowledgeGraph();
        addClass(graph, 'A', 'java', 'Interface');
        addClass(graph, 'B', 'java', 'Interface');
        addClass(graph, 'C', 'java');

        addInterfaceExtends(graph, 'B', 'A');
        addImplements(graph, 'C', 'B');

        const aFoo = addMethod(graph, 'A', 'foo', 'Interface');
        const bFoo = addMethod(graph, 'B', 'foo', 'Interface');
        addMethod(graph, 'C', 'foo');

        const result = computeMRO(graph);

        const edges: any[] = [];
        graph.forEachRelationship((rel) => {
          if (rel.type === 'METHOD_IMPLEMENTS') edges.push(rel);
        });

        // C.foo should link to both B.foo and A.foo
        expect(edges.some((e) => e.targetId === bFoo)).toBe(true);
        expect(edges.some((e) => e.targetId === aFoo)).toBe(true);
        expect(result.methodImplementsEdges).toBeGreaterThanOrEqual(2);
      });

      it('inherited contract method only on grandparent: C.bar links to A.bar', () => {
        // A (Interface) has bar, B (Interface) extends A but has NO bar, C implements B
        const graph = createKnowledgeGraph();
        addClass(graph, 'A', 'java', 'Interface');
        addClass(graph, 'B', 'java', 'Interface');
        addClass(graph, 'C', 'java');

        addInterfaceExtends(graph, 'B', 'A');
        addImplements(graph, 'C', 'B');

        const aBar = addMethod(graph, 'A', 'bar', 'Interface');
        // B has no bar method
        addMethod(graph, 'C', 'bar');

        const result = computeMRO(graph);

        const edges: any[] = [];
        graph.forEachRelationship((rel) => {
          if (rel.type === 'METHOD_IMPLEMENTS') edges.push(rel);
        });

        // C.bar should link to A.bar even though A is not a direct parent
        expect(edges.some((e) => e.targetId === aBar)).toBe(true);
        expect(result.methodImplementsEdges).toBeGreaterThanOrEqual(1);
      });

      it('diamond deduplication: E.foo gets exactly one edge to A.foo', () => {
        // A (Interface) has foo
        // B (Interface) has foo, extends A
        // D (Interface) has foo, extends A
        // E (Class) implements B and D
        const graph = createKnowledgeGraph();
        addClass(graph, 'A', 'java', 'Interface');
        addClass(graph, 'B', 'java', 'Interface');
        addClass(graph, 'D', 'java', 'Interface');
        addClass(graph, 'E', 'java');

        addInterfaceExtends(graph, 'B', 'A');
        addInterfaceExtends(graph, 'D', 'A');
        addImplements(graph, 'E', 'B');
        addImplements(graph, 'E', 'D');

        const aFoo = addMethod(graph, 'A', 'foo', 'Interface');
        const bFoo = addMethod(graph, 'B', 'foo', 'Interface');
        const dFoo = addMethod(graph, 'D', 'foo', 'Interface');
        addMethod(graph, 'E', 'foo');

        const result = computeMRO(graph);

        const eFoo = generateId('Method', 'E.foo');
        const edges: any[] = [];
        graph.forEachRelationship((rel) => {
          if (rel.type === 'METHOD_IMPLEMENTS') edges.push(rel);
        });

        // Filter to only edges FROM E.foo
        const eFooEdges = edges.filter((e) => e.sourceId === eFoo);

        // E.foo should link to B.foo, D.foo, and exactly ONE A.foo (deduplicated)
        expect(eFooEdges.filter((e) => e.targetId === bFoo)).toHaveLength(1);
        expect(eFooEdges.filter((e) => e.targetId === dFoo)).toHaveLength(1);
        expect(eFooEdges.filter((e) => e.targetId === aFoo)).toHaveLength(1);
        // Total from E.foo: 3 edges (B.foo + D.foo + A.foo), not 4
        expect(eFooEdges).toHaveLength(3);
      });

      it('no transitive through class-only chain', () => {
        // A (Class) has foo, B (Class) extends A has foo, C (Class) extends B has foo
        const graph = createKnowledgeGraph();
        addClass(graph, 'A', 'java');
        addClass(graph, 'B', 'java');
        addClass(graph, 'C', 'java');

        addExtends(graph, 'B', 'A');
        addExtends(graph, 'C', 'B');

        addMethod(graph, 'A', 'foo');
        addMethod(graph, 'B', 'foo');
        addMethod(graph, 'C', 'foo');

        const result = computeMRO(graph);

        // All class-extends, no interface involved → 0 METHOD_IMPLEMENTS edges
        expect(result.methodImplementsEdges).toBe(0);
      });
    });

    it('is queryable via MATCH pattern', () => {
      const graph = createKnowledgeGraph();
      addClass(graph, 'IRepo', 'typescript', 'Interface');
      addClass(graph, 'SqlRepo', 'typescript');
      addImplements(graph, 'SqlRepo', 'IRepo');
      addMethod(graph, 'IRepo', 'fetch', 'Interface');
      const concreteId = addMethod(graph, 'SqlRepo', 'fetch');

      computeMRO(graph);

      // Simulate MATCH (m)-[:METHOD_IMPLEMENTS]->(i) RETURN m
      const implementingMethods: string[] = [];
      graph.forEachRelationship((rel) => {
        if (rel.type === 'METHOD_IMPLEMENTS') {
          implementingMethods.push(rel.sourceId);
        }
      });
      expect(implementingMethods).toContain(concreteId);
    });

    describe('METHOD_IMPLEMENTS inherited + arity matching', () => {
      it('inherited implementation: Base.foo satisfies I.foo when C has no own foo', () => {
        const graph = createKnowledgeGraph();
        addClass(graph, 'Base', 'java');
        addClass(graph, 'I', 'java', 'Interface');
        addClass(graph, 'C', 'java');

        addExtends(graph, 'C', 'Base');
        addImplements(graph, 'C', 'I');

        const baseFoo = addMethod(graph, 'Base', 'foo');
        const iFoo = addMethod(graph, 'I', 'foo', 'Interface');

        const result = computeMRO(graph);

        const edges: any[] = [];
        graph.forEachRelationship((rel) => {
          if (rel.type === 'METHOD_IMPLEMENTS') edges.push(rel);
        });

        expect(edges).toHaveLength(1);
        expect(edges[0].sourceId).toBe(baseFoo);
        expect(edges[0].targetId).toBe(iFoo);
        expect(result.methodImplementsEdges).toBe(1);
      });

      it('class has own method — no inherited lookup needed', () => {
        const graph = createKnowledgeGraph();
        addClass(graph, 'Base2', 'java');
        addClass(graph, 'I2', 'java', 'Interface');
        addClass(graph, 'C2', 'java');

        addExtends(graph, 'C2', 'Base2');
        addImplements(graph, 'C2', 'I2');

        const baseFoo = addMethod(graph, 'Base2', 'foo');
        const iFoo = addMethod(graph, 'I2', 'foo', 'Interface');
        const cFoo = addMethod(graph, 'C2', 'foo');

        const result = computeMRO(graph);

        const edges: any[] = [];
        graph.forEachRelationship((rel) => {
          if (rel.type === 'METHOD_IMPLEMENTS') edges.push(rel);
        });

        // Should use C2.foo, not Base2.foo
        expect(edges).toHaveLength(1);
        expect(edges[0].sourceId).toBe(cFoo);
        expect(edges[0].targetId).toBe(iFoo);
      });

      it('deep inheritance chain: GrandBase.foo satisfies I.foo', () => {
        const graph = createKnowledgeGraph();
        addClass(graph, 'GrandBase', 'java');
        addClass(graph, 'Base3', 'java');
        addClass(graph, 'I3', 'java', 'Interface');
        addClass(graph, 'C3', 'java');

        addExtends(graph, 'Base3', 'GrandBase');
        addExtends(graph, 'C3', 'Base3');
        addImplements(graph, 'C3', 'I3');

        const grandFoo = addMethod(graph, 'GrandBase', 'foo');
        // Base3 has NO foo
        const iFoo = addMethod(graph, 'I3', 'foo', 'Interface');

        const result = computeMRO(graph);

        const edges: any[] = [];
        graph.forEachRelationship((rel) => {
          if (rel.type === 'METHOD_IMPLEMENTS') edges.push(rel);
        });

        expect(edges).toHaveLength(1);
        expect(edges[0].sourceId).toBe(grandFoo);
        expect(edges[0].targetId).toBe(iFoo);
        expect(result.methodImplementsEdges).toBe(1);
      });

      it('arity mismatch prevents false match', () => {
        const graph = createKnowledgeGraph();
        addClass(graph, 'IArity', 'java', 'Interface');
        addClass(graph, 'CArity', 'java');
        addImplements(graph, 'CArity', 'IArity');

        // Interface method: parameterCount=2, no parameterTypes
        const iMethodId = generateId('Method', 'IArity.process');
        graph.addNode({
          id: iMethodId,
          label: 'Method',
          properties: { name: 'process', filePath: 'src/IArity.ts', parameterCount: 2 },
        });
        graph.addRelationship({
          id: generateId('HAS_METHOD', `${generateId('Interface', 'IArity')}->${iMethodId}`),
          sourceId: generateId('Interface', 'IArity'),
          targetId: iMethodId,
          type: 'HAS_METHOD',
          confidence: 1.0,
          reason: '',
        });

        // Class method: parameterCount=3, no parameterTypes
        const cMethodId = generateId('Method', 'CArity.process');
        graph.addNode({
          id: cMethodId,
          label: 'Method',
          properties: { name: 'process', filePath: 'src/CArity.ts', parameterCount: 3 },
        });
        graph.addRelationship({
          id: generateId('HAS_METHOD', `${generateId('Class', 'CArity')}->${cMethodId}`),
          sourceId: generateId('Class', 'CArity'),
          targetId: cMethodId,
          type: 'HAS_METHOD',
          confidence: 1.0,
          reason: '',
        });

        const result = computeMRO(graph);
        expect(result.methodImplementsEdges).toBe(0);
      });

      it('arity match when types missing', () => {
        const graph = createKnowledgeGraph();
        addClass(graph, 'IArityOk', 'java', 'Interface');
        addClass(graph, 'CArityOk', 'java');
        addImplements(graph, 'CArityOk', 'IArityOk');

        // Interface method: parameterCount=2, no parameterTypes
        const iMethodId = generateId('Method', 'IArityOk.process');
        graph.addNode({
          id: iMethodId,
          label: 'Method',
          properties: { name: 'process', filePath: 'src/IArityOk.ts', parameterCount: 2 },
        });
        graph.addRelationship({
          id: generateId('HAS_METHOD', `${generateId('Interface', 'IArityOk')}->${iMethodId}`),
          sourceId: generateId('Interface', 'IArityOk'),
          targetId: iMethodId,
          type: 'HAS_METHOD',
          confidence: 1.0,
          reason: '',
        });

        // Class method: parameterCount=2, no parameterTypes
        const cMethodId = generateId('Method', 'CArityOk.process');
        graph.addNode({
          id: cMethodId,
          label: 'Method',
          properties: { name: 'process', filePath: 'src/CArityOk.ts', parameterCount: 2 },
        });
        graph.addRelationship({
          id: generateId('HAS_METHOD', `${generateId('Class', 'CArityOk')}->${cMethodId}`),
          sourceId: generateId('Class', 'CArityOk'),
          targetId: cMethodId,
          type: 'HAS_METHOD',
          confidence: 1.0,
          reason: '',
        });

        const result = computeMRO(graph);
        expect(result.methodImplementsEdges).toBe(1);
      });

      it('multiple same-arity candidates = ambiguous, no edge emitted', () => {
        const graph = createKnowledgeGraph();
        addClass(graph, 'IAmbig', 'java', 'Interface');
        addClass(graph, 'CAmbig', 'java');
        addImplements(graph, 'CAmbig', 'IAmbig');

        // Interface method: parameterCount=1, no parameterTypes
        const iMethodId = generateId('Method', 'IAmbig.handle');
        graph.addNode({
          id: iMethodId,
          label: 'Method',
          properties: { name: 'handle', filePath: 'src/IAmbig.ts', parameterCount: 1 },
        });
        graph.addRelationship({
          id: generateId('HAS_METHOD', `${generateId('Interface', 'IAmbig')}->${iMethodId}`),
          sourceId: generateId('Interface', 'IAmbig'),
          targetId: iMethodId,
          type: 'HAS_METHOD',
          confidence: 1.0,
          reason: '',
        });

        // Two class methods named handle, both with parameterCount=1
        const cMethod1 = generateId('Method', 'CAmbig.handle.1');
        graph.addNode({
          id: cMethod1,
          label: 'Method',
          properties: { name: 'handle', filePath: 'src/CAmbig.ts', parameterCount: 1 },
        });
        graph.addRelationship({
          id: generateId('HAS_METHOD', `${generateId('Class', 'CAmbig')}->${cMethod1}`),
          sourceId: generateId('Class', 'CAmbig'),
          targetId: cMethod1,
          type: 'HAS_METHOD',
          confidence: 1.0,
          reason: '',
        });

        const cMethod2 = generateId('Method', 'CAmbig.handle.2');
        graph.addNode({
          id: cMethod2,
          label: 'Method',
          properties: { name: 'handle', filePath: 'src/CAmbig.ts', parameterCount: 1 },
        });
        graph.addRelationship({
          id: generateId('HAS_METHOD', `${generateId('Class', 'CAmbig')}->${cMethod2}`),
          sourceId: generateId('Class', 'CAmbig'),
          targetId: cMethod2,
          type: 'HAS_METHOD',
          confidence: 1.0,
          reason: '',
        });

        const result = computeMRO(graph);
        expect(result.methodImplementsEdges).toBe(0);
      });
    });
  });

  // ---- findInheritedMethod ambiguity detection ------------------------------
  describe('findInheritedMethod ambiguity', () => {
    it('returns null when two EXTENDS parents both provide matching method', () => {
      // I { foo() }, B { foo() }, M { foo() }, C extends B + M, C implements I
      const graph = createKnowledgeGraph();
      addClass(graph, 'I', 'cpp', 'Interface');
      addClass(graph, 'B', 'cpp');
      addClass(graph, 'M', 'cpp');
      addClass(graph, 'C', 'cpp');
      addImplements(graph, 'C', 'I');
      addExtends(graph, 'C', 'B');
      addExtends(graph, 'C', 'M');
      addMethod(graph, 'I', 'foo', 'Interface');
      addMethod(graph, 'B', 'foo');
      addMethod(graph, 'M', 'foo');
      // C has NO own foo — must walk EXTENDS chain

      const result = computeMRO(graph);
      // Ambiguous: B.foo and M.foo both match — no METHOD_IMPLEMENTS edge
      const mi = graph.relationships.filter((r) => r.type === 'METHOD_IMPLEMENTS');
      const fooEdges = mi.filter((e) => graph.getNode(e.targetId)?.properties.name === 'foo');
      expect(fooEdges).toHaveLength(0);
    });

    it('diamond dedup: same method via two paths is NOT ambiguous', () => {
      // I { foo() }, GrandBase { foo() }, B extends GrandBase, M extends GrandBase
      // C extends B + M, C implements I
      const graph = createKnowledgeGraph();
      addClass(graph, 'I', 'cpp', 'Interface');
      addClass(graph, 'GrandBase', 'cpp');
      addClass(graph, 'B', 'cpp');
      addClass(graph, 'M', 'cpp');
      addClass(graph, 'C', 'cpp');
      addImplements(graph, 'C', 'I');
      addExtends(graph, 'C', 'B');
      addExtends(graph, 'C', 'M');
      addExtends(graph, 'B', 'GrandBase');
      addExtends(graph, 'M', 'GrandBase');
      addMethod(graph, 'I', 'foo', 'Interface');
      const gbFoo = addMethod(graph, 'GrandBase', 'foo');
      // B and M have NO own foo — both inherit from GrandBase

      const result = computeMRO(graph);
      // Not ambiguous: same GrandBase.foo via both paths
      const mi = graph.relationships.filter((r) => r.type === 'METHOD_IMPLEMENTS');
      const fooEdge = mi.find((e) => e.sourceId === gbFoo);
      expect(fooEdge).toBeDefined();
    });

    it('C extends B extends A, B and A both have foo → returns B.foo (nearest)', () => {
      // I { foo() }, A { foo() }, B extends A { foo() }, C extends B implements I { no foo }
      const graph = createKnowledgeGraph();
      addClass(graph, 'I', 'java', 'Interface');
      addClass(graph, 'A', 'java');
      addClass(graph, 'B', 'java');
      addClass(graph, 'C', 'java');
      addImplements(graph, 'C', 'I');
      addExtends(graph, 'C', 'B');
      addExtends(graph, 'B', 'A');
      addMethod(graph, 'I', 'foo', 'Interface');
      addMethod(graph, 'A', 'foo');
      const bFoo = addMethod(graph, 'B', 'foo');
      // C has NO own foo — nearest is B.foo at depth 1

      computeMRO(graph);
      const mi = graph.relationships.filter((r) => r.type === 'METHOD_IMPLEMENTS');
      const fooEdge = mi.find((e) => e.sourceId === bFoo);
      expect(fooEdge).toBeDefined();
      // A.foo should NOT be reached
      const aFooId = generateId('Method', 'A.foo');
      const aFooEdge = mi.find((e) => e.sourceId === aFooId);
      expect(aFooEdge).toBeUndefined();
    });

    it('C extends B extends A, only A has foo → returns A.foo (single match at depth 2)', () => {
      // I { foo() }, A { foo() }, B extends A { no foo }, C extends B implements I { no foo }
      const graph = createKnowledgeGraph();
      addClass(graph, 'I', 'java', 'Interface');
      addClass(graph, 'A', 'java');
      addClass(graph, 'B', 'java');
      addClass(graph, 'C', 'java');
      addImplements(graph, 'C', 'I');
      addExtends(graph, 'C', 'B');
      addExtends(graph, 'B', 'A');
      addMethod(graph, 'I', 'foo', 'Interface');
      const aFoo = addMethod(graph, 'A', 'foo');
      // B has NO foo, C has NO foo — only A.foo at depth 2

      computeMRO(graph);
      const mi = graph.relationships.filter((r) => r.type === 'METHOD_IMPLEMENTS');
      const fooEdge = mi.find((e) => e.sourceId === aFoo);
      expect(fooEdge).toBeDefined();
    });
  });

  // ---- METHOD_IMPLEMENTS concrete-source guard ----------------------------
  describe('METHOD_IMPLEMENTS concrete-source guard', () => {
    it('interface B extends interface A, B redeclares foo → 0 METHOD_IMPLEMENTS', () => {
      const graph = createKnowledgeGraph();
      addClass(graph, 'A', 'java', 'Interface');
      addClass(graph, 'B', 'java', 'Interface');
      addInterfaceExtends(graph, 'B', 'A');
      addMethod(graph, 'A', 'foo', 'Interface');
      addMethod(graph, 'B', 'foo', 'Interface');

      computeMRO(graph);

      const mi = graph.relationships.filter((r) => r.type === 'METHOD_IMPLEMENTS');
      expect(mi).toHaveLength(0);
    });

    it('abstract class C implements I, C has abstract foo → 0 METHOD_IMPLEMENTS for foo', () => {
      const graph = createKnowledgeGraph();
      addClass(graph, 'I', 'java', 'Interface');
      addClass(graph, 'C', 'java', 'Class');
      addImplements(graph, 'C', 'I');
      addMethod(graph, 'I', 'foo', 'Interface');

      // Add abstract method manually with isAbstract flag
      const classId = generateId('Class', 'C');
      const methodId = generateId('Method', 'C.foo');
      graph.addNode({
        id: methodId,
        label: 'Method',
        properties: { name: 'foo', filePath: 'src/C.ts', isAbstract: true },
      });
      graph.addRelationship({
        id: generateId('HAS_METHOD', `${classId}->${methodId}`),
        sourceId: classId,
        targetId: methodId,
        type: 'HAS_METHOD',
        confidence: 1.0,
        reason: '',
      });

      computeMRO(graph);

      const mi = graph.relationships.filter((r) => r.type === 'METHOD_IMPLEMENTS');
      expect(mi).toHaveLength(0);
    });

    it('abstract class C implements I, C has concrete bar → 1 METHOD_IMPLEMENTS for bar', () => {
      const graph = createKnowledgeGraph();
      addClass(graph, 'I', 'java', 'Interface');
      addClass(graph, 'C', 'java', 'Class');
      addImplements(graph, 'C', 'I');
      addMethod(graph, 'I', 'bar', 'Interface');
      const cBar = addMethod(graph, 'C', 'bar');

      computeMRO(graph);

      const mi = graph.relationships.filter((r) => r.type === 'METHOD_IMPLEMENTS');
      expect(mi).toHaveLength(1);
      expect(mi[0].sourceId).toBe(cBar);
    });

    it('concrete class implements interface → 1 METHOD_IMPLEMENTS (regression)', () => {
      const graph = createKnowledgeGraph();
      addClass(graph, 'I', 'java', 'Interface');
      addClass(graph, 'C', 'java', 'Class');
      addImplements(graph, 'C', 'I');
      addMethod(graph, 'I', 'foo', 'Interface');
      const cFoo = addMethod(graph, 'C', 'foo');

      computeMRO(graph);

      const mi = graph.relationships.filter((r) => r.type === 'METHOD_IMPLEMENTS');
      expect(mi).toHaveLength(1);
      expect(mi[0].sourceId).toBe(cFoo);
    });
  });
});
