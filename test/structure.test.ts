import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const SRC = new URL('../src/', import.meta.url).pathname;
const MAX_LINES = 1000;
const TICKET_DECISION = /decisions? \d+/i;
/** A `/` after one of these starts a regular expression; after anything else it divides. */
const BEFORE_REGEX = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);

type Comment = { line: number; text: string };

/** Every `//` comment and block comment in `source` with its first line. String, template and regex literals are not comments. */
export function commentsOf(source: string): Comment[] {
  const comments: Comment[] = [];
  let line = 1;
  let prev = '';

  function skipQuoted(from: number, quote: string) {
    let at = from + 1;
    while (at < source.length && source[at] !== quote && source[at] !== '\n') at += source[at] === '\\' ? 2 : 1;
    return at + 1;
  }

  function skipTemplate(from: number) {
    let at = from + 1;
    while (at < source.length && source[at] !== '`') {
      if (source[at] === '\\') at += 2;
      else if (source[at] === '$' && source[at + 1] === '{') at = scan(at + 2, true);
      else {
        if (source[at] === '\n') line++;
        at++;
      }
    }
    return at + 1;
  }

  function skipRegex(from: number) {
    let at = from + 1;
    let inClass = false;
    while (at < source.length && source[at] !== '\n' && (inClass || source[at] !== '/')) {
      if (source[at] === '\\') at++;
      else if (source[at] === '[') inClass = true;
      else if (source[at] === ']') inClass = false;
      at++;
    }
    return at + 1;
  }

  function scan(from: number, untilBrace: boolean) {
    let depth = 0;
    let at = from;
    while (at < source.length) {
      const ch = source[at] as string;
      const next = source[at + 1];
      if (ch === '\n') {
        line++;
        at++;
      } else if (ch === ' ' || ch === '\t' || ch === '\r') {
        at++;
      } else if (ch === '/' && next === '/') {
        const end = source.indexOf('\n', at);
        const stop = end === -1 ? source.length : end;
        comments.push({ line, text: source.slice(at, stop) });
        at = stop;
      } else if (ch === '/' && next === '*') {
        const end = source.indexOf('*/', at + 2);
        const stop = end === -1 ? source.length : end + 2;
        const text = source.slice(at, stop);
        comments.push({ line, text });
        line += text.split('\n').length - 1;
        at = stop;
      } else if (ch === "'" || ch === '"') {
        at = skipQuoted(at, ch);
        prev = ch;
      } else if (ch === '`') {
        at = skipTemplate(at);
        prev = ch;
      } else if (ch === '/' && (BEFORE_REGEX.has(prev) || /\b(?:return|typeof|case|yield|await)$/.test(source.slice(Math.max(0, at - 8), at).trimEnd()))) {
        at = skipRegex(at);
        prev = ')';
      } else {
        if (untilBrace && ch === '{') depth++;
        if (untilBrace && ch === '}') {
          if (depth === 0) return at + 1;
          depth--;
        }
        prev = ch;
        at++;
      }
    }
    return at;
  }

  scan(0, false);
  return comments;
}

/** One message per comment line that cites a ticket decision number. */
export function decisionCitations(file: string, source: string) {
  return commentsOf(source).flatMap(comment =>
    comment.text.split('\n').flatMap((text, offset) => (TICKET_DECISION.test(text) ? [`${file}:${comment.line + offset}: comment cites a ticket decision number: ${text.trim()}`] : [])),
  );
}

/** The files `source` imports from its own directory, by its `from './x.ts'` lines and its side-effect `import './x.ts'` lines. */
export function importsOf(source: string) {
  return source.split('\n').flatMap(text => {
    const from = /^\s*(?:(?:import|export)\b.*|\})\s*from\s+['"]\.\/([^'"]+\.ts)['"]|^\s*import\s+['"]\.\/([^'"]+\.ts)['"]/.exec(text);
    const target = from?.[1] ?? from?.[2];
    return target === undefined ? [] : [target];
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

  it('ignores decision numbers in string, template and regex literals', () => {
    const source = ["const a = 'decision 4 // not a comment';", 'const b = `Breaks decision ${n} /* nor this */ decision 5`;', 'const c = /decision 6\\/\\/ x/;', 'const d = "it\'s decision 7";', 'const e = x / 2; // fine'].join('\n');
    assert.deepEqual(decisionCitations('src/x.ts', source), []);
  });

  it('still finds a comment after a template with a nested expression', () => {
    const source = 'const a = `${f(`in ${g}`)} text`;\n// decision 9\n';
    assert.deepEqual(decisionCitations('src/x.ts', source), ['src/x.ts:2: comment cites a ticket decision number: // decision 9']);
  });

  it('reads every sibling import, including type imports, but not packages', () => {
    const source = ["import { a } from './a.ts';", "import type { B } from './b.ts';", 'import {', '  c,', "} from './c.ts';", 'export { e } from "./e.ts";', "import './s.ts';", 'import "./t.ts"', "import { x } from 'node:fs';"].join('\n');
    assert.deepEqual(importsOf(source), ['a.ts', 'b.ts', 'c.ts', 'e.ts', 's.ts', 't.ts']);
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
});

describe('structure of src/', () => {
  it('has no comment that cites a ticket decision number', () => {
    assert.deepEqual(files.flatMap(file => decisionCitations(`src/${file.name}`, file.source)), []);
  });

  it(`has no file over ${MAX_LINES} lines`, () => {
    const long = files.filter(file => lineCount(file.source) > MAX_LINES).map(file => `src/${file.name}:${lineCount(file.source)}: ${lineCount(file.source)} lines, over the limit of ${MAX_LINES}`);
    assert.deepEqual(long, []);
  });

  it('has no import cycle', () => {
    const graph = new Map(files.map(file => [file.name, importsOf(file.source)]));
    assert.deepEqual(cyclesOf(graph), []);
  });
});
