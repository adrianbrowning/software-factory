# Coding Standards

Reviewers check every change against these rules. `test/structure.test.ts` checks that the backticked `src/` paths and camelCase names in this file still exist; a paragraph marked "past history" is exempt.

## omp event hooks

The handlers for `before_subagent_spawn`, `turn_end`, `tool_result` and `session_stop` run in every omp session, not only in a factory run.

- Outside a factory run, a hook does nothing and never throws. Outside a factory run means the repo has no remembered run: a cwd outside any git repo, a missing or broken factory.json, or no factory_start or resume. A paused or done run is still a factory run. `turn_end` still records a child's actual model and thinking level on its first turn while the run is remembered (decision 14), and `before_subagent_spawn` still routes or blocks factory-role spawns from the run snapshot. Only `scout` (explorer) spawns go unrouted unless the run is in intake or running (decisions 5 and 12).
- A hook finds the active run through the workspace the run remembers from factory_start or resume. It never reloads factory.json, so a mid-run edit cannot change a running run.
- When a factory-role spawn cannot be routed (its model no longer resolves, or the run state cannot be read), the hook blocks the spawn with a reason that names the role. It never drops the routing in silence.

## Module state in tests

`src/index.ts` and `src/agents.ts` keep run state at module level, and every test in a file shares it. Every test file that loads the extension calls `resetModuleState()` in a `beforeEach` hook, so each test starts with no runs, stop attempts, cached roots or audited sessions, and passes or fails on its own state alone. Never reset inside a fixture: a second fixture call in the same test must keep the runs the first one started.

## No module mocking in tests

Tests never call `mock.module` (or `t.mock.module`), and `scripts/test.sh` never passes `--experimental-test-module-mocks`. `test/structure.test.ts` enforces both: it fails with a `file:line` message for each call in the top-level `test/*.ts` files and for the flag in `scripts/test.sh`. To test code that needs a mocked module, extract a pure builder from `src/` and test the builder instead. `mock.method` and `mock.fn` stay allowed.

## Refusal messages

A refusal or error message that names a next step must name a step that works in the state that produced the refusal, and a test runs that step once after the refusal. Example (past history): the ambiguity refusal in `resolveObservations` told the orchestrator to carry the items as a free-text note, but a note-only `factory_carry` needs an active slice with a green review, and the refusal happened with no active slice.

## Review data sections in tests

Tests that assert on a section of a review data file extract it with `dataSection` or `fixItems` from `test/helpers.ts`, not with an inline regex that names the next section. Adding a section then breaks no test.

## assert.ok over some/every

Never wrap `.some()` or `.every()` in `assert.ok`: it prints only `false`. Use `assert.deepEqual(arr.filter(x => !pred(x)), [])` for `every`, `assert.ok(arr.find(pred), message with the array)` or `assert.match` on the found item for `some`, and `assert.deepEqual(arr.filter(pred), [])` for `!some`. `test/structure.test.ts` enforces it.

## Reply lines in tests

A test outside the feature that owns a reply or summary line matches only that line's stable part, for example the command and the exit code. Only the owning feature's tests pin the full wording, so a wording change breaks one test file.

When the owning feature's test pins a line's full wording, the assertion matches the whole line, anchored at both ends: `assert.equal` on the full line, or `assert.match` with a regex that starts with `^` and ends with `$`. The anchored regex also has no unconstrained wildcard such as `.*` or `.+` between the fixed parts of the line. Otherwise text can slip in between the parts of the line. Example: `/foo.*: failed/` passes for `foo: bar baz: failed` and for `foo: failed (extra)`, because `.*` allows any text between the command and `: failed`, and nothing stops a trailing suffix. Anchoring alone does not fix the gap: `/^foo.*: failed$/` is still forbidden, because it accepts `foo: bar baz: failed`. Write `/^foo: failed$/` instead.

## Tests for a changed branch

When a change alters a default or a branch condition, search the tests for the input that the changed branch reads. Check each test that sets that input. Each such test must still prove the behavior its name gives, or you update it. Example: `defaultChoice` changed so that a correctness observation on a `fromEndQueue` slice defaults to fix. Three sibling follow-up tests moved to `missing-test`, but the re-sliced follow-up test was missed, and it then passed for the wrong reason.

## Negative type tests

