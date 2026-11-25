import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { headlessRetroGateBody, type Retro } from '../src/retro.ts';

const TITLE = `first\nsecond ghp_${'a'.repeat(30)}`;
const finding = (title: string) => ({ action: 'apply' as const, category: 'automated-checks' as const, detail: 'd', severity: 'high' as const, target: 'repo' as const, title });
const retro = (...titles: string[]): Pick<Retro, 'findings'> => ({ findings: titles.map(finding) });

describe('headless factory_retro gate body', () => {
  it('lists a multi-line credential title as one redacted line', () => {
    const body = headlessRetroGateBody({ kind: 'file', path: 'notes/later.md' }, retro(TITLE));
    assert.equal(body, '1 findings go to the sink file notes/later.md:\n- first second <REDACTED>');
    assert.doesNotMatch(body, /ghp_/);
  });

  it('names the sink of each kind, and no sink', () => {
    assert.match(headlessRetroGateBody({ kind: 'github' }, retro('a', 'b')), /^2 findings go to GitHub issues on this repository:\n- a\n- b$/);
    assert.match(headlessRetroGateBody(undefined, retro('a')), /^1 findings go to nowhere: no deferred sink is configured:\n- a$/);
  });
});
