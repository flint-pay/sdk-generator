import type { PhpRepresentation } from './php-value-plan.js';
export type { PhpRepresentation } from './php-value-plan.js';
import type { Schema } from './contract.js';
import { stable } from './canonical.js';
import { discriminatorBindings, directionalSchema } from './codec-plan.js';
import { Diagnostic } from './diagnostic.js';
import { pascalWords } from './naming.js';
import { phpDeclaration, phpNative } from './php-types.js';

export function phpRepresentationType(plan: PhpRepresentation, native = false): string {
  switch (plan.kind) {
    case 'value':
      return plan.type;
    case 'entity':
      return plan.name;
    case 'nullable': {
      const type = phpRepresentationType(plan.value, native);
      return type === 'mixed' || type.split('|').includes('null') ? type : type + '|null';
    }
    case 'list':
      return native ? 'array' : `list<${phpRepresentationType(plan.value)}>`;
    case 'map':
      return native ? 'array' : `array<array-key, ${phpRepresentationType(plan.value)}>`;
    case 'record':
      return '\\stdClass';
    case 'tagged':
      return [
        ...new Set([
          ...Object.values(plan.variants).map((value) => phpRepresentationType(value, native)),
          '\\stdClass',
        ]),
      ].join('|');
  }
}

export interface PhpEntity {
  name: string;
  schema: Schema;
  declaration: Schema;
  representation: Extract<PhpRepresentation, { kind: 'record' }>;
}

