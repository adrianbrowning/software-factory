import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, posix } from 'node:path';
import { z } from 'zod';

export const CONFIG_PATH = '.omp/factory.json';
const DEFAULT_CHECK_SCRIPTS = ['lint', 'typecheck', 'test'];
/** Script names that look like a check, offered at setup but not chosen by default. */
const CHECK_LIKE_SCRIPT = /^(build|check|e2e|format|lint|test|type-?check|types|validate|verify)(:|$)/;
const MUTATING_SCRIPT = /watch|fix|write/;
const INSTALL_COMMAND = /^(npm|pnpm|yarn|bun)\s+(ci|i|install)\b/;

const text = z.string().min(1);
const positiveInt = z.number().int().positive();

const configSchema = z
  .object({
    /** Ref the first slice branches from. */
    baseRef: text.default('origin/main'),
    branchPrefix: text.default('factory'),
    /** Checks a new run starts with, in order. Unset: the first run asks the user and saves the choice in `scratchDir`. */
    checks: z.array(text).min(1).optional(),
    checkTimeoutMs: positiveInt.default(10 * 60 * 1_000),
    /** Repository that receives retro findings about the factory itself. */
    factoryRepo: text.default('adrianbrowning/software-factory'),
    /** Fix rounds a slice gets before it stalls for a user decision; each "continue" grants this many more. */
    maxRounds: positiveInt.default(3),
    /** Run state directory, relative to the repository root. Kept out of git via info/exclude. */
    scratchDir: text.default('.scratch'),
    /**
     * Max estimated implementer context per slice: larger estimates are rejected at plan time, and a measured
     * peak above it is flagged for the retro. Default: 40% of a 1M window.
     */
    sliceTokenBudget: positiveInt.default(400_000),
    /** Trunk branch the stack is based on when submitted. Defaults to `baseRef` without its remote (resolved with git). */
    trunk: text.optional(),
  })
  .strict();

export type FactoryConfig = z.infer<typeof configSchema>;

const manifestSchema = z.object({
  packageManager: z.string().optional(),
  scripts: z.record(z.string(), z.unknown()).optional(),
});

