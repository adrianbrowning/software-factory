import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, it } from 'node:test';
import { tempDir } from './helpers.ts';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const MAX_LINES = 1000;
const TESTS = fileURLToPath(new URL('./', import.meta.url));
const TICKET_DECISION = /decisions? \d+/i;
type Comment = { line: number; text: string };

/** The content of every listed path under `root` that exists, whatever its extension; binary files are decoded too, so an ASCII phrase in them is still found. */
function contentsOfFiles(root: string, paths: string[]): Map<string, string> {
  const found = new Map<string, string>();
  for (const path of paths) {
    if (!path || !existsSync(join(root, path))) continue;
    const buffer = readFileSync(join(root, path));
    found.set(path, buffer.toString('utf8'));
  }
  return found;
}

/** Every `//` comment and block comment in `source` with its first line. String, template and regex literals are not comments. */
export function commentsOf(source: string): Comment[] {
  const file = ts.createSourceFile('x.ts', source, ts.ScriptTarget.Latest, true);
  const found = new Map<number, Comment>();
  const add = (ranges: ts.CommentRange[] | undefined) => {
    for (const range of ranges ?? []) {
      found.set(range.pos, { line: file.getLineAndCharacterOfPosition(range.pos).line + 1, text: source.slice(range.pos, range.end) });
    }
  };
  const visit = (node: ts.Node) => {
    add(ts.getLeadingCommentRanges(source, node.getFullStart()));
    add(ts.getTrailingCommentRanges(source, node.getEnd()));
    for (const child of node.getChildren(file)) visit(child);
  };
  visit(file);
  return [...found.values()].sort((a, b) => a.line - b.line);
}

/** One message per comment line that cites a ticket decision number. */
export function decisionCitations(file: string, source: string) {
  return commentsOf(source).flatMap(comment =>
    comment.text.split('\n').flatMap((text, offset) => (TICKET_DECISION.test(text) ? [`${file}:${comment.line + offset}: comment cites a ticket decision number: ${text.trim()}`] : [])),
  );
}

