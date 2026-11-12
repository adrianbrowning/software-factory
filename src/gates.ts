import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent';
import { checksPrompt, type HeadlessGate, parseChecks, suggestChecks } from './config.ts';
import { evidence } from './evidence.ts';
import { addEvent, readRun, type Run, type Source, withRun, type Workspace } from './run.ts';
import { fetchGithubIssue, fileSource, githubSource, repoChecks, saveChecks, type SourceInput } from './workflow.ts';

async function confirm(ctx: ExtensionContext, title: string, body: string) {
  if (!ctx.hasUI) throw new Error(`${title} needs the interactive UI.`);
  return ctx.ui.confirm(title, body);
}

/**
 * A confirmation gate. An interactive run asks the user. A headless run follows the policy for the gate: auto records an
 * autonomous event and proceeds; stop saves a pause with a reason naming the gate, then throws.
 */
export async function gate(ctx: ExtensionContext, ws: Workspace, feature: string, name: HeadlessGate, title: string, body: string) {
  if (readRun(ws, feature).mode !== 'headless') return confirm(ctx, title, body);
  if (ws.config.headless[name] === 'auto') {
    await withRun(ws, feature, run => addEvent(run, 'autonomous', `gate ${name} (auto): ${title}`));
    return true;
  }
  const reason = `headless gate "${name}" is set to stop: ${title}`;
  await withRun(ws, feature, run => {
    // Only a headless stop gate pauses an intake, stalled, or done run; /factory pause stays running-only. A stalled slice keeps asking to raise the budget on resume.
    run.status = 'paused';
    addEvent(run, 'pause', reason);
  });
  throw new Error(`The run is paused, ${reason}. /factory resume ${feature} continues it. Stop now.`);
}

/**
 * The run source, plus autonomous-event notes. The tool loads GitHub and file issues itself. For GitHub text from
 * outside the repository, an interactive run asks the user; a headless run always leaves it out and returns a note
 * naming the authors.
 */
export async function loadSource(ctx: ExtensionContext, ws: Workspace, input: SourceInput, mode: Run['mode']): Promise<{ notes: string[]; source: Source }> {
  if (input.kind === 'file') return { notes: [], source: await fileSource(ws, input.ref) };
  if (input.kind !== 'github') return { notes: [], source: input };
  const notes: string[] = [];
  const source = await githubSource(input.ref, await fetchGithubIssue(ws, input.ref), async outside => {
    if (mode === 'headless') {
      notes.push(`gate intake (auto): left out text from outside authors ${outside.map(part => `@${part.author}`).join(', ')}`);
      return false;
    }
    return confirm(
      ctx,
      `Use ${outside.length} parts of the issue written outside the repository?`,
      `These authors are not repository collaborators. Yes uses their text as evidence for the run; No leaves it out.\n\n${outside.map(part => `@${part.author} (${part.association}):\n${evidence(part.text, 1_000)}`).join('\n\n')}`,
    );
  });
  return { notes, source };
}

/** Shows the check dialog: the repository's current checks (or the default ones) chosen, other suggestions commented out. */
export async function chooseChecks(ctx: ExtensionContext, ws: Workspace) {
  if (!ctx.hasUI) throw new Error('Choosing the checks needs the interactive UI.');
  const suggestions = suggestChecks(ws.root, ws.config);
  const current = repoChecks(ws);
  const chosen = current.length === 0 ? suggestions.chosen : current;
  const prompt = checksPrompt({
    chosen,
    scripts: suggestions.scripts.filter(command => !chosen.includes(command)),
    workflows: suggestions.workflows.filter(command => !chosen.includes(command)),
  });
  const text = await ctx.ui.editor('Checks for this repository (one command per line)', prompt);
  return text === undefined ? undefined : parseChecks(text);
}

/** The first run in a repository asks the user for its checks and saves them; later runs reuse them. A headless run saves the detected ones. Returns the autonomous decision to record, if any. */
export async function ensureChecks(ctx: ExtensionContext, ws: Workspace, mode: Run['mode']): Promise<string[]> {
  if (repoChecks(ws).length > 0) return [];
  if (mode === 'headless') {
    if (ws.config.headless.checks === 'stop') throw new Error('Headless gate "checks" is set to stop and the repository has no configured checks. Configure checks in .omp/factory.json, or set headless.checks to auto.');
    const detected = suggestChecks(ws.root, ws.config).chosen;
    if (detected.length === 0) throw new Error('Headless gate "checks": the repository has no configured checks and none could be detected (no lint, typecheck, or test script). Set "checks" in .omp/factory.json, then start again.');
    await saveChecks(ws, detected);
    return [`gate checks (auto): saved the detected checks: ${detected.join('; ')}`];
  }
  for (;;) {
    const checks = await chooseChecks(ctx, ws);
    if (checks === undefined) throw new Error('The user cancelled the checks dialog. Every run needs at least one check: ask which checks to run, then call factory_start again.');
    if (checks.length > 0) {
      await saveChecks(ws, checks);
      return [];
    }
    ctx.ui.notify('Every run needs at least one check. Type at least one command, or cancel.', 'warning');
  }
}
