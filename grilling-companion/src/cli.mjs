#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { createGrillingServer } from './server.mjs';

const usage = `Usage:
  node src/cli.mjs serve [--host 127.0.0.1] [--port 8787] [--data .grilling/sessions.json]
  node src/cli.mjs publish QUESTIONS.json [--url http://127.0.0.1:8787]
  node src/cli.mjs answers ROUND_ID [--url http://127.0.0.1:8787]`;

function option(arguments_, name, fallback) {
  const position = arguments_.indexOf(name);
  return position === -1 ? fallback : arguments_[position + 1];
}

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error ?? `Request failed with status ${response.status}`);
  return payload;
}

async function main(arguments_) {
  const [command, subject] = arguments_;
  const baseUrl = option(arguments_, '--url', 'http://127.0.0.1:8787').replace(/\/$/, '');

  if (command === 'serve') {
    const host = option(arguments_, '--host', '127.0.0.1');
    const port = Number(option(arguments_, '--port', '8787'));
    const storePath = path.resolve(option(arguments_, '--data', '.grilling/sessions.json'));
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Port must be between 0 and 65535');
    const server = createGrillingServer({ storePath });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, resolve);
    });
    const address = server.address();
    console.log(`Grilling companion: http://${host}:${address.port}`);
    console.log(`Session data: ${storePath}`);
    return;
  }

  if (command === 'publish' && subject) {
    const document = JSON.parse(await readFile(path.resolve(subject), 'utf8'));
    const questions = Array.isArray(document) ? document : document.questions;
    const result = await requestJson(`${baseUrl}/api/rounds`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ questions }),
    });
    console.log(JSON.stringify(result));
    return;
  }

  if (command === 'answers' && subject) {
    const result = await requestJson(`${baseUrl}/api/rounds/${encodeURIComponent(subject)}/answers`);
    console.log(JSON.stringify(result));
    return;
  }

  throw new Error(usage);
}

main(process.argv.slice(2)).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
