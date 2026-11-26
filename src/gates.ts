import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent';
import { checksPrompt, type HeadlessGate, parseChecks, suggestChecks } from './config.ts';
import { evidence, redact } from './evidence.ts';
import { addEvent, readRun, type Run, type Source, withRun, type Workspace } from './run.ts';
import { fetchGithubIssue, fileSource, githubSource, issueKey, type SourceInput, workingRepo } from './source.ts';
import { markPaused, repoChecks, saveChecks } from './workflow.ts';

async function confirm(ctx: ExtensionContext, title: string, body: string) {
  if (!ctx.hasUI) throw new Error(`${title} needs the interactive UI.`);
  return ctx.ui.confirm(title, body);
}

/** A confirmation only an interactive run asks; a headless run proceeds with no policy lookup. Reads the run's mode, never ctx.hasUI. */
export async function confirmInteractive(ctx: ExtensionContext, ws: Workspace, feature: string, title: string, body: string) {
  return readRun(ws, feature).mode === 'headless' || confirm(ctx, title, body);
}

/**
 * A confirmation gate. An interactive run asks the user. A headless run follows the policy for the gate: auto records an
 * autonomous event and proceeds; the event holds the dialog title, then the dialog body redacted and clipped to its first
 * 2,000 characters (a clipped body ends with a line saying how many characters are not shown); stop saves a pause with a reason naming the gate, then throws.
 */
export async function gate(ctx: ExtensionContext, ws: Workspace, feature: string, name: HeadlessGate, title: string, body: string) {
  if (readRun(ws, feature).mode !== 'headless') return confirm(ctx, title, body);
  if (ws.config.headless[name] === 'auto') {
    await withRun(ws, feature, run => addEvent(run, 'autonomous', `gate ${name} (auto): ${title}${autoBody(body)}`));
    return true;
  }
  const reason = `headless gate "${name}" is set to stop: ${title}`;
  await withRun(ws, feature, run => markPaused(run, reason));
  throw new Error(`The run is paused, ${reason}. /factory resume ${feature} continues it. Stop now.`);
}

/** The body part of a headless auto gate event: a newline and the redacted body clipped to 2,000 characters, then, only when the redacted body is longer than 2,000 characters, a newline and `[<M> characters not shown]`; empty for an empty body. */
function autoBody(body: string) {
  const redacted = redact(body);
  if (redacted === '') return '';
  return redacted.length > 2_000 ? `\n${redacted.slice(0, 2_000)}\n[${redacted.length - 2_000} characters not shown]` : `\n${redacted}`;
}

/** One outside part for the dialog: the last 1,000 characters of the redacted text, preceded by a line saying how many characters are not shown. */
function shown(text: string) {
  const hidden = redact(text).length - 1_000;
  return hidden > 0 ? `[${hidden} characters not shown]\n${evidence(text, 1_000)}` : evidence(text, 1_000);
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
  const primary = await fetchGithubIssue(ws, input.ref);
  const refs = [...new Set(input.related ?? [])].filter(ref => ref !== input.ref);
  const loaded = await Promise.all(refs.map(async ref => ({ issue: await fetchGithubIssue(ws, ref), ref })));
  // Each issue is included once: related refs are fetched first, then one that resolves to the primary or an earlier related issue (compared by issue URL) is dropped.
  const seen = new Set([issueKey(primary.url) ?? primary.url]);
  const related = loaded.filter(item => {
    const key = issueKey(item.issue.url) ?? item.issue.url;
    return !seen.has(key) && seen.add(key);
  });
  const source = await githubSource(
    input.ref,
    primary,
    async outside => {
      if (mode === 'headless') {
        notes.push(`gate intake (auto): left out text from outside authors ${[...new Set(outside.map(part => `@${part.author}`))].join(', ')}`);
        return false;
      }
      const refs = [...new Set(outside.map(part => part.ref))];
      const grouped = refs
        .map(ref => {
          const parts = outside.filter(part => part.ref === ref);
          return `Issue ${ref} (${redact(parts[0]?.title ?? '')}):\n\n${parts.map(part => `@${part.author} (${part.association}):\n${shown(part.text)}`).join('\n\n')}`;
        })
        .join('\n\n---\n\n');
      return confirm(
        ctx,
        `Use ${outside.length} parts of the issue text written outside the repository?`,
        `These authors are not repository collaborators. Yes uses their text as evidence for the run; No leaves it out.\n\n${grouped}`,
      );
    },
    related,
    related.length > 0 ? await workingRepo(ws) : undefined,
  );
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
    const saved = await saveChecks(ws, detected);
    return [`gate checks (auto): saved the detected checks: ${saved.join('; ')}`];
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
