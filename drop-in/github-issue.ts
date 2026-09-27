import type { GitHubIssue } from './factory.js';

const fields = 'author,body,labels,number,title,url';
const usage = 'Usage: npx tsx .sandcastle/main.mts <issue> [--review-only]';

export type IssueTrustPolicy = {
  requiredLabel: string;
  trustedAuthors: readonly string[];
  trustedRepositories: readonly string[];
};

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

function normalizeRepository(repository: string) {
  return repository.toLowerCase();
}

function trustedRepository(repository: string, policy: IssueTrustPolicy) {
  const normalized = normalizeRepository(repository);
  const trusted = policy.trustedRepositories.some(candidate => (
    normalizeRepository(candidate) === normalized
  ));
  if (!trusted) throw new Error(`Untrusted GitHub repository: ${repository}`);
  return repository;
}

function command(issueNumber: string, repository: string) {
  return `gh issue view ${issueNumber} --repo ${repository} --json ${fields}`;
}

export function githubIssueCommand(reference: string, policy: IssueTrustPolicy) {
  const primaryRepository = policy.trustedRepositories[0];
  if (primaryRepository === undefined) throw new Error('Configure at least one trusted repository');

  if (/^[1-9]\d*$/.test(reference)) return command(reference, primaryRepository);

  const shorthand = /^([A-Za-z0-9.-]+\/[A-Za-z0-9._-]+)#([1-9]\d*)$/.exec(reference);
  if (shorthand?.[1] !== undefined && shorthand[2] !== undefined) {
    return command(shorthand[2], trustedRepository(shorthand[1], policy));
  }

  const url = /^https:\/\/github\.com\/([A-Za-z0-9.-]+\/[A-Za-z0-9._-]+)\/issues\/([1-9]\d*)$/.exec(reference);
  if (url?.[1] !== undefined && url[2] !== undefined) {
    return command(url[2], trustedRepository(url[1], policy));
  }

  throw new Error('Issue reference must be a number, owner/repository#number, or GitHub issue URL');
}

type RawGitHubIssue = {
  author: { login: string };
  body: string;
  labels: Array<{ name: string }>;
  number: number;
  title: string;
  url: string;
};

function isRawGitHubIssue(value: unknown): value is RawGitHubIssue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const issue = <Record<string, unknown>>value;
  const author = issue.author;
  const labels = issue.labels;
  return (
    typeof author === 'object'
    && author !== null
    && !Array.isArray(author)
    && typeof (<Record<string, unknown>>author).login === 'string'
    && typeof issue.body === 'string'
    && Array.isArray(labels)
    && labels.every(label => (
      typeof label === 'object'
      && label !== null
      && !Array.isArray(label)
      && typeof (<Record<string, unknown>>label).name === 'string'
    ))
    && Number.isInteger(issue.number)
    && Number(issue.number) > 0
    && typeof issue.title === 'string'
    && typeof issue.url === 'string'
  );
}

export function parseGitHubIssue(stdout: string, policy: IssueTrustPolicy) {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new Error('Invalid GitHub issue JSON');
  }
  if (!isRawGitHubIssue(value)) throw new Error('Invalid GitHub issue returned by gh');

  const url = /^https:\/\/github\.com\/([A-Za-z0-9.-]+\/[A-Za-z0-9._-]+)\/issues\/[1-9]\d*$/.exec(value.url);
  if (url?.[1] === undefined) throw new Error('Invalid GitHub issue URL returned by gh');
  trustedRepository(url[1], policy);

  const trustedAuthor = policy.trustedAuthors.some(author => (
    author.toLowerCase() === value.author.login.toLowerCase()
  ));
  if (!trustedAuthor) {
    throw new Error(`Untrusted GitHub issue author: ${value.author.login}`);
  }

  const labels = value.labels.map(label => label.name);
  if (!labels.includes(policy.requiredLabel)) {
    throw new Error(`GitHub issue is missing required label ${policy.requiredLabel}`);
  }

  return {
    author: value.author.login,
    body: value.body,
    labels,
    number: value.number,
    title: value.title,
    url: value.url,
  } satisfies GitHubIssue;
}
