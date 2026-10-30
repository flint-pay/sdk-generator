import { readReference } from './helpers/package-docs.mjs';
import { replacePhpExampleAutoload } from './local-example.mjs';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import MarkdownIt from 'markdown-it';
import ts from 'typescript';
import { loadContract } from '../dist/index.js';
import { render } from '../dist/generate.js';
import { bodyReference, referenceType } from '../dist/sdk-documentation.js';
import { compileSdkContract, parameterExample, sampleWithFormats } from '../dist/target-plan.js';
import { compileCodec } from '../dist/codec-plan.js';
import { executeCodec, SdkError } from '../dist/runtime.js';

const root = mkdtempSync(join(tmpdir(), 'sdk-reference-body-'));
after(() => rmSync(root, { recursive: true, force: true }));

test('format candidates share definitions while preserving complete-schema validation', () => {
  const uuid = { type: 'string', format: 'uuid' };
  const definitions = { Identifier: uuid };
  const schema = {
    type: 'object',
    properties: {
      first: { 'x-sdk-ref': 'Identifier' },
      second: { 'x-sdk-ref': 'Identifier' },
    },
    required: ['first', 'second'],
    not: { properties: { first: { const: '00000000-0000-4000-8000-000000000001' } } },
  };
  const registries = new Set();
  let rejected = 0;
  const accepts = (value, codec) => {
    registries.add(codec.definitions);
    // Compare the optimized plans with the original compilation boundary.
    assert.deepEqual(
      codec,
      compileCodec({
        ...(codec.value.kind === 'object' ? schema : uuid),
        'x-sdk-definitions': definitions,
      }),
    );
    try {
      executeCodec(value, codec, { mode: 'request', validateConstraints: true });
      return true;
    } catch (error) {
      if (!(error instanceof SdkError)) throw error;
      rejected++;
      return false;
    }
  };
  assert.deepEqual(sampleWithFormats(schema, definitions, accepts), {
    first: 'example',
    second: 'example',
  });
  assert.equal(rejected, 1, 'enclosing constraints must still reject local format choices');
  assert.equal(registries.size, 1, 'candidate checks must not recompile the definitions graph');

  // A later sampling call must observe changes instead of reusing a global cache.
  definitions.Identifier.maxLength = 3;
  assert.deepEqual(sampleWithFormats(schema, definitions, accepts), {
    first: 'exa',
    second: 'exa',
  });
  assert.equal(registries.size, 2);
});

let sequence = 0;
function fixture({
  parameters = [],
  body,
  schemas = {},
  media = {},
  config = {},
  api = {},
  raw,
} = {}) {
  const dir = join(root, String(sequence++));
  mkdirSync(dir);
  const definition = {
    openapi: '3.1.0',
    info: { title: 'Synthetic examples', version: '1' },
    components: { schemas },
    paths: {
      '/values/{id}': {
        post: {
          operationId: 'createValue',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
            ...parameters,
          ],
          ...(body
            ? {
                requestBody: {
                  required: true,
                  content: { 'application/json': { schema: body, ...media } },
                },
              }
            : {}),
          responses: { 204: { description: 'OK' } },
        },
      },
    },
    ...api,
  };
  writeFileSync(
    join(dir, 'api.json'),
    raw ? raw(JSON.stringify(definition)) : JSON.stringify(definition),
  );
  writeFileSync(
    join(dir, 'sdk.json'),
    JSON.stringify({
      version: '1.0.0',
      responses: { return: 'result' },
      requests: { style: 'object' },
      validation: 'schema',
      npm: { name: '@example/synthetic-values' },
      composer: { name: 'example/synthetic-values', namespace: 'Example\\Values' },
      ...config,
    }),
  );
  const contract = loadContract(join(dir, 'api.json'), join(dir, 'sdk.json'));
  const before = JSON.stringify(contract);
  const compiled = JSON.stringify(compileSdkContract(contract).plan);
  const files = render(contract);
  assert.equal(JSON.stringify(contract), before, 'sample generation must not annotate contracts');
  assert.equal(
    JSON.stringify(compileSdkContract(contract).plan),
    compiled,
    'sample generation must not annotate plans',
  );
  assert.deepEqual(
    [...render(JSON.parse(before))],
    [...files],
    'restored contracts render identically',
  );
  return { contract, files };
}
const query = (name, schema = { type: 'string' }, metadata = {}) => ({
  name,
  in: 'query',
  required: true,
  schema,
  ...metadata,
});
function samples(files) {
  return [...files].filter(([name]) =>
    /(?:README|RUNTIME)\.md$|examples\/api-createValue\.(?:mjs|php)$/.test(name),
  );
}
function everySample(files, present = [], absent = []) {
  const scripts = [...files].filter(([name]) =>
    /examples\/api-createValue\.(?:mjs|php)$/.test(name),
  );
  assert.equal(scripts.length, 2);
  for (const [name, source] of samples(files)) {
    for (const value of present) assert.ok(source.includes(value), `${name}: missing ${value}`);
    for (const value of absent) assert.ok(!source.includes(value), `${name}: copied ${value}`);
  }
}
function noGeneratedMarker(files, marker) {
  for (const target of ['node', 'php']) {
    const generated = [...files].filter(([name]) => name.startsWith(`${target}/`));
    assert.ok(generated.length > 0);
    for (const [name, source] of generated)
      assert.ok(!source.includes(marker), `${name}: copied ${marker}`);
  }
}

