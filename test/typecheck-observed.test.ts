import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, it } from 'node:test';
import { ctx, type Handler, load } from './extension.ts';
import { tempRepo } from './helpers.ts';
import { loadConfig } from '../src/config.ts';
import { resetModuleState } from '../src/index.ts';
import { readRun, reportPath, withRun } from '../src/run.ts';
import { remapReportShas, storedBehaviors } from '../src/report.ts';

beforeEach(() => resetModuleState());

const TC = 'pnpm run typecheck';
const OBSERVED = (command: string, exit: number) => `- \`${command}\` → exit ${exit} (last unfiltered run the factory saw in this implementer session)`;
const NONE = (command: string) => `- no unfiltered run of \`${command}\` seen in this implementer session`;
const MISSING = (command: string) => `The factory saw no unfiltered run of \`${command}\` in this implementer session: run it as its own bash call with no filter, read its exit code, and call factory_implementer_report again.`;

async function started(checks: string[] = [TC, 'pnpm run test', 'pnpm run lint']) {
  const repo = tempRepo('factory-typecheck-', { 'README.md': 'base\n' });
  const { root } = repo;
  const handlers = new Map<string, Handler>();
  const tools = load({ handlers });
  const main = { ...ctx('main', 'main'), cwd: root, hasUI: true, sessionManager: { getSessionId: () => 'session' }, ui: { confirm: async () => true, editor: async () => checks.join('\n'), notify() {} } };
  const as = (kind: 'main' | 'sub', name: string) => ({ ...ctx(kind, name), cwd: root });
  const implementer = as('sub', 'factory-implementer');
  const text = async (name: string, params: unknown, caller: unknown) => {
    const result = (await tools.get(name)?.execute('id', params, undefined, undefined, caller)) as { content: { text: string }[] };
    return result.content.map(block => block.text).join('\n');
  };
  await text('factory_start', { feature: 'demo', source: { body: 'Do it', kind: 'text', ref: 'pasted', title: 'Demo' } }, main);
  const slice = { acceptance: ['works'], blockedBy: [], estimateTokens: 500, seams: [], noTestReason: 'refactor', title: 'Feature', whatToBuild: 'Feature' };
  await text('factory_plan', { baseRef: 'main', slices: [slice], trunk: 'main' }, main);
  await text('factory_next', {}, main);
  const ws = { config: loadConfig(root), root };
  const stored = () => readFileSync(reportPath(ws, 'demo', { id: '01' }), 'utf8');
  const bash = (caller: unknown, command: string, extra: Record<string, unknown> = {}) =>
    handlers.get('tool_result')?.({ content: [{ text: 'out', type: 'text' }], details: undefined, input: { command }, isError: false, toolCallId: 't', toolName: 'bash', type: 'tool_result', ...extra }, caller);
  const submit = () => text('factory_implementer_report', { behaviors: [{ behavior: 'b', seenRed: false, test: 't' }], checks: [], commits: [], open: [] }, implementer);
  const spawn = () => handlers.get('before_subagent_spawn')?.({ agent: 'factory-implementer', invocationKind: 'task', patterns: [], type: 'before_subagent_spawn' }, main);
  return { [Symbol.dispose]: () => repo[Symbol.dispose](), as, bash, implementer, main, root, spawn, stored, submit, ws };
}

const section = (report: string) => report.split('\n').slice(report.split('\n').indexOf('Factory-observed typecheck:'));

