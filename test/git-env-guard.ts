/** The message when `env` shows the test/git-env.ts preload did not run, else undefined. Only the two variables that keep the user's git config out are checked. */
export function gitEnvPreloadProblem(env: NodeJS.ProcessEnv): string | undefined {
  if (env.GIT_CONFIG_GLOBAL === '/dev/null' && env.GIT_CONFIG_NOSYSTEM === '1') return undefined;
  return 'test/git-env.ts did not run first, so tests could read your git config. Run the file with `sh scripts/test.sh <file>` or `pnpm run test <file>`, not a raw `node --test`.';
}

const problem = gitEnvPreloadProblem(process.env);
if (problem !== undefined) throw new Error(problem);
