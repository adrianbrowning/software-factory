// Tests never read the developer's git config (signing, hooks, default branch).
// The test script preloads this with --import, so it runs before any test file and every git call (helpers.ts sh(), src/exec.ts) inherits the override. Test files do not import it.
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
