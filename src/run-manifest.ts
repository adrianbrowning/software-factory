import { mkdir, rename, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

import type { RunManifest } from './process-issue.js';

export async function saveRunManifest(runsDirectory: string, manifest: RunManifest) {
  const runDirectory = path.join(runsDirectory, manifest.runId);
  const manifestPath = path.join(runDirectory, 'manifest.json');
  const temporaryPath = `${manifestPath}.tmp`;

  await mkdir(runDirectory, { recursive: true });
  await writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await rename(temporaryPath, manifestPath);
  return manifestPath;
}