for (const location of ['query', 'header', 'cookie'])
  test(`unselected ${location} API-key scheme excludes matching query examples regardless of case`, () => {
    const marker = 'synthetic-unselected-scheme-marker';
    const { files } = fixture({
      api: {
        components: {
          securitySchemes: {
            Access: { type: 'apiKey', in: 'header', name: 'X-Access' },
            Unselected: { type: 'apiKey', in: location, name: 'KeY' },
          },
        },
      },
      config: { auth: { scheme: 'Access' } },
      parameters: [query('key', { type: 'string' }, { example: marker })],
    });
    noGeneratedMarker(files, marker);
    everySample(files, ['example']);
  });

for (const name of ['PaSsWoRd', 'ApiKeY', 'X_Api_Key', 'prefixTOKENsuffix', 'SessionId'])
  test(`normalized credential substring ${name} excludes parameter examples in every generated file`, () => {
    const marker = 'synthetic-mixed-case-marker';
    const { files } = fixture({
      parameters: [query(name, { type: 'string' }, { example: marker })],
    });
    noGeneratedMarker(files, marker);
    everySample(files, ['example']);
  });

test('credential substrings exclude named examples without changing safe parameter examples', () => {
  const marker = 'synthetic-named-credential-marker';
  const { files } = fixture({
    parameters: [
      ...[
        'password',
        'passwd',
        'secret',
        'token',
        'apikey',
        'clientsecret',
        'privatekey',
        'accesskey',
        'authorization',
        'credential',
        'signature',
        'cookie',
        'session',
      ].map((token) =>
        query(
          `prefix_${token.toUpperCase()}_suffix`,
          { type: 'string' },
          {
            examples: { first: { value: marker } },
          },
        ),
      ),
      query('label', { type: 'string' }, { example: 'synthetic-safe-parameter' }),
    ],
  });
  noGeneratedMarker(files, marker);
  everySample(files, ['synthetic-safe-parameter']);
});

for (const annotation of [{ 'x-sensitive': true }, { writeOnly: true }, { format: 'password' }])
  for (const referenced of [false, true])
    test(`sensitive array items ${JSON.stringify(annotation)} (${referenced ? 'reference' : 'inline'}) exclude parameter examples in every generated file`, () => {
      const marker = 'synthetic-sensitive-item-marker';
      const item = { type: 'string', ...annotation };
      const { files } = fixture({
        schemas: referenced ? { SensitiveItem: item } : {},
        parameters: [
          query(
            'values',
            {
              type: 'array',
              minItems: 1,
              items: referenced ? { $ref: '#/components/schemas/SensitiveItem' } : item,
            },
            { example: [marker] },
          ),
        ],
      });
      noGeneratedMarker(files, marker);
      everySample(files, ['example']);
    });

for (const keyword of ['allOf', 'anyOf', 'oneOf'])
  test(`sensitivity in any ${keyword} branch rejects the whole parameter example`, () => {
    const marker = 'synthetic-sensitive-branch-marker';
    const { files } = fixture({
      schemas: { SensitiveItem: { type: 'string', 'x-sensitive': true } },
      parameters: [
        query(
          'value',
          {
            [keyword]:
              keyword === 'allOf'
                ? [{ type: 'string' }, { type: 'string', writeOnly: true }]
                : [
                    { type: 'string' },
                    {
                      type: 'array',
                      items: { $ref: '#/components/schemas/SensitiveItem' },
                    },
                  ],
          },
          { examples: { first: { value: marker } } },
        ),
      ],
    });
    noGeneratedMarker(files, marker);
    everySample(files, ['example']);
  });

