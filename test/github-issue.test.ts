import assert from 'node:assert/strict';
import { test } from 'node:test';

import { githubIssueCommand, parseGitHubIssue } from '../drop-in/github-issue.js';

test('builds a gh command for a current-repository issue number', () => {
  assert.equal(
    githubIssueCommand('42'),
    'gh issue view 42 --json body,number,title,url',
  );
});

test('builds a gh command for an owner/repository issue reference', () => {
  assert.equal(
    githubIssueCommand('acme/example-repo#42'),
    'gh issue view 42 --repo acme/example-repo --json body,number,title,url',
  );
});

test('builds a gh command for an issue URL', () => {
  assert.equal(
    githubIssueCommand('https://github.com/acme/example-repo/issues/42'),
    'gh issue view 42 --repo acme/example-repo --json body,number,title,url',
  );
});

test('rejects unsafe issue references', () => {
  assert.throws(() => githubIssueCommand('42; rm -rf .'), /issue reference/i);
});

test('parses and validates GitHub issue JSON', () => {
  assert.deepEqual(
    parseGitHubIssue(JSON.stringify({
      body: 'Requested behavior',
      number: 42,
      title: 'Add behavior',
      url: 'https://github.com/acme/example/issues/42',
    })),
    {
      body: 'Requested behavior',
      number: 42,
      title: 'Add behavior',
      url: 'https://github.com/acme/example/issues/42',
    },
  );
  assert.throws(() => parseGitHubIssue('{"number":42}'), /invalid GitHub issue/i);
});
