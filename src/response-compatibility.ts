import type { ResponsePlan } from './response-plan.js';
import type { CompiledOperation } from './runtime-plan.js';
import { stable } from './canonical.js';
import { valuesFit, combineInclusion, type Inclusion } from './value-guarantee.js';

export function addsPhpResultClass(
  previous: string | undefined,
  next: CompiledOperation['responses'][string] | undefined,
): boolean {
  const types = previous?.split('|') ?? [];
  if (types.includes('mixed') || types.includes('object')) return false;
  const classes =
    next?.classification === 'redirect'
      ? ['\\stdClass']
      : next?.bodyKind === 'sse'
        ? ['EventStream']
        : next?.model
          ? [next.model]
          : Object.values(next?.variants ?? {});
  return classes.some((name) => !types.includes(name));
}

export function responseFits(
  previous: ResponsePlan,
  next: ResponsePlan,
  path: string,
  node = true,
  php = false,
): Inclusion {
  return combineInclusion(
    node
      ? combineInclusion(
          valuesFit(previous.publicType, next.publicType, path),
          valuesFit(previous.runtime, next.runtime, path),
        )
      : { result: 'compatible' },
    php
      ? valuesFit(previous.phpRuntime ?? previous.runtime, next.phpRuntime ?? next.runtime, path)
      : { result: 'compatible' },
  );
}

export function addedResultFits(
  previous: readonly (ResponsePlan | undefined)[],
  next: ResponsePlan | undefined,
  path: string,
  publicTypes = true,
  php = !publicTypes,
): Inclusion {
  if (!next)
    return previous.some((value) => !value)
      ? { result: 'compatible' }
      : {
          result: 'incompatible',
          path,
          reason: 'An absent body was not a previous result possibility.',
        };
  const bodies = [
    ...new Map(
      previous
        .filter((value): value is ResponsePlan => value !== undefined)
        .map((value) => [stable(value), value]),
    ).values(),
  ];
  if (!bodies.length)
    return {
      result: 'incompatible',
      path,
      reason: 'A response body was not a previous result possibility.',
    };
  const results = bodies.map((old) => responseFits(old, next, path, publicTypes, php));
  if (results.some((value) => value.result === 'compatible')) return { result: 'compatible' };
  if (results.length === 1 && results[0]) return results[0];
  // Failure against every individual alternative is not a proof against their union.
  return {
    result: 'unresolved',
    path,
    reason: 'Inclusion against the complete previous result union requires review.',
  };
}
