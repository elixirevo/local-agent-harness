import type { PromptTier } from '../models/profile.js';
import type { PermissionMode } from '../permissions/gate.js';
import type { ToolRegistry } from '../tools/registry.js';

export type ToolProtocol = 'native' | 'text' | 'none';

export interface PromptBuildOptions {
  tier: PromptTier;
  protocol: ToolProtocol;
  mode: PermissionMode;
  registry: ToolRegistry;
  cwd: string;
}

/**
 * System prompt assembly with the static/dynamic boundary from the plan:
 * everything before the boundary depends only on (tier, protocol, mode) —
 * byte-identical across sessions, so inference-server prefix caches can share
 * it. Session-specific values (cwd) come after. Within a session the whole
 * string is constant either way; the ordering pays off across sessions and
 * keeps the discipline visible for Phase 3+.
 */
export function buildSystemPrompt(opts: PromptBuildOptions): string {
  return [...staticSections(opts), ...dynamicSections(opts)].join('\n\n');
}

/** Exposed for tests: the cross-session-cacheable prefix. */
export function staticSections(opts: PromptBuildOptions): string[] {
  const sections: string[] = [identity(opts), coreRules(opts)];
  if (opts.protocol === 'none') return sections; // plain chat — no agent sections
  if (opts.tier !== 'minimal') sections.push(...standardSections());
  if (opts.tier === 'full') sections.push(...fullSections());
  if (opts.protocol === 'text') sections.push(textProtocolSection(opts));
  return sections;
}

function dynamicSections(opts: PromptBuildOptions): string[] {
  return [`# Environment\nWorking directory: ${opts.cwd}\nPlatform: ${process.platform}`];
}

function identity(opts: PromptBuildOptions): string {
  return opts.protocol === 'none'
    ? 'You are a helpful assistant running on a locally hosted model. Be direct and concise.'
    : "You are a coding agent running on a local model, working inside the user's project through tools.";
}

function coreRules(opts: PromptBuildOptions): string {
  if (opts.protocol === 'none') return 'Answer from the conversation; you have no tools in this session.';
  const rules = [
    '- Never guess or invent file contents — read a file before you describe or change it.',
    '- Prefer Edit for changing existing files; use Write only for new files or full rewrites.',
    '- If a tool call fails, read the error message and fix the call — never repeat it unchanged.',
    '- When the task is done, stop calling tools and reply with a short summary of what you did.',
  ];
  return `# Rules\n${rules.join('\n')}`;
}

function standardSections(): string[] {
  return [
    [
      '# Using tools',
      '- Use dedicated tools for file work: Read (not cat), Grep (not grep/rg), Glob (not find/ls), Edit/Write (not sed/echo). Use Bash only for real commands: builds, tests, git, package managers.',
      '- Paths may be absolute or relative to the working directory.',
      '- Work step by step: run one tool, read its result, then decide the next call.',
    ].join('\n'),
    [
      '# Working carefully',
      '- Local, reversible actions (reading, editing project files, running tests) are fine to take freely. Destructive or hard-to-reverse actions (deleting files, git push, package publishing) require user approval — if it is denied, do not look for a workaround; ask the user.',
      '- Fix root causes, not symptoms. Never bypass safety checks (e.g. --no-verify).',
      '- Keep changes minimal: no refactors, comments, or "improvements" beyond what was asked.',
    ].join('\n'),
    [
      '# Reporting',
      '- Report outcomes honestly: if a test fails, say so and show the relevant output. Never claim success you did not verify.',
    ].join('\n'),
  ];
}

function fullSections(): string[] {
  return [
    [
      '# Verification',
      '- Before declaring a task complete, verify it: run the test, execute the script, check the output.',
      '- If you cannot verify (nothing to run), say so explicitly instead of implying success.',
      '- If the user reports a bug, reproduce it before changing code.',
    ].join('\n'),
  ];
}

/**
 * Tool-calling protocol for models without native tool-call support.
 * Static per (tier, mode): the tool list comes from the fixed registry.
 */
function textProtocolSection(opts: PromptBuildOptions): string {
  const tools = opts.registry.list(opts.mode);
  const toolDocs = tools
    .map((t) => {
      const schema = JSON.stringify(t.inputSchema.properties);
      const required = t.inputSchema.required?.length
        ? ` (required: ${t.inputSchema.required.join(', ')})`
        : '';
      return `## ${t.name}\n${t.description(opts.tier)}\nArguments${required}: ${schema}`;
    })
    .join('\n\n');
  return [
    '# How to call tools',
    'You do not have native tool-calling in this session. To use a tool, end your response with EXACTLY one block in this format and output NOTHING after the closing tag:',
    '',
    '<tool_call>',
    '{"name": "Read", "arguments": {"file_path": "src/app.ts"}}',
    '</tool_call>',
    '',
    'Protocol rules:',
    '- At most ONE tool call per response.',
    '- The result arrives in the next user message inside a <tool_result> block.',
    '- Use only the tools listed below with their exact names.',
    '- When the task is finished, answer normally WITHOUT any <tool_call> block.',
    '',
    '# Available tools',
    '',
    toolDocs,
  ].join('\n');
}
