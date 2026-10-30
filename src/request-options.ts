import { ANY_CODEC, type CodecPlan } from './codec-plan.js';
import { Diagnostic } from './diagnostic.js';

/** Owns extension names, target spellings and mandatory wire validation. */
export const REQUEST_OPTIONS = {
  client_request_id: {
    node: 'clientRequestId',
    php: 'clientRequestId',
    codec: {
      ...ANY_CODEC,
      value: { kind: 'string' },
      nullable: false,
      checks: { minLength: 1, maxLength: 128, pattern: '^[\\x21-\\x7E]+(?![\\s\\S])' },
      phpPattern: '~^[\\x21-\\x7E]+(?![\\s\\S])~uD',
      constraints: true,
    },
  },
} as const satisfies Record<string, { node: string; php: string; codec: CodecPlan }>;

export type RequestOptionName = keyof typeof REQUEST_OPTIONS;
export type RequestOptionValues = Partial<
  Record<(typeof REQUEST_OPTIONS)[RequestOptionName]['node'], string>
>;

export function requestOption(value: unknown, path: string) {
  if (typeof value !== 'string' || !Object.hasOwn(REQUEST_OPTIONS, value))
    throw new Diagnostic(
      path,
      'Unknown x-flint-request-option; supported values: ' +
        Object.keys(REQUEST_OPTIONS).join(', '),
    );
  // Own-key validation above restricts the external extension to this registry.
  return REQUEST_OPTIONS[value as RequestOptionName];
}
