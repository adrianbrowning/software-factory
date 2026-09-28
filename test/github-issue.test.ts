import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fileIssueSlug, githubIssueCommand, parseFileIssue, parseGitHubIssue } from '../drop-in/github-issue.ts';

const policy = {
  requiredLabel: 'factory-approved',
  trustedAuthors: ['octocat'],
  trustedRepositories: ['acme/example'],
};

test('rejects unsafe issue references', () => {
  assert.throws(
    () => githubIssueCommand('42; rm -rf .', policy),
    /issue reference/i,
  );
});

test('rejects malformed GitHub issue JSON and shapes', () => {
  assert.throws(
    () => parseGitHubIssue('{not json}', policy),
    /invalid GitHub issue JSON/i,
  );
  assert.throws(
    () => parseGitHubIssue('{"number":42}', policy),
    /invalid GitHub issue returned by gh/i,
  );
});

test('parses a file issue, stripping leading #s and whitespace from the title', () => {
  const issue = parseFileIssue('  ## Fix the login bug  \n\nSteps to reproduce:\n1. Log in\n2. Observe crash\n', 'notes/Login Bug.md');

  assert.equal(issue.title, 'Fix the login bug');
  assert.equal(issue.body, 'Steps to reproduce:\n1. Log in\n2. Observe crash');
  assert.equal(issue.author, 'local-file');
  assert.deepEqual(issue.labels, []);
  assert.equal(issue.number, 0);
  assert.equal(issue.url, 'file://login-bug');
});

test('rejects an empty issue file or a file with only blank lines', () => {
  assert.throws(() => parseFileIssue('', 'notes/empty.md'), /issue file is empty/i);
  assert.throws(() => parseFileIssue('\n\n   \n', 'notes/blank.md'), /issue file is empty/i);
});

test('rejects a file whose first line strips down to an empty title', () => {
  assert.throws(() => parseFileIssue('#\n\nbody', 'notes/no-title.md'), /missing a title/i);
  assert.throws(() => parseFileIssue('   ###   \nbody', 'notes/no-title.md'), /missing a title/i);
});

test('derives a stable slug from a file path', () => {
  assert.equal(fileIssueSlug('notes/Login Bug.md'), 'login-bug');
  assert.equal(fileIssueSlug('/tmp/issue.txt'), 'issue');
  assert.equal(fileIssueSlug('###.md'), 'issue');
});
