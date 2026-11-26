import './git-env-guard.ts';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { type FactoryConfig, parseConfig, loadConfig } from '../src/config.ts';
import { activeSlice, type Finding, type FixVerdict, readRun, REVIEW_DOMAINS, reportPath, type SliceInput, statePath, type Workspace, withRun } from '../src/run.ts';
import { recordReview, runChecks, startReview, submitDomain, submitValidation, completeSlice } from '../src/review.ts';
import { placeObservationBatch, planPlace } from '../src/place.ts';
import { approvePlan, nextSlice, planSlices, startRun } from '../src/workflow.ts';
import { type Command, ctx, load } from './extension.ts';
import { parseRetro, recordRetro } from '../src/retro.ts';
import type { submitHeadless } from '../src/headless-submit.ts';

export function sh(root: string, ...args: string[]) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

/** Turns `root` into a git repository on `main` whose base commit holds `files` (path → content). */
export function initRepo(root: string, files: Record<string, string>) {
  sh(root, 'init', '-q', '-b', 'main');
  sh(root, 'config', 'user.email', 'test@example.com');
  sh(root, 'config', 'user.name', 'Test');
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  sh(root, 'add', '.');
  sh(root, 'commit', '-qm', 'base');
  return root;
}

/** A temp directory, removed when the `using` scope that holds it ends; when `setup` throws, the directory is removed and the error rethrown. */
export function tempDir(prefix: string, setup?: (root: string) => void) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  // Retries cover ENOTEMPTY when the OS (macOS writes .DS_Store) adds a file while the tree is being removed.
  const remove = () => rmSync(root, { force: true, maxRetries: 3, recursive: true });
  try {
    setup?.(root);
  } catch (error) {
    remove();
    throw error;
  }
  return { root, [Symbol.dispose]: remove };
}

/** Built repositories by their files, one per distinct `files` in this process; each test copies one instead of running git init and commit again. */
const templates = new Map<string, string>();

function templateRepo(files: Record<string, string>) {
  const key = JSON.stringify(files);
  let template = templates.get(key);
  if (template === undefined) {
    const built = tempDir('factory-template-', root => initRepo(root, files));
    process.once('exit', () => built[Symbol.dispose]());
    template = built.root;
    templates.set(key, template);
  }
  return template;
}

/** A temp git repository with a base commit of `files`, removed when the `using` scope that holds it ends. */
export function tempRepo(prefix: string, files: Record<string, string>) {
  return tempDir(prefix, root => cpSync(templateRepo(files), root, { recursive: true }));
}

/** A workspace on a temp repository, removed when the `using` scope that holds it ends. */
export function workspace(overrides: Partial<FactoryConfig> = {}): Workspace & Disposable {
  const repo = tempRepo('factory-', { 'README.md': 'base\n' });
  return {
    ...repo,
    config: {
      baseRef: 'main',
      branchPrefix: 'factory',
      // Passes only when the slice has committed a file named `ok`.
      checks: ['test -f ok'],
      checkPath: [],
      checkTimeoutMs: 10_000,
      factoryRepo: 'acme/factory',
      headless: parseConfig({}).headless,
      headlessMaxRounds: 3,
      maxRounds: 1,
      models: {},
      scratchDir: '.scratch',
      sliceTokenBudget: 1_000,
      trunk: 'main',
      ...overrides,
    },
  };
}

/** A check command that runs `guard` first, when given, and appends `label` to .git/check-runs (outside the working tree). */
export function countedCheck(label = 'run', guard = '') {
  return `${guard === '' ? '' : `${guard} && `}echo ${label} >> .git/check-runs`;
}

/** The labels counted checks logged, in run order. */
export function checkRuns(ws: Workspace) {
  return readFileSync(join(ws.root, '.git', 'check-runs'), 'utf8').split('\n').filter(Boolean);
}

export function slice(title: string, blockedBy: string[] = [], extra: Partial<SliceInput> = {}): SliceInput {
  return { acceptance: [`${title} works`], blockedBy, estimateTokens: 500, seams: ['cli'], title, whatToBuild: title, ...extra };
}

