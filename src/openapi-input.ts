import { readFileSync } from 'node:fs';
import { Diagnostic } from './diagnostic.js';
import { SourceJson } from './source-json.js';

/** Read local JSON through the same parser used for contract sources and profiles. */
export function readInput(file: string, sourceJson = new SourceJson()) {
  let content: string;
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    throw new Diagnostic(file, 'cannot read input');
  }
  return { content, value: sourceJson.parse(content, file) };
}

export function openApiObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Diagnostic('', 'expected an OpenAPI object');
  // JSON objects have string keys; the parser leaves all member values untrusted.
  return value as Record<string, unknown>;
}

export function assertOpenApiVersion(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^3\.[01]\.\d+$/.test(value))
    throw new Diagnostic('/openapi', 'supported input is OpenAPI 3.0 or 3.1 JSON');
}
