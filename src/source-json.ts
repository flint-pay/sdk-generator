import { Diagnostic, pointerSegment } from './diagnostic.js';
import { extname } from 'node:path';

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

/** V8 omits positions for some token errors; locate the token without quoting input. */
function invalidTokenOffset(text: string): number {
  type State =
    | 'value'
    | 'done'
    | 'arrayFirst'
    | 'arrayValue'
    | 'arrayEnd'
    | 'objectFirst'
    | 'objectKey'
    | 'objectColon'
    | 'objectValue'
    | 'objectEnd';
  const stack: State[] = ['value'];
  const numberToken = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (/[ \t\r\n]/.test(char)) continue;
    const state = stack[stack.length - 1];
    if (state === 'done') return i;
    if (
      ((state === 'arrayFirst' || state === 'arrayEnd') && char === ']') ||
      ((state === 'objectFirst' || state === 'objectEnd') && char === '}')
    ) {
      stack.pop();
      continue;
    }
    if (state === 'arrayEnd' || state === 'objectEnd') {
      if (char !== ',') return i;
      stack[stack.length - 1] = state === 'arrayEnd' ? 'arrayValue' : 'objectKey';
      continue;
    }
    if (state === 'objectColon') {
      if (char !== ':') return i;
      stack[stack.length - 1] = 'objectValue';
      continue;
    }
    const key = state === 'objectFirst' || state === 'objectKey';
    if (key && char !== '"') return i;
    stack[stack.length - 1] = key
      ? 'objectColon'
      : state === 'value'
        ? 'done'
        : state === 'objectValue'
          ? 'objectEnd'
          : 'arrayEnd';
    if (char === '{' || char === '[') {
      stack.push(char === '{' ? 'objectFirst' : 'arrayFirst');
      continue;
    }
    if (char === '"') {
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
      continue;
    }
    const literal =
      char === 't' ? 'true' : char === 'f' ? 'false' : char === 'n' ? 'null' : undefined;
    if (literal) {
      for (let j = 0; j < literal.length; j++) if (text[i + j] !== literal[j]) return i + j;
      i += literal.length - 1;
      continue;
    }
    numberToken.lastIndex = i;
    const number = numberToken.exec(text);
    if (!number) return i;
    i += number[0].length - 1;
  }
  return text.length;
}

/** Retain precision-loss provenance without changing parsed JSON or metadata. */
export class SourceJson {
  private readonly rounded = new WeakMap<object, Map<string, { source: string; file: string }>>();

  parse(text: string, file: string): unknown {
    const rounded = this.rounded;
    try {
      return JSON.parse(
        text,
        function (
          this: object,
          key: string,
          value: unknown,
          context?: { source?: string },
        ): unknown {
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
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      const position = /\bin JSON at position (\d+) \(line (\d+) column (\d+)\)$/.exec(
        error.message,
      );
      const offset = position
        ? Number(position[1])
        : error.message === 'Unexpected end of JSON input'
          ? text.length
          : invalidTokenOffset(text);
      const lines = text.slice(0, offset).split(/\r\n|\r|\n/);
      const line = position?.[2] ?? lines.length;
      const column = position?.[3] ?? (lines[lines.length - 1]?.length ?? 0) + 1;
      const yaml = /\.ya?ml$/i.test(extname(file)) || !/^[\s]*[\[{]/.test(text);
      throw new Diagnostic(
        file,
        `expected valid JSON at line ${line}, column ${column}${yaml ? '; YAML is not supported' : ''}`,
      );
    }
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
      this.assertMember(value, key, path + '/' + pointerSegment(key));
  }

  /** An explicit provider replacement supersedes the original source token. */
  forget(value: object, key: string): void {
    this.rounded.get(value)?.delete(key);
  }
}
