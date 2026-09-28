import type { GitHubIssue } from './factory.ts';

const fields = 'author,body,labels,number,title,url';
const usage = 'Usage: node .sandcastle/main.mts (<issue> | --file <path>) [--review-only]';

export type IssueTrustPolicy = {
  requiredLabel: string;
  trustedAuthors: readonly string[];
  trustedRepositories: readonly string[];
};

export type ParsedArguments =
  | { filePath: string; reviewOnly: boolean }
  | { issueReference: string; reviewOnly: boolean };

export function parseArguments(arguments_: string[]): ParsedArguments {
  let filePath: string | undefined;
  let issueReference: string | undefined;
  let reviewOnly = false;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === undefined) continue;

    if (argument === '--review-only' && !reviewOnly) {
      reviewOnly = true;
    } else if (argument === '--file' && filePath === undefined) {
      const next = arguments_[index + 1];
      if (next === undefined || next.startsWith('-')) throw new Error(usage);
      filePath = next;
      index += 1;
    } else if (!argument.startsWith('-') && issueReference === undefined) {
      issueReference = argument;
    } else {
      throw new Error(usage);
    }
  }

  if (filePath !== undefined && issueReference !== undefined) throw new Error(usage);
  if (filePath !== undefined) return { filePath, reviewOnly };
  if (issueReference !== undefined) return { issueReference, reviewOnly };
  throw new Error(usage);
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
  const issue = value as Record<string, unknown>;
  const author = issue.author;
  const labels = issue.labels;
  return (
    typeof author === 'object'
    && author !== null
    && !Array.isArray(author)
    && typeof (author as Record<string, unknown>).login === 'string'
    && typeof issue.body === 'string'
    && Array.isArray(labels)
    && labels.every(label => (
      typeof label === 'object'
      && label !== null
      && !Array.isArray(label)
      && typeof (label as Record<string, unknown>).name === 'string'
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

export function fileIssueSlug(filePath: string) {
  const base = filePath.split(/[\\/]/).pop() ?? filePath;
  const withoutExtension = base.replace(/\.[^./]+$/, '');
  const slug = withoutExtension.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-').replaceAll(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : 'issue';
}

export function parseFileIssue(content: string, filePath: string) {
  const lines = content.split(/\r?\n/);
  const titleIndex = lines.findIndex(line => line.trim().length > 0);
  if (titleIndex === -1) throw new Error(`Issue file is empty: ${filePath}`);

  const title = (lines[titleIndex] ?? '').trim().replace(/^#+\s*/, '').trim();
  if (title.length === 0) throw new Error(`Issue file is missing a title: ${filePath}`);

  const body = lines.slice(titleIndex + 1).join('\n').trim();

  return {
    author: 'local-file',
    body,
    labels: [],
    number: 0,
    title,
    url: `file://${fileIssueSlug(filePath)}`,
  } satisfies GitHubIssue;
}
