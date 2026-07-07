import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from '../config/config.js';
import { resolveProfile } from '../models/profile.js';
import { createProvider } from '../providers/index.js';
import { selectScenarios } from './scenarios.js';
import { buildConfigMatrix, formatReport, type EvalReport } from './report.js';
import { runScenario, configKey } from './runner.js';

const EVAL_USAGE = `harness eval — run the scenario suite across a model×settings matrix

Usage:
  harness eval --model <id> [--model <id>]... [options]

Options (repeatable flags form the matrix):
  --model <id>        model id (default: config.defaultModel or first available)
  --tier <t>          minimal | standard | full (default: each model's profile tier)
  --protocol <p>      native | text (default: from each model's profile)
  --temp <x>          temperature override; "profile" keeps the profile value
  --scenario <id>     run only these scenario ids
  --runs <n>          repetitions per cell (default 1)
  --heavy             include heavy scenarios (long compaction runs)
  --provider <name>   provider from config (default: config.defaultProvider)
  --list              list scenario ids and exit
  -h, --help          show this help

The report prints per-cell tables and a matrix summary; raw results are
saved as JSON under .harness/eval/.`;

export async function evalMain(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      model: { type: 'string', multiple: true },
      tier: { type: 'string', multiple: true },
      protocol: { type: 'string', multiple: true },
      temp: { type: 'string', multiple: true },
      scenario: { type: 'string', multiple: true },
      runs: { type: 'string' },
      heavy: { type: 'boolean' },
      provider: { type: 'string' },
      list: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  if (values.help) {
    console.log(EVAL_USAGE);
    return;
  }

  const scenarios = selectScenarios(values.scenario, values.heavy ?? false);
  if (values.list) {
    for (const s of selectScenarios(undefined, true)) {
      console.log(`${s.id}  (${s.kind}${s.heavy ? ', heavy' : ''}${s.subagent ? `, ${s.subagent} subagent` : ''})`);
    }
    return;
  }

  const config = loadConfig();
  const providerName = values.provider ?? config.defaultProvider;
  const providerCfg = config.providers[providerName];
  if (!providerCfg) throw new Error(`unknown provider "${providerName}"`);
  const provider = createProvider(providerName, providerCfg);

  let models = values.model ?? [];
  if (models.length === 0) {
    const fallback = config.defaultModel ?? (await provider.listModels())[0];
    if (!fallback) throw new Error('no model specified and none available');
    models = [fallback];
  }

  for (const t of values.tier ?? []) {
    if (!['minimal', 'standard', 'full'].includes(t)) throw new Error(`invalid --tier ${t}`);
  }
  for (const p of values.protocol ?? []) {
    if (!['native', 'text'].includes(p)) throw new Error(`invalid --protocol ${p}`);
  }

  const runs = Number.parseInt(values.runs ?? '1', 10);
  if (!Number.isFinite(runs) || runs < 1) throw new Error(`invalid --runs ${values.runs}`);

  // Per-model defaults: tier/protocol come from the profile unless forced.
  const cells = models.flatMap((model) => {
    const profile = resolveProfile(model, config.models);
    return buildConfigMatrix({
      models: [model],
      tiers: values.tier ?? [profile.promptTier],
      protocols: values.protocol ?? [profile.nativeToolCalls ? 'native' : 'text'],
      temps: values.temp ?? [],
    });
  });

  const total = cells.length * scenarios.length * runs;
  console.log(
    `eval: ${scenarios.length} scenario(s) × ${cells.length} config cell(s) × ${runs} run(s) = ${total} runs on ${providerName}\n`,
  );

  const report: EvalReport = { startedAt: new Date().toISOString(), results: [] };
  let done = 0;
  for (const cell of cells) {
    for (const scenario of scenarios) {
      for (let i = 0; i < runs; i++) {
        const result = await runScenario(scenario, cell, provider, config);
        report.results.push(result);
        done++;
        console.log(
          `[${done}/${total}] ${configKey(cell)} · ${scenario.id} → ${result.success ? '✓' : '✗'} (${(result.wallMs / 1000).toFixed(1)}s) ${result.detail}`,
        );
      }
    }
  }

  console.log(`\n${formatReport(report)}`);

  const outDir = path.join(process.cwd(), '.harness', 'eval');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = report.startedAt.replace(/[:.]/g, '-');
  const outFile = path.join(outDir, `eval-${stamp}.json`);
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2), 'utf8');
  console.log(`\nraw results: ${outFile}`);
}
