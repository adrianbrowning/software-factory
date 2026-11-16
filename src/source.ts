import { existsSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { z } from 'zod';
import { gh } from './exec.ts';
import { type Source, sourceSchema, type Workspace } from './run.ts';

/** What `factory_start` takes: GitHub and file issues by reference (the tool loads them), Jira and pasted text in full. */
export const sourceInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('github'), ref: z.string().min(1).describe('Issue number or URL; the tool loads it with gh') }),
  z.object({ kind: z.literal('file'), ref: z.string().min(1).describe('Path of the issue file: absolute, or relative to the repository root; the tool reads it') }),
  sourceSchema.extend({ kind: z.enum(['jira', 'text']) }),
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

type OutsidePart = { association: string; author: string; text: string };

/**
 * The run source for a GitHub issue: its body and comments. Text by people outside the repository goes to `approve`
 * (the user's dialog) and stays out unless it returns true; `approve` runs only when there is such text.
 */
export async function githubSource(ref: string, issue: GithubIssue, approve: (outside: OutsidePart[]) => Promise<boolean>): Promise<Source> {
  const parts = [
    { association: issue.authorAssociation, author: issue.author, text: `${issue.title}\n\n${issue.body}` },
    ...issue.comments.map(comment => ({ association: comment.authorAssociation, author: comment.author, text: comment.body })),
  ];
  const outside = parts.filter(part => !TRUSTED_ASSOCIATIONS.has(part.association));
  const include = outside.length > 0 && (await approve(outside));
  const use = (association: string) => include || TRUSTED_ASSOCIATIONS.has(association);
  const authored = use(issue.authorAssociation);
  const body = authored ? issue.body : `(The issue title and text by @${issue.author}, who is not a repository collaborator, are left out.)`;
  const comments = issue.comments
    .filter(comment => use(comment.authorAssociation))
    .map(comment => `### @${comment.author} (${comment.authorAssociation})\n\n${comment.body}`);
  const title = authored ? issue.title : `GitHub issue ${ref}`;
  return { body: comments.length === 0 ? body : `${body}\n\n## Comments\n\n${comments.join('\n\n')}`, kind: 'github', ref, title, url: issue.url };
}

/** The run source for an issue file; its title is the first `# ` heading, or the file name. */
export function fileSource(ws: Workspace, ref: string): Source {
  const path = resolve(ws.root, ref);
  if (!existsSync(path)) throw new Error(`Issue file ${path} does not exist.`);
  const body = readFileSync(path, 'utf8');
  const title = /^#\s+(.+)$/m.exec(body)?.[1]?.trim() || basename(path);
  return { body, kind: 'file', ref, title };
}
