import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type FactoryConfig = {
  /** Ref the first slice branches from. */
  baseRef: string;
  branchPrefix: string;
  /** Deterministic checks, run in order; every one must pass. */
  checks: string[];
  checkTimeoutMs: number;
  /** Repository that receives retro findings about the factory itself. */
  factoryRepo: string;
  /** Fix rounds (failed checks or blocking review) allowed per slice before the run stalls. */
  maxRounds: number;
  /** Run state directory, relative to the repository root. Kept out of git via info/exclude. */
  scratchDir: string;
  /** Upper bound on one implementer's context per slice: 40% of a 1M window. */
  sliceTokenBudget: number;
  /** Trunk branch the stack is based on when submitted. */
  trunk: string;
};

export const CONFIG_PATH = '.omp/factory.json';
const CHECK_SCRIPTS = ['lint', 'typecheck', 'test'];

function packageManager(cwd: string, declared: unknown) {
  if (typeof declared === 'string') {
    const name = declared.split('@')[0];
    if (name === 'pnpm' || name === 'yarn' || name === 'bun' || name === 'npm') return name;
  }
  if (existsSync(join(cwd, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(cwd, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(cwd, 'bun.lock')) || existsSync(join(cwd, 'bun.lockb'))) return 'bun';
  return 'npm';
}

/** `lint`, `typecheck`, `test` scripts from package.json, in that order, run with the repo's package manager. */
export function detectChecks(cwd: string) {
  const path = join(cwd, 'package.json');
  if (!existsSync(path)) return [];
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as { packageManager?: unknown; scripts?: Record<string, unknown> };
  const pm = packageManager(cwd, manifest.packageManager);
  return CHECK_SCRIPTS.filter(name => typeof manifest.scripts?.[name] === 'string').map(name => `${pm} run ${name}`);
}

function expect<T>(value: unknown, key: string, valid: (v: unknown) => v is T): T | undefined {
  if (value === undefined) return undefined;
  if (!valid(value)) throw new Error(`${CONFIG_PATH}: invalid "${key}"`);
  return value;
}

const isString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isPositiveInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;
const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.every(isString);

export function loadConfig(cwd: string): FactoryConfig {
  const path = join(cwd, CONFIG_PATH);
  const raw = existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>) : {};
  const baseRef = expect(raw.baseRef, 'baseRef', isString) ?? 'origin/main';
  const checks = expect(raw.checks, 'checks', isStringList) ?? detectChecks(cwd);
  if (checks.length === 0) {
    throw new Error(`No checks found. Add lint/typecheck/test scripts to package.json or set "checks" in ${CONFIG_PATH}.`);
  }
  return {
    baseRef,
    branchPrefix: expect(raw.branchPrefix, 'branchPrefix', isString) ?? 'factory',
    checks,
    checkTimeoutMs: expect(raw.checkTimeoutMs, 'checkTimeoutMs', isPositiveInt) ?? 10 * 60 * 1_000,
    factoryRepo: expect(raw.factoryRepo, 'factoryRepo', isString) ?? 'adrianbrowning/software-factory',
    maxRounds: expect(raw.maxRounds, 'maxRounds', isPositiveInt) ?? 3,
    scratchDir: expect(raw.scratchDir, 'scratchDir', isString) ?? '.scratch',
    sliceTokenBudget: expect(raw.sliceTokenBudget, 'sliceTokenBudget', isPositiveInt) ?? 400_000,
    trunk: expect(raw.trunk, 'trunk', isString) ?? baseRef.replace(/^origin\//, ''),
  };
}
