/** The TARGETED REVIEW step of startReview: the fix diff since the review that blocked, and its changed lines. */
import { evidence } from './evidence.ts';
import { git } from './exec.ts';
import type { Slice, Workspace } from './run.ts';

/** The changed lines of the fix commits since `targeting.from` up to `sha`, and the data-file section that lists them. */
export async function targetedReview(ws: Workspace, targeting: NonNullable<Slice['targeting']>, sha: string) {
  const fixRange = `${targeting.base}..${sha}`;
  const fixDiff = await git(ws.root, '-c', 'core.quotePath=false', 'diff', '--no-ext-diff', '--unified=0', fixRange);
  const lines = changedLines(fixDiff, await changedPaths(ws.root, fixRange));
  const commits = (await git(ws.root, 'log', '--oneline', fixRange)).trim();
  const listedLines = renderChangedLines(lines);
  const targeted = { from: targeting.from, lines };
  const section = `## TARGETED REVIEW\n\nThis review follows review ${targeting.from}. It runs only the domains that blocked it (${targeting.domains.join(', ') || 'none'}) and the domains that always run. Report an observation only on a line the fix changed, listed below; the validator drops any other observation. Blocking findings anywhere in the slice diff still count. A full review of this commit follows once this one is green.\n\nFix diff: the commits since review ${targeting.from} (${targeting.base}):\n\n\`\`\`\n${evidence(commits === '' ? 'none' : commits, 2_000)}\n\`\`\`\n\nChanged lines (new side):\n\n${listedLines.join('\n') || 'None.'}\n\n`;
  return { section, targeted };
}

/** One `- <path>: <start>-<end>, ...` entry per changed path; a path with no hunks reads `(no hunk lines: file-level only)`. */
export function renderChangedLines(lines: Record<string, [number, number][]>) {
  return Object.entries(lines).map(([file, ranges]) => `- ${file}: ${ranges.length === 0 ? '(no hunk lines: file-level only)' : ranges.map(([start, end]) => `${start}-${end}`).join(', ')}`);
}

export async function changedPaths(root: string, range: string, ...filter: string[]) {
  return (await git(root, 'diff', '--name-only', '-z', ...filter, range)).split('\0').filter(Boolean);
}


/**
 * Each changed path with the new-side line ranges of its hunks, context lines included. A path with no hunks (a
 * binary, mode-only, or deleted file) maps to no ranges, so a finding on it can only be file-level.
 */
export function changedLines(diff: string, files: string[]) {
  const lines: Record<string, [number, number][]> = Object.fromEntries(files.map(file => [file, []]));
  let ranges: [number, number][] | undefined;
  let header = false;
  for (const line of diff.split('\n')) {
    // Content lines start with ' ', '+', '-', or '\', so these prefixes only match headers.
    if (line.startsWith('diff --git ')) {
      header = true;
      ranges = undefined;
    } else if (header && line.startsWith('+++ ')) {
      const name = line.slice(4).replace(/\t$/, '');
      const path = (name.startsWith('"') ? (JSON.parse(name) as string) : name).replace(/^b\//, '');
      ranges = name === '/dev/null' ? undefined : (lines[path] ??= []);
    } else if (line.startsWith('@@ ')) {
      header = false;
      const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
      const start = Number(match?.[1]);
      const count = match?.[2] === undefined ? 1 : Number(match[2]);
      if (ranges !== undefined && count > 0) ranges.push([start, start + count - 1]);
    }
  }
  return lines;
}

