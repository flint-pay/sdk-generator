// Synthetic OAuth token contract with four form-encoded grant branches. Field
// names follow RFC 6749, RFC 7523, RFC 7636, RFC 8628 and RFC 8693; values in
// tests are placeholders, never provider data.
const text = { type: 'string' };
const fields = {
  grant_type: {
    type: 'string',
    enum: [
      'authorization_code',
      'refresh_token',
      'urn:ietf:params:oauth:grant-type:device_code',
      'urn:ietf:params:oauth:grant-type:token-exchange',
    ],
  },
  client_id: text,
  client_secret: text,
  client_assertion: { type: 'string', minLength: 1 },
  client_assertion_type: {
    type: 'string',
    enum: ['urn:ietf:params:oauth:client-assertion-type:jwt-bearer'],
  },
  code: text,
  code_verifier: { type: 'string', minLength: 43, maxLength: 128, pattern: '^[A-Za-z0-9._~-]+$' },
  redirect_uri: text,
  refresh_token: text,
  device_code: text,
  subject_token: text,
  subject_token_type: { type: 'string', enum: ['urn:ietf:params:oauth:token-type:jwt'] },
  workload_identity_id: text,
  scope: text,
};
// A client assertion requires its type and client ID and excludes a client secret.
const assertion = {
  if: { anyOf: [{ required: ['client_assertion'] }, { required: ['client_assertion_type'] }] },
  then: {
    not: { required: ['client_secret'] },
    required: ['client_id', 'client_assertion', 'client_assertion_type'],
  },
};
const branch = (grant, required, title) => ({
  type: 'object',
  ...(title ? { title } : {}),
  properties: { ...fields, grant_type: { type: 'string', enum: [grant] } },
  required: ['grant_type', ...required],
  allOf: [assertion, { properties: { grant_type: { const: grant } }, required }],
});

export function tokenApi() {
  return {
    openapi: '3.1.0',
    info: { title: 'Synthetic token API', version: '1' },
    servers: [{ url: 'https://api.example.invalid' }],
    components: {
      schemas: {
        TokenRequestAuthorizationCode: branch('authorization_code', [
          'code',
          'redirect_uri',
          'code_verifier',
        ]),
        TokenRequestRefreshToken: branch('refresh_token', ['refresh_token']),
        TokenRequestDeviceCode: branch('urn:ietf:params:oauth:grant-type:device_code', [
          'device_code',
        ]),
        TokenRequestTokenExchange: branch(
          'urn:ietf:params:oauth:grant-type:token-exchange',
          ['subject_token', 'subject_token_type', 'workload_identity_id'],
          'Workload identity token exchange',
        ),
        TokenRequest: {
          type: 'object',
          properties: fields,
          required: ['grant_type'],
          allOf: [assertion],
          discriminator: {
            propertyName: 'grant_type',
            mapping: {
              authorization_code: '#/components/schemas/TokenRequestAuthorizationCode',
              refresh_token: '#/components/schemas/TokenRequestRefreshToken',
              'urn:ietf:params:oauth:grant-type:device_code':
                '#/components/schemas/TokenRequestDeviceCode',
              'urn:ietf:params:oauth:grant-type:token-exchange':
                '#/components/schemas/TokenRequestTokenExchange',
            },
          },
          oneOf: [
            { $ref: '#/components/schemas/TokenRequestAuthorizationCode' },
            { $ref: '#/components/schemas/TokenRequestRefreshToken' },
            { $ref: '#/components/schemas/TokenRequestDeviceCode' },
            { $ref: '#/components/schemas/TokenRequestTokenExchange' },
          ],
        },
        TokenResponse: {
          type: 'object',
          properties: {
            access_token: text,
            token_type: { type: 'string', enum: ['Bearer'] },
            expires_in: { type: 'integer', minimum: 1 },
            refresh_token: text,
            scope: text,
          },
          required: ['access_token', 'token_type', 'expires_in'],
        },
        TokenError: {
          type: 'object',
          properties: { error: text, error_description: text },
          required: ['error'],
        },
        SessionRequest: {
          type: 'object',
          properties: {
            label: text,
            remember: { type: 'boolean' },
            ttl_seconds: { type: 'integer', minimum: 1 },
            weight: { type: 'number' },
            tier: { enum: ['basic', 'plus'] },
          },
          required: ['label'],
        },
        Note: {
          type: 'object',
          properties: { title: text, pinned: { type: 'boolean' } },
          required: ['title'],
        },
      },
    },
    paths: {
      '/v1/oauth/token': {
        post: {
          operationId: 'exchangeToken',
          requestBody: {
            required: true,
            content: {
              'application/x-www-form-urlencoded': {
                schema: { $ref: '#/components/schemas/TokenRequest' },
              },
            },
          },
          responses: {
            200: {
              description: 'Issued',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/TokenResponse' } },
              },
            },
            400: {
              description: 'Rejected',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/TokenError' } },
              },
            },
          },
        },
      },
      '/v1/sessions': {
        post: {
          operationId: 'createSession',
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Note' } },
              'application/x-www-form-urlencoded': {
                schema: { $ref: '#/components/schemas/SessionRequest' },
              },
            },
          },
          responses: { 204: { description: 'Created' } },
        },
      },
      '/v1/notes': {
        post: {
          operationId: 'createNote',
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Note' } },
              'application/x-www-form-urlencoded': {
                schema: { $ref: '#/components/schemas/SessionRequest' },
              },
            },
          },
          responses: { 204: { description: 'Created' } },
        },
      },
    },
  };
}

export const tokenSdk = {
  operationNames: 'path',
  validation: 'schema',
  version: '1.0.0',
  responses: { return: 'result' },
  npm: { name: '@example/token-forms' },
  composer: { name: 'example/token-forms', namespace: 'Example\\TokenForms' },
  operations: {
    createSession: { requestMediaType: 'application/x-www-form-urlencoded' },
  },
};
