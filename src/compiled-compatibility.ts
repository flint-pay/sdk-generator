import type { CompiledSdkContract } from './target-plan.js';
import type { Compatibility } from './compatibility.js';
import { addedResultFits, addsPhpResultClass, responseFits } from './response-compatibility.js';
import type { ResponsePlan } from './response-plan.js';
import { successStatus } from './runtime-plan.js';
import { stable } from './canonical.js';

const resultStatus = (status: string) => successStatus(status) || status === 'default';

function recordedBody(
  contract: CompiledSdkContract,
  id: string,
  status: string,
): ResponsePlan | undefined {
  const body = contract.responses[id]?.[status]?.body;
  if (body) return body;
  const response = contract.runtime.operations.find((op) => op.id === id)?.responses[status];
  if (
    response?.bodyKind === 'binary' ||
    response?.bodyKind === 'sse' ||
    response?.classification === 'redirect'
  ) {
    // Older records omitted these guarantees. Preserve that uncertainty instead of
    // treating a historical non-JSON result as an absent body or recompiling it.
    const unknown = {
      kind: 'unresolved' as const,
      reason: 'Historical non-JSON response guarantees were not recorded.',
    };
    return { publicType: unknown, runtime: unknown };
  }
  return undefined;
}

/** Compare persisted emitted-contract decisions, including generator-only changes. */
export function compareCompiledContracts(
  previous: CompiledSdkContract,
  next: CompiledSdkContract,
): Compatibility[] {
  const findings: Compatibility[] = [];
  const node = previous.targets.includes('node') && next.targets.includes('node');
  const php = previous.targets.includes('php') && next.targets.includes('php');
  if (!node && !php) return findings;
  if (node) {
    // Historical plans emitted unrestricted runtime options. Narrowing those
    // exports is breaking even when the API and its credential modes are unchanged.
    if (stable(previous.node.authentication) !== stable(next.node.authentication))
      findings.push({
        severity: 'breaking',
        subject: 'authentication options',
        message:
          'Public ClientOptions/RequestOptions authentication declarations changed; update option types and wrappers before upgrading.',
      });
    for (const [id, old] of Object.entries(previous.node.operations)) {
      const current = next.node.operations[id];
      if (
        !current ||
        (old.requestOptions ?? 'RequestOptions') === (current.requestOptions ?? 'RequestOptions')
      )
        continue;
      const widened =
        old.authModes !== undefined &&
        current.authModes !== undefined &&
        old.authModes.every((mode) => current.authModes!.includes(mode));
      findings.push({
        severity: widened ? 'additive' : 'breaking',
        subject: id + '.options',
        message: widened
          ? 'Operation authentication option types accept additional modes.'
          : 'Operation RequestOptions were narrowed; update callers that forward shared options.',
      });
    }
  }
  for (const id of Object.keys(previous.node.operations)) {
    if (!next.node.operations[id]) continue;
    const old = previous.responseReturns?.[id],
      current = next.responseReturns?.[id];
    if (
      stable(old?.path) !== stable(current?.path) ||
      (node && old?.node !== current?.node) ||
      (php && old?.php !== current?.php)
    )
      findings.push({
        severity: 'breaking',
        subject: id + '.responseReturn',
        message:
          'Public response return mode, payload path, or payload type changed; migrate callers before upgrading.',
      });
  }
  if (
    node &&
    previous.node.responseReturnDeclarations &&
    previous.node.responseReturnDeclarations !== next.node.responseReturnDeclarations
  )
    findings.push({
      severity: 'breaking',
      subject: 'response return declarations',
      message:
        'Public payload/response helper declarations changed; review consumer types before upgrading.',
    });
  const samePolicy = stable(previous.policy) === stable(next.policy);
  for (const [id, oldResponses] of Object.entries(previous.responses)) {
    const responses = next.responses[id];
    if (!responses) continue;
    const oldResults = Object.entries(oldResponses)
      .filter(([status]) => resultStatus(status))
      .map(([status]) => recordedBody(previous, id, status));
    for (const [status, response] of Object.entries(responses)) {
      if (!resultStatus(status)) continue;
      const subject = `${id}.response.${status}`;
      const old = oldResponses[status];
      const oldBody = recordedBody(previous, id, status);
      const body = recordedBody(next, id, status);
      const comparison =
        old && stable(old) === stable(response)
          ? { result: 'compatible' as const }
          : !old
            ? addedResultFits(oldResults, body, subject, node, php)
            : oldBody && body
              ? responseFits(oldBody, body, subject, node, php)
              : Boolean(oldBody) !== Boolean(body)
                ? {
                    result: 'incompatible' as const,
                    path: subject,
                    reason: 'Response body presence changed.',
                  }
                : { result: 'compatible' as const };
      if (comparison.result !== 'compatible')
        findings.push({
          severity: comparison.result === 'incompatible' ? 'breaking' : 'review',
          subject: comparison.path,
          message: comparison.reason,
        });
      if (php) {
        const before = previous.php.runtime.operations.find((op) => op.id === id)?.responses[
          status
        ];
        const after = next.php.runtime.operations.find((op) => op.id === id)?.responses[status];
        if (before?.model && before.model !== after?.model)
          findings.push({
            severity: 'breaking',
            subject,
            message: 'Previously returned PHP response class identity changed.',
          });
        for (const [tag, name] of Object.entries(before?.variants ?? {}))
          if (after?.variants?.[tag] !== name)
            findings.push({
              severity: 'breaking',
              subject,
              message: `PHP class identity for response tag ${tag} changed.`,
            });
        if (!old && addsPhpResultClass(previous.php.operations[id]?.output, after)) {
          findings.push({
            severity: 'breaking',
            subject,
            message: 'Added result introduces PHP classes outside the previous public return type.',
          });
        }
      }
    }
    if (
      node &&
      previous.node.operations[id] &&
      next.node.operations[id] &&
      (previous.node.operations[id].input !== next.node.operations[id].input ||
        previous.node.operations[id].output !== next.node.operations[id].output ||
        previous.node.operations[id].items !== next.node.operations[id].items ||
        previous.node.operations[id].inputRequired !== next.node.operations[id].inputRequired ||
        stable(previous.node.operations[id].known) !== stable(next.node.operations[id].known))
    )
      findings.push({
        severity: 'review',
        subject: id,
        message:
          'Compiled public method declaration changed; review unchanged consumers alongside the shape findings.',
      });
  }
  if (node)
    for (const [name, model] of Object.entries(previous.node.models)) {
      const current = next.node.models[name];
      if (
        current &&
        (model.input !== current.input ||
          model.output !== current.output ||
          model.objectFactory !== current.objectFactory)
      )
        findings.push({
          severity: 'review',
          subject: 'models.' + name,
          message:
            'Compiled public model declaration changed; review factories and unchanged consumers.',
        });
    }
  if (node) {
    if (previous.node.eventType !== next.node.eventType)
      findings.push({
        severity: 'review',
        subject: 'webhook',
        message: 'Compiled webhook event declaration changed; review unchanged consumers.',
      });
    for (const [id, op] of Object.entries(previous.node.operations)) {
      const current = next.node.operations[id];
      if (!current || (op.known && !current.known) || (!op.inputRequired && current.inputRequired))
        findings.push({
          severity: 'breaking',
          subject: id,
          message:
            'A compiled public operation/known guard was removed or its input argument became required.',
        });
    }
    for (const [name, model] of Object.entries(previous.node.models)) {
      const current = next.node.models[name];
      if (!current)
        findings.push({
          severity: 'breaking',
          subject: 'models.' + name,
          message: 'Compiled exported model/factory removed.',
        });
      else if (
        stable(model.codec) !== stable(current.codec) &&
        stable(previous.policy.models[name]) === stable(next.policy.models[name])
      )
        findings.push({
          severity: 'review',
          subject: 'models.' + name,
          message:
            'Compiled factory codec changed without a source policy change; review accepted values and inspection.',
        });
    }
  }
  if (php) {
    for (const model of previous.php.models) {
      const current = next.php.models.find((value) => value.name === model.name);
      if (!current) {
        findings.push({
          severity: 'breaking',
          subject: 'models.' + model.name,
          message: 'Compiled public PHP class removed.',
        });
        continue;
      }
      for (const getter of model.getters)
        if (getter.method && !current.getters.some((value) => value.method === getter.method))
          findings.push({
            severity: 'breaking',
            subject: 'models.' + model.name + '.' + getter.method,
            message: 'Compiled PHP getter removed.',
          });
      if (
        model.constructorType !== current.constructorType ||
        model.constructorDoc !== current.constructorDoc ||
        model.defaultObject !== current.defaultObject ||
        stable(model.getters) !== stable(current.getters)
      )
        findings.push({
          severity: 'review',
          subject: 'models.' + model.name,
          message:
            'Compiled PHP constructor/getter declaration changed; review unchanged consumers.',
        });
      if (stable(model.codec) !== stable(current.codec) && samePolicy)
        findings.push({
          severity: 'review',
          subject: 'models.' + model.name,
          message:
            'Compiled PHP model codec changed without a source policy change; review accepted and returned values.',
        });
    }
    for (const [id, operation] of Object.entries(previous.php.operations))
      if (stable(operation) !== stable(next.php.operations[id]))
        findings.push({
          severity: next.php.operations[id] ? 'review' : 'breaking',
          subject: id,
          message:
            'Compiled PHP method or iterator declaration changed; review unchanged consumers.',
        });
    for (const [event, name] of Object.entries(previous.php.eventModels))
      if (next.php.eventModels[event] !== name)
        findings.push({
          severity: 'breaking',
          subject: 'webhook.' + event,
          message: 'Compiled PHP webhook class identity changed.',
        });
  }
  if (
    samePolicy &&
    (stable(previous.runtime) !== stable(next.runtime) ||
      (node && stable(previous.node) !== stable(next.node)) ||
      (php && stable(previous.php) !== stable(next.php)))
  )
    findings.push({
      severity: 'review',
      subject: 'compiled codecs',
      message:
        'Compiled execution or target descriptors changed without a source policy change; review encoding, decoding and operation behavior.',
    });
  return findings;
}