function packageManager(cwd: string, declared: string | undefined) {
  const name = declared?.split('@')[0];
  if (name === 'pnpm' || name === 'yarn' || name === 'bun' || name === 'npm') return name;
  if (existsSync(join(cwd, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(cwd, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(cwd, 'bun.lock')) || existsSync(join(cwd, 'bun.lockb'))) return 'bun';
  return 'npm';
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`${path}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
}

function readManifest(cwd: string) {
  const path = join(cwd, 'package.json');
  if (!existsSync(path)) return undefined;
  const manifest = manifestSchema.parse(readJson(path));
  const pm = packageManager(cwd, manifest.packageManager);
  const scripts = Object.keys(manifest.scripts ?? {}).filter(name => typeof manifest.scripts?.[name] === 'string');
  return { pm, scripts };
}

/** `lint`, `typecheck`, `test` scripts from package.json, in that order, run with the repo's package manager. */
export function detectChecks(cwd: string) {
  const manifest = readManifest(cwd);
  if (manifest === undefined) return [];
  return DEFAULT_CHECK_SCRIPTS.filter(name => manifest.scripts.includes(name)).map(name => `${manifest.pm} run ${name}`);
}

/** A script line whose effect reaches later lines (control flow, directory, environment), so no line stands alone. */
const STATEFUL_LINE = /^(if|then|else|elif|fi|for|while|until|do|done|case|esac|function|cd|pushd|popd|export|source|set|unset|\.|\{|\}|\(|\))(\s|;|$)|^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Shell commands of the `run:` steps in one GitHub Actions workflow: inline values, and each line of a `|` block
 * (a `>` block folds into one command). Lines that end in `\` continue on the next line. A block with control flow,
 * a directory change, or variable setup gives no suggestions, since none of its lines runs alone.
 */
export function runCommands(yaml: string) {
  const lines = yaml.split('\n');
  const commands: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(\s*)(?:-\s+)?run:\s*(.*?)\s*$/.exec(lines[index] ?? '');
    if (match === null) continue;
    const [, indent = '', value = ''] = match;
    if (!/^[|>][-+0-9]*$/.test(value)) {
      if (value !== '' && !value.startsWith('#')) commands.push(value.replace(/^(['"])(.*)\1$/, '$2'));
      continue;
    }
    const block: string[] = [];
    while (index + 1 < lines.length) {
      const next = lines[index + 1] ?? '';
      if (next.trim() !== '' && next.length - next.trimStart().length <= indent.length) break;
      block.push(next.trim());
      index += 1;
    }
    const body = value.startsWith('>') ? [block.filter(Boolean).join(' ')] : block;
    const script: string[] = [];
    let pending = '';
    for (const line of body) {
      if (line === '' || line.startsWith('#')) continue;
      if (line.endsWith('\\')) {
        pending += `${line.slice(0, -1).trimEnd()} `;
        continue;
      }
      script.push(pending + line);
      pending = '';
    }
    if (pending !== '') script.push(pending.trimEnd());
    commands.push(...(script.some(line => STATEFUL_LINE.test(line)) ? [] : script));
  }
  return commands;
}

/** `run:` commands from the GitHub Actions workflows, without dependency installs. */
function workflowCommands(cwd: string) {
  const dir = join(cwd, '.github', 'workflows');
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter(name => /\.ya?ml$/.test(name)).sort();
  return files.flatMap(name => runCommands(readFileSync(join(dir, name), 'utf8'))).filter(command => !INSTALL_COMMAND.test(command));
}

export type CheckSuggestions = {
  /** Run unless the user removes them: the configured checks, or the lint/typecheck/test scripts. */
  chosen: string[];
  /** Other check-like package.json scripts, and CI commands that no script suggestion already covers. */
  scripts: string[];
  workflows: string[];
};

export function suggestChecks(cwd: string, config: Pick<FactoryConfig, 'checks'>): CheckSuggestions {
  const chosen = config.checks ?? detectChecks(cwd);
  const manifest = readManifest(cwd);
  const scriptCommands = (manifest?.scripts ?? [])
    .filter(name => CHECK_LIKE_SCRIPT.test(name) && !MUTATING_SCRIPT.test(name))
    .map(name => ({ command: `${manifest?.pm} run ${name}`, short: `${manifest?.pm} ${name}` }));
  const scripts = scriptCommands.map(entry => entry.command).filter(command => !chosen.includes(command));
  const covered = new Set([...chosen, ...scriptCommands.flatMap(entry => [entry.command, entry.short])]);
  const workflows = [...new Set(workflowCommands(cwd))].filter(command => !covered.has(command));
  return { chosen, scripts, workflows };
}

/** Editor text for the setup dialog: chosen checks as lines, other suggestions commented out. */
export function checksPrompt(suggestions: CheckSuggestions) {
  const section = (title: string, commands: string[]) => (commands.length === 0 ? [] : ['', `# ${title}:`, ...commands.map(command => `# ${command}`)]);
  return [
    '# One check command per line. They run in this order before each review, and every one must pass.',
    '# Lines that start with # are ignored: uncomment a suggestion to run it.',
    ...suggestions.chosen,
    ...section('Other package.json scripts', suggestions.scripts),
    ...section('Commands from .github/workflows', suggestions.workflows),
  ].join('\n');
}

export function parseChecks(text: string) {
  return text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '' && !line.startsWith('#'));
}

function normalizeScratchDir(value: string) {
  const normalized = posix.normalize(value.replaceAll('\\', '/')).replace(/^\.\//, '').replace(/\/+$/, '');
  if (isAbsolute(normalized) || normalized === '.' || normalized.split('/').includes('..')) {
    throw new Error(`${CONFIG_PATH}: "scratchDir" must be a directory inside the repository`);
  }
  return normalized;
}

export function loadConfig(cwd: string): FactoryConfig {
  const path = join(cwd, CONFIG_PATH);
  const parsed = configSchema.safeParse(existsSync(path) ? readJson(path) : {});
  if (!parsed.success) throw new Error(`${CONFIG_PATH}: ${z.prettifyError(parsed.error)}`);
  return { ...parsed.data, scratchDir: normalizeScratchDir(parsed.data.scratchDir) };
}
