import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const publicDirectory = fileURLToPath(new URL('../public/', import.meta.url));
const requiredQuestionFields = ['title', 'body', 'recommendation'];

class SessionStore {
  #operation = Promise.resolve();

  constructor(storePath) {
    this.storePath = storePath;
  }

  async #read() {
    try {
      return JSON.parse(await readFile(this.storePath, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return { rounds: [] };
      throw error;
    }
  }

  async #write(data) {
    await mkdir(path.dirname(this.storePath), { recursive: true });
    const temporaryPath = `${this.storePath}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(data, null, 2)}\n`);
    await rename(temporaryPath, this.storePath);
  }

  #serialized(action) {
    const result = this.#operation.then(action, action);
    this.#operation = result.catch(() => {});
    return result;
  }

  list() {
    return this.#serialized(async () => (await this.#read()).rounds);
  }

  create(questions) {
    return this.#serialized(async () => {
      const data = await this.#read();
      const round = {
        id: randomUUID(),
        status: 'waiting',
        createdAt: new Date().toISOString(),
        questions,
      };
      data.rounds.push(round);
      await this.#write(data);
      return round;
    });
  }

  answer(roundId, answers) {
    return this.#serialized(async () => {
      const data = await this.#read();
      const round = data.rounds.find(item => item.id === roundId);
      if (!round) return undefined;
      round.answers = answers;
      round.status = 'answered';
      round.answeredAt = new Date().toISOString();
      await this.#write(data);
      return round;
    });
  }
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}

function isValidQuestions(questions) {
  return Array.isArray(questions)
    && questions.length > 0
    && questions.every(question => question && typeof question === 'object'
      && requiredQuestionFields.every(field => typeof question[field] === 'string' && question[field].trim()));
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error('Request body is too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function createGrillingServer({ storePath }) {
  const store = new SessionStore(storePath);

  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean);

      if (request.method === 'GET' && url.pathname === '/') {
        const body = await readFile(path.join(publicDirectory, 'index.html'));
        response.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-length': body.length,
          'cache-control': 'no-store',
        });
        response.end(body);
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/rounds') {
        sendJson(response, 200, { rounds: await store.list() });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/rounds/current') {
        const rounds = await store.list();
        const current = rounds.findLast(round => round.status === 'waiting');
        sendJson(response, current ? 200 : 404, current ?? { error: 'No round is waiting' });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/rounds') {
        const payload = await readJson(request);
        if (!isValidQuestions(payload?.questions)) {
          sendJson(response, 400, { error: 'Questions need a title, body, and recommendation' });
          return;
        }
        const questions = payload.questions.map(question => Object.fromEntries(
          requiredQuestionFields.map(field => [field, question[field].trim()]),
        ));
        sendJson(response, 201, await store.create(questions));
        return;
      }

      const isAnswersRoute = parts.length === 4
        && parts[0] === 'api' && parts[1] === 'rounds' && parts[3] === 'answers';
      if (isAnswersRoute && request.method === 'GET') {
        const round = (await store.list()).find(item => item.id === parts[2]);
        if (!round) sendJson(response, 404, { error: 'Round not found' });
        else if (round.status !== 'answered') sendJson(response, 202, { id: round.id, status: 'waiting' });
        else sendJson(response, 200, { id: round.id, status: round.status, answers: round.answers });
        return;
      }

      if (isAnswersRoute && request.method === 'POST') {
        const round = (await store.list()).find(item => item.id === parts[2]);
        if (!round) {
          sendJson(response, 404, { error: 'Round not found' });
          return;
        }
        const { answers } = await readJson(request);
        if (!Array.isArray(answers) || answers.length !== round.questions.length
          || answers.some(answer => typeof answer !== 'string' || !answer.trim())) {
          sendJson(response, 400, { error: 'Every question needs an answer' });
          return;
        }
        const updated = await store.answer(parts[2], answers.map(answer => answer.trim()));
        sendJson(response, 200, { id: updated.id, status: updated.status });
        return;
      }

      sendJson(response, 404, { error: 'Not found' });
    } catch (error) {
      const isBadRequest = error instanceof SyntaxError || error.message === 'Request body is too large';
      sendJson(response, isBadRequest ? 400 : 500, { error: isBadRequest ? error.message : 'Internal server error' });
    }
  });
}