export function commit(ws: Workspace, file: string, content = 'x\n') {
  writeFileSync(join(ws.root, file), content);
  sh(ws.root, 'add', file);
  sh(ws.root, 'commit', '-qm', `add ${file}`);
  listInReport(ws);
}

/** Like an implementer that reports every commit of a fix round: lists HEAD in the active fix-phase slice's stored report. */
export function listInReport(ws: Workspace) {
  if (!existsSync(statePath(ws, 'demo'))) return;
  const slice = activeSlice(readRun(ws, 'demo'));
  if (slice?.phase !== 'fix') return;
  const path = reportPath(ws, 'demo', slice);
  const earlier = existsSync(path) ? /^- ([0-9a-f]{7,}) /gm : undefined;
  const shas = earlier === undefined ? [] : [...readFileSync(path, 'utf8').matchAll(earlier)].map(match => match[1]);
  const lines = [...shas, sh(ws.root, 'rev-parse', '--short=12', 'HEAD')].map(sha => `- ${sha} commit`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `Implementer report:\nCommits:\n${lines.join('\n')}\nFix file items:\n- none\nBehaviors:\n- none\nOpen:\n- none\n`);
}

export function finding(domain: Finding['domain'], severity: Finding['severity'], name: string): Finding {
  return { domain, fix: 'fix it', fix_prompt: 'fix it', id: `${domain}-${name}`, line: 1, path: 'ok', problem: 'wrong', severity, title: name, category: 'naming' as const };
}

export function start(ws: Workspace) {
  return startRun(ws, { feature: 'demo', sessionId: 's', source: { body: '', kind: 'text', ref: 'r', title: 'T' } });
}

export async function newRun(ws: Workspace, inputs: SliceInput[]) {
  await startRun(ws, {
    feature: 'demo',
    sessionId: 'session-1',
    source: { body: 'Do it', kind: 'text', ref: 'pasted', title: 'Demo' },
  });
  await withRun(ws, 'demo', run => approvePlan(ws, run, planSlices(ws, run, inputs)));
}

export const step = <T>(ws: Workspace, mutate: Parameters<typeof withRun<T>>[2]) => withRun(ws, 'demo', mutate);

/** The text of a review data file's `## <heading>` section, up to the next `## ` heading; '' when the section is absent. */
export function dataSection(dataFile: string, heading: string) {
  const data = readFileSync(dataFile, 'utf8');
  const marker = `## ${heading}\n\n`;
  const start = data.indexOf(marker);
  if (start === -1) return '';
  const rest = data.slice(start + marker.length);
  const next = rest.indexOf('\n## ');
  return next === -1 ? rest : rest.slice(0, next);
}

/** The FIX ITEMS section of a review data file. */
export const fixItems = (dataFile: string) => dataSection(dataFile, 'FIX ITEMS');

/** The fixItems a submission gives for a review that lists no fix items: [] for the scope domain, none for the others. */
export const noFixItems = (domain: Finding['domain']) => (domain === 'scope' ? { fixItems: [] } : {});

/**
 * Every reviewed domain submits (the given findings under their domains, the rest empty), then the validator keeps
 * `keep`. The scope domain gives `verdicts`, by default `fixed` for every fix item the review lists.
 */
export async function review(ws: Workspace, reviewId: string, findings: Finding[], keep = findings.map(item => item.id), verdicts?: FixVerdict[]) {
  const reviewed = readRun(ws, 'demo').slices.find(item => item.review?.id === reviewId);
  const skipped = reviewed?.review?.skipped ?? [];
  const fixVerdicts = verdicts ?? (reviewed?.fixItems ?? []).map(item => ({ id: item.id, reason: 'the diff fixes it', status: 'fixed' as const }));
  for (const domain of REVIEW_DOMAINS.filter(name => !skipped.some(entry => entry.domain === name))) {
    const own = findings.filter(item => item.domain === domain);
    await step(ws, run => submitDomain(ws, run, { agentId: `r-${domain}`, domain, findings: own, reviewId, ...(domain === 'scope' ? { fixItems: fixVerdicts } : {}) }));
  }
  const dropped = findings.filter(item => !keep.includes(item.id)).map(item => ({ id: item.id, reason: 'not in diff' }));
  await step(ws, run => submitValidation(ws, run, { agentId: 'validator', dropped, keep, reviewId }));
}

