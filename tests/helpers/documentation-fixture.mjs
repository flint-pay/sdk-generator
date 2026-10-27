import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadContract } from '../../dist/index.js';

const object = (properties, required = Object.keys(properties)) => ({
  type: 'object',
  properties,
  required,
});
const ref = (name) => ({ $ref: '#/components/schemas/' + name });

export function documentationFixture(directory) {
  const fields = {
    container: { type: ['array', 'null'], items: { type: 'string' } },
    items: { type: 'array', items: { type: ['string', 'null'], minLength: 2 } },
    nested: {
      type: 'array',
      items: { type: ['array', 'null'], items: { type: ['integer', 'null'], minimum: 1 } },
    },
    mapping: {
      type: ['object', 'null'],
      additionalProperties: { type: ['array', 'null'], items: { type: ['string', 'null'] } },
    },
    primitives: {
      description: 'Primitive alternatives.\n- Each branch retains its own constraints.',
      anyOf: [
        {
          type: 'integer',
          minimum: 2,
          maximum: 9,
          multipleOf: 1,
          description: 'Integer branch annotation.',
          default: 2,
        },
        {
          type: 'string',
          minLength: 3,
          maxLength: 9,
          pattern: '^[a-z]+$',
          format: 'email',
          description: 'Text branch annotation.',
          default: 'abc',
        },
      ],
    },
    capabilities: {
      example: ['red', 'green'],
      oneOf: [
        {
          type: 'array',
          minItems: 2,
          maxItems: 2,
          uniqueItems: true,
          items: { type: 'string', enum: ['red', 'green'] },
        },
        {
          type: 'array',
          minItems: 3,
          maxItems: 3,
          uniqueItems: true,
          items: { type: 'string', enum: ['red', 'green', 'blue'] },
        },
      ],
    },
    model_items: { type: 'array', items: ref('ModelA') },
    config: ref('RootConfig'),
    annotations: {
      type: 'string',
      description: 'A synthetic description.',
      default: 'placeholder',
      enum: ['placeholder', 'other'],
    },
  };
  const schemas = {
    ModelA: {
      ...object({ id: { type: 'string' } }),
      allOf: [{ if: { properties: { id: { const: 'placeholder' } } }, then: { required: ['id'] } }],
    },
    RootConfig: {
      type: 'object',
      minProperties: 1,
      properties: { label: { type: 'string', minLength: 1 } },
    },
    Facts: object(fields),
    Leaf: object({ id: { type: 'string' } }),
    Envelope: object({
      single: { anyOf: [ref('Leaf'), { type: 'null' }] },
      items: { type: 'array', items: { anyOf: [ref('Leaf'), { type: 'null' }] } },
      map: { type: 'object', additionalProperties: { anyOf: [ref('Leaf'), { type: 'null' }] } },
      nonnull: ref('Leaf'),
    }),
    Choice: {
      oneOf: [
        object({
          mode: { type: 'string', enum: ['first'] },
          value: { type: 'array', items: ref('ModelA'), minItems: 2 },
        }),
        object({
          mode: { type: 'string', enum: ['second'] },
          value: { type: 'array', items: ref('ModelA'), minItems: 3 },
        }),
      ],
    },
    ConstraintOnly: {
      oneOf: [2, 3].map((n) => ({
        type: 'array',
        items: { type: 'integer' },
        minItems: n,
        maxItems: n,
      })),
    },
    MapChoices: {
      example: { a: 2 },
      oneOf: [
        { type: 'object', additionalProperties: { type: 'integer', minimum: 2 } },
        { type: 'object', additionalProperties: { type: 'string', minLength: 3 } },
      ],
    },
    NestedValues: object({
      values: {
        type: 'array',
        items: {
          anyOf: [
            { type: 'integer', exclusiveMinimum: 0, exclusiveMaximum: 10 },
            { type: 'string', minLength: 3 },
          ],
        },
      },
    }),
    VersionA: object({ version: { type: 'integer', format: 'int64', minimum: 1 } }),
    VersionB: object({ version: { type: 'integer', format: 'uint64', minimum: 2 } }),
  };
  const paths = {};
  for (const name of Object.keys(schemas).filter((n) => n !== 'ModelA'))
    for (const suffix of ['first', 'second'])
      paths[`/${name}-${suffix}`] = {
        post: {
          operationId: name + suffix,
          tags: ['records'],
          requestBody: { required: true, content: { 'application/json': { schema: ref(name) } } },
          responses: {
            200: {
              description: 'Synthetic response',
              content: { 'application/json': { schema: ref(name) } },
            },
          },
        },
      };
  paths['/inline-branches'] = {
    post: {
      operationId: 'inlineBranches',
      requestBody: {
        required: true,
        content: { 'application/json': { schema: structuredClone(fields.capabilities) } },
      },
      responses: {
        200: {
          description: 'Synthetic',
          content: { 'application/json': { schema: ref('Envelope') } },
        },
      },
    },
  };
  writeFileSync(
    join(directory, 'api.json'),
    JSON.stringify({
      openapi: '3.1.0',
      info: { title: 'Documentation facts', version: '1' },
      components: { schemas },
      paths,
    }),
  );
  writeFileSync(
    join(directory, 'sdk.json'),
    JSON.stringify({
      version: '1.0.0',
      requests: { style: 'object' },
      responses: { return: 'payload' },
      npm: { name: '@example/facts' },
      composer: { name: 'example/facts', namespace: 'Example\\Facts' },
    }),
  );
  return loadContract(join(directory, 'api.json'), join(directory, 'sdk.json'));
}

