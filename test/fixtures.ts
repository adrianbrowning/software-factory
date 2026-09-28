import type { FactoryOptions, GitHubIssue } from '../drop-in/factory.ts';

export const authorizedIssue = {
  author: 'octocat',
  body: 'Requested behavior',
  labels: ['factory-approved'],
  number: 42,
  title: 'Add behavior',
  url: 'https://github.com/acme/example/issues/42',
} satisfies GitHubIssue;

export function factoryOptions(overrides: Partial<FactoryOptions> = {}): FactoryOptions {
  return {
    baseRef: 'main',
    captureRepositoryState: async () => 'clean',
    checks: ['pnpm test'],
    checkTimeoutMs: 1_000,
    execute: async () => ({ exitCode: 0, stderr: '', stdout: 'passed', timedOut: false }),
    fix: async () => {},
    implement: async () => {},
    issue: { ...authorizedIssue, labels: [...authorizedIssue.labels] },
    maxRounds: 1,
    review: async () => ({ findings: [] }),
    ...overrides,
  };
}