/** Takes a slice that commits `ok` to a green review with `findings` (default: one thermo naming observation). */
export async function greenWithObservation(ws: Workspace, findings: Finding[] = [finding('thermo', 'observation', 'naming')]) {
  await newRun(ws, [slice('Feature')]);
  await step(ws, run => nextSlice(ws, run));
  commit(ws, 'ok');
  await step(ws, run => runChecks(ws, run));
  const opened = await step(ws, run => startReview(ws, run));
  await review(ws, opened.reviewId, findings);
  assert.equal((await step(ws, run => recordReview(ws, run))).kind, 'green');
}

/** Leaves the active slice of the 'demo' run with one unplaced thermo observation whose finding id is `id`, as a kept observation of a recorded review would. */
export async function seedUnplacedObservation(ws: Workspace, id: string) {
  await step(ws, run => {
    const slice = activeSlice(run);
    assert.ok(slice, 'no active slice');
    const seeded = { ...finding('thermo', 'observation', 'naming'), id };
    slice.unplaced.push({ category: 'naming', finding: seeded, review: 'seeded' });
  });
}

/** Places the active slice's unplaced observations by their defaults, as factory_place with no exceptions does. */
export async function settleObservations(ws: Workspace) {
  await step(ws, run => placeObservationBatch(ws, run, planPlace(ws, run, { placements: [] })));
}

/** Takes the active slice from committed work to green. */
export async function green(ws: Workspace) {
  await step(ws, run => runChecks(ws, run));
  const { reviewId } = await step(ws, run => startReview(ws, run));
  await review(ws, reviewId, []);
  return step(ws, run => recordReview(ws, run));
}

/** The files `fakeGh` writes under its temp dir `root`, which both its gh script and its returned API use. */
const fakeGhFiles = (root: string) => ({ log: join(root, 'calls.log'), args: join(root, 'args.log'), fail: join(root, 'fail'), garble: join(root, 'garble') });

/** A fake `gh` first on PATH that logs each call, prints an issue URL numbered by the call, and fails the call whose number is in `fail`. */
export function fakeGh() {
  const dir = tempDir('factory-gh-', root => {
    const { log, args, fail, garble } = fakeGhFiles(root);
    writeFileSync(
      join(root, 'gh'),
      `#!/bin/sh\nif [ "$1 $2" != 'issue create' ]; then exit 0; fi\necho "$1 $2 $3 $4" >> '${log}'\necho "$@" >> '${args}'\nn=$(wc -l < '${log}' | tr -d ' ')\nif [ -f '${fail}' ] && [ "$n" = "$(cat '${fail}')" ]; then echo 'HTTP 502' >&2; exit 1; fi\nif [ -f '${garble}' ]; then echo 'created'; exit 0; fi\necho "https://github.com/o/r/issues/$n"\n`,
    );
    chmodSync(join(root, 'gh'), 0o755);
  });
  const { log, args, fail, garble } = fakeGhFiles(dir.root);
  const path = process.env.PATH;
  process.env.PATH = `${dir.root}:${path}`;
  return {
    args: () => (existsSync(args) ? readFileSync(args, 'utf8') : ''),
    calls: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []),
    failOn: (n: number) => writeFileSync(fail, String(n)),
    healed: () => writeFileSync(fail, '0'),
    garbled: () => writeFileSync(garble, ''),
    ungarbled: () => rmSync(garble),
    [Symbol.dispose]: () => {
      process.env.PATH = path;
      dir[Symbol.dispose]();
    },
  };
}

/** A done run of `count` chained slices, each with a reviewed commit, checked out on `main` (off the top slice). */
export async function submitDoneRun(ws: Workspace, count: number) {
  const titles = Array.from({ length: count }, (_, index) => `S${index + 1}`);
  await newRun(ws, titles.map((title, index) => slice(title, index === 0 ? [] : [titles[index - 1] ?? ''])));
  for (const [index] of titles.entries()) {
    await step(ws, run => nextSlice(ws, run));
    commit(ws, index === 0 ? 'ok' : `s${index + 1}.txt`);
    await green(ws);
    await step(ws, run => completeSlice(ws, run));
  }
  await step(ws, run => recordRetro(ws, run, parseRetro(ws, run, [])));
  sh(ws.root, 'switch', '-q', 'main');
  return readRun(ws, 'demo').slices.map(item => item.branch);
}

