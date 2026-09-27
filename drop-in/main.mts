import * as sandcastle from '@ai-hero/sandcastle';
import { docker } from '@ai-hero/sandcastle/sandboxes/docker';
import { z } from 'zod';

import { runFactory } from './factory.js';
import { githubIssueCommand, parseArguments, parseGitHubIssue } from './github-issue.js';

// Edit this small block for the repository receiving these files.
const BASE_REF = 'origin/main';
const BRANCH_PREFIX = 'sandcastle/factory';
const CHECKS = ['pnpm lint', 'pnpm typecheck', 'pnpm test'];
const MAX_ROUNDS = 3;
const SETUP_COMMAND = 'pnpm install --frozen-lockfile';

const reviewSchema = z.object({
  findings: z.array(z.object({
    evidence: z.string(),
    file: z.string(),
    line: z.number().int().positive().nullable(),
    recommendation: z.string(),
    severity: z.enum(['critical', 'high', 'medium', 'low']),
    title: z.string(),
  })),
});
const agent = sandcastle.claudeCode('claude-sonnet-4-6');
const branch = `${BRANCH_PREFIX}/${Date.now()}`;
const { issueReference, reviewOnly } = parseArguments(process.argv.slice(2));
const loadIssueCommand = githubIssueCommand(issueReference);

function parseReview(stdout: string) {
  const match = /<review>\s*([\s\S]*?)\s*<\/review>/.exec(stdout);
  if (match?.[1] === undefined) throw new Error('Reviewer did not return a <review> payload');
  const value: unknown = JSON.parse(match[1]);
  return reviewSchema.parse(value);
}

console.log(`[setup] Creating sandbox branch ${branch}`);
const sandbox = await sandcastle.createSandbox({
  branch,
  hooks: {
    sandbox: { onSandboxReady: [{ command: SETUP_COMMAND }] },
  },
  sandbox: docker(),
});

try {
  console.log(`[setup] Loading GitHub issue ${issueReference}`);
  const loadedIssue = await sandbox.exec(loadIssueCommand);
  if (loadedIssue.exitCode !== 0) {
    throw new Error(`Unable to load GitHub issue:\n${loadedIssue.stderr}`);
  }
  const issue = parseGitHubIssue(loadedIssue.stdout);
  console.log(`[setup] Loaded issue #${issue.number}: ${issue.title}`);

  const result = await runFactory({
    baseRef: BASE_REF,
    checks: CHECKS,
    execute: command => sandbox.exec(command),
    fix: async prompt => {
      await sandbox.run({ agent, maxIterations: 1, name: 'fix', prompt });
    },
    implement: async prompt => {
      await sandbox.run({ agent, maxIterations: 1, name: 'implement', prompt });
    },
    issue,
    maxRounds: MAX_ROUNDS,
    mode: reviewOnly ? 'review-only' : 'implement',
    onStatus: message => console.log(message),
    review: async prompt => {
      const review = await sandbox.run({
        agent,
        maxIterations: 1,
        name: 'review',
        prompt,
      });
      return parseReview(review.stdout);
    },
  });

  console.log(JSON.stringify({ branch, issue: issue.url, ...result }, null, 2));
  if (result.status === 'failed') process.exitCode = 1;
} finally {
  console.log('[setup] Closing sandbox');
  await sandbox.close();
}
