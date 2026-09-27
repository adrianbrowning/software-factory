import type { GitHubIssue } from './factory.js';

const fields = 'body,number,title,url';
const usage = 'Usage: npx tsx .sandcastle/main.mts <issue> [--review-only]';

export type ParsedArguments = {
  issueReference: string;
  reviewOnly: boolean;
};

export function parseArguments(arguments_: string[]) {
  let issueReference: string | undefined;
  let reviewOnly = false;

  for (const argument of arguments_) {
    if (argument === '--review-only' && !reviewOnly) {
      reviewOnly = true;
    } else if (!argument.startsWith('-') && issueReference === undefined) {
      issueReference = argument;
    } else {
      throw new Error(usage);
    }
  }

  if (issueReference === undefined) throw new Error(usage);
  return { issueReference, reviewOnly } satisfies ParsedArguments;
}

function command(issueNumber: string, repository?: string) {
  const repositoryOption = repository === undefined ? '' : ` --repo ${repository}`;
  return `gh issue view ${issueNumber}${repositoryOption} --json ${fields}`;
}

export function githubIssueCommand(reference: string) {
  if (/^[1-9]\d*$/.test(reference)) return command(reference);

  const shorthand = /^([A-Za-z0-9.-]+\/[A-Za-z0-9._-]+)#([1-9]\d*)$/.exec(reference);
  if (shorthand?.[1] !== undefined && shorthand[2] !== undefined) {
    return command(shorthand[2], shorthand[1]);
  }

  const url = /^https:\/\/github\.com\/([A-Za-z0-9.-]+\/[A-Za-z0-9._-]+)\/issues\/([1-9]\d*)$/.exec(reference);
  if (url?.[1] !== undefined && url[2] !== undefined) return command(url[2], url[1]);

  throw new Error('Issue reference must be a number, owner/repository#number, or GitHub issue URL');
}

function isGitHubIssue(value: unknown): value is GitHubIssue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const issue = <Record<string, unknown>>value;
  return (
    typeof issue.body === 'string'
    && Number.isInteger(issue.number)
    && Number(issue.number) > 0
    && typeof issue.title === 'string'
    && typeof issue.url === 'string'
  );
}

export function parseGitHubIssue(stdout: string) {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new Error('Invalid GitHub issue JSON');
  }
  if (!isGitHubIssue(value)) throw new Error('Invalid GitHub issue returned by gh');
  return value;
}