// Some of these schema shapes are unsupported as wire parameters (notably
// prefixItems and objects). Exercise the selection boundary directly as well.
for (const schema of [
  { type: 'array', items: { type: 'string' }, prefixItems: [{ format: 'password' }] },
  { type: 'array', items: { type: 'string' }, contains: { writeOnly: true } },
  { type: 'object', properties: { nested: { properties: { value: { 'x-sensitive': true } } } } },
  { type: 'object', additionalProperties: { items: { format: 'password' } } },
  { type: 'string', not: { writeOnly: true } },
  { type: 'string', if: { 'x-sensitive': true } },
  { type: 'string', then: { 'x-sensitive': true } },
  { type: 'string', else: { 'x-sensitive': true } },
  { 'x-sdk-ref': 'Sensitive', 'x-sensitive': false, writeOnly: false },
])
  test(`deep sensitive schema excludes parameter metadata: ${JSON.stringify(schema)}`, () => {
    const definitions = {
      Sensitive: {
        properties: {
          cycle: { 'x-sdk-ref': 'Sensitive' },
          hidden: { 'x-sdk-ref': 'Password' },
        },
      },
      Password: { type: 'string', format: 'password' },
    };
    assert.equal(
      parameterExample(
        query('value', schema, { example: 'synthetic-deep-marker' }),
        definitions,
        () => {
          assert.fail('sensitive metadata must be rejected before validation');
        },
      ),
      undefined,
    );
  });

test('parameter-level examples fill placeholders; enums and omitted optional fields retain main behavior', () => {
  const { files } = fixture({
    parameters: [
      query(
        'label',
        { type: 'string', default: 'synthetic-default' },
        { example: 'synthetic-parameter' },
      ),
      query(
        'category',
        { type: 'string' },
        {
          examples: { first: { value: 'synthetic-first' }, second: { value: 'synthetic-second' } },
        },
      ),
      query('optional', { type: 'string' }, { required: false, example: 'synthetic-optional' }),
      query('mode', {
        type: 'string',
        enum: ['synthetic-enum', 'synthetic-later-enum'],
        default: 'synthetic-later-enum',
      }),
      query('fallback', { type: 'string', default: 'synthetic-leaf-default' }),
    ],
  });
  everySample(
    files,
    ['synthetic-parameter', 'synthetic-first', 'synthetic-enum'],
    [
      'synthetic-default',
      'synthetic-second',
      'synthetic-later-enum',
      'synthetic-optional',
      'synthetic-leaf-default',
    ],
  );
});

test('explicit SDK examples retain precedence for all fields', () => {
  const { files } = fixture({
    parameters: [query('label', { type: 'string' }, { example: 'synthetic-spec' })],
    config: {
      operations: {
        createValue: { example: { id: 'synthetic-config-id', label: 'synthetic-config' } },
      },
    },
  });
  everySample(files, ['synthetic-config'], ['synthetic-spec']);
});

test('schema examples drive samples unless complete media examples supply the operation input', () => {
  const input = {
    schemas: {
      Body: {
        type: 'object',
        required: ['label', 'items', 'model'],
        properties: {
          label: { type: 'string', example: 'synthetic-property-marker' },
          items: {
            type: 'array',
            minItems: 1,
            items: { type: 'string', example: 'synthetic-item-marker' },
          },
          model: { $ref: '#/components/schemas/NamedValue' },
        },
      },
      NamedValue: { type: 'string', example: 'synthetic-model-marker' },
    },
    body: { $ref: '#/components/schemas/Body' },
  };
  const { files } = fixture(input);
  everySample(files, [
    'synthetic-property-marker',
    'synthetic-item-marker',
    'synthetic-model-marker',
  ]);
  const media = fixture({
    ...input,
    media: {
      example: {
        label: 'synthetic-media-marker',
        items: ['synthetic-media-item'],
        model: 'synthetic-media-model',
      },
    },
  });
  everySample(
    media.files,
    ['synthetic-media-marker', 'synthetic-media-item', 'synthetic-media-model'],
    ['synthetic-property-marker', 'synthetic-item-marker', 'synthetic-model-marker'],
  );
  assert.deepEqual(media.contract.operations[0].body.example, {
    label: 'synthetic-media-marker',
    items: ['synthetic-media-item'],
    model: 'synthetic-media-model',
  });
  const whole = fixture({
    body: {
      type: 'object',
      required: ['label'],
      properties: { label: { type: 'string' } },
      example: { label: 'synthetic-whole-body' },
    },
  });
  everySample(whole.files, ['synthetic-whole-body']);
});

test('schema examples, enums and consts retain precedence over parameter metadata', () => {
  const { files } = fixture({
    parameters: [
      query(
        'local',
        { type: 'string', example: 'synthetic-schema' },
        { example: 'synthetic-parameter' },
      ),
      query(
        'mode',
        { type: 'string', enum: ['synthetic-enum', 'synthetic-parameter'] },
        { example: 'synthetic-parameter' },
      ),
      query(
        'literal',
        { type: 'string', const: 'synthetic-const' },
        { example: 'synthetic-parameter' },
      ),
      query('same', { type: 'string', example: 'example' }, { example: 'synthetic-parameter' }),
    ],
  });
  everySample(
    files,
    ['synthetic-schema', 'synthetic-enum', 'synthetic-const'],
    ['synthetic-parameter'],
  );
});

