// Tests never read the developer's git config (signing, hooks, default branch).
// The test script preloads this with --import, before any test file: src/exec.ts copies process.env when it loads,
// so the override must come before any src module. Test files do not import it.
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
