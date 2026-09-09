import type { ResponsePlan } from './response-plan.js';
import { stable } from './canonical.js';
import { valuesFit, combineInclusion, type Inclusion } from './value-guarantee.js';

export function addedResultFits(
  previous: readonly (ResponsePlan | undefined)[],
  next: ResponsePlan | undefined,
  path: string,
  publicTypes = true,
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
  const results = bodies.map((old) =>
    combineInclusion(
      publicTypes ? valuesFit(old.publicType, next.publicType, path) : { result: 'compatible' },
      valuesFit(old.runtime, next.runtime, path),
    ),
  );
  if (results.some((value) => value.result === 'compatible')) return { result: 'compatible' };
  if (results.length === 1 && results[0]) return results[0];
  // Failure against every individual alternative is not a proof against their union.
  return {
    result: 'unresolved',
    path,
    reason: 'Inclusion against the complete previous result union requires review.',
  };
}
