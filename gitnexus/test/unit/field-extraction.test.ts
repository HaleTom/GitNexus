import { describe, it, expect, beforeEach } from 'vitest';
import { TypeScriptFieldExtractor } from '../../src/core/ingestion/field-extractors/typescript.js';
import type { FieldExtractorContext, ExtractedFields } from '../../src/core/ingestion/field-types.js';
import type { TypeEnvironment } from '../../src/core/ingestion/type-env.js';
import { createSymbolTable } from '../../src/core/ingestion/symbol-table.js';
import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';
import { SupportedLanguages } from '../../src/config/supported-languages.js';

const parser = new Parser();

const parse = (code: string) => {
  parser.setLanguage(TypeScript.typescript);
  return parser.parse(code);
};

// Mock context for tests
const createMockContext = (): FieldExtractorContext => ({
  typeEnv: {
    lookup: () => undefined,
    constructorBindings: [],
    fileScope: () => new Map(),
    allScopes: () => new Map(),
    constructorTypeMap: new Map(),
  } as TypeEnvironment,
  symbolTable: createSymbolTable(),
  filePath: 'test.ts',
  language: SupportedLanguages.TypeScript,
});

describe('TypeScriptFieldExtractor', () => {
  let extractor: TypeScriptFieldExtractor;
  let mockContext: FieldExtractorContext;

  beforeEach(() => {
    extractor = new TypeScriptFieldExtractor();
    mockContext = createMockContext();
  });

  describe('isTypeDeclaration', () => {
    it('recognizes class_declaration', () => {
      const tree = parse('class User {}');
      const classNode = tree.rootNode.child(0);
      expect(classNode).toBeDefined();
      expect(extractor.isTypeDeclaration(classNode!)).toBe(true);
    });

    it('recognizes interface_declaration', () => {
      const tree = parse('interface IUser {}');
      const interfaceNode = tree.rootNode.child(0);
      expect(interfaceNode).toBeDefined();
      expect(extractor.isTypeDeclaration(interfaceNode!)).toBe(true);
    });

    it('recognizes abstract_class_declaration', () => {
      const tree = parse('abstract class BaseService {}');
      const abstractNode = tree.rootNode.child(0);
      expect(abstractNode).toBeDefined();
      expect(extractor.isTypeDeclaration(abstractNode!)).toBe(true);
    });

    it('rejects function_declaration', () => {
      const tree = parse('function getUser() {}');
      const functionNode = tree.rootNode.child(0);
      expect(functionNode).toBeDefined();
      expect(extractor.isTypeDeclaration(functionNode!)).toBe(false);
    });

    it('rejects variable declaration', () => {
      const tree = parse('const user = {};');
      const variableNode = tree.rootNode.child(0);
      expect(variableNode).toBeDefined();
      expect(extractor.isTypeDeclaration(variableNode!)).toBe(false);
    });
  });

  describe('extract', () => {
    it('extracts single field with type', () => {
      const tree = parse(`
        class User {
          name: string;
        }
      `);
      const classNode = tree.rootNode.child(0);
      const result = extractor.extract(classNode!, mockContext);

      expect(result).not.toBeNull();
      expect(result!.ownerFqn).toBe('User');
      expect(result!.fields).toHaveLength(1);
      expect(result!.fields[0].name).toBe('name');
      expect(result!.fields[0].type).toBe('string');
      expect(result!.fields[0].visibility).toBe('public');
    });

    it('extracts private field', () => {
      const tree = parse(`
        class User {
          private password: string;
        }
      `);
      const classNode = tree.rootNode.child(0);
      const result = extractor.extract(classNode!, mockContext);

      expect(result).not.toBeNull();
      expect(result!.fields).toHaveLength(1);
      expect(result!.fields[0].name).toBe('password');
      expect(result!.fields[0].type).toBe('string');
      expect(result!.fields[0].visibility).toBe('private');
    });

    it('extracts static readonly field', () => {
      const tree = parse(`
        class Config {
          static readonly VERSION: string = '1.0';
        }
      `);
      const classNode = tree.rootNode.child(0);
      const result = extractor.extract(classNode!, mockContext);

      expect(result).not.toBeNull();
      expect(result!.fields).toHaveLength(1);
      expect(result!.fields[0].name).toBe('VERSION');
      expect(result!.fields[0].type).toBe('string');
      expect(result!.fields[0].isStatic).toBe(true);
      expect(result!.fields[0].isReadonly).toBe(true);
      expect(result!.fields[0].visibility).toBe('public');
    });

    it('extracts optional field (?:)', () => {
      const tree = parse(`
        interface User {
          email?: string;
        }
      `);
      const interfaceNode = tree.rootNode.child(0);
      const result = extractor.extract(interfaceNode!, mockContext);

      expect(result).not.toBeNull();
      expect(result!.fields).toHaveLength(1);
      expect(result!.fields[0].name).toBe('email');
      // Note: optional fields may have type modified to include undefined
      expect(result!.fields[0].type).toContain('string');
    });

    it('extracts multiple fields with different visibilities', () => {
      const tree = parse(`
        class User {
          public id: number;
          private secretKey: string;
          protected createdAt: Date;
          name: string;
        }
      `);
      const classNode = tree.rootNode.child(0);
      const result = extractor.extract(classNode!, mockContext);

      expect(result).not.toBeNull();
      expect(result!.fields).toHaveLength(4);

      const fields = result!.fields;
      
      const idField = fields.find(f => f.name === 'id');
      expect(idField).toBeDefined();
      expect(idField!.visibility).toBe('public');
      expect(idField!.type).toBe('number');

      const secretKeyField = fields.find(f => f.name === 'secretKey');
      expect(secretKeyField).toBeDefined();
      expect(secretKeyField!.visibility).toBe('private');

      const createdAtField = fields.find(f => f.name === 'createdAt');
      expect(createdAtField).toBeDefined();
      expect(createdAtField!.visibility).toBe('protected');

      const nameField = fields.find(f => f.name === 'name');
      expect(nameField).toBeDefined();
      expect(nameField!.visibility).toBe('public'); // default
    });

    it('handles field without type annotation', () => {
      const tree = parse(`
        class User {
          name;
          age;
        }
      `);
      const classNode = tree.rootNode.child(0);
      const result = extractor.extract(classNode!, mockContext);

      expect(result).not.toBeNull();
      expect(result!.fields).toHaveLength(2);
      
      const nameField = result!.fields.find(f => f.name === 'name');
      expect(nameField).toBeDefined();
      expect(nameField!.type).toBeNull();

      const ageField = result!.fields.find(f => f.name === 'age');
      expect(ageField).toBeDefined();
      expect(ageField!.type).toBeNull();
    });

    it('extracts complex generic types (Map<string, User>, Array<number>)', () => {
      const tree = parse(`
        class Repository {
          users: Map<string, User>;
          ids: Array<number>;
        }
      `);
      const classNode = tree.rootNode.child(0);
      const result = extractor.extract(classNode!, mockContext);

      expect(result).not.toBeNull();
      expect(result!.fields).toHaveLength(2);

      const usersField = result!.fields.find(f => f.name === 'users');
      expect(usersField).toBeDefined();
      expect(usersField!.type).toBe('Map<string, User>');

      const idsField = result!.fields.find(f => f.name === 'ids');
      expect(idsField).toBeDefined();
      expect(idsField!.type).toBe('Array<number>');
    });

    it('extracts nested types', () => {
      const tree = parse(`
        class Container {
          data: OuterType<InnerType<string>>;
        }
      `);
      const classNode = tree.rootNode.child(0);
      const result = extractor.extract(classNode!, mockContext);

      expect(result).not.toBeNull();
      expect(result!.fields).toHaveLength(1);
      expect(result!.fields[0].name).toBe('data');
      expect(result!.fields[0].type).toBe('OuterType<InnerType<string>>');
    });

    it('extracts fields from interface', () => {
      const tree = parse(`
        interface UserDTO {
          id: number;
          name: string;
          email?: string;
        }
      `);
      const interfaceNode = tree.rootNode.child(0);
      const result = extractor.extract(interfaceNode!, mockContext);

      expect(result).not.toBeNull();
      expect(result!.ownerFqn).toBe('UserDTO');
      expect(result!.fields).toHaveLength(3);

      const idField = result!.fields.find(f => f.name === 'id');
      expect(idField).toBeDefined();
      expect(idField!.type).toBe('number');

      const nameField = result!.fields.find(f => f.name === 'name');
      expect(nameField).toBeDefined();
      expect(nameField!.type).toBe('string');

      const emailField = result!.fields.find(f => f.name === 'email');
      expect(emailField).toBeDefined();
    });

    it('extracts fields from abstract class', () => {
      const tree = parse(`
        abstract class BaseEntity {
          protected id: number;
          createdAt: Date;
        }
      `);
      const abstractNode = tree.rootNode.child(0);
      const result = extractor.extract(abstractNode!, mockContext);

      expect(result).not.toBeNull();
      expect(result!.ownerFqn).toBe('BaseEntity');
      expect(result!.fields).toHaveLength(2);

      const idField = result!.fields.find(f => f.name === 'id');
      expect(idField).toBeDefined();
      expect(idField!.visibility).toBe('protected');

      const createdAtField = result!.fields.find(f => f.name === 'createdAt');
      expect(createdAtField).toBeDefined();
      expect(createdAtField!.visibility).toBe('public');
    });

    it('extracts array types', () => {
      const tree = parse(`
        class UserService {
          users: User[];
          ids: number[];
        }
      `);
      const classNode = tree.rootNode.child(0);
      const result = extractor.extract(classNode!, mockContext);

      expect(result).not.toBeNull();
      expect(result!.fields).toHaveLength(2);

      const usersField = result!.fields.find(f => f.name === 'users');
      expect(usersField).toBeDefined();
      expect(usersField!.type).toBe('User[]');

      const idsField = result!.fields.find(f => f.name === 'ids');
      expect(idsField).toBeDefined();
      expect(idsField!.type).toBe('number[]');
    });

    it('extracts union types', () => {
      const tree = parse(`
        class Field {
          value: string | number | null;
        }
      `);
      const classNode = tree.rootNode.child(0);
      const result = extractor.extract(classNode!, mockContext);

      expect(result).not.toBeNull();
      expect(result!.fields).toHaveLength(1);
      expect(result!.fields[0].name).toBe('value');
      expect(result!.fields[0].type).toBe('string | number | null');
    });

    it('returns null for non-type declaration nodes', () => {
      const tree = parse('function getUser() {}');
      const functionNode = tree.rootNode.child(0);
      const result = extractor.extract(functionNode!, mockContext);
      expect(result).toBeNull();
    });

    it('extracts fields from type alias with object type', () => {
      const tree = parse(`
        type UserDTO = {
          id: number;
          name: string;
        }
      `);
      const typeAliasNode = tree.rootNode.child(0);
      const result = extractor.extract(typeAliasNode!, mockContext);

      expect(result).not.toBeNull();
      expect(result!.ownerFqn).toBe('UserDTO');
      expect(result!.fields).toHaveLength(2);

      const idField = result!.fields.find(f => f.name === 'id');
      expect(idField).toBeDefined();
      expect(idField!.type).toBe('number');

      const nameField = result!.fields.find(f => f.name === 'name');
      expect(nameField).toBeDefined();
      expect(nameField!.type).toBe('string');
    });

    it('includes source file path in field info', () => {
      const tree = parse(`
        class User {
          name: string;
        }
      `);
      const classNode = tree.rootNode.child(0);
      const result = extractor.extract(classNode!, mockContext);

      expect(result).not.toBeNull();
      expect(result!.fields).toHaveLength(1);
      expect(result!.fields[0].sourceFile).toBe('test.ts');
    });

    it('includes line number in field info', () => {
      const tree = parse(`
        class User {
          name: string;
        }
      `);
      const classNode = tree.rootNode.child(0);
      const result = extractor.extract(classNode!, mockContext);

      expect(result).not.toBeNull();
      expect(result!.fields).toHaveLength(1);
      expect(result!.fields[0].line).toBeGreaterThan(0);
    });

    it('detects nested interface declarations in methods', () => {
      const tree = parse(`
        class Container {
          data: string;
          
          process() {
            interface LocalInterface {
              value: number;
            }
          }
        }
      `);
      const classNode = tree.rootNode.child(0);
      const result = extractor.extract(classNode!, mockContext);

      expect(result).not.toBeNull();
      expect(result!.ownerFqn).toBe('Container');
      // Note: Nested types within method bodies are detected
      expect(result!.nestedTypes).toContain('LocalInterface');
      // Should only extract fields from the outer class
      expect(result!.fields).toHaveLength(1);
      expect(result!.fields[0].name).toBe('data');
    });
  });
});