test('credential exclusions apply to new parameter metadata and sensitive schema examples stay unpublished', () => {
  const { files } = fixture({
    parameters: [
      query(
        'password',
        { type: 'string', example: 'synthetic-existing-password' },
        { example: 'synthetic-new-password' },
      ),
      query(
        'privateValue',
        { type: 'string', 'x-sensitive': true, example: 'synthetic-existing-sensitive' },
        { example: 'synthetic-new-sensitive' },
      ),
      query(
        'mode',
        { type: 'string', 'x-sensitive': true, enum: ['synthetic-existing-enum'] },
        { example: 'synthetic-new-enum' },
      ),
    ],
  });
  everySample(
    files,
    ['synthetic-existing-password', 'synthetic-existing-enum'],
    [
      'synthetic-new-password',
      'synthetic-new-sensitive',
      'synthetic-new-enum',
      // Sensitive schema examples are never published.
      'synthetic-existing-sensitive',
    ],
  );
});

for (const credential of [
  'PASSWORD',
  'passwd',
  'APIToken',
  'clientSecret',
  'access_token',
  'api_key',
  'apiKey',
  'private_key',
  'accessKey',
  'authorization',
  'credential',
  'signature',
  'cookie',
])
  test(`credential token ${credential} excludes parameter examples and defaults`, () => {
    const { files } = fixture({
      parameters: [
        query(
          credential,
          { type: 'string', default: 'synthetic-default-marker' },
          { example: 'synthetic-sensitive-marker' },
        ),
      ],
    });
    everySample(files, [], ['synthetic-sensitive-marker', 'synthetic-default-marker']);
  });

for (const annotation of [{ 'x-sensitive': true }, { writeOnly: true }, { format: 'password' }])
  test(`sensitive schema ${JSON.stringify(annotation)} excludes spec values`, () => {
    const { files } = fixture({
      parameters: [
        query(
          'value',
          { type: 'string', default: 'synthetic-default-marker', ...annotation },
          { example: 'synthetic-sensitive-marker' },
        ),
      ],
    });
    everySample(files, [], ['synthetic-sensitive-marker', 'synthetic-default-marker']);
  });

test('security-scheme parameters and ordinary headers never copy parameter examples', () => {
  const { files } = fixture({
    api: {
      components: {
        securitySchemes: { Access: { type: 'apiKey', in: 'header', name: 'X-Access' } },
      },
    },
    config: { auth: { scheme: 'Access' } },
    parameters: [
      {
        name: 'X-Access',
        in: 'header',
        required: true,
        schema: { type: 'string' },
        example: 'synthetic-auth-marker',
      },
      {
        name: 'X-Label',
        in: 'header',
        required: true,
        schema: { type: 'string' },
        example: 'synthetic-header-marker',
      },
    ],
  });
  everySample(files, [], ['synthetic-auth-marker', 'synthetic-header-marker']);
});

test('invalid parameter examples and defaults fall back, including alternative validation', () => {
  const { files } = fixture({
    parameters: [
      query('bounded', { type: 'integer', minimum: 1, maximum: 3, default: 99 }, { example: 99 }),
      query(
        'named',
        { type: 'string' },
        { examples: { first: { value: 9 }, second: { value: 'synthetic-later' } } },
      ),
      query(
        'alternative',
        {
          anyOf: [
            { type: 'integer', minimum: 0, maximum: 1 },
            { type: 'array', items: { type: 'integer' } },
          ],
        },
        { example: [2, 3] },
      ),
    ],
  });
  everySample(files, [], ['bounded: 99', "'bounded' => 99", 'synthetic-later']);
});

for (const [format, value] of [
  ['uuid', '00000000-0000-4000-8000-000000000001'],
  ['date', '2026-01-01'],
  ['date-time', '2026-01-01T00:00:00Z'],
  ['email', 'example@example.invalid'],
  ['uri', 'https://example.invalid/'],
  ['hostname', 'example.invalid'],
  ['ipv4', '192.0.2.1'],
  ['ipv6', '2001:db8::1'],
])
  test(`inferred ${format} placeholders validate in rendered examples`, () => {
    const { files } = fixture({
      parameters: [query('formatted', { type: 'string', format }, { example: 'invalid format' })],
    });
    everySample(files, [value], ['invalid format']);
  });