export const NO_STACK = { code: 2, stderr: '✗ no local or remote stack found for "$3"' };

export interface FakeGh {
  /** The stack `stack view --json` serves (a raw string is served as is); undefined means no stack. */
  stack: string[] | string | undefined;
  /** How `stack checkout` fails without a stack; by default gh-stack's real "no stack" exit and stderr. */
  checkoutFailure?: { code: number; stderr: string };
  /** Branches whose `stack checkout` fails as without a stack, though the served stack exists (a branch that is in no stack while another is); `stack add` takes a branch off this list. */
  unstacked?: string[];
  /** The subcommand (such as `stack submit`) that runs `onFail` and exits 1. */
  fail?: string;
  onFail?: string;
  /** A shell command run when `stack submit` succeeds. */
  onSubmit?: string;
  /** The stack `stack view --json` serves after `stack submit`, with each branch's PR number (none: no `pr`). */
  submitted?: { name: string; pr?: number }[];
}

/** The branches as a submitted stack, with PRs numbered from 101. */
export const withPrs = (branches: string[]) => branches.map((name, index) => ({ name, pr: 101 + index }));

/** The `gh api` call that sets the title and the body of PR 101 onwards (`demo: NN Sn`) in one PATCH; `calls()` abbreviates a body to `…`. */
export const prCalls = (count: number) =>
  Array.from({ length: count }, (_, index) => `api -X PATCH repos/{owner}/{repo}/pulls/${101 + index} -f title=demo: 0${index + 1} S${index + 1} -f body=…`);

/** The files `submitFakeGh` writes under its temp dir `dir`, which both its gh script and its returned API use. */
const submitGhFiles = (dir: string) => ({ log: join(dir, 'calls'), atSubmit: join(dir, 'at-submit.json') });

/**
 * Puts a fake `gh` first on PATH until the `using` scope that holds it ends, then removes it; it records each call.
 * With a stack, `stack checkout <branch>` switches to that branch, as gh-stack does; `stack init` switches to its last
 * (top) branch, `stack top` to the stack's top branch, and `stack add <branch>` to the branch it adds.
 */
