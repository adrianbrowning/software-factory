import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addEvent, type Run } from './run.ts';

/** The checkout omp loaded this extension from, taken from this module's own location. */
export const LOADED_PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The directories whose code omp loads once: tools and gates in src/, agent definitions in agents/. Skills and review references are read from disk each time. */
const LOADED_DIRS = ['src', 'agents'];

export type LoadedPlugin = { digest: string; root: string };

/** A content digest of every file under src/ and agents/ of `root`: committed, checked-out and uncommitted edits alike, because it reads the files on disk. */
export function pluginDigest(root: string) {
  const hash = createHash('sha256');
  const files = LOADED_DIRS.flatMap(dir => {
    try {
      return readdirSync(join(root, dir), { recursive: true, withFileTypes: true })
        .filter(entry => entry.isFile())
        .map(entry => join(entry.parentPath, entry.name));
    } catch {
      return [];
    }
  }).sort();
  for (const file of files) hash.update(`${relative(root, file)}\0`).update(readFileSync(file)).update('\0');
  return hash.digest('hex');
}

/** The plugin as it was when this module loaded: the checkout and its digest, which later tool calls compare against. */
const INITIAL_LOADED_PLUGIN: LoadedPlugin = { digest: pluginDigest(LOADED_PLUGIN_ROOT), root: LOADED_PLUGIN_ROOT };
let loadedPlugin = INITIAL_LOADED_PLUGIN;
/** Test-only: replaces the loaded plugin that tool calls compare against; no argument restores the one taken at module load. */
export function setLoadedPlugin(plugin: LoadedPlugin = INITIAL_LOADED_PLUGIN) {
  loadedPlugin = plugin;
}

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
 * omp loaded the plugin from another checkout, or from this one before its src/ or agents/ changed. It never refuses:
 * callers add it to a reply and a run event.
 */
export function selfHostWarning(repoRoot: string, loaded: LoadedPlugin = loadedPlugin) {
  if (!isPluginRepo(repoRoot)) return undefined;
  if (real(repoRoot) !== real(loaded.root)) {
    return `This run's repository ${repoRoot} is the software-factory plugin, but omp loaded the plugin from ${loaded.root}. The run's gates, agents and references come from the loaded checkout, not from the code the run changes.`;
  }
  if (pluginDigest(loaded.root) === loaded.digest) return undefined;
  return `This run's repository ${repoRoot} is the loaded software-factory plugin, and its src/ or agents/ changed since omp loaded it. The loaded gates are stale: start a new omp session to run with the new gates.`;
}

/** Records the self-host warning for `repoRoot` as a 'warning' run event and returns the reply line for it, or '' when there is none. */
export function recordSelfHostWarning(run: Run, repoRoot: string) {
  const warning = selfHostWarning(repoRoot);
  if (warning === undefined) return '';
  addEvent(run, 'warning', warning);
  return `\nWarning: ${warning}`;
}