for (const targets of [['node'], ['php'], ['node', 'php']])
  for (const [name, schema, expected] of [
    ['hostname length', { format: 'hostname', minLength: 20 }, 'examplexxxxxxxxxxxxx'],
    ['URI length', { format: 'uri', maxLength: 20 }, 'example'],
    ['UUID pattern', { format: 'uuid', pattern: '^example$' }, 'example'],
  ])
    test(`${targets.join('+')} ${name} falls back to main's sample without aborting generation`, () => {
      const { files } = fixture({
        parameters: [query('formatted', { type: 'string', ...schema })],
        config: { targets },
      });
      for (const target of targets) {
        const script = files.get(
          `${target}/examples/api-createValue.${target === 'node' ? 'mjs' : 'php'}`,
        );
        assert.ok(script.includes(expected));
        assert.doesNotMatch(script, /example\.invalid|00000000-0000-4000-8000-000000000001/);
      }
    });

for (const targets of [['node'], ['php'], ['node', 'php']])
  test(`${targets.join('+')} format choices respect enclosing constraints and retain main's fallback`, () => {
    const { files } = fixture({
      config: { targets },
      body: {
        type: 'object',
        required: ['formatted'],
        properties: {
          formatted: {
            allOf: [{ pattern: '^example$' }, { type: 'string', format: 'uuid' }],
          },
        },
      },
    });
    for (const target of targets) {
      const script = files.get(
        `${target}/examples/api-createValue.${target === 'node' ? 'mjs' : 'php'}`,
      );
      assert.match(script, /formatted["']?\s*(?::|=>)\s*["']example["']/);
      assert.doesNotMatch(script, /00000000-0000-4000-8000-000000000001/);
    }
  });

for (const [type, format, token] of [
  ['integer', 'int64', '9007199254740993'],
  ['integer', 'uint64', '18446744073709551615'],
  ['number', 'decimal', '0.123456789012345678901'],
]) {
  test(`${format} string tokens are preserved; parsed numeric literals fall back`, () => {
    const { files } = fixture({
      parameters: [query('exact', { type, format }, { example: token })],
    });
    everySample(files, [token]);
    const literal = fixture({
      parameters: [query('exact', { type, format }, { example: 'SOURCE_NUMBER' })],
      raw: (source) => source.replace('"SOURCE_NUMBER"', token),
    });
    everySample(literal.files, [], [token, '9007199254740992', '0.12345678901234568']);
  });
}

