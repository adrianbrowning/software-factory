import { existsSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { z } from 'zod';
import { git, gh } from './exec.ts';
import { type Source, sourceSchema, type Workspace } from './run.ts';

/** The most related issue refs a run takes; the one owner of the limit. */
export const RELATED_MAX = 20;

/** What `factory_start` takes: GitHub and file issues by reference (the tool loads them), Jira and pasted text in full. */
export const sourceInputSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('github'),
    ref: z.string().min(1).describe('Primary issue number or URL; the tool loads it with gh'),
    related: z.array(z.string().min(1)).max(RELATED_MAX).optional().describe(`Up to ${RELATED_MAX} further issue numbers or URLs the run also covers; the tool loads each with its comments`),
  }),
  z.object({
    kind: z.literal('file'),
    ref: z.string().min(1).describe('Path of the issue file: absolute, or relative to the repository root; the tool reads it'),
    related: z.never({ error: '`related` is only for github sources' }).optional(),
  }),
  sourceSchema.omit({ related: true }).extend({ kind: z.enum(['jira', 'text']), related: z.never({ error: '`related` is only for github sources' }).optional() }),
]);
export type SourceInput = z.infer<typeof sourceInputSchema>;

const ghLogin = z
  .object({ login: z.string() })
  .nullable()
  .transform(author => author?.login ?? 'ghost');
const ghIssueSchema = z.object({
  author: ghLogin,
  body: z.string(),
  comments: z.array(z.object({ author: ghLogin, authorAssociation: z.string(), body: z.string() })),
  title: z.string().min(1),
  url: z.string(),
});
export type GithubIssue = z.infer<typeof ghIssueSchema> & { authorAssociation: string };

/** `owner/repo#number`, lowercased, of a GitHub issue or pull URL; undefined for anything else. */
export function issueKey(url: string) {
  const match = /github\.com\/([^/]+\/[^/]+)\/(?:issues|pull)\/(\d+)/i.exec(url);
  return match === null ? undefined : `${match[1]}#${match[2]}`.toLowerCase();
}

/** The `owner/repo` (lowercased) of a GitHub issue URL. */
export const repoOf = (url: string) => issueKey(url)?.split('#')[0];

/** Associations whose text the run uses without asking: people who can already change the repository. */
const TRUSTED_ASSOCIATIONS = new Set(['COLLABORATOR', 'MEMBER', 'OWNER']);

/** Loads a GitHub issue with its comments, and the issue author's association with the repository. */
export async function fetchGithubIssue(ws: Workspace, ref: string): Promise<GithubIssue> {
  if (ref.startsWith('-')) throw new Error(`"${ref}" is not an issue number or URL.`);
  const issue = ghIssueSchema.parse(JSON.parse(await gh(ws.root, 'issue', 'view', ref, '--json', 'author,body,comments,title,url')));
  const match = /github\.com\/([^/]+\/[^/]+)\/(?:issues|pull)\/(\d+)/.exec(issue.url);
  if (match === null) throw new Error(`gh returned an issue URL the factory cannot read: ${issue.url}`);
  const authorAssociation = (await gh(ws.root, 'api', `repos/${match[1]}/issues/${match[2]}`, '--jq', '.author_association')).trim();
  return { ...issue, authorAssociation };
}

type OutsidePart = { association: string; author: string; ref: string; text: string; title: string };

/** The `owner/repo` the run works in: what `gh repo view` names (the repo gh resolves bare issue numbers against), else the `origin` remote when it is a GitHub URL; undefined when neither tells. */
export async function workingRepo(ws: Workspace) {
  try {
    const fromGh = (await gh(ws.root, 'repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner')).trim().toLowerCase();
    if (fromGh !== '') return fromGh;
  } catch {
    // gh cannot tell: read the origin remote.
  }
  try {
    const url = (await git(ws.root, 'remote', 'get-url', 'origin')).trim();
    return /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec(url)?.[1]?.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * The run source for a GitHub issue: its body and comments. Text by people outside the repository goes to `approve`
 * (the user's dialog) and stays out unless it returns true; `approve` runs only when there is such text.
 */
export async function githubSource(
  ref: string,
  issue: GithubIssue,
  approve: (outside: OutsidePart[]) => Promise<boolean>,
  related: { issue: GithubIssue; ref: string }[],
  repo: string | undefined,
): Promise<Source> {
  // The primary issue keeps its own author associations. A related issue from another repo than the run's is outside text whatever its author association says there; with no known working repo no related issue is trusted.
  const trusted = (from: GithubIssue, association: string) => TRUSTED_ASSOCIATIONS.has(association) && (from === issue || (repo !== undefined && repoOf(from.url) === repo));
  const parts = (at: string, from: GithubIssue): OutsidePart[] => [
    { association: from.authorAssociation, author: from.author, ref: at, text: `${from.title}\n\n${from.body}`, title: from.title },
    ...from.comments.map(comment => ({ association: comment.authorAssociation, author: comment.author, ref: at, text: comment.body, title: from.title })),
  ];
  const outside = [{ at: ref, from: issue }, ...related.map(item => ({ at: item.ref, from: item.issue }))]
    .flatMap(({ at, from }) => parts(at, from).filter(part => !trusted(from, part.association)));
  const include = outside.length > 0 && (await approve(outside));
  const use = (from: GithubIssue, association: string) => include || trusted(from, association);
  const authored = use(issue, issue.authorAssociation);
  const body = authored ? issue.body : `(The issue title and text by @${issue.author}, who is not a repository collaborator, are left out.)`;
  const comments = issue.comments
    .filter(comment => use(issue, comment.authorAssociation))
    .map(comment => `### @${comment.author} (${comment.authorAssociation})\n\n${comment.body}`);
  const title = authored ? issue.title : `GitHub issue ${ref}`;
  const sections = related.map(item => ({ item, section: relatedSection(item.ref, item.issue, use) }));
  const primary = comments.length === 0 ? body : `${body}\n\n## Comments\n\n${comments.join('\n\n')}`;
  const source: Source = { body: [primary, ...sections.map(entry => entry.section.body)].join('\n\n'), kind: 'github', ref, title, url: issue.url };
  if (sections.length > 0) source.related = sections.map(entry => ({ ref: entry.item.ref, title: entry.section.title, url: entry.item.issue.url }));
  return source;
}

/** The text of one related issue: a section of the run source body. */
function relatedSection(ref: string, issue: GithubIssue, use: (from: GithubIssue, association: string) => boolean) {
  const authored = use(issue, issue.authorAssociation);
  const title = authored ? issue.title : `GitHub issue ${ref}`;
  const text = authored ? issue.body : `(The issue title and text by @${issue.author}, who is not a repository collaborator, are left out.)`;
  const comments = issue.comments.filter(comment => use(issue, comment.authorAssociation)).map(comment => `### @${comment.author} (${comment.authorAssociation})\n\n${comment.body}`);
  return { body: `## Related issue ${ref}: ${title}\n\n${text}${comments.length === 0 ? '' : `\n\n### Comments\n\n${comments.join('\n\n')}`}`, title };
}

/** The run source for an issue file; its title is the first `# ` heading, or the file name. */
export function fileSource(ws: Workspace, ref: string): Source {
  const path = resolve(ws.root, ref);
  if (!existsSync(path)) throw new Error(`Issue file ${path} does not exist.`);
  const body = readFileSync(path, 'utf8');
  const title = /^#\s+(.+)$/m.exec(body)?.[1]?.trim() || basename(path);
  return { body, kind: 'file', ref, title };
}
