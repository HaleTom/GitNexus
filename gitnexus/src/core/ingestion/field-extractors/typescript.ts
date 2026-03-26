// gitnexus/src/core/ingestion/field-extractors/typescript.ts

import type { SyntaxNode } from '../utils/ast-helpers.js';
import { SupportedLanguages } from '../../../config/supported-languages.js';
import { BaseFieldExtractor } from '../field-extractor.js';
import type { FieldExtractorContext, ExtractedFields, FieldInfo } from '../field-types.js';

/**
 * TypeScript field extractor for class and interface declarations.
 * 
 * Handles:
 * - Class fields with visibility modifiers (public/private/protected)
 * - Interface properties with optional markers (?:)
 * - Static and readonly modifiers
 * - Complex generic types
 * - Property signatures in interface bodies
 */
export class TypeScriptFieldExtractor extends BaseFieldExtractor {
  language = SupportedLanguages.TypeScript;

  /**
   * Node types that represent type declarations with fields in TypeScript
   */
  private static readonly TYPE_DECLARATION_NODES = new Set([
    'class_declaration',
    'interface_declaration',
    'abstract_class_declaration',
    'type_alias_declaration', // for object type literals
  ]);

  /**
   * Node types that contain field definitions within class bodies
   */
  private static readonly FIELD_NODE_TYPES = new Set([
    'public_field_definition',   // class field: private users: User[]
    'property_signature',         // interface property: name: string
    'field_definition',           // fallback field type
  ]);

  /**
   * Visibility modifiers in TypeScript
   */
  private static readonly VISIBILITY_MODIFIERS = new Set([
    'public',
    'private',
    'protected',
  ]);

  /**
   * Check if this node represents a type declaration with fields
   */
  isTypeDeclaration(node: SyntaxNode): boolean {
    return TypeScriptFieldExtractor.TYPE_DECLARATION_NODES.has(node.type);
  }

