import { git } from './exec.ts';

const MAX_FLAGGED = 20;

/**
 * The reply section naming tracked files that git flags skip-worktree (`S`) or assume-unchanged (lowercase tag) in the
 * worktree at `root`, or '' when none is flagged. Such a local file can differ from the committed one, so a check can
 * fail only on this machine.
 */
export async function flaggedFilesSection(root: string) {
  const flagged: string[] = [];
  for (const line of (await git(root, 'ls-files', '-v', '-z')).split('\0')) {
    const tag = line[0];
    if (tag === undefined || line[1] !== ' ') continue;
    if (tag === 'S') flagged.push(`- skip-worktree: ${line.slice(2)}`);
    else if (tag >= 'a' && tag <= 'z') flagged.push(`- assume-unchanged: ${line.slice(2)}`);
  }
  if (flagged.length === 0) return '';
  const rest = flagged.length - MAX_FLAGGED;
  const listed = flagged.slice(0, MAX_FLAGGED).join('\n');
  return `\nFlagged files (git ls-files -v): a local file flagged skip-worktree or assume-unchanged can differ from the committed one and make a check fail only on this machine.\n${listed}${rest > 0 ? `\n- and ${rest} more` : ''}`;
}