export function submitFakeGh({ stack, checkoutFailure = NO_STACK, unstacked = [], fail = '', onFail = ':', onSubmit = ':', submitted }: FakeGh) {
  const temp = tempDir('factory-gh-', dir => {
    const { log } = submitGhFiles(dir);
    const view = join(dir, 'view.json');
    if (typeof stack === 'string') writeFileSync(view, stack);
    else if (stack !== undefined) {
      writeFileSync(view, JSON.stringify({ branches: stack.map(name => ({ name })), currentBranch: stack[0], trunk: 'main' }));
      writeFileSync(join(dir, 'top'), stack.at(-1) ?? '');
    }
    const loose = join(dir, 'unstacked');
    writeFileSync(loose, unstacked.map(name => `${name}\n`).join(''));
    const { atSubmit } = submitGhFiles(dir);
    // `stack add <branch>` appends the branch to the served stack, as gh-stack does, and the stack top moves to it.
    const append = `const f=require('fs');try{const v=JSON.parse(f.readFileSync('${view}','utf8'));v.branches.push({name:process.argv[1]});f.writeFileSync('${view}',JSON.stringify(v));f.writeFileSync('${join(dir, 'top')}',process.argv[1])}catch{}`;
    const after = join(dir, 'submitted.json');
    if (submitted !== undefined) {
      const items = submitted.map(({ name, pr }) => (pr === undefined ? { name } : { name, pr: { number: pr, url: `https://example.test/pull/${pr}`, state: 'OPEN' } }));
      writeFileSync(after, JSON.stringify({ branches: items, currentBranch: submitted.at(-1)?.name, trunk: 'main' }));
    }
    const script = [
      '#!/bin/sh',
      // A newline in an argument (a PR body) is logged as \\036, so each call stays one line.
      `printf '%s\\n' "$(printf '%s' "$*" | tr '\\n' '\\036')" >> '${log}'`,
      `if [ "$1 $2" = "stack checkout" ] && { [ ! -f '${view}' ] || grep -qx "$3" '${loose}'; }; then echo "${checkoutFailure.stderr}" >&2; exit ${checkoutFailure.code}; fi`,
      `if [ "$1 $2" = "stack checkout" ]; then git switch -q "$3" || exit 1; fi`,
      `if [ "$1 $2" = "stack view" ]; then cat '${view}' || exit 1; fi`,
      `if [ "$1 $2" = "stack init" ]; then eval "git switch -q \\"\\\${$#}\\"" || exit 1; fi`,
      `if [ "$1 $2" = "stack top" ]; then git switch -q "$(cat '${join(dir, 'top')}')" || exit 1; fi`,
      `if [ "$1 $2" = "stack add" ]; then git switch -q "$3" || exit 1; node -e "${append}" "$3"; grep -vx "$3" '${loose}' > '${loose}.tmp'; mv '${loose}.tmp' '${loose}'; fi`,
      `if [ "$1 $2" = '${fail}' ]; then ${onFail}; exit 1; fi`,
      `if [ "$1 $2" = "stack submit" ]; then ${onSubmit}; fi`,
      `if [ "$1 $2" = "stack submit" ]; then cp '${view}' '${atSubmit}'; fi`,
      `if [ "$1 $2" = "stack submit" ] && [ -f '${after}' ]; then cp '${after}' '${view}'; fi`,
      'exit 0',
      '',
    ].join('\n');
    writeFileSync(join(dir, 'gh'), script);
    chmodSync(join(dir, 'gh'), 0o755);
  });
  const dir = temp.root;
  const { log, atSubmit } = submitGhFiles(dir);
  process.env.PATH = `${dir}:${process.env.PATH}`;
  const raw = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(call => call.replaceAll('\x1e', '\n')) : []);
  return {
    calls: () => raw().map(call => call.replace(/ -f body=[\s\S]*/, ' -f body=…')),
    /** The branch names of the stack the last `stack submit` pushed (the served stack, with each `stack add` applied), bottom first. */
    stackAtSubmit: () => (JSON.parse(readFileSync(atSubmit, 'utf8')) as { branches: { name: string }[] }).branches.map(item => item.name),
    /** The body each PR (by number) was last given. */
    bodies: () => new Map(raw().map(call => /pulls\/(\d+) -f title=[^\n]* -f body=([\s\S]*)/.exec(call)).filter((match): match is RegExpExecArray => match !== null).map(match => [Number(match[1]), match[2] ?? ''] as const)),
    // Removes only this fake's PATH entry, so several fakes in one test clean up in any order.
    [Symbol.dispose]: () => {
      process.env.PATH = (process.env.PATH ?? '').split(':').filter(entry => entry !== dir).join(':');
      temp[Symbol.dispose]();
    },
  };
}

/** Puts `dir` first on PATH until the `using` scope that holds the result ends. It removes only that entry, so several PATH entries in one test clean up in any order. */
export function prependPath(dir: string) {
  process.env.PATH = `${dir}:${process.env.PATH}`;
  return { [Symbol.dispose]: () => void (process.env.PATH = (process.env.PATH ?? '').split(':').filter(entry => entry !== dir).join(':')) };
}

export interface IssueGh {
  /** The issues `gh issue view <ref>` serves, by issue number; a ref (number or URL) with no entry prints nothing. */
  issues: Record<string, unknown>;
  /** Shell patterns for the `gh api repos/<o>/<r>/issues/<n>` path (for example a slash then the number); an issue whose path matches one has author association OWNER, every other NONE. By default every issue is OWNER's. */
  owners?: string[];
  /** The shell command `gh repo view` runs; by default it prints `o/r`. */
  repoView?: string;
}

/** The file `issueGh` writes under its temp dir `root`. */
const issueGhFiles = (root: string) => ({ log: join(root, 'viewed') });

/**
 * Puts a fake `gh` first on PATH until the `using` scope that holds it ends: it serves `issue view`, the issue author association
 * (`api`) and `repo view`. `viewed()` lists the ref of each `issue view` call.
 */