  /**
   * Extract visibility modifier from a field node
   */
  protected extractVisibility(node: SyntaxNode): string {
    // Check for accessibility_modifier named child (tree-sitter typescript)
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child && child.type === 'accessibility_modifier') {
        const text = child.text.trim();
        if (TypeScriptFieldExtractor.VISIBILITY_MODIFIERS.has(text)) {
          return text;
        }
      }
    }

    // Check for modifiers in the field's unnamed children (fallback)
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child && !child.isNamed) {
        const text = child.text.trim();
        if (TypeScriptFieldExtractor.VISIBILITY_MODIFIERS.has(text)) {
          return text;
        }
      }
    }

    // Check for modifier node (tree-sitter typescript may group these)
    const modifiers = node.childForFieldName('modifiers');
    if (modifiers) {
      for (let i = 0; i < modifiers.childCount; i++) {
        const modifier = modifiers.child(i);
        if (modifier && TypeScriptFieldExtractor.VISIBILITY_MODIFIERS.has(modifier.text)) {
          return modifier.text;
        }
      }
    }

    // TypeScript class members are public by default
    return 'public';
  }

  /**
   * Check if a field has the static modifier
   */
  private isStatic(node: SyntaxNode): boolean {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child && !child.isNamed && child.text.trim() === 'static') {
        return true;
      }
    }

    const modifiers = node.childForFieldName('modifiers');
    if (modifiers) {
      for (let i = 0; i < modifiers.childCount; i++) {
        const modifier = modifiers.child(i);
        if (modifier && modifier.text === 'static') {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Check if a field has the readonly modifier
   */
  private isReadonly(node: SyntaxNode): boolean {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child && !child.isNamed && child.text.trim() === 'readonly') {
        return true;
      }
    }

    const modifiers = node.childForFieldName('modifiers');
    if (modifiers) {
      for (let i = 0; i < modifiers.childCount; i++) {
        const modifier = modifiers.child(i);
        if (modifier && modifier.text === 'readonly') {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Check if a property is optional (has ?: syntax)
   */
  private isOptional(node: SyntaxNode): boolean {
    // Look for the optional marker '?' in unnamed children
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child && !child.isNamed && child.text === '?') {
        return true;
      }
    }

    // Also check for optional_property_signature or marker in type
    const kind = node.childForFieldName('kind');
    if (kind && kind.text === '?') {
      return true;
    }

    return false;
  }

  /**
   * Extract the full type text, handling complex generic types
   */
  private extractFullType(typeNode: SyntaxNode | null): string | null {
    if (!typeNode) return null;

    // For type_annotation, get the inner type (skip the ':')
    if (typeNode.type === 'type_annotation') {
      const innerType = typeNode.firstNamedChild;
      if (innerType) {
        return this.normalizeType(innerType.text);
      }
    }

    // Handle predefined_type (string, number, boolean, etc.)
    if (typeNode.type === 'predefined_type') {
      return typeNode.text;
    }

    // Handle type_identifier (custom types)
    if (typeNode.type === 'type_identifier') {
      return typeNode.text;
    }

    // Handle generic_type (Array<User>, Map<string, User>, etc.)
    if (typeNode.type === 'generic_type') {
      return this.normalizeType(typeNode.text);
    }

    // Handle array_type (User[])
    if (typeNode.type === 'array_type') {
      return this.normalizeType(typeNode.text);
    }

    // Handle union_type (User | null)
    if (typeNode.type === 'union_type') {
      return this.normalizeType(typeNode.text);
    }

    // Handle intersection_type (A & B)
    if (typeNode.type === 'intersection_type') {
      return this.normalizeType(typeNode.text);
    }

    // Handle object_type ({ name: string; age: number })
    if (typeNode.type === 'object_type') {
      return this.normalizeType(typeNode.text);
    }

    // Handle literal types
    if (typeNode.type === 'literal_type') {
      return this.normalizeType(typeNode.text);
    }

    // Handle nullable_type (string | null shorthand)
    if (typeNode.type === 'nullable_type') {
      return this.normalizeType(typeNode.text);
    }

    // Fallback: use the full text and normalize
    return this.normalizeType(typeNode.text);
  }

  /**
   * Extract a single field from a field definition node
   */
  private extractField(node: SyntaxNode, context: FieldExtractorContext): FieldInfo | null {
    // Get the field name
    const nameNode = node.childForFieldName('name') ?? node.childForFieldName('property');
    if (!nameNode) return null;

    const name = nameNode.text;
    if (!name) return null;

    // Get the type annotation
    const typeNode = node.childForFieldName('type');
    let type: string | null = this.extractFullType(typeNode);

    // Try to resolve the type using the context
    if (type) {
      const resolvedType = this.resolveType(type, context);
      type = resolvedType ?? type;
    }

    return {
      name,
      type,
      visibility: this.extractVisibility(node),
      isStatic: this.isStatic(node),
      isReadonly: this.isReadonly(node),
      sourceFile: context.filePath,
      line: node.startPosition.row + 1,
    };
  }

  /**
   * Extract fields from a class body or interface body
   */
  private extractFieldsFromBody(
    bodyNode: SyntaxNode,
    context: FieldExtractorContext,
  ): FieldInfo[] {
    const fields: FieldInfo[] = [];

    // Find all field definition nodes within the body
    for (let i = 0; i < bodyNode.namedChildCount; i++) {
      const child = bodyNode.namedChild(i);
      if (!child) continue;

      if (TypeScriptFieldExtractor.FIELD_NODE_TYPES.has(child.type)) {
        const field = this.extractField(child, context);
        if (field) {
          fields.push(field);
        }
      }
    }

    return fields;
  }

  /**
   * Extract fields from an object type (used in type aliases)
   */
  private extractFieldsFromObjectType(
    objectTypeNode: SyntaxNode,
    context: FieldExtractorContext,
  ): FieldInfo[] {
    const fields: FieldInfo[] = [];

    // Find all property_signature nodes within the object type
    const propertySignatures = objectTypeNode.descendantsOfType('property_signature');
    
    for (const propNode of propertySignatures) {
      const field = this.extractField(propNode, context);
      if (field) {
        // Mark optional properties
        if (this.isOptional(propNode) && field.type) {
          field.type = field.type + ' | undefined';
        }
        fields.push(field);
      }
    }

    return fields;
  }

  /**
   * Extract fields from a class or interface declaration
   */
  extract(node: SyntaxNode, context: FieldExtractorContext): ExtractedFields | null {
    if (!this.isTypeDeclaration(node)) return null;

    // Get the type name
    const nameNode = node.childForFieldName('name');
    if (!nameNode) return null;

    const typeName = nameNode.text;
    const ownerFqn = typeName;

    const fields: FieldInfo[] = [];
    const nestedTypes: string[] = [];

    // Handle different declaration types
    if (node.type === 'class_declaration' || node.type === 'abstract_class_declaration') {
      // Find the class body
      const bodyNode = node.childForFieldName('body');
      if (bodyNode) {
        const extractedFields = this.extractFieldsFromBody(bodyNode, context);
        fields.push(...extractedFields);
      }
    } else if (node.type === 'interface_declaration') {
      // Find the interface body
      const bodyNode = node.childForFieldName('body');
      if (bodyNode) {
        const extractedFields = this.extractFieldsFromBody(bodyNode, context);
        fields.push(...extractedFields);
      }
    } else if (node.type === 'type_alias_declaration') {
      // Handle type aliases with object types
      const valueNode = node.childForFieldName('value');
      if (valueNode && valueNode.type === 'object_type') {
        const extractedFields = this.extractFieldsFromObjectType(valueNode, context);
        fields.push(...extractedFields);
      }
    }

    // Find nested type declarations
    const nestedClasses = node.descendantsOfType('class_declaration');
    const nestedInterfaces = node.descendantsOfType('interface_declaration');
    const nestedDeclarations = [...nestedClasses, ...nestedInterfaces];

    for (const nested of nestedDeclarations) {
      // Skip the current node itself
      if (nested === node) continue;
      
      const nestedName = nested.childForFieldName('name');
      if (nestedName) {
        nestedTypes.push(nestedName.text);
      }
    }

    return {
      ownerFqn,
      fields,
      nestedTypes,
    };
  }
}

// Export a singleton instance for registration
export const typescriptFieldExtractor = new TypeScriptFieldExtractor();
