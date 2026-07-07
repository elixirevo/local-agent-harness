import { configKey, type EvalConfig, type RunResult } from './runner.js';

export interface EvalReport {
  startedAt: string;
  results: RunResult[];
}

/** Plain-text matrix report: one block per config cell, one line per run. */
export function formatReport(report: EvalReport): string {
  const byConfig = new Map<string, RunResult[]>();
  for (const r of report.results) {
    const key = configKey(r.config);
    const list = byConfig.get(key) ?? [];
    list.push(r);
    byConfig.set(key, list);
  }

  const lines: string[] = [];
  for (const [key, runs] of byConfig) {
    lines.push(`=== ${key} ===`);
    lines.push(
      pad('scenario', 26) + pad('ok', 4) + pad('steps', 7) + pad('tools', 7) + pad('t.err', 7) + pad('parse✗', 8) + pad('guard', 7) + pad('cmp', 5) + pad('wall', 8) + 'detail',
    );
    for (const r of runs) {
      lines.push(
        pad(r.scenarioId, 26) +
          pad(r.success ? '✓' : '✗', 4) +
          pad(String(r.steps), 7) +
          pad(String(r.toolCalls), 7) +
          pad(String(r.toolErrors), 7) +
          pad(String(r.parseFailures), 8) +
          pad(String(r.guardStops), 7) +
          pad(String(r.compactions), 5) +
          pad(`${(r.wallMs / 1000).toFixed(1)}s`, 8) +
          r.detail,
      );
    }
    lines.push(summaryLine(runs));
    lines.push('');
  }
  if (byConfig.size > 1) {
    lines.push('=== matrix summary ===');
    for (const [key, runs] of byConfig) lines.push(`${pad(key, 56)} ${successRate(runs)}`);
  }
  return lines.join('\n');
}

function summaryLine(runs: RunResult[]): string {
  const ok = runs.filter((r) => r.success).length;
  const avg = (f: (r: RunResult) => number) =>
    runs.length === 0 ? 0 : runs.reduce((a, r) => a + f(r), 0) / runs.length;
  const prefillPerKtok =
    runs.reduce((a, r) => a + r.prefillMsTotal, 0) /
    Math.max(1, runs.reduce((a, r) => a + r.promptTokensMax, 0) / 1000);
  const parts = [
    `TOTAL ${ok}/${runs.length}`,
    `avg steps ${avg((r) => r.steps).toFixed(1)}`,
    `tool errors ${runs.reduce((a, r) => a + r.toolErrors, 0)}`,
    `parse fails ${runs.reduce((a, r) => a + r.parseFailures, 0)}`,
    `guards ${runs.reduce((a, r) => a + r.guardStops, 0)}`,
    `compactions ${runs.reduce((a, r) => a + r.compactions, 0)}`,
    `avg wall ${(avg((r) => r.wallMs) / 1000).toFixed(1)}s`,
  ];
  if (Number.isFinite(prefillPerKtok) && prefillPerKtok > 0) {
    parts.push(`prefill ~${prefillPerKtok.toFixed(0)}ms/1k-tok`);
  }
  return parts.join(' · ');
}

function successRate(runs: RunResult[]): string {
  const ok = runs.filter((r) => r.success).length;
  return `${ok}/${runs.length} (${Math.round((ok / Math.max(1, runs.length)) * 100)}%)`;
}

function pad(s: string, width: number): string {
  // pad by display-ish length; wide glyphs (✓/✗) count as 1 which is fine here
  return s.length >= width ? `${s.slice(0, width - 1)} ` : s + ' '.repeat(width - s.length);
}

export function buildConfigMatrix(opts: {
  models: string[];
  tiers: string[];
  protocols: string[];
  temps: string[];
}): EvalConfig[] {
  const out: EvalConfig[] = [];
  for (const model of opts.models) {
    for (const tier of opts.tiers) {
      for (const protocol of opts.protocols) {
        for (const temp of opts.temps.length > 0 ? opts.temps : ['profile']) {
          out.push({
            model,
            tier: tier as EvalConfig['tier'],
            protocol: protocol as EvalConfig['protocol'],
            temperature: temp === 'profile' ? undefined : Number(temp),
          });
        }
      }
    }
  }
  return out;
}
