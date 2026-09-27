import * as assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'software-factory-process-'));

after(() => rmSync(temporaryRoot, { force: true, recursive: true }));

test('process issue captures an immutable Issue Contract in a run manifest', () => {
  const binaryDirectory = path.join(temporaryRoot, 'bin');
  const callsPath = path.join(temporaryRoot, 'gh-calls.json');
  const runsDirectory = path.join(temporaryRoot, 'runs');
  const fakeGhPath = path.join(binaryDirectory, 'gh');
  mkdirSync(binaryDirectory);

  writeFileSync(
    fakeGhPath,
    `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync(process.env.FAKE_GH_CALLS_PATH, JSON.stringify(process.argv.slice(2)));
process.stdout.write(JSON.stringify({
  number: 42,
  title: 'Capture the first Issue Contract',
  body: 'Acceptance: preserve the original issue context.',
  url: 'https://github.com/adrianbrowning/example/issues/42'
}));
`,
    { encoding: 'utf8', mode: 0o700 },
  );
  chmodSync(fakeGhPath, 0o700);

  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'src/process-cli.ts', 'issue', 'adrianbrowning/example#42'],
    {
      cwd: projectRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        FAKE_GH_CALLS_PATH: callsPath,
        PATH: `${binaryDirectory}${path.delimiter}${process.env.PATH ?? ''}`,
        SOFTWARE_FACTORY_RUNS_DIR: runsDirectory,
      },
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(callsPath, 'utf8')), [
    'issue',
    'view',
    '42',
    '--repo',
    'adrianbrowning/example',
    '--json',
    'number,title,body,url',
  ]);

  const runDirectories = readdirSync(runsDirectory);
  assert.equal(runDirectories.length, 1);
  const manifest = JSON.parse(
    readFileSync(path.join(runsDirectory, runDirectories[0]!, 'manifest.json'), 'utf8'),
  );

  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.state, 'planning');
  assert.deepEqual(manifest.issueContract.issue, {
    body: 'Acceptance: preserve the original issue context.',
    number: 42,
    owner: 'adrianbrowning',
    repository: 'example',
    title: 'Capture the first Issue Contract',
    url: 'https://github.com/adrianbrowning/example/issues/42',
  });
  assert.match(manifest.issueContract.capturedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(result.stdout, /Captured Issue Contract for adrianbrowning\/example#42/);
});
