// Tests never read the developer's git config (signing, hooks, default branch).
// Import this first in every test file: src/exec.ts copies process.env when it loads, so the override must come before any src module.
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
