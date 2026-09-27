import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { IssueReference, IssueSnapshot } from './process-issue.js';

const execFileAsync = promisify(execFile);

function isIssueSnapshot(value: unknown): value is IssueSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = <Record<string, unknown>>value;
  return typeof candidate.body === 'string'
    && typeof candidate.number === 'number'
    && typeof candidate.title === 'string'
    && typeof candidate.url === 'string';
}

export async function readGitHubIssue(reference: IssueReference) {
  const { stdout } = await execFileAsync('gh', [
    'issue',
    'view',
    String(reference.issueNumber),
    '--repo',
    `${reference.owner}/${reference.repository}`,
    '--json',
    'number,title,body,url',
  ]);
  const value: unknown = JSON.parse(stdout);
  if (!isIssueSnapshot(value)) throw new Error('GitHub returned an invalid Issue');
  return value;
}
