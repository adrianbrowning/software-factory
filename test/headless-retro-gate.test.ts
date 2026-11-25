import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

const TITLE = `first\nsecond ghp_${'a'.repeat(30)}`;

describe('headless factory_retro gate', () => {
  it('lists a multi-line credential title as one redacted line in the gate body', async () => {
    const bodies: string[] = [];
    const real = await import('../src/gates.ts');
    mock.module('../src/gates.ts', {
      exports: {
        ...real,
        gate: async (_ctx: unknown, _ws: unknown, _feature: string, _name: string, _title: string, body: string) => {
          bodies.push(body);
          return true;
        },
      },
    });
    const { CHECKS_OK, retroDoneRun, tempRepo } = await import('./helpers.ts');
    using repo = tempRepo('factory-retro-gate-', CHECKS_OK);
    const { call } = await retroDoneRun(repo.root, { kind: 'file', path: 'notes/later.md' });
    await call('factory_retro', { findings: [{ action: 'apply', category: 'automated-checks', detail: 'd', severity: 'high', target: 'repo', title: TITLE }] });
    assert.match(bodies.at(-1) ?? '', /^- first second <REDACTED>$/m);
  });
});