/** One message per assert.throws / assert.rejects call with no second argument or only the bare `Error` class as it. */
export function unmatchedAsserts(file: string, source: string) {
  const sf = ts.createSourceFile('x.ts', source, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'assert') {
      const method = node.expression.name.text;
      const matcher = node.arguments[1];
      if (method === 'throws' || method === 'rejects') {
        const problem = matcher === undefined ? 'has no message matcher' : ts.isIdentifier(matcher) && matcher.text === 'Error' ? 'matches only the bare Error class' : undefined;
        if (problem) found.push(`${file}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}: assert.${method} ${problem}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** One message per assert.ok call, with or without a message argument, whose first argument has a `.some(...)` or `.every(...)` call among its top-level `&&` operands (parentheses and `!` ignored). */
export function someEveryAsserts(file: string, source: string) {
  const sf = ts.createSourceFile('x.ts', source, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const operands = (expr: ts.Expression): ts.Expression[] => {
    if (ts.isParenthesizedExpression(expr)) return operands(expr.expression);
    if (ts.isPrefixUnaryExpression(expr) && expr.operator === ts.SyntaxKind.ExclamationToken) return operands(expr.operand);
    if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) return [...operands(expr.left), ...operands(expr.right)];
    return [expr];
  };
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'assert' && node.expression.name.text === 'ok' && node.arguments[0] !== undefined) {
      for (const operand of operands(node.arguments[0])) {
        if (ts.isCallExpression(operand) && ts.isPropertyAccessExpression(operand.expression) && (operand.expression.name.text === 'some' || operand.expression.name.text === 'every')) {
          found.push(`${file}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}: assert.ok over .${operand.expression.name.text}() hides the failing value`);
          break;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** The someEveryAsserts messages for each {name, source} file, prefixed `test/<name>`. */
export function someEveryAssertsOf(files: { name: string; source: string }[]) {
  return files.flatMap(file => someEveryAsserts(`test/${file.name}`, file.source));
}

const SUB_SECOND_SLEEP = /\bsleep +0\.[0-9]/;
const SUB_SECOND_ALLOW = /allow-sub-second-sleep:\s*[^\s*/"'`]/;

/** One message per line of `source` holding a sub-second `sleep`, unless the same line carries `allow-sub-second-sleep: <reason>`. */
export function subSecondSleeps(file: string, source: string) {
  return source.split('\n').flatMap((line, i) =>
    SUB_SECOND_SLEEP.test(line) && !SUB_SECOND_ALLOW.test(line)
      ? [`${file}:${i + 1}: sub-second sleep orders events by timing; use a handshake, or mark a duration bound with allow-sub-second-sleep: <reason>`]
      : [],
  );
}

/** The subSecondSleeps messages for each {name, source} file, prefixed `test/<name>`. */
export function subSecondSleepsOf(files: { name: string; source: string }[]) {
  return files.flatMap(file => subSecondSleeps(`test/${file.name}`, file.source));
}

const MODULE_MOCK_FIX = 'extract a pure builder from src/ and test it instead of mocking a module';

/** One message per line holding a `mock.module(...)` or `t.mock.module(...)` call in code, at the line of the `module` name. Comments, strings and other `mock` members are not calls. */
export function mockModuleCalls(file: string, source: string) {
  const sf = ts.createSourceFile('x.ts', source, ts.ScriptTarget.Latest, true);
  const lines = new Set<number>();
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'module') {
      const target = node.expression.expression;
      if ((ts.isIdentifier(target) && target.text === 'mock') || (ts.isPropertyAccessExpression(target) && target.name.text === 'mock')) {
        lines.add(sf.getLineAndCharacterOfPosition(node.expression.name.getStart(sf)).line + 1);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return [...lines].sort((a, b) => a - b).map(line => `${file}:${line}: mock.module call; ${MODULE_MOCK_FIX}`);
}

/** One message per line of a script text holding `--experimental-test-module-mocks`. */
export function moduleMockFlag(file: string, script: string) {
  return script.split('\n').flatMap((line, i) =>
    line.includes('--experimental-test-module-mocks') ? [`${file}:${i + 1}: --experimental-test-module-mocks enables module mocking; ${MODULE_MOCK_FIX}`] : [],
  );
}

/**
 * The files `source` imports from its own directory, by its static import and `export … from` declarations, side-effect
 * imports included. With `runtimeOnly`, a declaration that is wholly type-only (`import type`, `export type`) is left out:
 * node strips it, so it never loads the file. `import { type C }` stays: node strips only the specifier and still loads the file.
 */
export function importsOf(source: string, options: { runtimeOnly?: boolean } = {}) {
  const file = ts.createSourceFile('source.ts', source, ts.ScriptTarget.Latest);
  return file.statements.flatMap(statement => {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) return [];
    const typeOnly = ts.isImportDeclaration(statement) ? statement.importClause?.isTypeOnly === true : statement.isTypeOnly;
    if (options.runtimeOnly === true && typeOnly) return [];
    const specifier = statement.moduleSpecifier;
    const target = specifier !== undefined && ts.isStringLiteral(specifier) ? /^\.\/([^/]+\.ts)$/.exec(specifier.text)?.[1] : undefined;
    return target === undefined ? [] : [target];
  });
}

/** One message per `export … from` declaration with a relative specifier (named, star, `* as ns`, type-only), at the line it starts. */
export function reExportsOf(file: string, source: string) {
  const sf = ts.createSourceFile('x.ts', source, ts.ScriptTarget.Latest, true);
  return sf.statements.flatMap(statement => {
    if (!ts.isExportDeclaration(statement) || statement.moduleSpecifier === undefined || !ts.isStringLiteral(statement.moduleSpecifier) || !/^\.\.?(?:$|[\\/])/.test(statement.moduleSpecifier.text)) return [];
    const line = sf.getLineAndCharacterOfPosition(statement.getStart(sf)).line + 1;
    return [`${file}:${line}: re-exports from a local module: ${statement.getText(sf).split('\n')[0]}`];
  });
}

/** The first import cycle reachable from each file of `graph`, as `a.ts -> b.ts -> a.ts`. */
export function cyclesOf(graph: Map<string, string[]>) {
  const cycles = new Map<string, string>();
  const done = new Set<string>();
  const path: string[] = [];
  function visit(file: string) {
    const at = path.indexOf(file);
    if (at !== -1) {
      const loop = path.slice(at);
      const first = loop.indexOf([...loop].sort()[0] as string);
      const ordered = [...loop.slice(first), ...loop.slice(0, first)];
      cycles.set(ordered.join(' '), [...ordered, ordered[0]].join(' -> '));
      return;
    }
    if (done.has(file)) return;
    path.push(file);
    for (const next of graph.get(file) ?? []) visit(next);
    path.pop();
    done.add(file);
  }
  for (const file of graph.keys()) visit(file);
  return [...cycles.values()];
}

const TEST_SCOPE_PHRASE = 'test files that assert on output';

/**
 * One message per file the AGENTS.md implementer test-scope list names that lacks the key phrase, and per tracked file outside
 * the list that holds it. Files under test/ and AGENTS.md are exempt from the second rule. `tracked` maps path to content.
 */
export function testScopeProblems(agents: string, tracked: Map<string, string>) {
  const lines = agents.split('\n');
  const start = lines.findIndex(line => line.includes('implementer test-scope wording'));
  const listed: string[] = [];
  for (const line of start === -1 ? [] : lines.slice(start + 1)) {
    const path = /^- `([^`]+)`/.exec(line)?.[1];
    if (path) listed.push(path);
    else if (listed.length || line.trim() !== '') break;
  }
  if (!listed.length) return ['AGENTS.md: implementer test-scope wording list not found'];
  const missing = listed.filter(path => !tracked.get(path)?.includes(TEST_SCOPE_PHRASE)).map(path => `${path}: listed in AGENTS.md but does not hold "${TEST_SCOPE_PHRASE}"`);
  const extra = [...tracked]
    .filter(([path, content]) => !listed.includes(path) && path !== 'AGENTS.md' && !path.startsWith('test/') && content.includes(TEST_SCOPE_PHRASE))
    .map(([path]) => `${path}: holds "${TEST_SCOPE_PHRASE}" but is not in the AGENTS.md test-scope list`);
  return [...missing, ...extra];
}

const STALE_SPAN = /`([^`\n]+)`/g;
const CAMEL_NAME = /^([a-z][a-zA-Z0-9]*)(\(\))?$/;

/**
 * One message per inline code span of the CODING_STANDARDS.md text that is stale: a `src/` path absent from `paths`
 * (files and directories), or a camelCase identifier (optional trailing `()`) that no `sources` text holds as a whole word.
 * Spans inside fenced code blocks and in a paragraph holding "past history" are skipped. The line is 1-based.
 */
export function standardsReferenceProblems(standards: string, paths: Set<string>, sources: string[]) {
  const problems: string[] = [];
  const lines = standards.split('\n');
  let fenced = false;
  let start = 0;
  while (start < lines.length) {
    let end = start;
    const paragraph: number[] = [];
    while (end < lines.length && lines[end]!.trim() !== '') {
      if (lines[end]!.trimStart().startsWith('```')) fenced = !fenced;
      else if (!fenced) paragraph.push(end);
      end++;
    }
    if (!paragraph.some(i => lines[i]!.includes('past history'))) {
      for (const i of paragraph) {
        for (const match of lines[i]!.matchAll(STALE_SPAN)) {
          const span = match[1]!;
          const name = CAMEL_NAME.exec(span)?.[1];
          if (span.startsWith('src/')) {
            if (!paths.has(span.replace(/\/$/, ''))) problems.push(`CODING_STANDARDS.md:${i + 1}: \`${span}\` names no existing path`);
          } else if (name && /[A-Z]/.test(name)) {
            const word = new RegExp(`(?<![A-Za-z0-9_$])${name}(?![A-Za-z0-9_$])`);
            if (!sources.some(source => word.test(source))) problems.push(`CODING_STANDARDS.md:${i + 1}: \`${span}\` is in no src/ or test/ .ts file`);
          }
        }
      }
    }
    start = end + 1;
  }
  return problems;
}

const lineCount = (source: string) => source.split('\n').length - (source.endsWith('\n') ? 1 : 0);

const tsFilesIn = (dir: string) =>
  readdirSync(dir)
    .filter(name => name.endsWith('.ts'))
    .sort()
    .map(name => ({ name, source: readFileSync(join(dir, name), 'utf8') }));

const files = tsFilesIn(SRC);

describe('structure checks: the helpers', () => {
  it('subSecondSleeps flags sub-second sleeps with file and line, and nothing else', () => {
    const sleep = (n: string) => 'sleep ' + n;
    const source = ['a', `run("${sleep('0.2')}")`, `x; ${'sleep  ' + '0.05'}`, sleep('1'), sleep('5'), sleep('30'), sleep('0'), 'no' + sleep('0.2')].join('\n');
    const found = subSecondSleeps('f.ts', source);
    assert.equal(found.length, 2);
    assert.match(found[0] ?? '', /^f\.ts:2:/);
    assert.match(found[1] ?? '', /^f\.ts:3:/);
  });

  it('subSecondSleeps allows a line carrying the marker with a reason, not a marker on another line', () => {
    const sleep = 'sleep ' + '0.2';
    assert.deepEqual(subSecondSleeps('f.ts', `${sleep} // allow-sub-second-sleep: bounds a timeout`), []);
    assert.equal(subSecondSleeps('f.ts', `// allow-sub-second-sleep: why\n${sleep}`).length, 1);
  });

  it('subSecondSleeps does not accept a marker without reason text', () => {
    const sleep = 'sleep ' + '0.2';
    assert.equal(subSecondSleeps('f.ts', `${sleep} /* allow-sub-second-sleep: */`).length, 1);
    assert.equal(subSecondSleeps('f.ts', `${sleep} // allow-sub-second-sleep:   `).length, 1);
    assert.equal(subSecondSleeps('f.ts', `${sleep} /* allow-sub-second-sleep: **/`).length, 1);
    assert.equal(subSecondSleeps('f.ts', `${sleep} /* allow-sub-second-sleep: ***/`).length, 1);
    assert.equal(subSecondSleeps('f.ts', `${sleep} "allow-sub-second-sleep:"`).length, 1);
    assert.equal(subSecondSleeps('f.ts', `${sleep} \`allow-sub-second-sleep:\``).length, 1);
    assert.deepEqual(subSecondSleeps('f.ts', `${sleep} /* allow-sub-second-sleep: why */`), []);
    assert.deepEqual(subSecondSleeps('f.ts', `${sleep} // allow-sub-second-sleep: #852 bounds timeout`), []);
    assert.deepEqual(subSecondSleeps('f.ts', `${sleep} // allow-sub-second-sleep: (why)`), []);
  });

  it('subSecondSleepsOf prefixes test/<name> and the line', () => {
    const found = subSecondSleepsOf([{ name: 'x.test.ts', source: 'a\n' + 'sleep ' + '0.5' }]);
    assert.equal(found.length, 1);
    assert.match(found[0] ?? '', /^test\/x\.test\.ts:2:/);
  });

  it('cites a comment with a decision number, by file and line', () => {
    const source = "const a = 1;\n/**\n * Per\n * decision 4, do it.\n */\nconst b = 2; // Decisions 12 and 13\n";
    assert.deepEqual(decisionCitations('src/x.ts', source), [
      'src/x.ts:4: comment cites a ticket decision number: * decision 4, do it.',
      'src/x.ts:6: comment cites a ticket decision number: // Decisions 12 and 13',
    ]);
  });

  it('ignores comment-looking text in string, template and regex literals, and reports only the real comments', () => {
    const source = [
      "const a = '// decision 4';",
      '// decision 7',
      'const b = "// decision 4";',
      '// decision 7',
      'const c = `/* decision 4 */`;',
      '// decision 7',
      'const d = /\\/*decision 4/;',
      '// decision 7',
    ].join('\n');
    assert.deepEqual(
      commentsOf(source).map(comment => `${comment.line}:${comment.text}`),
      ['2:// decision 7', '4:// decision 7', '6:// decision 7', '8:// decision 7'],
    );
  });

  it('counts the line of a backslash-newline continuation in a string and in a template', () => {
    const source = "const s = 'a\\\n b';\nconst t = `a\\\n b`;\n// decision 1\n";
    assert.deepEqual(decisionCitations('src/x.ts', source), ['src/x.ts:5: comment cites a ticket decision number: // decision 1']);
  });

  it('reads a slash after a value as a divide, so the comment after it is found', () => {
    const source = 'const x = 4;\nconst e = x / 2; // decision 8\n';
    assert.deepEqual(decisionCitations('src/x.ts', source), ['src/x.ts:2: comment cites a ticket decision number: // decision 8']);
  });

  it('still finds a comment after a template with a nested expression', () => {
    const source = 'const a = `${f(`in ${g}`)} text`;\n// decision 9\n';
    assert.deepEqual(decisionCitations('src/x.ts', source), ['src/x.ts:2: comment cites a ticket decision number: // decision 9']);
  });

  it('reads a slash after ++ as a divide, so the comment after it is found', () => {
    assert.deepEqual(decisionCitations('src/x.ts', 'const z = x++ / y; // decision 1\n'), ['src/x.ts:1: comment cites a ticket decision number: // decision 1']);
  });

  it('reports a comment after a regex that follows a keyword such as void, once, at its line', () => {
    const source = "const v = void /'/; // decision 2\n";
    assert.deepEqual(decisionCitations('src/x.ts', source), ['src/x.ts:1: comment cites a ticket decision number: // decision 2']);
  });

  it('reads every sibling import, including type imports, but not packages', () => {
    const source = ["import { a } from './a.ts';", "import type { B } from './b.ts';", 'import {', '  c,', "} from './c.ts';", 'export { e } from "./e.ts";', "import './s.ts';", 'import "./t.ts"', "import { x } from 'node:fs';"].join('\n');
    assert.deepEqual(importsOf(source), ['a.ts', 'b.ts', 'c.ts', 'e.ts', 's.ts', 't.ts']);
  });

  it('finds a cycle through a multi-line import list', () => {
    const files = { 'a.ts': ['import x, {', '  y,', '  z }', "  from './b.ts';"].join('\n'), 'b.ts': "import './a.ts';" };
    const graph = new Map(Object.entries(files).map(([name, source]) => [name, importsOf(source)]));
    assert.deepEqual(cyclesOf(graph), ['a.ts -> b.ts -> a.ts']);
  });

  it('names an import cycle by its path', () => {
    const graph = new Map([
      ['a.ts', ['b.ts']],
      ['b.ts', ['c.ts']],
      ['c.ts', ['a.ts', 'd.ts']],
      ['d.ts', []],
    ]);
    assert.deepEqual(cyclesOf(graph), ['a.ts -> b.ts -> c.ts -> a.ts']);
    assert.deepEqual(cyclesOf(new Map([['a.ts', ['b.ts']], ['b.ts', []]])), []);
  });

  it('finds a cycle that runs through a side-effect import', () => {
    const files = { 'a.ts': "import './b.ts';", 'b.ts': "export * from './a.ts';" };
    const graph = new Map(Object.entries(files).map(([name, source]) => [name, importsOf(source)]));
    assert.deepEqual(cyclesOf(graph), ['a.ts -> b.ts -> a.ts']);
  });

  it('leaves a type-only import out of the runtime graph, and keeps a value import', () => {
    const source = ["import type { B } from './b.ts';", "import { type C } from './c.ts';", "import { d } from './d.ts';", "export type { E } from './e.ts';", "export { f } from './f.ts';"].join('\n');
    assert.deepEqual(importsOf(source, { runtimeOnly: true }), ['c.ts', 'd.ts', 'f.ts']);
  });

  it('refuses assert.throws and assert.rejects with no matcher or only the bare Error class, at the line the call starts', () => {
    const source = ['assert.throws(() => f());', 'assert.rejects(', '  g(),', '  Error,', ');', "assert.throws(() => f(), /x/);", 'assert.rejects(g(), { message: "x" });', 'assert.throws(f, new Error("x"));', 'assert.throws(f, TypeError);', 'assert.throws(f, matcher);', 'assert.doesNotThrow(f);', '// assert.throws(f);', 'const s = "assert.throws(f)";', 'other.throws(f);', 'other.rejects(g());'].join('\n');
    assert.deepEqual(unmatchedAsserts('test/x.test.ts', source), ['test/x.test.ts:1: assert.throws has no message matcher', 'test/x.test.ts:2: assert.rejects matches only the bare Error class']);
  });

  it('lets a test file with no matcher-less call through', () => {
    assert.deepEqual(unmatchedAsserts('test/x.test.ts', 'assert.throws(f, /x/);'), []);
  });

  it('refuses assert.ok over a some/every operand, with or without a message, at the line the call starts', () => {
    const source = ['assert.ok(arr.some(p));', 'assert.ok(arr.every(p));', 'assert.ok(!arr.some(p));', 'assert.ok(x && arr.some(p));', 'assert.ok((arr.some(p)));', "assert.ok(arr.some(p), 'msg');"].join('\n');
    assert.deepEqual(someEveryAsserts('test/x.test.ts', source), [1, 2, 3, 4, 5, 6].map(line => `test/x.test.ts:${line}: assert.ok over .${line === 2 ? 'every' : 'some'}() hides the failing value`));
  });

  it('reports a some() assert.ok in a listed file as test/<name>:<line>', () => {
    const source = 'const a = 1;\nassert.ok(arr.some(p));';
    assert.deepEqual(someEveryAssertsOf([{ name: 'zz.test.ts', source }]), ['test/zz.test.ts:2: assert.ok over .some() hides the failing value']);
  });

  it('lets assertions that print the failing value through', () => {
    const source = ['assert.ok(arr.find(p));', 'assert.deepEqual(arr.filter(p), []);', 'assert.equal(arr.some(p), true);', 'assert.ok(f(arr.some(p)));', 'assert.ok(x || arr.some(p));'].join('\n');
    assert.deepEqual(someEveryAsserts('test/x.test.ts', source), []);
  });

  it('refuses a re-export from a relative module, at the line the declaration starts', () => {
    const source = ["export { a } from './a.ts';", 'export {', '  b,', "} from '../b';", "export * from './c.ts';", "export * as d from './d.ts';", "export type { E } from './e.ts';"].join('\n');
    assert.deepEqual(reExportsOf('src/x.ts', source), [
      'src/x.ts:1: re-exports from a local module: export { a } from \'./a.ts\';',
      'src/x.ts:2: re-exports from a local module: export {',
      'src/x.ts:5: re-exports from a local module: export * from \'./c.ts\';',
      'src/x.ts:6: re-exports from a local module: export * as d from \'./d.ts\';',
      'src/x.ts:7: re-exports from a local module: export type { E } from \'./e.ts\';',
    ]);
  });

  it('lets local exports, imports, package re-exports, and re-export text in comments or strings through', () => {
    const source = ['const x = 1;', 'export { x };', 'export const y = 2;', "import { z } from './z.ts';", "export { q } from 'zod';", "export { r } from '.internal/r';", "// export { a } from './a.ts';", "const s = \"export { a } from './a.ts'\";"].join('\n');
    assert.deepEqual(reExportsOf('src/x.ts', source), []);
  });

  it('reports a listed file without the key phrase and an unlisted file with it, but not files under test/ or AGENTS.md', () => {
    const agents = ['The implementer test-scope wording sits in two places:', '- `a.md`: one.', '- `src/b.ts`: two.', '', 'Other text.', '- `c.md`: not in the list.'].join('\n');
    const phrase = 'test files that assert on output';
    const tracked = new Map([
      ['AGENTS.md', agents + phrase],
      ['a.md', `x ${phrase} y`],
      ['src/b.ts', 'nothing'],
      ['c.md', phrase],
      ['test/t.test.ts', phrase],
      ['d.md', 'unrelated'],
    ]);
    assert.deepEqual(testScopeProblems(agents, tracked), ['src/b.ts: listed in AGENTS.md but does not hold "test files that assert on output"', 'c.md: holds "test files that assert on output" but is not in the AGENTS.md test-scope list']);
  });

  it('reports one not-found problem when the anchor sentence is missing, ignoring the first bullet list', () => {
    const agents = 'Submit list:\n- `src/index.ts`: one.\n- `src/submit.ts`: two.\n';
    assert.deepEqual(testScopeProblems(agents, new Map()), ['AGENTS.md: implementer test-scope wording list not found']);
  });

  it('reports the same not-found problem when the anchor is followed by no backticked bullet paths', () => {
    const agents = 'The implementer test-scope wording sits in two places:\n\n- plain bullet\n';
    assert.deepEqual(testScopeProblems(agents, new Map()), ['AGENTS.md: implementer test-scope wording list not found']);
  });

  it('does not parse a later unrelated list after an anchor followed by a plain bullet', () => {
    const agents = 'The implementer test-scope wording sits in two places:\n\n- plain bullet\n\n- `other.md`: x.\n';
    assert.deepEqual(testScopeProblems(agents, new Map()), ['AGENTS.md: implementer test-scope wording list not found']);
  });
});

describe('module mocking ban: the helpers', () => {
  it('reports each line holding a mock.module call, in both forms, as test/<name>:<line> naming the pure-builder fix', () => {
    const source = ["import { mock } from 'node:test';", "mock.module('./a.ts', {});", 'it("x", t => {', "  t.mock.module('./b.ts', {});", '  mock.module(', "    './c.ts',", '  );', '});'].join('\n');
    const fix = 'extract a pure builder from src/ and test it instead of mocking a module';
    assert.deepEqual(mockModuleCalls('test/x.test.ts', source), [
      `test/x.test.ts:2: mock.module call; ${fix}`,
      `test/x.test.ts:4: mock.module call; ${fix}`,
      `test/x.test.ts:5: mock.module call; ${fix}`,
    ]);
  });

  it('lets mock.module text in comments and strings, and mock.method and mock.fn calls, through', () => {
    const source = ["// mock.module('./a.ts', {});", "/* t.mock.module('./a.ts') */", "const s = \"mock.module('./a.ts')\";", 'const t = `mock.module(x)`;', "mock.method(obj, 'f');", 'const f = mock.fn();'].join('\n');
    assert.deepEqual(mockModuleCalls('test/x.test.ts', source), []);
  });

  it('reports a call whose receiver sits on an earlier line at the line of .mock.module', () => {
    assert.deepEqual(mockModuleCalls('test/x.test.ts', "t\n  .mock.module('./x');"), [`test/x.test.ts:2: mock.module call; ${MODULE_MOCK_FIX}`]);
  });

  it('reports the module-mocks flag in a script text at its line, naming the flag and the pure-builder fix', () => {
    const script = 'a\nexec node --experimental-test-module-mocks --test "$@"\n';
    assert.deepEqual(moduleMockFlag('scripts/test.sh', script), ['scripts/test.sh:2: --experimental-test-module-mocks enables module mocking; extract a pure builder from src/ and test it instead of mocking a module']);
  });
});

const testFiles = tsFilesIn(TESTS);

describe('reading every listed file for the test-scope check, binary files included', () => {
  it('reads text and binary files of any extension and skips missing ones', () => {
    using temp = tempDir('scope-');
    const dir = temp.root;
    writeFileSync(join(dir, 'ci.yml'), 'test files that assert on output');
    writeFileSync(join(dir, 'bin.dat'), Buffer.concat([Buffer.from('test files that assert on output'), Buffer.from([0])]));
    const tracked = contentsOfFiles(dir, ['ci.yml', 'bin.dat', 'gone.txt']);
    assert.deepEqual([...tracked.keys()], ['ci.yml', 'bin.dat']);
    assert.deepEqual(testScopeProblems('The implementer test-scope wording sits in one place:\n- `a.md`: one.\n', tracked), ['a.md: listed in AGENTS.md but does not hold "test files that assert on output"', 'ci.yml: holds "test files that assert on output" but is not in the AGENTS.md test-scope list', 'bin.dat: holds "test files that assert on output" but is not in the AGENTS.md test-scope list']);
  });
});

describe('structure of test/', () => {
  it('has no assert.throws or assert.rejects without a message matcher', () => {
    assert.deepEqual(testFiles.flatMap(file => unmatchedAsserts(`test/${file.name}`, file.source)), []);
  });

  it('has no assert.ok over .some() or .every()', () => {
    assert.deepEqual(someEveryAssertsOf(testFiles), []);
  });

  it('has no sub-second sleep without an allow-sub-second-sleep marker', () => {
    assert.deepEqual(subSecondSleepsOf(testFiles), []);
  });

  it('has no mock.module call', () => {
    assert.deepEqual(testFiles.flatMap(file => mockModuleCalls(`test/${file.name}`, file.source)), []);
  });

  it('has no module-mocks flag in scripts/test.sh', () => {
    assert.deepEqual(moduleMockFlag('scripts/test.sh', readFileSync(fileURLToPath(new URL('../scripts/test.sh', import.meta.url)), 'utf8')), []);
  });
});

describe('structure of src/', () => {
  it('has no comment that cites a ticket decision number', () => {
    assert.deepEqual(files.flatMap(file => decisionCitations(`src/${file.name}`, file.source)), []);
  });

  it(`has no file over ${MAX_LINES} lines`, () => {
    const long = files.filter(file => lineCount(file.source) > MAX_LINES).map(file => `src/${file.name}:${lineCount(file.source)}: ${lineCount(file.source)} lines, over the limit of ${MAX_LINES}`);
    assert.deepEqual(long, []);
  });

  it('has no runtime import cycle (a type-only import is erased, so it cannot cycle)', () => {
    const graph = new Map(files.map(file => [file.name, importsOf(file.source, { runtimeOnly: true })]));
    assert.deepEqual(cyclesOf(graph), []);
  });

  it('has no re-export shim between its modules', () => {
    assert.deepEqual(files.flatMap(file => reExportsOf(`src/${file.name}`, file.source)), []);
  });
});

describe('structure of the implementer test-scope wording', () => {
  it('sits in exactly the files the AGENTS.md list names', () => {
    const root = fileURLToPath(new URL('../', import.meta.url));
    const tracked = contentsOfFiles(root, execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0'));
    assert.deepEqual(testScopeProblems(tracked.get('AGENTS.md') ?? '', tracked), []);
  });
});

function tsSourceTexts(root: string): string[] {
  return ['src', 'test']
    .flatMap(dir => readdirSync(join(root, dir), { recursive: true }).map(name => `${dir}/${String(name)}`))
    .filter(path => path.endsWith('.ts') && path !== 'test/structure.test.ts')
    .map(path => readFileSync(join(root, path), 'utf8'));
}

describe('structure of the CODING_STANDARDS.md references', () => {
  const paths = new Set(['src/a.ts', 'src']);
  const sources = ['export function evidenceHeadline() {}'];

  it('reports a src/ path outside the path set and accepts a file or directory in it', () => {
    assert.deepEqual(standardsReferenceProblems('x `src/a.ts` `src/` `src/gone.ts`\n', paths, sources), ['CODING_STANDARDS.md:1: `src/gone.ts` names no existing path']);
  });

  it('reports a camelCase name held by no source as a whole word, with or without ()', () => {
    assert.deepEqual(standardsReferenceProblems('`evidenceHeadline` `evidenceHead()` `evidenceHeadline()`\n', paths, sources), ['CODING_STANDARDS.md:1: `evidenceHead()` is in no src/ or test/ .ts file']);
  });

  it('reports the 1-based line, skips fenced blocks, other span kinds and past-history paragraphs', () => {
    const text = ['ok', '', '```', '`goneName` `src/no.ts`', '```', '', '`factory_carry` `Map` `OMP` `assert.ok` `test/helpers.ts` `node`', '', 'Example (past history): `goneName`', 'and `src/no.ts`', '', '`goneName`', ''].join('\n');
    assert.deepEqual(standardsReferenceProblems(text, paths, sources), ['CODING_STANDARDS.md:12: `goneName` is in no src/ or test/ .ts file']);
  });

  it('reports a name a source holds only at the end of a longer word', () => {
    assert.deepEqual(standardsReferenceProblems('`evidenceHead`\n', paths, ['const xevidenceHead = 1']), ['CODING_STANDARDS.md:1: `evidenceHead` is in no src/ or test/ .ts file']);
  });

  it('finds no stale reference in the real CODING_STANDARDS.md', () => {
    const root = fileURLToPath(new URL('../', import.meta.url));
    const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
    const paths = new Set(tracked.flatMap(path => path.split('/').map((_, i, parts) => parts.slice(0, i + 1).join('/'))));
    const texts = tsSourceTexts(root);
    assert.deepEqual(standardsReferenceProblems(readFileSync(join(root, 'CODING_STANDARDS.md'), 'utf8'), paths, texts), []);
  });

  it('reads nested src/ and test/ .ts files and excludes only the root structure test', () => {
    using temp = tempDir('standards-');
    const root = temp.root;
    for (const dir of ['src/sub', 'test/sub']) mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, 'src/sub/a.ts'), 'srcNestedName');
    writeFileSync(join(root, 'test/sub/b.ts'), 'testNestedName');
    writeFileSync(join(root, 'test/sub/structure.test.ts'), 'nestedSameName');
    writeFileSync(join(root, 'test/structure.test.ts'), 'rootExcludedName');
    const texts = tsSourceTexts(root);
    const text = '`srcNestedName` `testNestedName` `nestedSameName` `rootExcludedName`';
    assert.deepEqual(standardsReferenceProblems(text, new Set(), texts), ['CODING_STANDARDS.md:1: `rootExcludedName` is in no src/ or test/ .ts file']);
  });
});
