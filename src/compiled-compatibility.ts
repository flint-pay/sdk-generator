import type { PhpRepresentation } from './php-value-plan.js';
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
  declarationOwners: ReadonlyMap<string, string> = new Map(),
): Compatibility[] {
  const findings: Compatibility[] = [];
  const declaration = (severity: Compatibility['severity'], subject: string, message: string) => {
    const owner = declarationOwners.get(subject);
    findings.push(
      owner && severity === 'review'
        ? {
            severity,
            subject: owner,
            message:
              'Compiled public declarations changed for this shared model; review factories, getters and unchanged consumers.',
          }
        : { severity, subject, message },
    );
  };
  const node = previous.targets.includes('node') && next.targets.includes('node');
  const php = previous.targets.includes('php') && next.targets.includes('php');
  if (!node && !php) return findings;
  for (const target of ['node', 'php'] as const) {
    if (target === 'node' ? !node : !php) continue;
    if ((previous[target].errorSurfaceVersion ?? 1) !== (next[target].errorSurfaceVersion ?? 1))
      findings.push({
        severity: 'breaking',
        subject: target + '.errorSurfaceVersion',
        message: 'SDK error classes, constructors and call context changed.',
      });
    for (const feature of ['webhookReasons', 'standaloneWebhook'] as const)
      if (previous[target][feature] !== next[target][feature])
        findings.push({
          severity: next[target][feature] === true ? 'additive' : 'breaking',
          subject: target + '.' + feature,
          message:
            next[target][feature] === true
              ? 'Added ' + feature + ' to the public SDK runtime API.'
              : 'Removed ' + feature + ' from the public SDK runtime API.',
        });
  }
  if (previous.runtime.semantics !== next.runtime.semantics)
    findings.push({
      severity: 'breaking',
      subject: 'SDK value representations',
      message:
        'Compiler value semantics changed; regenerate both SDKs and review numeric representations and object declarations before upgrading.',
    });
  if (previous.runtime.defaultBaseUrl !== next.runtime.defaultBaseUrl)
    findings.push({
      severity: previous.runtime.defaultBaseUrl === undefined ? 'additive' : 'breaking',
      subject: 'defaultBaseUrl',
      message: 'Default API destination changed; review clients that omit baseUrl in both targets.',
    });
  if (node) {
    for (const [event, name] of Object.entries(previous.node.eventTypes ?? {}))
      if (next.node.eventTypes?.[event] !== name)
        findings.push({
          severity: 'breaking',
          subject: 'webhook.' + event,
          message: 'Exported webhook event type removed or renamed',
        });
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
      const operation = previous.runtime.operations.find((op) => op.id === id);
      const nextOperation = next.runtime.operations.find((op) => op.id === id);
      const previousName =
        old.responseType ??
        (operation &&
          operation.resource[0]!.toUpperCase() +
            operation.resource.slice(1) +
            operation.method[0]!.toUpperCase() +
            operation.method.slice(1) +
            'Response');
      if (
        current?.responseType &&
        operation?.resource === nextOperation?.resource &&
        operation?.method === nextOperation?.method &&
        previousName &&
        previousName !== current.responseType &&
        (!next.node.models[previousName] || next.node.models[previousName]!.outputAlias) &&
        !Object.values(next.node.operations).some((op) => op.responseType === previousName)
      )
        findings.push({
          severity: 'breaking',
          subject: id + '.responseType',
          message: `Node response alias ${previousName} was removed; use ${current.responseType}.`,
        });
      if (
        !current ||
        (old.requestOptions ?? 'RequestOptions') === (current.requestOptions ?? 'RequestOptions')
      )
        continue;
      const keyNarrowed = old.idempotencyKey !== false && current.idempotencyKey === false;
      const keyWidened = old.idempotencyKey === false && current.idempotencyKey === true;
      const authUnchanged = stable(old.authModes) === stable(current.authModes);
      const widened =
        !keyNarrowed &&
        !(current.idempotencyKeyRequired && !old.idempotencyKeyRequired) &&
        ((keyWidened && authUnchanged) ||
          (old.authModes !== undefined &&
            current.authModes !== undefined &&
            old.authModes.every((mode) => current.authModes!.includes(mode))));
      findings.push({
        severity: widened ? 'additive' : 'breaking',
        subject: id + '.options',
        message: widened
          ? 'Operation request option types accept additional capabilities or authentication modes.'
          : 'Operation RequestOptions were narrowed; update callers that forward shared options.',
      });
    }
  }
  for (const current of next.runtime.operations) {
    const old = previous.runtime.operations.find((op) => op.id === current.id);
    if (!old) continue;
    const options = (op: typeof current) =>
      new Map(
        op.parameters
          .filter((parameter) => parameter.source === 'request-option')
          .map((parameter) => [
            parameter['x-flint-request-option'],
            {
              header: parameter.name.toLowerCase(),
              option: parameter.requestOption,
              codec: parameter.codec,
            },
          ]),
      );
    const before = options(old),
      after = options(current);
    for (const name of new Set([...before.keys(), ...after.keys()])) {
      if (stable(before.get(name)) === stable(after.get(name))) continue;
      findings.push({
        severity: !before.has(name) ? 'additive' : 'breaking',
        subject: current.id + '.requestOptions.' + name,
        message: !before.has(name)
          ? 'Added a per-call request option in Node and PHP.'
          : 'Removed or changed a per-call request option; review option names, validation and headers in both targets.',
      });
    }
  }
  for (const old of previous.runtime.operations) {
    const current = next.runtime.operations.find((op) => op.id === old.id);
    if (
      current &&
      (previous.runtime.retrySemantics !== next.runtime.retrySemantics ||
        stable(previous.runtime.errors?.retry) !== stable(next.runtime.errors?.retry) ||
        stable({ retry: old.retry, replay: old.replay, idempotency: old.idempotency }) !==
          stable({
            retry: current.retry,
            replay: current.replay,
            idempotency: current.idempotency,
          }))
    ) {
      findings.push({
        severity: 'review',
        subject: old.id + '.retry',
        message:
          'Effective retry or idempotency behavior changed; review attempt budgets, automatic read retries, and mutation key requirements in both targets.',
      });
    }
  }
  for (const id of Object.keys(previous.node.operations)) {
    if (!next.node.operations[id]) continue;
    if (
      stable(
        previous.requestCalls?.[id] && {
          paths: previous.requestCalls[id]!.paths,
          params: previous.requestCalls[id]!.params,
        },
      ) !==
      stable(
        next.requestCalls?.[id] && {
          paths: next.requestCalls[id]!.paths,
          params: next.requestCalls[id]!.params,
        },
      )
    )
      findings.push({
        severity: 'breaking',
        subject: id + '.request',
        message:
          'Public request argument style or positional path order changed; migrate callers before upgrading.',
      });
    const old = previous.responseReturns?.[id],
      current = next.responseReturns?.[id];
    const oldOperation = previous.runtime.operations.find((op) => op.id === id);
    if (
      old &&
      current &&
      old.helperReturn !== current.helperReturn &&
      (oldOperation?.pagination || oldOperation?.polling)
    )
      findings.push({
        severity: 'breaking',
        subject: id + '.helperReturn',
        message:
          'Pagination/polling helper return mode changed; use lastResponse for the complete body and response information.',
      });
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
  const comparedResults = new Set<string>();
  // Provenance may be absent in historical records. Only semantic policy
  // facts determine whether unexplained codec changes require review.
  const samePolicy = (['models', 'definitions', 'operations'] as const).every(
    (key) => stable(previous.policy[key]) === stable(next.policy[key]),
  );
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
      const resultKey = stable([
        old ? oldBody : oldResults,
        body,
        comparison.result,
        comparison.result === 'compatible' ? '' : comparison.reason,
      ]);
      if (comparison.result !== 'compatible' && !comparedResults.has(resultKey))
        findings.push({
          severity: comparison.result === 'incompatible' ? 'breaking' : 'review',
          subject: comparison.path,
          message: comparison.reason,
        });
      comparedResults.add(resultKey);
      if (php) {
        const before = previous.php.runtime.operations.find((op) => op.id === id)?.responses[
          status
        ];
        const after = next.php.runtime.operations.find((op) => op.id === id)?.responses[status];
        const oldRepresentation =
          before?.phpRepresentation ??
          (before?.model ? { kind: 'entity' as const, name: before.model } : undefined);
        const newRepresentation =
          after?.phpRepresentation ??
          (after?.model ? { kind: 'entity' as const, name: after.model } : undefined);
        if (
          before &&
          newRepresentation &&
          (oldRepresentation
            ? !samePhpRepresentation(oldRepresentation, newRepresentation)
            : addsPhpHydration(newRepresentation))
        )
          findings.push({
            severity: 'breaking',
            subject,
            message: 'PHP response value representation changed.',
          });
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
      declaration(
        'review',
        id,
        'Compiled public method declaration changed; review unchanged consumers alongside the shape findings.',
      );
  }
  if (node)
    for (const [name, model] of Object.entries(previous.node.models)) {
      const current = next.node.models[name];
      if (
        current &&
        ((!model.outputAlias && current.outputAlias) ||
          (model.inputReachable !== false && current.inputReachable === false))
      )
        findings.push({
          severity: 'breaking',
          subject: 'models.' + name,
          message: [
            !model.outputAlias && current.outputAlias
              ? `Node response alias ${name} was removed; use ${current.outputAlias}.`
              : '',
            model.inputReachable !== false && current.inputReachable === false
              ? `Response-only ${name}Input and make${name} were removed; use the response type for reading or the owning operation input for requests.`
              : '',
          ]
            .filter(Boolean)
            .join(' '),
        });
      if (
        current &&
        (model.input !== current.input ||
          model.output !== current.output ||
          (model.inputReachable !== false) !== (current.inputReachable !== false) ||
          model.objectFactory !== current.objectFactory)
      )
        declaration(
          'review',
          'models.' + name,
          'Compiled public model declaration changed; review factories and unchanged consumers.',
        );
    }
  if (node) {
    if (
      previous.node.eventType !== next.node.eventType ||
      (previous.node.eventDeclarations ?? '') !==
        (previous.node.webhookReasons !== true && next.node.webhookReasons === true
          ? (next.node.eventDeclarations ?? '').replace(
              '; reason: "unknown_event" | "unmatched_envelope"',
              '',
            )
          : (next.node.eventDeclarations ?? ''))
    )
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
      if (!samePhpRepresentation(model.representation, current.representation))
        findings.push({
          severity: 'breaking',
          subject: 'models.' + model.name,
          message:
            'PHP public value representation changed; migrate nested entity and dictionary access.',
        });
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
        declaration(
          'review',
          'models.' + model.name,
          'Compiled PHP constructor/getter declaration changed; review unchanged consumers.',
        );
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
        declaration(
          next.php.operations[id] ? 'review' : 'breaking',
          id,
          'Compiled PHP method or iterator declaration changed; review unchanged consumers.',
        );
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
      (node &&
        stable(executionDescriptors(previous.node)) !== stable(executionDescriptors(next.node))) ||
      (php &&
        stable(executionDescriptors(previous.php)) !== stable(executionDescriptors(next.php))))
  )
    findings.push({
      severity: 'review',
      subject: 'compiled codecs',
      message:
        'Compiled execution or target descriptors changed without a source policy change; review encoding, decoding and operation behavior.',
    });
  return findings;
}