/** Compile public response values once; rendering and runtime only consume this graph. */
export function phpRepresentations(
  models: Readonly<Record<string, Schema>>,
  definitions: Readonly<Record<string, Schema>>,
) {
  const entities = new Map<string, PhpEntity>();
  const building = new Set<string>();
  const activeSchemas = new Map<string, string>();
  // Reference-site annotations describe the containing field, not a different
  // component value. Nested annotations and all validation constraints remain.
  const identitySchema = (schema: Schema): Schema => {
    const {
      readOnly: _read,
      writeOnly: _write,
      description: _description,
      title: _title,
      deprecated: _deprecated,
      ...value
    } = schema;
    return value;
  };
  const identities = new Map<string, string>();
  for (const [name, schema] of Object.entries(models).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  ))
    if (!identities.has(stable(identitySchema(schema))))
      identities.set(stable(identitySchema(schema)), name);
  // Resolvers can leave different finite unfoldings of the same recursive model.
  // Compare those graphs coinductively rather than assigning an inline identity.
  const equivalent = (
    left: unknown,
    right: unknown,
    seen = {
      schema: new WeakMap<object, WeakSet<object>>(),
      collection: new WeakMap<object, WeakSet<object>>(),
    },
    context: 'schema' | 'collection' | 'data' = 'schema',
  ): boolean => {
    if (left === right) return true;
    if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
    if (context === 'data') return stable(left) === stable(right);
    const pairs = seen[context];
    const resolve = (value: object): object => {
      if (context === 'schema' && 'x-sdk-ref' in value && typeof value['x-sdk-ref'] === 'string')
        return definitions[value['x-sdk-ref']] ?? value;
      return value;
    };
    left = resolve(left);
    right = resolve(right);
    if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
    if (pairs.get(left)?.has(right)) return true;
    const rights = pairs.get(left) ?? new WeakSet<object>();
    rights.add(right);
    pairs.set(left, rights);
    if (Array.isArray(left) !== Array.isArray(right)) return false;
    const a = Object.entries(left)
      .filter(([key]) => context !== 'schema' || key !== 'x-sdk-definitions')
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const b = Object.entries(right)
      .filter(([key]) => context !== 'schema' || key !== 'x-sdk-definitions')
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return (
      a.length === b.length &&
      a.every(([key, value], i) => {
        const childContext =
          context === 'collection'
            ? 'schema'
            : ['properties', 'allOf', 'oneOf', 'anyOf'].includes(key)
              ? 'collection'
              : ['items', 'additionalProperties', 'not', 'if', 'then', 'else', 'contains'].includes(
                    key,
                  )
                ? 'schema'
                : 'data';
        return key === b[i]?.[0] && equivalent(value, b[i]?.[1], seen, childContext);
      })
    );
  };
  // Coinductive matching is only needed among schemas with the same root layout.
  // Index that layout so large exports do not compare every inline object with
  // every component, while keeping the exact comparison as the deciding step.
  const signature = (schema: Schema): string => {
    const value = identitySchema(
      schema['x-sdk-ref'] ? (definitions[schema['x-sdk-ref']] ?? schema) : schema,
    );
    return stable([
      Object.keys(value)
        .filter((key) => key !== 'x-sdk-definitions')
        .sort(),
      value.type,
      Object.keys(value.properties ?? {}).sort(),
    ]);
  };
  const candidates = new Map<string, [string, Schema][]>();
  for (const entry of Object.entries(models)) {
    const key = signature(entry[1]);
    const values = candidates.get(key) ?? [];
    values.push(entry);
    candidates.set(key, values);
  }
  const equivalentNames = new WeakMap<Schema, string | null>();
  function named(schema: Schema): string | undefined {
    const exact = identities.get(stable(identitySchema(schema)));
    if (exact) return exact;
    if (equivalentNames.has(schema)) return equivalentNames.get(schema) ?? undefined;
    for (const [name, candidate] of candidates.get(signature(schema)) ?? []) {
      if (equivalent(identitySchema(schema), identitySchema(candidate))) {
        equivalentNames.set(schema, name);
        return name;
      }
    }
    equivalentNames.set(schema, null);
    return undefined;
  }
  const names = new Map<string, { name: string; owner: string }>();
  function model(name: string, schema: Schema, owner = name): PhpRepresentation {
    const previous = names.get(name.toLowerCase());
    if (previous && (previous.name !== name || previous.owner !== owner))
      throw new Diagnostic(
        owner,
        `PHP class ${name} collides between ${previous.owner} and ${owner}`,
      );
    names.set(name.toLowerCase(), { name, owner });
    if (!entities.has(name) && !building.has(name)) {
      building.add(name);
      const identity = stable(schema);
      activeSchemas.set(identity, name);
      const declaration = directionalSchema(phpDeclaration(schema, definitions), true);
      const fields = Object.fromEntries(
        Object.entries(declaration.properties ?? {})
          .filter(([, child]) => !child.writeOnly)
          .map(([key, child]) => [
            key,
            compile(child, name + pascalWords(key), owner + '.properties.' + key),
          ]),
      );
      const extra =
        typeof declaration.additionalProperties === 'object'
          ? compile(
              declaration.additionalProperties,
              name + 'AdditionalValue',
              owner + '.additionalProperties',
            )
          : undefined;
      entities.set(name, {
        name,
        schema,
        declaration,
        representation: { kind: 'record', fields, ...(extra ? { extra } : {}) },
      });
      building.delete(name);
      activeSchemas.delete(identity);
    }
    return { kind: 'entity', name };
  }
  function compile(
    schema: Schema,
    suggested: string,
    owner = suggested,
    identity = schema,
  ): PhpRepresentation {
    const declaration = phpDeclaration(schema, definitions);
    const types = Array.isArray(declaration.type) ? declaration.type : [declaration.type];
    if (types.includes('null') && types.length > 1)
      return {
        kind: 'nullable',
        value: types.every((type) => type !== 'object' && type !== 'array')
          ? {
              kind: 'value',
              type: phpNative(schema, true, definitions)
                .split('|')
                .filter((type) => type !== 'null')
                .join('|'),
            }
          : compile(
              {
                ...declaration,
                type: types.filter((type): type is string => type !== 'null' && type !== undefined),
              },
              suggested,
              owner,
              identity,
            ),
      };
    const branches = declaration.oneOf ?? declaration.anyOf;
    if (branches) {
      const tag = declaration.discriminator?.propertyName;
      if (tag && declaration.oneOf) {
        const bindings = discriminatorBindings({
          ...declaration,
          'x-sdk-definitions': definitions,
        });
        if (bindings)
          return {
            kind: 'tagged',
            field: tag,
            variants: Object.fromEntries(
              Object.entries(bindings).map(([value, index]) => {
                const branch = branches[index];
                if (!branch) throw new Error('Invalid PHP discriminator binding');
                const { oneOf: _one, anyOf: _any, discriminator: _tag, ...base } = declaration;
                return [
                  value,
                  compile(
                    { allOf: [base, branch] },
                    suggested + pascalWords(value),
                    owner + '.variant.' + value,
                  ),
                ];
              }),
            ),
          };
      }
      return { kind: 'value', type: declaration.type === 'object' ? '\\stdClass' : 'mixed' };
    }
    if (types[0] === 'array')
      return {
        kind: 'list',
        value: compile(declaration.items ?? {}, suggested + 'Item', owner + '.items'),
      };
    if (types[0] === 'object') {
      if (
        !Object.keys(declaration.properties ?? {}).length &&
        declaration.additionalProperties !== false
      )
        return {
          kind: 'map',
          value:
            typeof declaration.additionalProperties === 'object'
              ? compile(
                  declaration.additionalProperties,
                  suggested + 'Value',
                  owner + '.additionalProperties',
                )
              : { kind: 'value', type: 'mixed' },
        };
      // Removing null changes the declaration, not the component's identity.
      const reference = identity['x-sdk-ref'];
      const canonical = reference ?? named(identity);
      if (!canonical) {
        const recursive = activeSchemas.get(stable(schema));
        if (recursive) return { kind: 'entity', name: recursive };
      }
      const name = canonical ?? suggested;
      return model(
        name,
        canonical ? (definitions[canonical] ?? identity) : schema,
        canonical ? 'models.' + canonical : owner,
      );
    }
    return { kind: 'value', type: phpNative(schema, true, definitions) };
  }
  return { entities, model, compile };
}