A `@ts-expect-error` test must fail only for the behavior its name gives. The value on the line after the directive is otherwise complete and valid, so the one type error is the one under test. The test also holds a positive control: the same value without the part under test, typed with no directive, which compiles. Past history: in issue-858 slice 01 a `Validation` literal omitted the required `downgrade` key, so the expected error came from the missing key and the test could never fail on the behavior it named. Copy the pattern of 'has no state with both decision and criterion' in test/review-record.test.ts. This is a reviewer judgement rule; no test enforces it.

## Non-null assertions in tests

Non-null assertions `!` are allowed in test files under `test/`, for example on an array index or an optional field the test just set up (`run.slices[0]!.fixItems[0]!`), because a failed lookup throws inside the test and fails it. The 'Pair derived records with their source' rule still applies in tests: no `!` on a read of a second, parallel array at the same index. This section makes no rule for `src/` code. This is a reviewer judgement rule; no test enforces it, so reviewers do not raise `!` in tests as a style finding.

## Zod union errors and strictness

In a zod schema in `src/`, a custom `error` function on a `z.union` returns its message text only for the input case the message describes and returns `undefined` for every other case, so zod's default issue still reports a wrong-typed field or an unknown key. A change to a schema's shape does not change its object strictness (`z.object` versus `z.strictObject`) as a side effect. Copy the escalate union in `validationSchema` in `src/review-record.ts`. Past history: in issue-858 slice 01 a union error fired for every `invalid_union` issue, which hid wrong-typed fields and unknown keys behind one message, and the schema switched to `z.strictObject` along the way. This is a reviewer judgement rule; no test enforces it.

## Permissive tool parameter schemas

When a change touches a zod schema that a tool registers as `parameters` (through `toolRegistrar` in `src/tool-scope.ts`), review the JSON schema that the schema exposes (`z.toJSONSchema`). The omp host refuses arguments that fail the exposed JSON schema with its own generic message, before execute runs. A rule whose error message matters (for example a message that names the finding id) is enforced in execute, by the zod parse, and not in the exposed JSON schema. Advertise a permissive item, and let the zod parse in execute refuse the bad input. Copy `escalateInputSchema` in `src/review-record.ts`, which `validateSchema` in `src/review-tools.ts` advertises. The test 'advertises an escalate item with decision and criterion both optional, so the tool argument check cannot refuse a neither-or-both entry before the factory names the finding' in test/index.test.ts asserts that the advertised escalate item has no anyOf, oneOf or `not`.

Past history: in issue-858 slice 01 the advertised escalate item had a union, so omp refused a neither-or-both entry with its generic message and the factory could not name the finding. Fix round r1 changed the advertised item to the plain item. This is a reviewer judgement rule; no test enforces it.

## Script env in tests

A test that spawns a script with `process.env` controls every variable the script reads. Otherwise the result depends on the developer's or CI's shell.