export function issueGh({ issues, owners = ['*'], repoView = 'echo o/r' }: IssueGh) {
  const temp = tempDir('factory-fake-gh-', root => {
    const { log } = issueGhFiles(root);
    const cases = Object.entries(issues).map(([number, issue]) => `  ${number}) echo '${JSON.stringify(issue)}';;`).join('\n');
    const association = owners.length === 0 ? 'echo NONE' : `case "$2" in ${owners.join('|')}) echo OWNER;; *) echo NONE;; esac`;
    writeFileSync(
      join(root, 'gh'),
      `#!/bin/sh\nif [ "$1" = repo ]; then ${repoView}; exit 0; fi\nif [ "$1" = issue ]; then echo "$3" >> '${log}'; case "\${3##*/}" in\n${cases}\nesac; else ${association}; fi\n`,
    );
    chmodSync(join(root, 'gh'), 0o755);
  });
  const { log } = issueGhFiles(temp.root);
  const path = prependPath(temp.root);
  return {
    viewed: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []),
    [Symbol.dispose]: () => {
      path[Symbol.dispose]();
      temp[Symbol.dispose]();
    },
  };
}

export const CHECKS_OK = { 'demo.md': '# Demo\n\nDo it.\n', '.omp/factory.json': JSON.stringify({ baseRef: 'main', checks: ['test -f ok'] }) };
export type Reply = { content: { text: string }[] };

/** Runs run 'demo' through its one 'Feature' slice: approve the plan, take the slice, commit, run checks, review with `findings`, record, `beforeComplete`, then complete the slice. */
export async function completeFeatureSlice(ws: Workspace, findings: Parameters<typeof review>[2], beforeComplete?: () => Promise<void>) {
  await withRun(ws, 'demo', run => approvePlan(ws, run, planSlices(ws, run, [slice('Feature')])));
  await withRun(ws, 'demo', run => nextSlice(ws, run));
  commit(ws, 'ok');
  await withRun(ws, 'demo', run => runChecks(ws, run));
  const { reviewId } = await withRun(ws, 'demo', run => startReview(ws, run));
  await review(ws, reviewId, findings);
  await withRun(ws, 'demo', run => recordReview(ws, run));
  await beforeComplete?.();
  await withRun(ws, 'demo', run => completeSlice(ws, run));
}

/** A headless run with its one slice done, UI dialogs throwing, and the deferred sink `deferred`. With `deferEarlier`, the slice's green review lists one observation, deferred before the slice completes. */
export async function retroDoneRun(root: string, deferred: unknown, deferEarlier = false) {
  writeFileSync(join(root, '.omp/factory.json'), JSON.stringify({ baseRef: 'main', checks: ['test -f ok'], headless: { submission: 'stop' }, ...(deferred === undefined ? {} : { deferred }) }));
  sh(root, 'commit', '-qam', 'config', '--allow-empty');
  const commands = new Map<string, Command>();
  const tools = load({ commands, sent: [] });
  const noDialog = async (title: string) => {
    throw new Error(`dialog: ${title}`);
  };
  const caller = { ...ctx('main', 'main'), cwd: root, hasUI: true, sessionManager: { getSessionId: () => 'session' }, ui: { confirm: noDialog, notify() {}, select: noDialog } };
  const call = async (name: string, params: unknown) => (await tools.get(name)?.execute('id', params, undefined, undefined, caller)) as Reply;
  await commands.get('factory')?.handler('headless demo.md', caller);
  const ws: Workspace = { config: loadConfig(root), root };
  await completeFeatureSlice(ws, deferEarlier ? [finding('thermo', 'observation', 'naming')] : [], async () => {
    if (deferEarlier) await call('factory_defer', { observations: ['thermo-naming'] });
  });
  return { call, ws };
}

export const FINDINGS = [
  { action: 'apply', category: 'automated-checks', detail: 'Add a lint rule', severity: 'high', target: 'repo', title: 'Lint rule' },
  { action: 'file-issue', category: 'agents-md', detail: 'The skill is vague', severity: 'medium', target: 'factory', title: 'Vague skill' },
  { action: 'skip', category: 'automated-checks', detail: 'Minor', severity: 'low', target: 'repo', title: 'Minor thing' },
];

