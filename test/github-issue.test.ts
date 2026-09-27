import assert from 'node:assert/strict';
import { test } from 'node:test';

import { githubIssueCommand, parseGitHubIssue } from '../drop-in/github-issue.js';

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
