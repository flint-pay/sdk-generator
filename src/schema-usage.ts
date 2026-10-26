import { createHash } from 'node:crypto';
import { stable } from './canonical.js';
import type { Contract } from './contract.js';

/** Bind source-use proof to the normalized graph, including programmatic edits. */
export function schemaUsageFingerprint(contract: Contract): string {
  return createHash('sha256')
    .update(
      stable({
        models: contract.models,
        definitions: contract.definitions,
        operations: contract.operations,
        incoming: contract.incoming,
        webhook: contract.config.webhook,
      }),
    )
    .digest('hex');
}

/** Missing or stale provenance never grants the response-only exemption. */
export function responseOnlyModels(contract: Contract): string[] {
  const proof = contract.schemaUsage;
  if (
    !proof ||
    !Array.isArray(proof.responseOnlyModels) ||
    !proof.responseOnlyModels.every((name) => typeof name === 'string') ||
    proof.fingerprint !== schemaUsageFingerprint(contract)
  )
    return [];
  return proof.responseOnlyModels;
}