/** Runs the active Record slice through its fix budget with blocking findings, then a full review that is red too, so a headless run accepts it unresolved. */
export async function acceptUnresolved(ws: Workspace, call: (name: string, params: unknown) => Promise<Reply>, tag: string) {
  for (const round of ['one', 'two', 'three', 'four']) {
    commit(ws, 'ok', `${tag}${round}\n`);
    await withRun(ws, 'demo', run => runChecks(ws, run));
    const { reviewId } = await withRun(ws, 'demo', run => startReview(ws, run));
    await review(ws, reviewId, [finding('scope', 'high', 'a'), finding('bug', 'high', 'b')]);
    await call('factory_review_record', {});
  }
  await acceptFullUnresolved(ws, call);
}

/** After a targeted review accepted unresolved, runs the full review the slice still needs, red again with the budget spent, so it is accepted unresolved and the slice can complete. */
export async function acceptFullUnresolved(ws: Workspace, call: (name: string, params: unknown) => Promise<Reply>, findings = [finding('scope', 'high', 'a'), finding('bug', 'high', 'b')]) {
  const { reviewId } = await withRun(ws, 'demo', run => startReview(ws, run));
  await review(ws, reviewId, findings);
  return (await call('factory_review_record', {})).content[0]?.text ?? '';
}

/** Takes the next slice through checks and a green review listing `findings`, leaving it unfinished so the caller can defer before completeSlice. */
export const reviewActive = async (ws: Workspace, file: string, findings: ReturnType<typeof finding>[]) => {
  await withRun(ws, 'demo', run => nextSlice(ws, run));
  commit(ws, 'ok', `${file}\n`);
  await withRun(ws, 'demo', run => runChecks(ws, run));
  const { reviewId } = await withRun(ws, 'demo', run => startReview(ws, run));
  await review(ws, reviewId, findings);
  await withRun(ws, 'demo', run => recordReview(ws, run));
};

export const HEADLESS_FILES = { 'demo.md': '# Demo\n\nDo it.\n', '.omp/factory.json': JSON.stringify({ baseRef: 'main', checks: ['test -f ok'] }) };

/** A headless run planned with `titles` (each blocked by the one before), whose UI throws on any dialog; slice 01 is active with `ok` committed. */
export async function headlessSubmitRun(root: string, titles: string[], policy: Record<string, string> = {}, config: Record<string, unknown> = {}, submit?: typeof submitHeadless) {
  writeFileSync(join(root, '.omp/factory.json'), JSON.stringify({ baseRef: 'main', checks: ['test -f ok'], headless: policy, ...config }));
  sh(root, 'commit', '-qam', 'policy');
  const commands = new Map<string, Command>();
  const tools = load({ commands, sent: [], submit });
  const noDialog = async (title: string) => {
    throw new Error(`dialog: ${title}`);
  };
  const caller = { ...ctx('main', 'main'), cwd: root, hasUI: true, sessionManager: { getSessionId: () => 'session' }, ui: { confirm: noDialog, notify() {}, select: noDialog } };
  const call = async (name: string, params: unknown) => (await tools.get(name)?.execute('id', params, undefined, undefined, caller)) as Reply;
  await commands.get('factory')?.handler('headless demo.md', caller);
  const ws: Workspace = { config: loadConfig(root), root };
  await withRun(ws, 'demo', run => approvePlan(ws, run, planSlices(ws, run, titles.map((title, index) => slice(title, index === 0 ? [] : [titles[index - 1] ?? ''])))));
  await withRun(ws, 'demo', run => nextSlice(ws, run));
  commit(ws, 'ok');
  return { branches: readRun(ws, 'demo').slices.map(item => item.branch), call, ws };
}

/** Takes the active slice to a green review. */
export async function submitGreenWithObservation(ws: Workspace) {
  await withRun(ws, 'demo', run => runChecks(ws, run));
  const { reviewId } = await withRun(ws, 'demo', run => startReview(ws, run));
  await review(ws, reviewId, [finding('thermo', 'observation', 'naming')]);
  await withRun(ws, 'demo', run => recordReview(ws, run));
}