describe('factory-observed typecheck', () => {
  it('stores the observed line directly after Checks and replies with it; other checks get no line', async () => {
    using s = await started();
    await s.bash(s.implementer, TC);
    const reply = await s.submit();
    assert.ok(reply.split('\n').includes(OBSERVED(TC, 0)), reply);
    const lines = s.stored().split('\n');
    assert.deepEqual(lines.slice(lines.indexOf('Checks:'), lines.indexOf('Behaviors:')), ['Checks:', '- none', 'Factory-observed typecheck:', OBSERVED(TC, 0)]);
    assert.doesNotMatch(reply, /pnpm run (test|lint)/);
    assert.doesNotMatch(reply, /The factory saw no unfiltered run/);
  });

  it('shows the last run: a non-zero exit, then a later zero exit wins', async () => {
    using s = await started();
    await s.bash(s.implementer, TC, { details: { exitCode: 2 }, isError: true });
    await s.submit();
    assert.ok(s.stored().split('\n').includes(OBSERVED(TC, 2)));
    await s.bash(s.implementer, TC);
    await s.submit();
    assert.ok(s.stored().split('\n').includes(OBSERVED(TC, 0)));
  });

  it('counts a command with surrounding whitespace like the exact one', async () => {
    using s = await started();
    await s.bash(s.implementer, `  ${TC}\n`);
    await s.submit();
    assert.ok(s.stored().split('\n').includes(OBSERVED(TC, 0)));
  });

  it('reads the exit code of the echo suffix form, and does not count it without an exit line', async () => {
    using s = await started();
    await s.bash(s.implementer, `${TC}; echo "exit $?"`, { content: [{ text: 'ok\nexit 1', type: 'text' }] });
    await s.submit();
    assert.ok(s.stored().split('\n').includes(OBSERVED(TC, 1)));
    await s.spawn();
    await s.bash(s.implementer, `${TC}; echo "exit $?"`, { content: [{ text: 'ok\nexit code 1', type: 'text' }] });
    const reply = await s.submit();
    assert.ok(s.stored().split('\n').includes(NONE(TC)));
    assert.ok(reply.split('\n').includes(MISSING(TC)), reply);
  });

  for (const command of [`${TC} > /dev/null`, `${TC} 2>&1 | tail -5`, `cd x && ${TC}`, `${TC}; true`]) {
    it(`does not count \`${command}\`, and still stores the report`, async () => {
      using s = await started();
      await s.bash(s.implementer, command);
      const reply = await s.submit();
      assert.deepEqual(section(s.stored()).slice(0, 2), ['Factory-observed typecheck:', NONE(TC)]);
      assert.ok(reply.split('\n').includes(MISSING(TC)), reply);
      assert.match(reply, /^Stored the report/);
    });
  }

  it('counts only bash results of the implementer session', async () => {
    using s = await started();
    await s.bash(s.as('main', 'main'), TC);
    await s.bash(s.as('sub', 'factory-reviewer'), TC);
    await s.bash(s.as('sub', 'advisor'), TC);
    await s.bash(s.implementer, TC, { toolName: 'read' });
    await s.submit();
    assert.deepEqual(section(s.stored()).slice(0, 2), ['Factory-observed typecheck:', NONE(TC)]);
  });

  it('does not count a result moved to a background job or one that timed out', async () => {
    using s = await started();
    await s.bash(s.implementer, TC, { details: { async: { jobId: 'bg_1', state: 'running', type: 'bash' }, timeoutSeconds: 60 } });
    await s.bash(s.implementer, TC, { details: { timedOut: true }, isError: true });
    await s.submit();
    assert.deepEqual(section(s.stored()).slice(0, 2), ['Factory-observed typecheck:', NONE(TC)]);
  });

  it('counts runs per implementer session: a spawn drops earlier runs, a repeat report keeps them', async () => {
    using s = await started();
    await s.bash(s.implementer, TC);
    await s.spawn();
    await s.submit();
    assert.deepEqual(section(s.stored()).slice(0, 2), ['Factory-observed typecheck:', NONE(TC)]);
    await s.bash(s.implementer, TC);
    await s.submit();
    assert.ok(s.stored().split('\n').includes(OBSERVED(TC, 0)));
    const again = await s.submit();
    assert.ok(again.split('\n').includes(OBSERVED(TC, 0)), again);
  });

  it('has one line per typecheck command in check order, and no section when no check is a typecheck', async () => {
    {
      using s = await started(['pnpm run typecheck:web', 'true', 'pnpm run typecheck']);
      await s.bash(s.implementer, 'pnpm run typecheck');
      await s.submit();
      assert.deepEqual(section(s.stored()).slice(0, 3), ['Factory-observed typecheck:', NONE('pnpm run typecheck:web'), OBSERVED('pnpm run typecheck', 0)]);
    }
    using none = await started(['true']);
    await none.bash(none.implementer, 'true');
    const reply = await none.submit();
    assert.doesNotMatch(none.stored(), /Factory-observed typecheck/);
    assert.doesNotMatch(reply, /Factory-observed typecheck|The factory saw no unfiltered run/);
  });

  it('does nothing outside a run or without an active slice, and never throws', async () => {
    const handlers = new Map<string, Handler>();
    load({ handlers });
    using plain = tempRepo('factory-typecheck-plain-', { 'README.md': 'x\n' });
    const event = { content: [], details: undefined, input: { command: TC }, isError: false, toolName: 'bash', type: 'tool_result' };
    assert.equal(await handlers.get('tool_result')?.(event, { ...ctx('sub', 'factory-implementer'), cwd: plain.root }), undefined);
    assert.equal(await handlers.get('tool_result')?.(event, { ...ctx('sub', 'factory-implementer'), cwd: '/' }), undefined);
    using s = await started();
    // No active slice: the slice is done or pending; simulate by a run whose slice is not active.
    await withRun(s.ws, 'demo', run => { run.slices[0]!.status = 'pending'; });
    assert.equal(await s.bash(s.implementer, TC), undefined);
    assert.equal(readRun(s.ws, 'demo').slices[0]?.typecheckRuns, undefined);
  });

  it('keeps the section out of the review behaviors and unchanged by remapReportShas', async () => {
    using s = await started();
    await s.bash(s.implementer, TC);
    await s.submit();
    const before = s.stored();
    const run = readRun(s.ws, 'demo');
    assert.equal(remapReportShas(s.ws, run, run.slices[0]!, []), true);
    assert.equal(s.stored(), before);
    assert.deepEqual(storedBehaviors(s.ws, run, run.slices[0]!), ['t → b (seen red: no)']);
  });
});