export const documentationMutations = [
  [
    'container nullability',
    'documentation-format.js',
    'return fact.nullable &&',
    "return fact.value.kind !== 'array' && !fact.item && typeof fact.extra !== 'object' && fact.nullable &&",
  ],
  [
    'item nullability',
    'documentation-format.js',
    'const type = factType(child, definitions, names, seen, ancestors);',
    `const type = factType({...child, nullable:false, one:child.one.filter(p=>p.value.kind!=="null"), any:child.any.filter(p=>p.value.kind!=="null")}, definitions, names, seen, ancestors);`,
  ],
  [
    'item type',
    'documentation-format.js',
    "type = `Array of ${fact.item ? childType(fact.item) : 'any'}`;",
    'type = "Array of any";',
  ],
  ['model link', 'documentation-format.js', '`[${name}](MODELS.md#${anchor(name)})` +', 'name +'],
  [
    'branch constraint',
    'documentation-format.js',
    'for (const [key, value] of Object.entries(fact.checks))',
    'for (const [key, value] of Object.entries(fact.checks).filter(([key])=>key!=="minItems"))',
  ],
  [
    'branch enum',
    'sdk-documentation.js',
    'const values = enumNotes(factEnums(child, definitions), literal, enumLinks);',
    'const values = "";',
  ],
  [
    'constraint-only merge',
    'sdk-documentation.js',
    'const key = factIdentity(factFromAtoms(factAtoms(shape.fact)));',
    'const key = "merged";',
  ],
  [
    'fact compiler nullability',
    'documentation-plan.js',
    'nullable: p.nullable,',
    'nullable: false,',
  ],
  [
    'dedupe ignores checks',
    'sdk-documentation.js',
    'const key = factIdentity(factFromAtoms(factAtoms(shape.fact)));',
    'const key = factIdentity(JSON.parse(JSON.stringify(factFromAtoms(factAtoms(shape.fact)), (key,value)=>key === "checks" ? {} : value)));',
  ],
  [
    'PHP model links',
    'package-documentation.js',
    'export function phpModelReference(',
    'function _mutatedPhpModelReference(',
    ['php'],
  ],
  [
    'fact compiler item minimum',
    'documentation-plan.js',
    'checks: p.checks,',
    'checks: Object.fromEntries(Object.entries(p.checks).filter(([key])=>key!=="minimum")),',
  ],
  [
    'PHP projection minLength',
    'target-plan.js',
    'default: defaultValue,',
    'default: defaultValue, minLength: _lostMinLength,',
    ['php'],
  ],
  [
    'PHP named scalar nullability',
    'target-plan.js',
    "bind(child, value?.kind === 'record' ? value.fields[field] : undefined)",
    "bind(child, value?.kind === 'record' ? (value.fields[field]?.kind === 'nullable' && value.fields[field].value.kind === 'entity' ? value.fields[field].value : value.fields[field]) : undefined)",
    ['php'],
  ],
  [
    'PHP named item nullability',
    'target-plan.js',
    "bind(s.items, value?.kind === 'list' ? value.value : undefined)",
    "bind(s.items, value?.kind === 'list' ? (value.value.kind === 'nullable' && value.value.value.kind === 'entity' ? value.value.value : value.value) : undefined)",
    ['php'],
  ],
  [
    'PHP named map nullability',
    'target-plan.js',
    "value?.kind === 'map' ? value.value : undefined)",
    "value?.kind === 'map' ? (value.value.kind === 'nullable' && value.value.value.kind === 'entity' ? value.value.value : value.value) : undefined)",
    ['php'],
  ],
  [
    'inline item enum merge',
    'sdk-documentation.js',
    'enumNotes(factEnums(variant, documentedDefinitions), literal, enumLinks)',
    'enumNotes(factEnums(fact, documentedDefinitions), literal, enumLinks)',
  ],
  [
    'inline item enum association',
    'sdk-documentation.js',
    'enumNotes(factEnums(variant, documentedDefinitions), literal, enumLinks)',
    '""',
  ],
];
