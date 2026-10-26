import ts from 'typescript';
import type { PublicType, TypeCertificate } from './type-certificate.js';

function mapChildren(node: PublicType, transform: (child: PublicType) => PublicType): PublicType {
  switch (node.kind) {
    case 'array':
      return { ...node, element: transform(node.element) };
    case 'nonarray':
      return { ...node, value: transform(node.value) };
    case 'union':
    case 'intersection':
      return { ...node, members: node.members.map(transform) };
    case 'record':
      return {
        ...node,
        fields: Object.fromEntries(
          Object.entries(node.fields).map(([key, field]) => [
            key,
            { ...field, type: transform(field.type) },
          ]),
        ),
        ...(node.extra ? { extra: transform(node.extra) } : {}),
      };
    default:
      return node;
  }
}

/** Parse the finalized declaration expression, never reinterpret its source schema. */
export function publicTypePlanner(declarations: Readonly<Record<string, string>>) {
  const parsed = new Map<string, PublicType>();
  const parse = (text: string): PublicType => {
    const source = ts.createSourceFile(
      'public-type.ts',
      'type T = ' + text + ';',
      ts.ScriptTarget.Latest,
      true,
    );
    const statement = source.statements[0];
    if (!statement || !ts.isTypeAliasDeclaration(statement))
      throw new Error('Invalid public type expression');
    const convert = (node: ts.TypeNode): PublicType => {
      if (ts.isParenthesizedTypeNode(node)) return convert(node.type);
      if (ts.isTypeOperatorNode(node) && node.operator === ts.SyntaxKind.ReadonlyKeyword)
        return convert(node.type);
      if (ts.isUnionTypeNode(node) || ts.isIntersectionTypeNode(node)) {
        const members = node.types.map(convert);
        // Open enum autocomplete syntax promises exactly string at runtime.
        // Keep that scalar check once rather than repeating every known value.
        if (
          members.some((member) => member.kind === 'string') &&
          members.every((member) =>
            ts.isUnionTypeNode(node)
              ? member.kind === 'string' ||
                (member.kind === 'literal' && typeof member.value === 'string')
              : member.kind === 'string' || member.kind === 'nonnull',
          )
        )
          return { kind: 'string' };
        return { kind: ts.isUnionTypeNode(node) ? 'union' : 'intersection', members };
      }
      if (ts.isArrayTypeNode(node)) return { kind: 'array', element: convert(node.elementType) };
      if (ts.isLiteralTypeNode(node)) {
        const literal = node.literal;
        if (literal.kind === ts.SyntaxKind.NullKeyword) return { kind: 'null' };
        if (ts.isStringLiteral(literal)) return { kind: 'literal', value: literal.text };
        if (ts.isNumericLiteral(literal)) return { kind: 'literal', value: Number(literal.text) };
        if (ts.isPrefixUnaryExpression(literal) && ts.isNumericLiteral(literal.operand))
          return { kind: 'literal', value: -Number(literal.operand.text) };
        if (
          literal.kind === ts.SyntaxKind.TrueKeyword ||
          literal.kind === ts.SyntaxKind.FalseKeyword
        )
          return { kind: 'literal', value: literal.kind === ts.SyntaxKind.TrueKeyword };
      }
      if (ts.isTemplateLiteralTypeNode(node) && node.getText(source) === '`${bigint}`')
        return { kind: 'integer-string' };
      if (ts.isIndexedAccessTypeNode(node) && node.objectType.getText(source) === 'Object')
        return { kind: 'function' };
      if (ts.isTypeLiteralNode(node)) {
        if (!node.members.length) return { kind: 'nonnull' };
        const fields: Extract<PublicType, { kind: 'record' }>['fields'] = {};
        let extra: PublicType | undefined;
        for (const member of node.members) {
          if (ts.isIndexSignatureDeclaration(member) && member.type) extra = convert(member.type);
          else if (ts.isPropertySignature(member) && member.name && member.type) {
            const key = ts.isStringLiteral(member.name)
              ? member.name.text
              : member.name.getText(source);
            Object.defineProperty(fields, key, {
              value: { type: convert(member.type), optional: !!member.questionToken },
              enumerable: true,
            });
          } else throw new Error('Unsupported public type member: ' + member.getText(source));
        }
        return { kind: 'record', fields, ...(extra ? { extra } : {}) };
      }
      if (ts.isTypeReferenceNode(node)) {
        const name = node.typeName.getText(source);
        const args = node.typeArguments ?? [];
        if ((name === 'Array' || name === 'ReadonlyArray') && args[0])
          return { kind: 'array', element: convert(args[0]) };
        if (name === 'Record' && args[1])
          return { kind: 'record', fields: {}, extra: convert(args[1]) };
        if (name === 'Exclude' && args[0] && args[1]) {
          const excluded = convert(args[1]);
          if (excluded.kind === 'array' && excluded.element.kind === 'unknown')
            return { kind: 'nonarray', value: convert(args[0]) };
        }
        if (name === 'Uint8Array') return { kind: 'binary' };
        if (name === 'EventStream') return { kind: 'stream' };
        if (Object.hasOwn(declarations, name)) return { kind: 'reference', name };
      }
      const primitive = new Map<
        number,
        'unknown' | 'never' | 'undefined' | 'string' | 'number' | 'boolean' | 'object'
      >([
        [ts.SyntaxKind.UnknownKeyword, 'unknown'],
        [ts.SyntaxKind.NeverKeyword, 'never'],
        [ts.SyntaxKind.UndefinedKeyword, 'undefined'],
        [ts.SyntaxKind.StringKeyword, 'string'],
        [ts.SyntaxKind.NumberKeyword, 'number'],
        [ts.SyntaxKind.BooleanKeyword, 'boolean'],
        [ts.SyntaxKind.ObjectKeyword, 'object'],
      ]).get(node.kind);
      if (primitive) return { kind: primitive };
      throw new Error('Unsupported public type expression: ' + node.getText(source));
    };
    return convert(statement.type);
  };
  // Repeated nested envelopes share ordinary certificate references, just like
  // named declarations. Decide sharing over the whole plan so every operation
  // sees the same definition for a given name.
  const counts = new Map<string, number>();
  const count = (node: PublicType): PublicType => {
    const signature = JSON.stringify(node);
    if (signature.length > 150) counts.set(signature, (counts.get(signature) ?? 0) + 1);
    mapChildren(node, count);
    return node;
  };
  for (const [name, expression] of Object.entries(declarations))
    parsed.set(name, count(parse(expression)));
  const shared = new Map<string, string>();
  const sharedNodes = new Map<string, PublicType>();
  const compact = (node: PublicType): PublicType => {
    const signature = JSON.stringify(node);
    const previous = shared.get(signature);
    if (previous) return { kind: 'reference', name: previous };
    const result = mapChildren(node, compact);
    if ((counts.get(signature) ?? 0) > 1 && JSON.stringify(result).length > 150) {
      // '@' cannot occur in a public TypeScript declaration identifier.
      const name = '@' + shared.size;
      shared.set(signature, name);
      sharedNodes.set(name, result);
      return { kind: 'reference', name };
    }
    return result;
  };
  for (const [name, node] of parsed) parsed.set(name, compact(node));
  return (expression: string): TypeCertificate => {
    const definitions: Record<string, PublicType> = {};
    const visit = (node: PublicType): void => {
      if (node.kind === 'reference') {
        if (Object.hasOwn(definitions, node.name)) return;
        const declaration = parsed.get(node.name) ?? sharedNodes.get(node.name);
        if (!declaration) throw new Error('Missing public type ' + node.name);
        Object.defineProperty(definitions, node.name, { value: declaration, enumerable: true });
        visit(declaration);
      } else if (node.kind === 'union' || node.kind === 'intersection') node.members.forEach(visit);
      else if (node.kind === 'array') visit(node.element);
      else if (node.kind === 'nonarray') visit(node.value);
      else if (node.kind === 'record') {
        Object.values(node.fields).forEach((field) => visit(field.type));
        if (node.extra) visit(node.extra);
      }
    };
    const type = compact(parse(expression));
    visit(type);
    return { type, definitions };
  };
}

// This expression also emits the runtime declaration. Runtime-generated details
// are checked against the complete provider + runtime union at construction.
export const RUNTIME_ERROR_DETAILS =
  '{ "transportCode": string | null } | { "eventId": string; "position": number } | { "reason": string; "source": string; "workloadIdentityId": string; "iss": string; "sub": string; "aud": string; "error_description": string }';

export function publicTypeDeclarations(text: string): Record<string, string> {
  const source = ts.createSourceFile('declarations.ts', text, ts.ScriptTarget.Latest, true);
  return Object.fromEntries(
    source.statements
      .filter(ts.isTypeAliasDeclaration)
      .map((node) => [node.name.text, node.type.getText(source)]),
  );
}
