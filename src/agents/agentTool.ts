import type { PromptTier } from '../models/profile.js';
import { err, type Tool, type ToolResult } from '../tools/types.js';
import { runSubagent, SUBAGENT_TYPES, type SubagentDeps, type SubagentType } from './subagent.js';

/**
 * Factory instead of a singleton: the tool needs the live session (provider,
 * model, config), which only the CLI owns — injecting a getter keeps
 * core/tools free of that dependency and lets /model switches flow through.
 */
export function createAgentTool(deps: () => SubagentDeps): Tool {
  return {
    name: 'Agent',
    isReadOnly: false, // verify runs commands; readonly sessions exclude it entirely

    inputSchema: {
      type: 'object',
      properties: {
        agent_type: {
          type: 'string',
          enum: [...SUBAGENT_TYPES],
          description: '"explore" for read-only codebase search, "verify" for adversarial verification',
        },
        prompt: { type: 'string', description: 'Self-contained task briefing for the subagent' },
      },
      required: ['agent_type', 'prompt'],
    },

    description(tier: PromptTier): string {
      if (tier === 'minimal') {
        return 'Delegate to a subagent: "explore" (read-only codebase search) or "verify" (runs checks, returns VERDICT: PASS|FAIL|PARTIAL). Write a self-contained prompt — it cannot see this conversation.';
      }
      return [
        'Delegates a task to a specialized subagent that runs its own tool loop and returns a final report.',
        '- agent_type "explore": READ-ONLY codebase search and analysis. Use for broad searches that would flood your context with intermediate results; for a single targeted lookup, use Glob/Grep/Read yourself.',
        '- agent_type "verify": adversarially verifies finished work by running commands. Its report ends with "VERDICT: PASS", "VERDICT: FAIL", or "VERDICT: PARTIAL". Use after non-trivial implementation work.',
        '- Brief it like a capable colleague who has NOT seen this conversation: include concrete file paths, what to check or find, and what a good answer looks like. Never write "as discussed above".',
        '- The subagent cannot spawn further agents and cannot modify project files.',
      ].join('\n');
    },

    summarize(input) {
      const p = String(input.prompt ?? '').replace(/\s+/g, ' ');
      return `${input.agent_type}: ${p.length > 60 ? `${p.slice(0, 60)}…` : p}`;
    },

    async call(input): Promise<ToolResult> {
      const type = input.agent_type as SubagentType;
      const prompt = input.prompt as string;
      const result = await runSubagent(deps(), type, prompt);
      if (type === 'verify' && !result.verdict) {
        return {
          ok: true,
          output: `${result.report}\n\n(note: the verifier did not produce a parseable VERDICT line — treat the result as PARTIAL)`,
          display: `${result.steps} steps · no verdict`,
        };
      }
      return {
        ok: true,
        output: result.report,
        display: `${result.steps} steps · ${result.toolCalls} tools${result.verdict ? ` · ${result.verdict}` : ''}${result.guardStopped ? ' · guard-stopped' : ''}`,
      };
    },
  };
}

export { err };
