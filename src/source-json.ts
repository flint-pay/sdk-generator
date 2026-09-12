import { Diagnostic } from './diagnostic.js';

/** Compare decimal values without expanding exponents or using floating point. */
function decimalIdentity(token: string): string {
  const [mantissa, exponent = '0'] = token.toLowerCase().split('e');
  const [whole, fraction = ''] = mantissa!.split('.');
  const digits = (whole!.replace('-', '') + fraction).replace(/^0+/, '');
  if (!digits) return '0';
  const significant = digits.replace(/0+$/, '');
  const scale =
    BigInt(exponent) - BigInt(fraction.length) + BigInt(digits.length - significant.length);
  return (token.startsWith('-') ? '-' : '') + significant + 'e' + scale;
}

/** Retain precision-loss provenance without changing parsed JSON or metadata. */
export class SourceJson {
  private readonly rounded = new WeakMap<object, Map<string, { source: string; file: string }>>();

  parse(text: string, file: string): unknown {
    const rounded = this.rounded;
    return JSON.parse(
      text,
      function (this: object, key: string, value: unknown, context?: { source?: string }): unknown {
        if (typeof value === 'number') {
          // Source text in JSON revivers is available in the minimum Node 22 runtime.
          if (context?.source === undefined) throw new Error('JSON source text is unavailable');
          if (
            !Number.isFinite(value) ||
            decimalIdentity(context.source) !== decimalIdentity(String(value))
          ) {
            const fields = rounded.get(this) ?? new Map();
            fields.set(key, { source: context.source, file });
            rounded.set(this, fields);
          }
        }
        return value;
      },
    );
  }

  /** Check only consumed constraints; ignored examples and excluded schemas stay data. */
  assertMember(value: object, key: string, path: string): void {
    const rounded = this.rounded.get(value)?.get(key);
    if (rounded)
      throw new Diagnostic(
        path,
        `numeric literal ${rounded.source} loses precision in the generator's JSON parser (${rounded.file}); use a decimal value that round-trips exactly, or explicitly replace it with a provider override`,
      );
    this.assertExact(Reflect.get(value, key), path);
  }

  assertExact(value: unknown, path: string): void {
    if (!value || typeof value !== 'object') return;
    for (const key of Object.keys(value))
      this.assertMember(value, key, path + '/' + key.replaceAll('~', '~0').replaceAll('/', '~1'));
  }

  /** An explicit provider replacement supersedes the original source token. */
  forget(value: object, key: string): void {
    this.rounded.get(value)?.delete(key);
  }
}
