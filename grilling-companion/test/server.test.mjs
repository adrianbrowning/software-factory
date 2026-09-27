import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createGrillingServer } from '../src/server.mjs';

async function startServer(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'grilling-web-'));
  const storePath = path.join(directory, 'sessions.json');
  const server = createGrillingServer({ host: '127.0.0.1', port: 0, storePath });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true });
  });
  const { port } = server.address();
  return { baseUrl: `http://127.0.0.1:${port}`, storePath };
}

test('a grilling round can be published, completed, persisted, and retrieved', async t => {
  const { baseUrl, storePath } = await startServer(t);
  const questions = [
    { title: 'Audience', body: 'Who is this for?', recommendation: 'Start with maintainers.' },
    { title: 'Scope', body: 'How small should version one be?', recommendation: 'Ship the smallest useful slice.' },
  ];

  const publishResponse = await fetch(`${baseUrl}/api/rounds`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ questions }),
  });
  assert.equal(publishResponse.status, 201);
  const published = await publishResponse.json();

  const currentResponse = await fetch(`${baseUrl}/api/rounds/current`);
  assert.equal(currentResponse.status, 200);
  const current = await currentResponse.json();
  assert.equal(current.id, published.id);
  assert.equal(current.questions[0].title, 'Audience');
  assert.equal('answers' in current, false);

  const answerResponse = await fetch(`${baseUrl}/api/rounds/${published.id}/answers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ answers: ['Library maintainers', 'Only the happy path'] }),
  });
  assert.equal(answerResponse.status, 200);
  assert.equal((await answerResponse.json()).status, 'answered');

  const resultResponse = await fetch(`${baseUrl}/api/rounds/${published.id}/answers`);
  assert.equal(resultResponse.status, 200);
  assert.deepEqual((await resultResponse.json()).answers, ['Library maintainers', 'Only the happy path']);

  const persisted = JSON.parse(await readFile(storePath, 'utf8'));
  assert.equal(persisted.rounds[0].answers[0], 'Library maintainers');
});

test('a round rejects an incomplete set of answers', async t => {
  const { baseUrl } = await startServer(t);
  const published = await fetch(`${baseUrl}/api/rounds`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ questions: [
      { title: 'One', body: 'First?', recommendation: 'A' },
      { title: 'Two', body: 'Second?', recommendation: 'B' },
    ] }),
  }).then(response => response.json());

  const response = await fetch(`${baseUrl}/api/rounds/${published.id}/answers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ answers: ['only one'] }),
  });
  assert.equal(response.status, 400);
});

test('the home page is a mobile wizard that automatically checks for new rounds', async t => {
  const { baseUrl } = await startServer(t);
  const response = await fetch(baseUrl);
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(html, /name="viewport"/);
  assert.match(html, />Back</);
  assert.match(html, />Next</);
  assert.match(html, /Review answers/);
  assert.match(html, /Submit answers/);
  assert.match(html, /pollForRound/);
});