test('body references list inline variants, named models, field descriptions and requiredness without schema examples', () => {
  for (const keyword of ['oneOf', 'anyOf']) {
    const child = {
      type: 'object',
      required: ['label'],
      properties: {
        label: {
          type: 'string',
          description: 'Synthetic label description.',
          example: 'synthetic-table-marker',
        },
        optional: { type: 'boolean' },
        responseOnly: { type: 'string', readOnly: true },
      },
    };
    const { files, contract } = fixture({
      body: {
        [keyword]: [
          child,
          {
            type: 'object',
            required: ['count'],
            properties: { count: { type: 'integer', description: 'Synthetic count description.' } },
          },
        ],
      },
    });
    for (const target of ['node', 'php']) {
      const source = readReference(files, target);
      assert.match(source, /#### api\.createValue: variant 1/);
      assert.match(source, /#### api\.createValue: variant 2/);
      assert.match(source, /\| `label` \| Required \| string \| Synthetic label description\./);
      assert.match(source, /\| `optional` \| Optional \| boolean \|/);
      assert.match(source, /\| `count` \| Required \| integer \| Synthetic count description\./);
    }
    const body = bodyReference(contract.operations[0], contract.definitions);
    assert.doesNotMatch(body, /synthetic-table-marker|responseOnly/);
  }
  const op = { resource: 'values', method: 'create', body: { 'x-sdk-ref': 'Body' } };
  assert.match(
    bodyReference(op, {
      Body: { type: 'object', properties: { child: { 'x-sdk-ref': 'Child' } } },
      Child: { type: 'string' },
    }),
    /\[Body\]\(MODELS.md#body\)/,
  );
  assert.match(
    bodyReference(op, {
      Body: { type: 'object', properties: { child: { 'x-sdk-ref': 'Child' } } },
      Child: { type: 'string' },
    }),
    /\[Child\]\(MODELS.md#child\)/,
  );
});

for (const keyword of ['oneOf', 'anyOf'])
  for (const layout of ['inline', 'allOf', 'reference'])
    test(`${keyword} ${layout} body variants retain parent types, required fields and constraints`, () => {
      const body = {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'Parent label.', minLength: 2 },
          mode: { type: 'string', description: 'Parent mode.' },
          bounded: { type: 'string', minLength: 2 },
          optional: { type: 'boolean' },
          nested: { $ref: '#/components/schemas/Child' },
          responseOnly: { type: 'string', readOnly: true },
        },
        [keyword]: [
          {
            required: ['label', 'mode', 'responseOnly'],
            properties: {
              mode: { const: 'first' },
              bounded: { maxLength: 20 },
            },
          },
          { required: ['mode'], properties: { mode: { const: 'second' } } },
        ],
      };
      const { [keyword]: variants, ...parent } = body;
      const { files } = fixture({
        body:
          layout === 'reference'
            ? { $ref: '#/components/schemas/Body' }
            : layout === 'allOf'
              ? { allOf: [parent, { [keyword]: variants }] }
              : body,
        schemas: {
          Child: { type: 'object', properties: { value: { type: 'string' } } },
          ...(layout === 'reference' ? { Body: body } : {}),
        },
      });
      for (const target of ['node', 'php']) {
        const reference = readReference(files, target);
        const first = reference.split(`#### api.createValue: variant 1`)[1]?.split('####')[0];
        assert.ok(first, `${target}: missing first variant table`);
        assert.match(first, /\| `label` \| Required \| string \| Parent label\./);
        assert.match(first, /minLength: `2`\./);
        assert.match(
          first,
          /\| `bounded` \| Optional \| string \| minLength: `2`\. maxLength: `20`\./,
        );
        assert.match(first, /\| `mode` \| Required \| string \| Parent mode\./);
        assert.match(first, /Values: `"first"`\./);
        assert.match(first, /\| `optional` \| Optional \| boolean \|/);
        assert.match(
          first,
          target === 'node'
            ? /\| `nested` \| Optional \| \[ChildInput\]\(MODELS\.md#child\) \|/
            : /\| `nested` \| Optional \| \[ChildInput\]\(MODELS\.md#childinput\) \|/,
        );
        assert.doesNotMatch(first, /responseOnly/);
        const second = reference.split(`#### api.createValue: variant 2`)[1]?.split('####')[0];
        assert.match(second, /\| `label` \| Optional \| string \| Parent label\./);
        assert.match(second, /\| `mode` \| Required \| string \| Parent mode\./);
        assert.match(second, /Values: `"second"`\./);
      }
    });

for (const keyword of ['oneOf', 'anyOf'])
  for (const layout of ['inline', 'reference'])
    test(`nested allOf ${keyword} ${layout} body variants merge every enclosing declaration`, () => {
      const parent = {
        type: 'object',
        required: ['parentId'],
        properties: {
          parentId: { type: 'string', description: 'Outer parent field.' },
          label: { type: 'string', minLength: 2, description: 'Parent label.' },
          mode: { type: 'string', description: 'Parent mode.' },
          responseOnly: { type: 'string', readOnly: true },
        },
      };
      const common = {
        properties: {
          label: { maxLength: 20, description: 'Common label.' },
          common: { type: 'boolean', description: 'Inner common field.' },
        },
      };
      const alternatives = {
        [keyword]: [
          {
            description: 'First branch description.',
            required: ['label', 'mode', 'responseOnly'],
            properties: { mode: { const: 'first' } },
          },
          {
            description: 'Second branch description.',
            required: ['mode'],
            properties: { mode: { const: 'second' } },
          },
        ],
      };
      const inner = {
        allOf: [
          layout === 'reference' ? { $ref: '#/components/schemas/Common' } : common,
          layout === 'reference' ? { $ref: '#/components/schemas/Choices' } : alternatives,
        ],
      };
      const { files } = fixture({
        body: {
          allOf: [
            parent,
            layout === 'reference' ? { $ref: '#/components/schemas/Inner' } : inner,
            {
              required: ['sibling'],
              properties: { sibling: { type: 'integer', description: 'Outer sibling field.' } },
            },
          ],
        },
        schemas:
          layout === 'reference' ? { Common: common, Choices: alternatives, Inner: inner } : {},
      });
      for (const target of ['node', 'php']) {
        const reference = readReference(files, target);
        const commonTable = reference
          .split('#### api.createValue body fields')[1]
          ?.split('####')[0];
        assert.match(commonTable, /\| `label` \| Optional \| string \|/);
        for (const [index, presence, mode] of [
          [1, 'Required', 'first'],
          [2, 'Optional', 'second'],
        ]) {
          const table = reference
            .split(`#### api.createValue: variant ${index}`)[1]
            ?.split('####')[0];
          assert.ok(table, `${target}: missing nested ${keyword} variant ${index} table`);
          assert.match(table, /\| `parentId` \| Required \| string \| Outer parent field\./);
          assert.match(
            table,
            new RegExp(`\\| \`label\` \\| ${presence} \\| string \\| Parent label\\.`),
          );
          assert.match(table, /minLength: `2`\. Common label\. maxLength: `20`\./);
          assert.match(table, /\| `common` \| Optional \| boolean \| Inner common field\./);
          assert.match(table, /\| `sibling` \| Required \| integer \| Outer sibling field\./);
          assert.match(table, /\| `mode` \| Required \| string \| Parent mode\./);
          assert.ok(table.includes(`Values: \`"${mode}"\`.`));
          assert.doesNotMatch(table, /responseOnly/);
        }
        assert.match(reference, /First branch description\./);
        assert.match(reference, /Second branch description\./);
      }
    });

for (const keyword of ['oneOf', 'anyOf'])
  test(`body references follow reference chains to nested ${keyword} and stop reference cycles`, () => {
    const body = bodyReference(
      { resource: 'values', method: 'create', body: { 'x-sdk-ref': 'Body' } },
      {
        Body: {
          allOf: [{ properties: { label: { type: 'string' } } }, { 'x-sdk-ref': 'Alias' }],
        },
        Alias: { 'x-sdk-ref': 'Choices' },
        Choices: {
          allOf: [
            {
              [keyword]: [{ required: ['label'] }, { 'x-sdk-ref': 'Body' }],
            },
          ],
        },
      },
    );
    const first = body.split(`#### values.create: variant 1`)[1]?.split('####')[0];
    assert.match(first, /\| `label` \| Required \| string \|/);
    assert.equal(body.split(`#### values.create: variant 1`).length, 2);
  });

test('long unions indent their members, preserve Record expressions and retain syntax', () => {
  const source =
    '{ mapping?: Record<string, { nested: Record<string, string | null> }>; status?: ' +
    Array.from({ length: 12 }, (_, i) => `"synthetic_status_${i}"`).join(' | ') +
    '; }';
  const document = referenceType('Input', source, 'node');
  const content = new MarkdownIt()
    .parse(document, {})
    .find((token) => token.type === 'fence').content;
  assert.match(content, /Record<string, \{ nested: Record<string, string \| null> \}>/);
  assert.match(content, /\n    "synthetic_status_1" \|\n    "synthetic_status_2"/);
  const print = (type) =>
    ts
      .createPrinter()
      .printFile(
        ts.createSourceFile('type.ts', `type Check = ${type};`, ts.ScriptTarget.Latest, true),
      );
  assert.equal(print(content), print(source));
});

test('idempotency scope punctuation is joined once', () => {
  const { files } = fixture({
    config: {
      operations: {
        createValue: {
          idempotency: {
            header: 'Idempotency-Key',
            retention: '24 hours.',
            scope: 'request parameters.',
            auto: true,
          },
        },
      },
    },
  });
  for (const target of ['node', 'php']) {
    const source = readReference(files, target);
    assert.match(source, /Idempotent: key automatic/);
    assert.doesNotMatch(source, /request parameters|24 hours\./);
    assert.match(source, /\[24 hours retention\]\(/);
    assert.match(
      files.get(`${target}/RUNTIME.md`),
      /\| 24 hours retention \| `Idempotency-Key` \| 24 hours\. \| request parameters\. \|/,
    );
    assert.doesNotMatch(source, /request parameters\.\./);
  }
});

test('path examples are validated and chosen ahead of placeholders', () => {
  const { files } = fixture({
    parameters: [
      {
        name: 'id',
        in: 'path',
        required: true,
        schema: { type: 'string' },
        example: 'synthetic_path_123',
      },
    ],
  });
  everySample(files, ['synthetic_path_123']);
});

for (const annotation of [{ 'x-sensitive': true }, { writeOnly: true }, { format: 'password' }])
  test(`parameter-level ${JSON.stringify(annotation)} excludes examples and defaults`, () => {
    const { files } = fixture({
      parameters: [
        query(
          'label',
          { type: 'string', default: 'synthetic-protected-default' },
          { example: 'synthetic-protected-example', ...annotation },
        ),
      ],
    });
    everySample(files, [], ['synthetic-protected-default', 'synthetic-protected-example']);
  });

test('existing defaults remain metadata and enum leaves remain usable', () => {
  const { files } = fixture({
    body: {
      type: 'object',
      required: ['protected', 'ordinary'],
      properties: {
        protected: {
          type: 'object',
          'x-sensitive': true,
          properties: { child: { type: 'string', default: 'synthetic-protected-default' } },
        },
        ordinary: { type: 'string', enum: ['synthetic-ordinary-enum'] },
      },
    },
  });
  everySample(files, ['synthetic-ordinary-enum'], ['synthetic-protected-default']);
});

test('exact array examples retain strings and discard parsed numeric candidates', () => {
  const schema = { type: 'array', minItems: 1, items: { type: 'integer', format: 'int64' } };
  everySample(
    fixture({ parameters: [query('ids', schema, { example: ['9007199254740993'] })] }).files,
    ['9007199254740993'],
  );
  everySample(
    fixture({
      parameters: [query('ids', schema, { example: ['SOURCE_NUMBER'] })],
      raw: (source) => source.replace('"SOURCE_NUMBER"', '9007199254740993'),
    }).files,
    [],
    ['9007199254740992'],
  );
});

for (const keyword of ['oneOf', 'anyOf'])
  test(`${keyword} preserves main's first-branch and finite recursive example behavior`, () => {
    const { files } = fixture({
      schemas: {
        Tree: {
          type: 'object',
          properties: { child: { $ref: '#/components/schemas/Tree' } },
        },
      },
      body: {
        [keyword]: [
          { $ref: '#/components/schemas/Tree', example: { child: { child: {} } } },
          { type: 'string', example: 'synthetic-later-branch' },
        ],
      },
    });
    everySample(files, [], ['synthetic-later-branch']);
    assert.match(files.get('node/examples/api-createValue.mjs'), /child:\s*\{\s*child: \{\}/);
  });

test('generated Node calls preserve schema examples alongside new parameter values and placeholders', async () => {
  const { files } = fixture({
    parameters: [
      query('exact', { type: 'integer', format: 'int64' }, { example: '9007199254740993' }),
      query('label', { type: 'string' }, { example: 'synthetic-query' }),
      query('password', { type: 'string' }, { example: 'synthetic-excluded' }),
    ],
    body: {
      type: 'object',
      required: ['label', 'uuid'],
      properties: {
        label: { type: 'string', example: 'synthetic-existing-body' },
        uuid: { type: 'string', format: 'uuid' },
      },
    },
  });
  const output = join(root, 'node-wire');
  for (const [name, source] of files) {
    const file = join(output, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, source);
  }
  const { Client } = await import(pathToFileURL(join(output, 'node/index.js')).href);
  let calls = 0;
  const client = new Client({
    baseUrl: 'https://example.invalid',
    transport: async (url, request) => {
      calls++;
      assert.equal(
        String(url),
        'https://example.invalid/values/example?exact=9007199254740993&label=synthetic-query&password=example',
      );
      assert.equal(request.method, 'POST');
      assert.equal(
        request.body,
        '{"label":"synthetic-existing-body","uuid":"00000000-0000-4000-8000-000000000001"}',
      );
      return new Response(null, { status: 204 });
    },
  });
  const source = files.get('node/examples/api-createValue.mjs');
  const input = source.match(/client\.api\.createValue\(([\s\S]*?)\);/)[1];
  // Evaluate only this synthetic generated input, with no network or ambient data.
  await client.api.createValue(Function(`return (${input})`)());
  assert.equal(calls, 1);
});

test('generated PHP examples preserve schema examples alongside new parameter values and placeholders', () => {
  const { files } = fixture({
    parameters: [
      query('exact', { type: 'integer', format: 'int64' }, { example: '9007199254740993' }),
      query('label', { type: 'string' }, { example: 'synthetic-query' }),
      query('password', { type: 'string' }, { example: 'synthetic-excluded' }),
    ],
    body: {
      type: 'object',
      required: ['label', 'uuid'],
      properties: {
        label: { type: 'string', example: 'synthetic-existing-body' },
        uuid: { type: 'string', format: 'uuid' },
      },
    },
  });
  const output = join(root, 'php-wire');
  for (const [name, source] of files) {
    const file = join(output, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, source);
  }
  const source = replacePhpExampleAutoload(
    files.get('php/examples/api-createValue.php'),
    "require __DIR__ . '/../src/Runtime.php'; require __DIR__ . '/../src/Client.php';",
  ).replace(
    'new ClientOptions(',
    `new ClientOptions(transport: function($request) {
      if ($request['url'] !== 'https://example.invalid/values/example?exact=9007199254740993&label=synthetic-query&password=example') throw new \\Exception('wrong URL');
      if ($request['method'] !== 'POST') throw new \\Exception('wrong method');
      if ($request['body'] !== '{"label":"synthetic-existing-body","uuid":"00000000-0000-4000-8000-000000000001"}') throw new \\Exception('wrong body');
      echo "synthetic wire assertions passed\\n";
      return ['status'=>204,'headers'=>[],'body'=>''];
    },`,
  );
  const file = join(output, 'php/examples/wire.php');
  writeFileSync(file, source);
  const run = execFileSync('php', [file], {
    encoding: 'utf8',
    env: { ...process.env, FLINT_BASE_URL: 'https://example.invalid' },
  });
  assert.match(run, /synthetic wire assertions passed/);
});
