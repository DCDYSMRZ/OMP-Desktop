import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInstalledVersion } from './discovery';

test('installed native bin/version output is accepted and normalized', () => {
  assert.equal(parseInstalledVersion('omp/18.3.2\n'), '18.3.2');
  assert.equal(parseInstalledVersion('omp 18.3.2\r\n'), '18.3.2');
  assert.equal(parseInstalledVersion('omp/18.3.2-rc.1'), '18.3.2-rc.1');
});

test('unrelated binaries, malformed output and unsupported releases remain rejected', () => {
  for (const output of ['18.3.2', 'v18.3.2', 'pi/18.3.2', 'node/18.3.2', 'omp/18.3', 'omp/not-a-version', 'warning\nomp/18.3.2', 'omp/18.3.2\nunexpected output', '']) {
    assert.throws(() => parseInstalledVersion(output), /did not report a supported omp version/);
  }
  for (const output of ['omp/17.9.0', 'omp/18.2.9']) {
    assert.throws(() => parseInstalledVersion(output), /is unsupported/);
  }
});
