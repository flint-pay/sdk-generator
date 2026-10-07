import test from 'node:test';
import assert from 'node:assert/strict';
import { npmPackResult } from '../dist/distribution.js';

test('release archives accept legacy and npm 12 pack reports', () => {
  const packed = {
    filename: 'example-library-1.0.0.tgz',
    size: 123,
    files: [{ path: 'index.js' }],
  };
  assert.deepEqual(npmPackResult(JSON.stringify([packed])), packed);
  assert.deepEqual(npmPackResult(JSON.stringify({ '@example/library': packed })), packed);
});

test('release archive reports reject missing, multiple, and unsafe filenames', () => {
  const packed = { filename: 'example-library-1.0.0.tgz' };
  for (const report of [
    null,
    42,
    [],
    {},
    [packed, packed],
    { a: packed, b: packed },
    [{}],
    [{ filename: '../unsafe.tgz' }],
    [{ filename: 42 }],
  ]) {
    assert.throws(() => npmPackResult(JSON.stringify(report)), /expected one archive/);
  }
});
