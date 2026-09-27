import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

import { createGrillingServer } from '../src/server.mjs';

const execute = promisify(execFile);
const cliPath = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));

test('CLI publishes a question file and reads the submitted answers', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'grilling-cli-'));
  const questionsPath = path.join(directory, 'questions.json');
  await writeFile(questionsPath, JSON.stringify({ questions: [
    { title: 'Direction', body: 'Which way?', recommendation: 'Choose north.' },
  ] }));

  const server = createGrillingServer({ storePath: path.join(directory, 'sessions.json') });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true });
  });
  const url = `http://127.0.0.1:${server.address().port}`;

  const publishedProcess = await execute(process.execPath, [cliPath, 'publish', questionsPath, '--url', url]);
  const published = JSON.parse(publishedProcess.stdout);
  assert.match(published.id, /^[0-9a-f-]+$/);

  await fetch(`${url}/api/rounds/${published.id}/answers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ answers: ['North'] }),
  });

  const answersProcess = await execute(process.execPath, [cliPath, 'answers', published.id, '--url', url]);
  assert.deepEqual(JSON.parse(answersProcess.stdout).answers, ['North']);
});
