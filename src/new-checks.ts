import { CONFIG_PATH, parseConfig } from './config.ts';
import { git } from './exec.ts';

/**
 * The reply section naming checks that the commit at `sha` (the checked commit) lists in its committed config and the run's frozen `checks`
 * do not, or '' when it adds none or the committed config is missing, not JSON, or fails the schema. The run does not
 * run them: a slice cannot widen what the gate executes.
 */
export async function newChecksSection(root: string, sha: string, checks: string[]) {
  let added: string[];
  try {
    const committed = parseConfig(JSON.parse(await git(root, 'show', `${sha}:${CONFIG_PATH}`)));
    added = (committed.checks ?? []).map(command => command.trim()).filter(command => !checks.includes(command));
  } catch {
    return '';
  }
  if (added.length === 0) return '';
  return `\nThis slice's committed ${CONFIG_PATH} lists checks the run's frozen checks do not. This run does not run them:\n${added.map(command => `- ${command}`).join('\n')}`;
}
