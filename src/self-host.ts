import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The checkout omp loaded this extension from, taken from this module's own location. */
export const LOADED_PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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
 * The warning for a run whose repository is the software-factory plugin while omp loaded the plugin from another
 * checkout, or undefined when there is nothing to warn about. It never refuses: callers add it to a reply and a run event.
 */
export function selfHostWarning(repoRoot: string, loadedPlugin: string = LOADED_PLUGIN_ROOT) {
  if (!isPluginRepo(repoRoot) || real(repoRoot) === real(loadedPlugin)) return undefined;
  return `This run's repository ${repoRoot} is the software-factory plugin, but omp loaded the plugin from ${loadedPlugin}. The run's gates, agents and references come from the loaded checkout, not from the code the run changes.`;
}