/** Public API additions are compared above, separately from execution descriptors. */
function executionDescriptors(target: CompiledSdkContract['node'] | CompiledSdkContract['php']) {
  const { errorClasses, errorSurfaceVersion, webhookReasons, standaloneWebhook, ...execution } =
    target;
  if ('runtime' in execution)
    return {
      ...execution,
      models: execution.models.map(
        ({ documentationSchema, documentation, description, ...model }) => model,
      ),
    };
  return {
    ...execution,
    models: Object.fromEntries(
      Object.entries(execution.models).map(
        ([name, { documentedInput, documentedOutput, ...model }]) => [name, model],
      ),
    ),
    operations: Object.fromEntries(
      Object.entries(execution.operations).map(([name, { documentedInput, ...operation }]) => [
        name,
        operation,
      ]),
    ),
    eventDeclarations: execution.eventDeclarations?.replace(
      '; reason: "unknown_event" | "unmatched_envelope"',
      '',
    ),
  };
}

/** Historical raw objects and dictionaries did not have representation graphs. */
function addsPhpHydration(value: PhpRepresentation): boolean {
  switch (value.kind) {
    case 'entity':
    case 'map':
      return true;
    case 'nullable':
    case 'list':
      return addsPhpHydration(value.value);
    case 'record':
      return (
        Object.values(value.fields).some(addsPhpHydration) ||
        Boolean(value.extra && addsPhpHydration(value.extra))
      );
    case 'tagged':
      return Object.values(value.variants).some(addsPhpHydration);
    case 'value':
      return false;
  }
}

/** Adding getters is compatible; changing the value returned by an existing getter is not. */
function samePhpRepresentation(
  before: PhpRepresentation | undefined,
  after: PhpRepresentation | undefined,
): boolean {
  if (!before || !after) return before === after;
  if (before.kind === 'record' && after.kind === 'record')
    return (
      samePhpRepresentation(before.extra, after.extra) &&
      Object.entries(before.fields).every(([field, value]) =>
        samePhpRepresentation(value, after.fields[field]),
      )
    );
  return stable(before) === stable(after);
}
