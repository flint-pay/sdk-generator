import type { Contract } from './contract.js';
import { Diagnostic } from './diagnostic.js';
import { webhookEventTypeName } from './naming.js';
const pascal = (s: string) => s[0]!.toUpperCase() + s.slice(1);

/** Reserve shared public identities before target-specific class compilation. */
export function reservePublicSymbols(
  c: Contract,
  modelNames: readonly string[],
  knownOperations: ReadonlySet<string>,
): (name: string, owner?: string) => void {
  const targets = c.config.targets ?? ['node', 'php'];
  const groups = [...new Set(c.operations.map((op) => op.resource))].sort();
  const hasPayloadReturns = c.operations.some((op) => op.response?.return === 'payload');
  const symbols = new Set(
    [
      'Client',
      ...(hasPayloadReturns ? ['SdkResponse'] : []),
      'Runtime',
      'Model',
      'Result',
      'SdkError',
      'Codec',
      'RawNumber',
      'ExactNumber',
      'EventStream',
      'ServerSentEvent',
      'ByteStream',
      'CurlByteStream',
      'ParsedNumber',
      'Cancellation',
      'ClientOptions',
      'RuntimeClientOptions',
      'RequestOptions',
      'InputValue',
      ...(c.authentication ? ['Credentials', 'AuthMode', 'RuntimeRequestOptions'] : []),
      'Metadata',
      'ErrorKind',
      'DiagnosticEvent',
      'serialize',
      'parseExact',
      'redact',
      ...(targets.includes('node')
        ? [
            'Promise',
            'AsyncGenerator',
            'Record',
            'Omit',
            ...(c.authentication ? ['Partial'] : []),
            'Exclude',
            'Object',
            'Array',
            'Uint8Array',
            'any',
            'unknown',
            'number',
            'boolean',
            'bigint',
            'symbol',
            'undefined',
            'intrinsic',
          ]
        : []),
    ].map((n) => n.toLowerCase()),
  );
  const symbolOwners = new Map([...symbols].map((name) => [name, 'runtime.' + name]));
  // The Node namespace lives in runtime.js, so an Errors model/file can coexist.
  const exactSymbols = new Map(targets.includes('node') ? [['errors', 'runtime.errors']] : []);
  const reserve = (n: string, owner = 'generated.' + n) => {
    const existing = exactSymbols.get(n) ?? symbolOwners.get(n.toLowerCase());
    if (existing)
      throw new Diagnostic(
        'public interface',
        `generated type collision: ${n} between ${existing} and ${owner}; customize resource/method/model names`,
      );
    symbolOwners.set(n.toLowerCase(), owner);
  };
  for (const group of groups) reserve(pascal(group) + 'Resource', 'resources.' + group);
  for (const name of modelNames) {
    reserve(name, 'models.' + name);
    reserve(name + 'Input', 'models.' + name + '.input');
  }
  for (const op of c.operations) {
    reserve(pascal(op.resource) + pascal(op.method) + 'Input', op.id + '.input');
    reserve(pascal(op.resource) + pascal(op.method) + 'Response', op.id + '.response');
    if (knownOperations.has(op.id))
      reserve(pascal(op.resource) + pascal(op.method) + 'ResponseKnown');
  }
  if (c.config.webhook) {
    reserve('KnownWebhookEvent', 'webhook');
    reserve('VerifiedWebhook', 'webhook');
    reserve('verifyWebhook', 'webhook');
    if (targets.includes('php')) reserve('Webhooks', 'webhook');
    for (const event of Object.keys(c.config.webhook.events))
      reserve(webhookEventTypeName(event), 'webhook.events.' + event);
  }
  reserve('SchemaRegistry');
  return reserve;
}
