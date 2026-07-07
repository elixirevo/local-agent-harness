import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export type ScenarioKind = 'edit' | 'debug' | 'multistep' | 'search' | 'agent';

export interface CheckResult {
  success: boolean;
  detail: string;
}

export interface Scenario {
  id: string;
  kind: ScenarioKind;
  /** Seed the scratch project. */
  setup(dir: string): void;
  /** User turns fed to the agent in order. */
  turns: string[];
  /** Programmatic success check — never trusts the model's own claims. */
  check(dir: string, finalAnswer: string): CheckResult;
  /** Force a small context window (compaction stress). */
  contextLength?: number;
  /** Excluded from the default suite unless --heavy. */
  heavy?: boolean;
  /** Run through a subagent directly instead of the main loop. */
  subagent?: 'explore' | 'verify';
  timeoutMs?: number;
}

function write(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
}

function read(dir: string, rel: string): string {
  try {
    return fs.readFileSync(path.join(dir, rel), 'utf8');
  } catch {
    return '';
  }
}

/** Run a node script; success = exit 0. stderr stays captured (execSync leaks it to the parent by default). */
function runNode(dir: string, script: string): { ok: boolean; output: string } {
  try {
    const output = execFileSync('node', [script], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 10000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, output };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message: string };
    return { ok: false, output: `${err.stdout ?? ''}${err.stderr ?? ''}` || err.message };
  }
}

const CALC_BUGGY = `function add(a, b) {
  return a - b;
}

function multiply(a, b) {
  return a * b;
}

module.exports = { add, multiply };
`;

const CALC_TEST = `const { add, multiply } = require('./src/calc');
let failed = 0;
function check(name, actual, expected) {
  if (actual !== expected) { console.error('FAIL ' + name); failed++; }
}
check('add', add(2, 3), 5);
check('add-neg', add(-1, 1), 0);
check('multiply', multiply(4, 5), 20);
if (failed) { console.error(failed + ' failed'); process.exit(1); }
console.log('all tests passed');
`;