- Pin every external binary that has an env variable (for example `OMP`) through that variable, set to the fake's absolute path. Never reach such a fake through the script's default lookup (a fake under the default name on `PATH`): if the default changes, the real binary runs (#409).
- A binary the script has no env variable for (for example `gh` in `scripts/headless-backlog.sh`) is reached through a `PATH` the test builds with the fake dir first. A test that must never run the real binary uses a `PATH` that holds only the fake dir and linked tools. The rule above stays for binaries that have an env variable (`OMP`).
- Test a binary's default in its own test, with a `PATH` that holds only the fake dir and linked tools. A wrong default then fails as not found instead of running the real binary.
- Remove every other variable the script reads from the inherited env, unless the test sets it on purpose. Do not set a variable whose default is the behavior under test, because the value masks the default.

Example: `test/headless-backlog.test.ts` spawns `scripts/headless-backlog.sh`, which reads `OMP` and `LOG_DIR`. It sets `OMP` to `join(bin, ',omp')`, the fake's absolute path, so a local `OMP` or a changed script default can never start the real omp. It removes `LOG_DIR` from the env it passes, so the script's default log dir stays under test.

## One-line agent text

Free text that an agent wrote (a reviewer, validator, implementer or issue) and that a one-line field shows (a location, a title, a `Symbol` line) goes through `evidenceLine` from `src/evidence.ts`. It redacts credential shapes, collapses all whitespace to one line and clips to a limit. Never pass such text through `evidence` or `redact` alone, and never show it raw: each leaves newlines or unbounded length in a field that must stay on one line.

Every rendering of one field uses one shared helper, not its own `evidence` or `evidenceLine` call. A finding's location is `findingLocation`, its title is `findingTitle` and its symbol is `findingSymbol`, all in `src/ledger.ts`. A second rendering that formats the same field on its own drifts from the first.

Example (issue #589, past history): slice 01 put the reviewer-written symbol into location lines without redact, clip or single-line. Slice 04 fixed `findingLocation` with `evidenceLine(symbol, 200)`, and the review then found `filedLocation` in `src/finding-text.ts` still used `evidence(symbol, 500)`, so the same field rendered two ways.

A confirm dialog and the action it confirms render the same field through the same helper, so the dialog never hides, redacts or reshapes text the action sends. If they differ, a user can approve publishing text the dialog did not show. Example: `retroTitle` in `src/retro.ts` renders the retro finding title both in the factory_retro confirm dialog in `src/index.ts` and in the `gh issue create` title in `fileFactoryIssues`.

Example (issue-831 slice 04, past history): the dialog redacted retro titles while `gh issue create` posted the raw title, so a user could approve publishing a credential the dialog hid. An outside review caught it and slice 04 was reopened.

## Event order in tests

A test that needs one event before another (stdout before stderr, one callback before another) orders them by a handshake or backpressure: the test or script waits until the first event is observed, then triggers the next. Never order events with a fixed sleep or timer. A fixed sleep passes on an idle machine and fails under load, for example parallel reviewer agents (issue 348).

A sleep that bounds a duration, not an order, is allowed: a check that must outlast a timeout (`sleep 5` with a smaller `checkTimeoutMs` in `test/review-gates-checks.test.ts`) or a process that must be killed (`sleep 30` in `test/units.test.ts`). `test/structure.test.ts` flags every `sleep 0.<digit>` line in `test/*.ts`; a duration-bounding sub-second sleep carries `allow-sub-second-sleep: <reason>` on the same line.

Example (forbidden): `runShell` cases that run `echo out; sleep 0.2; echo err >&2` to get stdout before stderr. Under load the 0.2 s gap can pass before the first chunk is read, and the order is no longer guaranteed. Handshake to copy: the `runShell` cases in `test/units.test.ts` that go through `stdoutThenStderr`. `runShell` takes an optional `onStdout` hook that runs after it recorded each stdout chunk. The script writes `out`, then waits in a loop for a marker file. The test creates that file from the hook, and only then does the script write to stderr. The loop is bounded by the `runShell` timeout. Do not spawn the child directly: that bypasses `runShell` and tests nothing about how it orders chunks.

## Validator-only finding fields

A finding field that only the validator sets (for example `criterion`, set when the validator escalates an observation for an unmet acceptance criterion) does not belong on the reviewer input schema of `factory_review_submit`, which is `findingSchema` in `src/run.ts`. Reviewers submit through that schema, so a field on it is a field a reviewer can set. If such a field must stay on the shared schema, its `.describe()` text on `findingSchema` starts with "Set by the validator", and `submitDomain` in `src/review.ts` refuses a finding that sets it. The test 'refuses every findingSchema field described as set by the validator' in `test/review.test.ts` selects those fields from the schema, submits one finding per field through `submitDomain`, and expects the refusal; it fails, naming the field, when the field has no sample value in the test.

Example (issue-502 slice 03, past history): `criterion` was added to `findingSchema`, and reviewers could set it until a fix round made `submitDomain` refuse it. The refusal of `criterion` in `submitDomain` is the pattern to copy.

## Pair derived records with their source

Pair a derived record with its source by mapping once to `{source, record}` pairs, or by building a `Map` keyed by a stable id. Never read a second, parallel array at the same index with a non-null assertion `!`. If the derived array is shorter, the read gives `undefined` at runtime, and the `!` hides that from the type checker. If the order differs, a source is paired with another source's record, with no error at all.

Forbidden:

```ts
const records = blocking.map(toRecord);
for (let i = 0; i < blocking.length; i++) use(blocking[i], records[i]!);
```

Copy:

```ts
const pairs = blocking.map((source) => ({ source, record: toRecord(source) }));
for (const { source, record } of pairs) use(source, record);
```

Or key the records by id: `const byId = new Map(records.map((r) => [r.id, r]))`, then read `byId.get(source.id)` and handle the missing case.

An indexed read of a single array (for example `chunk[i]!` in `src/exec.ts`) pairs nothing and is outside this rule.

Example (issue-671 slice 01, past history): `recordReview` paired `blocking[i]` with `findingRecords[i]!`. `src/review.ts` now maps `blocking` once to `{ finding, record }` pairs (`pairs`), which is the pattern to copy.

## One const per reply part

When a tool handler adds a new part to a reply, the part gets its own named const, joined in the reply template. Never append it onto an existing const whose name describes other content: the name then no longer matches the content, and the next reader trusts the name.

Forbidden:

```ts
let unchanged = result.unchanged ? '\nNo new commits since the fix file.' : '';
unchanged += await flaggedFilesSection(ws.root); // flagged text under a name that says "unchanged"
return reply(`${summary}${unchanged}${newChecks}`);
```

Copy:

```ts
const unchanged = result.unchanged ? '\nNo new commits since the fix file.' : '';
const flagged = await flaggedFilesSection(ws.root);
return reply(`${summary}${unchanged}${flagged}${newChecks}`);
```

The `factory_checks` handler in `src/index.ts` is the pattern to copy: `unchanged`, `flagged` and `newChecks` are separate consts, each named for its content, and the reply template joins them.

Example (issue-377 retro, past history): the flagged-files text was appended onto `unchanged`, so a const named for "no new commits" held flagged-file text too. It is now the separate `flagged` const. This is a reviewer judgement rule; no test enforces it.

## Relative paths in agent text

A relative path shown in text that agents read (tool replies such as Next lines, tickets, fix files, review data files) uses forward slashes on every platform. Build it with `posix.join` from node:path, or write it with a literal '/'. Never build it with the native `join`. An absolute path used for file I/O (built from the workspace root or the run dir) keeps the native `join`.

The repository states no supported-platform list. A reviewer or validator does not drop a finding about a native-separator relative path in agent text on the grounds that a platform such as Windows is not supported.

Copy `reportFile` in `src/run.ts`: it builds the relative report path with `posix.join`, and `reportPath` joins it to the run dir with the native `join` for file I/O.

Example (issue-788 slice 01, past history): a fix round found `reportFile` built with the native `join`, so the Next line would say `reports\01.md` on Windows. This is a reviewer judgement rule; no test enforces it.

## Plugin text cites no plugin-only paths

Text in files under `skills/` and `agents/` must not cite a file or directory that exists only in this plugin's repository (for example `test/helpers.ts`, `src/index.ts`, `scripts/test.sh`) as if it were in the working repository. That text runs as prompt text in every repository the factory works on, where such a path does not exist or names a different file, so the agent looks for the wrong thing or trusts the wrong file.

Write one of these instead:

- Describe the thing generically, for example "the repository's test helpers".
- Reach a plugin file through a path the agent is given, for example `<reference dir>/../known-observations.md`.

Example (issue-260, past history): a slice put `test/helpers.ts` in a skill, and the slice was reopened. This is a reviewer judgement rule; no test enforces it.

## Test fakes return state

A test fake that exposes state a test reads (for example the active tool list) returns it from its load function. It does not fill a mutable out-parameter that the test passes in and reads back with a fallback such as `?? []`.

Copy `loadWithActiveTools` in `test/extension.ts`: it returns `activeTools`, and `resumeSetup` in `test/index.test.ts` reads that returned state.

Example (issue-770 slice 01, past history): the fake's getActiveTools was exposed through a mutable `probe` out-parameter that the test read with `?? []`, and an unused `activated` array was left in `resumeSetup`.

The rule covers state a new or changed fake exposes. The existing recording options of `load` and `loadWithActiveTools` (activated, sent, sentOptions, handlers, commands) are not migrated. This is a reviewer judgement rule; no test enforces it.

## Error-text assertions in tests

A test assertion on error or refusal text (`includes`, `match`, a regex) matches a fragment that only the specific cause under test produces, such as a field path (`finding.id`) or a schema message (`must match pattern`). It never matches a short common word that the fixed message prefix or other fixed text of the message can contain, because such an assertion can never fail.

Copy the test 'rejects a withRun mutation that leaves an invalid value and keeps the previous state' in `test/save-run.test.ts`: it asserts on `finding.id` and `must match pattern`.

Example (issue-735 slice 01, past history): `includes('id')` also matched 'invalid' in the `saveRun` message prefix 'Refusing to save invalid factory state', so the assertion passed whatever the cause.

This is a reviewer judgement rule; no test enforces it.
