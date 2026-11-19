import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, it } from 'node:test';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const MAX_LINES = 1000;
const TICKET_DECISION = /decisions? \d+/i;
type Comment = { line: number; text: string };

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
  }).concat(dynamicImportsOf(file));
}

/** Every `import('./x.ts')` call anywhere in the file: it loads the file at run time, so it is an edge of the graph. */
function dynamicImportsOf(file: ts.SourceFile) {
  const targets: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [argument] = node.arguments;
      const target = argument !== undefined && ts.isStringLiteralLike(argument) ? /^\.\/([^/]+\.ts)$/.exec(argument.text)?.[1] : undefined;
      if (target !== undefined) targets.push(target);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return targets;
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

const lineCount = (source: string) => source.split('\n').length - (source.endsWith('\n') ? 1 : 0);

const files = readdirSync(SRC)
  .filter(name => name.endsWith('.ts'))
  .sort()
  .map(name => ({ name, source: readFileSync(join(SRC, name), 'utf8') }));

describe('structure checks: the helpers', () => {
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

  it('reads a dynamic import as an edge, so a lazy load cannot hide a cycle', () => {
    const files = { 'a.ts': "export async function f() { return (await import('./b.ts')).g; }", 'b.ts': "import { f } from './a.ts';" };
    const graph = new Map(Object.entries(files).map(([name, source]) => [name, importsOf(source, { runtimeOnly: true })]));
    assert.deepEqual(cyclesOf(graph), ['a.ts -> b.ts -> a.ts']);
  });

  it('leaves a type-only import out of the runtime graph, and keeps a value import', () => {
    const source = ["import type { B } from './b.ts';", "import { type C } from './c.ts';", "import { d } from './d.ts';", "export type { E } from './e.ts';", "export { f } from './f.ts';"].join('\n');
    assert.deepEqual(importsOf(source, { runtimeOnly: true }), ['c.ts', 'd.ts', 'f.ts']);
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
});