export const SCENARIOS: Scenario[] = [
  // ---- edit ----
  {
    id: 'edit-fix-operator',
    kind: 'edit',
    setup: (dir) => write(dir, { 'src/calc.js': CALC_BUGGY, 'test.js': CALC_TEST }),
    turns: ['Fix the bug in src/calc.js: the add function must return a plus b, but it subtracts.'],
    check: (dir) => {
      const r = runNode(dir, 'test.js');
      return { success: r.ok, detail: r.ok ? 'tests pass' : `tests fail: ${r.output.slice(0, 120)}` };
    },
  },
  {
    id: 'edit-rename-all',
    kind: 'edit',
    setup: (dir) =>
      write(dir, {
        'src/util.js': `function calcTotal(items) {\n  return items.length;\n}\nconst a = calcTotal([1]);\nconst b = calcTotal([1, 2]);\nmodule.exports = { calcTotal, a, b };\n`,
      }),
    turns: ['In src/util.js, rename the function calcTotal to countItems everywhere (definition, calls, and export).'],
    check: (dir) => {
      const content = read(dir, 'src/util.js');
      const renamed = content.includes('countItems') && !content.includes('calcTotal');
      const r = runNode(dir, 'src/util.js');
      return {
        success: renamed && r.ok,
        detail: renamed ? (r.ok ? 'renamed, still runs' : 'renamed but broken') : 'old name remains',
      };
    },
  },
  {
    id: 'edit-create-file',
    kind: 'edit',
    setup: (dir) => write(dir, { 'src/app.js': `console.log('app');\n` }),
    turns: [
      'Create a new file src/greet.js that exports a function greet(name) returning the string "hello, " followed by the name. CommonJS module.exports.',
    ],
    check: (dir) => {
      write(dir, {
        '_check.js': `const { greet } = require('./src/greet');\nif (greet('kim') !== 'hello, kim') process.exit(1);\nconsole.log('ok');\n`,
      });
      const r = runNode(dir, '_check.js');
      return { success: r.ok, detail: r.ok ? 'greet works' : `broken: ${r.output.slice(0, 120)}` };
    },
  },
  // ---- debug ----
  {
    id: 'debug-null-crash',
    kind: 'debug',
    setup: (dir) =>
      write(dir, {
        'src/parse.js': `function firstWordLength(s) {\n  return s.split(' ')[0].length;\n}\nmodule.exports = { firstWordLength };\n`,
        'test.js': `const { firstWordLength } = require('./src/parse');\nif (firstWordLength('hi there') !== 2) { console.error('FAIL basic'); process.exit(1); }\nif (firstWordLength('') !== 0) { console.error('FAIL empty'); process.exit(1); }\nif (firstWordLength(null) !== 0) { console.error('FAIL null'); process.exit(1); }\nconsole.log('all tests passed');\n`,
      }),
    turns: ['node test.js fails. Find why and fix src/parse.js so all tests pass, then run node test.js to confirm.'],
    check: (dir) => {
      const r = runNode(dir, 'test.js');
      return { success: r.ok, detail: r.ok ? 'tests pass' : `tests fail: ${r.output.slice(0, 120)}` };
    },
  },
  {
    id: 'debug-off-by-one',
    kind: 'debug',
    setup: (dir) =>
      write(dir, {
        'src/range.js': `function sumUpTo(n) {\n  let total = 0;\n  for (let i = 1; i < n; i++) total += i;\n  return total;\n}\nmodule.exports = { sumUpTo };\n`,
        'test.js': `const { sumUpTo } = require('./src/range');\nif (sumUpTo(5) !== 15) { console.error('FAIL: sumUpTo(5)=' + sumUpTo(5) + ' expected 15'); process.exit(1); }\nconsole.log('all tests passed');\n`,
      }),
    turns: ['The test says sumUpTo(5) should be 15 (1+2+3+4+5) but it returns 10. Fix src/range.js and verify with node test.js.'],
    check: (dir) => {
      const r = runNode(dir, 'test.js');
      return { success: r.ok, detail: r.ok ? 'tests pass' : `tests fail: ${r.output.slice(0, 120)}` };
    },
  },
  {
    id: 'debug-wrong-export',
    kind: 'debug',
    setup: (dir) =>
      write(dir, {
        'src/config.js': `const settings = { retries: 3 };\nmodule.exports = { setting: settings };\n`,
        'test.js': `const { settings } = require('./src/config');\nif (!settings || settings.retries !== 3) { console.error('FAIL: settings missing'); process.exit(1); }\nconsole.log('all tests passed');\n`,
      }),
    turns: ['node test.js fails with "settings missing". Find the mismatch and fix src/config.js (the test file is correct), then verify.'],
    check: (dir) => {
      const r = runNode(dir, 'test.js');
      const testUntouched = read(dir, 'test.js').includes("require('./src/config')");
      return {
        success: r.ok && testUntouched,
        detail: r.ok ? (testUntouched ? 'fixed at source' : 'passed but test was modified') : 'tests fail',
      };
    },
  },
  // ---- multistep ----
  {
    id: 'multi-test-driven',
    kind: 'multistep',
    setup: (dir) => write(dir, { 'src/calc.js': CALC_BUGGY, 'test.js': CALC_TEST }),
    turns: ['Run node test.js, find why it fails, fix the code, and re-run the tests to confirm they pass.'],
    check: (dir, answer) => {
      const r = runNode(dir, 'test.js');
      const verified = /pass/i.test(answer);
      return {
        success: r.ok && verified,
        detail: r.ok ? (verified ? 'fixed and reported' : 'fixed but report unclear') : 'tests still fail',
      };
    },
  },
  {
    id: 'multi-search-edit',
    kind: 'multistep',
    setup: (dir) =>
      write(dir, {
        'src/a.js': `const x = 1;\nmodule.exports = x;\n`,
        'src/deep/limits.js': `const MAX_RETRIES = 3;\nmodule.exports = { MAX_RETRIES };\n`,
        'src/b.js': `const y = 2;\nmodule.exports = y;\n`,
      }),
    turns: ['Find where MAX_RETRIES is defined in this project and change its value from 3 to 5.'],
    check: (dir) => {
      const content = read(dir, 'src/deep/limits.js');
      return {
        success: content.includes('MAX_RETRIES = 5'),
        detail: content.includes('MAX_RETRIES = 5') ? 'found and changed' : 'value unchanged',
      };
    },
  },
  {
    id: 'multi-compaction-recall',
    kind: 'multistep',
    heavy: true,
    contextLength: 5000,
    timeoutMs: 420_000,
    setup: (dir) => {
      const files: Record<string, string> = { 'src/calc.js': CALC_BUGGY, 'test.js': CALC_TEST };
      const words = 'server database deployment latency rollout schedule budget review milestone target'.split(' ');
      for (const name of ['a', 'b', 'c', 'd', 'e']) {
        const lines = [`# Meeting notes ${name}\n`];
        for (let i = 0; i < 48; i++) {
          lines.push(`- Item ${i + 1}: ${Array.from({ length: 14 }, (_, k) => words[(i * 7 + k * 3) % words.length]).join(' ')}.`);
        }
        files[`notes/${name}.md`] = lines.join('\n');
      }
      write(dir, files);
    },
    turns: [
      'Remember this codeword: BLUEFROG-77. Just acknowledge it briefly, do not use any tools.',
      'Read notes/a.md and tell me its first item number.',
      'Read notes/b.md and tell me its first item number.',
      'Read notes/c.md and tell me its first item number.',
      'Read notes/d.md and tell me its first item number.',
      'Read notes/e.md and tell me its first item number.',
      'What was the codeword I gave you at the start?',
      'Now fix the bug in src/calc.js: the add function must return a plus b, but it subtracts. Edit it, then run node test.js and show the result.',
    ],
    check: (dir, answer) => {
      const r = runNode(dir, 'test.js');
      const recalled = answer.includes('BLUEFROG-77');
      return {
        success: r.ok && recalled,
        detail: `${recalled ? 'codeword recalled' : 'codeword LOST'} · ${r.ok ? 'tests pass' : 'tests fail'}`,
      };
    },
  },
  // ---- search (explore subagent, run directly) ----
  {
    id: 'explore-find-definition',
    kind: 'search',
    subagent: 'explore',
    setup: (dir) =>
      write(dir, {
        'src/a.js': `const helper = require('./deep/helpers');\nmodule.exports = helper;\n`,
        'src/deep/helpers.js': `function formatPrice(cents) {\n  return (cents / 100).toFixed(2);\n}\nmodule.exports = { formatPrice };\n`,
        'README.md': '# demo\n',
      }),
    turns: ['Find which file defines the function formatPrice and report its path and what the function does.'],
    check: (_dir, answer) => {
      const found = answer.includes('helpers.js');
      return { success: found, detail: found ? 'file identified' : 'file not identified' };
    },
  },
  // ---- agent (verify subagent, run directly) ----
  {
    id: 'verify-catches-failure',
    kind: 'agent',
    subagent: 'verify',
    setup: (dir) => write(dir, { 'src/calc.js': CALC_BUGGY, 'test.js': CALC_TEST }),
    turns: [
      'The add function in src/calc.js was just implemented. Verify it works correctly: the project test suite is "node test.js". Check edge cases too.',
    ],
    check: (_dir, answer) => {
      const verdict = answer.match(/VERDICT:\s*(PASS|FAIL|PARTIAL)/i)?.[1]?.toUpperCase();
      return {
        success: verdict === 'FAIL',
        detail: verdict ? `verdict ${verdict} (expected FAIL — code is buggy)` : 'no verdict line',
      };
    },
  },
  {
    id: 'verify-confirms-pass',
    kind: 'agent',
    subagent: 'verify',
    setup: (dir) =>
      write(dir, {
        'src/calc.js': CALC_BUGGY.replace('a - b', 'a + b'),
        'test.js': CALC_TEST,
      }),
    turns: [
      'The add function in src/calc.js was just implemented. Verify it works correctly: the project test suite is "node test.js". Check edge cases too.',
    ],
    check: (_dir, answer) => {
      const verdict = answer.match(/VERDICT:\s*(PASS|FAIL|PARTIAL)/i)?.[1]?.toUpperCase();
      return {
        success: verdict === 'PASS',
        detail: verdict ? `verdict ${verdict} (expected PASS — code is correct)` : 'no verdict line',
      };
    },
  },
];

export function selectScenarios(ids: string[] | undefined, heavy: boolean): Scenario[] {
  let list = SCENARIOS;
  if (ids && ids.length > 0) {
    const wanted = new Set(ids);
    list = list.filter((s) => wanted.has(s.id));
    const missing = ids.filter((id) => !SCENARIOS.some((s) => s.id === id));
    if (missing.length > 0) throw new Error(`unknown scenario id(s): ${missing.join(', ')}`);
    return list;
  }
  return heavy ? list : list.filter((s) => !s.heavy);
}
