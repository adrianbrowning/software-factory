#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';

import { readGitHubIssue } from './github-issue.js';
import { processIssue } from './process-issue.js';
import { saveRunManifest } from './run-manifest.js';

async function main(arguments_: string[]) {
  const [command, rawReference] = arguments_;
  if (command !== 'issue' || rawReference === undefined) {
    throw new Error("Usage: pnpm process issue 'owner/repository#number'");
  }

  const runsDirectory = path.resolve(
    process.env.SOFTWARE_FACTORY_RUNS_DIR ?? '.software-factory/runs',
  );
  const result = await processIssue(rawReference, {
    loadIssue: readGitHubIssue,
    newRunId: randomUUID,
    now: () => new Date(),
    saveManifest: manifest => saveRunManifest(runsDirectory, manifest),
  });

  console.log(
    `Captured Issue Contract for ${result.reference.owner}/${result.reference.repository}#${result.reference.issueNumber}`,
  );
  console.log(`Manifest: ${result.manifestPath}`);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Unknown failure');
  process.exitCode = 1;
});
