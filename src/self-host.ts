import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addEvent, type Run } from './run.ts';

/** The checkout omp loaded this extension from, taken from this module's own location. */
export const LOADED_PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The directories whose code omp loads once: tools and gates in src/, agent definitions in agents/. Skills and review references are read from disk each time. */
const LOADED_DIRS = ['src', 'agents'];

export type LoadedPlugin = { hashes: Record<string, string>; root: string };

/** A content hash per file under src/ and agents/ of `root`, keyed by path relative to `root`: committed, checked-out and uncommitted edits alike, because it reads the files on disk. */
export function pluginHashes(root: string) {
  const hashes: Record<string, string> = {};
  for (const dir of LOADED_DIRS) {
    let entries;
    try {
      entries = readdirSync(join(root, dir), { recursive: true, withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const file = join(entry.parentPath, entry.name);
      hashes[relative(root, file).split(sep).join('/')] = createHash('sha256').update(readFileSync(file)).digest('hex');
    }
  }
  return hashes;
}

/** The plugin as it was when this module loaded: the checkout and its per-file hashes, which later tool calls compare against. */
const INITIAL_LOADED_PLUGIN: LoadedPlugin = { hashes: pluginHashes(LOADED_PLUGIN_ROOT), root: LOADED_PLUGIN_ROOT };
let loadedPlugin = INITIAL_LOADED_PLUGIN;
/** Test-only: replaces the loaded plugin that tool calls compare against; no argument restores the one taken at module load. */
export function setLoadedPlugin(plugin: LoadedPlugin = INITIAL_LOADED_PLUGIN) {
  loadedPlugin = plugin;
}

/** Files changed from `base` to HEAD in `root`, or undefined when `base` does not resolve. */
function changedSince(root: string, base: string) {
  try {
    const out = execFileSync('git', ['diff', '--name-only', '--no-renames', '-z', `${base}..HEAD`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return new Set(out.split('\0').filter(Boolean));
  } catch {
    return undefined;
  }
}

/** The content hash of `path` at commit `base`, or undefined when the file is absent there. */
function hashAtBase(root: string, base: string, path: string) {
  try {
    return createHash('sha256').update(execFileSync('git', ['show', `${base}:${path}`], { cwd: root, maxBuffer: Infinity, stdio: ['ignore', 'pipe', 'ignore'] })).digest('hex');
  } catch {
    return undefined;
  }
}

const MAX_LISTED = 5;

const real = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

function isPluginRepo(root: string) {
  const file = join(root, 'package.json');
  if (!existsSync(file)) return false;
  try {
    const pkg: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return typeof pkg === 'object' && pkg !== null && 'name' in pkg && pkg.name === 'software-factory';
  } catch {
    return false;
  }
}

/**
 * The warning for a run whose repository is the software-factory plugin, or undefined when there is nothing to warn about:
 * omp loaded the plugin from another checkout, or from this one while src/ or agents/ files differ from the loaded
 * content, comparing each file with the loaded content: a file the commits from `base` to HEAD changed is compared as it was
 * at `base` (absent there counts as absent), any other file as it is on disk (every file is compared on disk when `base` is
 * undefined or does not resolve). It never refuses:
 * callers add it to a reply and a run event.
 */
export function selfHostWarning(repoRoot: string, loaded: LoadedPlugin = loadedPlugin, base?: string) {
  if (!isPluginRepo(repoRoot)) return undefined;
  if (real(repoRoot) !== real(loaded.root)) {
    return `This run's repository ${repoRoot} is the software-factory plugin, but omp loaded the plugin from ${loaded.root}. The run's gates, agents and references come from the loaded checkout, not from the code the run changes.`;
  }
  const now = pluginHashes(loaded.root);
  const own = base === undefined ? undefined : changedSince(repoRoot, base);
  const ownLoaded = [...own ?? []].filter(file => LOADED_DIRS.some(dir => file.startsWith(`${dir}/`)));
  const stale = [...new Set([...Object.keys(now), ...Object.keys(loaded.hashes), ...ownLoaded])]
    .filter(file => (own?.has(file) ? hashAtBase(repoRoot, base ?? '', file) : now[file]) !== loaded.hashes[file])
    .sort();
  if (stale.length === 0) return undefined;
  const listed = stale.slice(0, MAX_LISTED).join(', ') + (stale.length > MAX_LISTED ? ` and ${stale.length - MAX_LISTED} more (set ${createHash('sha256').update(stale.join('\n')).digest('hex').slice(0, 7)})` : '');
  return `This run's repository ${repoRoot} is the loaded software-factory plugin, and these src/ or agents/ files changed since omp loaded it, outside the run's own commits: ${listed}. The loaded gates are stale. An interactive run can start a new omp session to load them; a headless run goes on with the loaded gates and needs no action.`;
}

/** Records the self-host warning for `repoRoot` as a 'warning' run event and returns the reply line for it, or '' when there is none or the run already has a 'warning' event with the same text. */
export function recordSelfHostWarning(run: Run, repoRoot: string) {
  const warning = selfHostWarning(repoRoot, undefined, run.baseSha ?? run.baseRef);
  if (warning === undefined || run.events.some(event => event.kind === 'warning' && event.detail === warning)) return '';
  addEvent(run, 'warning', warning);
  return `\nWarning: ${warning}`;
}
