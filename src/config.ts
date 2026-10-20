import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, posix } from 'node:path';
import { z } from 'zod';

export const CONFIG_PATH = '.omp/factory.json';
const CHECK_SCRIPTS = ['lint', 'typecheck', 'test'];

const text = z.string().min(1);
const positiveInt = z.number().int().positive();

const configSchema = z
  .object({
    /** Ref the first slice branches from. */
    baseRef: text.default('origin/main'),
    branchPrefix: text.default('factory'),
    /** Deterministic checks, run in order; every one must pass. Defaults to the package.json scripts. */
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
    /** Trunk branch the stack is based on when submitted. Defaults to `baseRef` without its remote. */
    trunk: text.optional(),
  })
  .strict();

export type FactoryConfig = Omit<z.infer<typeof configSchema>, 'checks' | 'trunk'> & { checks: string[]; trunk: string };

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

/** `lint`, `typecheck`, `test` scripts from package.json, in that order, run with the repo's package manager. */
export function detectChecks(cwd: string) {
  const path = join(cwd, 'package.json');
  if (!existsSync(path)) return [];
  const manifest = manifestSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  const pm = packageManager(cwd, manifest.packageManager);
  return CHECK_SCRIPTS.filter(name => typeof manifest.scripts?.[name] === 'string').map(name => `${pm} run ${name}`);
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
  const parsed = configSchema.safeParse(existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {});
  if (!parsed.success) throw new Error(`${CONFIG_PATH}: ${z.prettifyError(parsed.error)}`);
  const { checks: configured, trunk, ...config } = parsed.data;
  const checks = configured ?? detectChecks(cwd);
  if (checks.length === 0) {
    throw new Error(`No checks found. Add lint/typecheck/test scripts to package.json or set "checks" in ${CONFIG_PATH}.`);
  }
  return {
    ...config,
    checks,
    scratchDir: normalizeScratchDir(config.scratchDir),
    trunk: trunk ?? config.baseRef.replace(/^[^/]+\//, ''),
  };
}
