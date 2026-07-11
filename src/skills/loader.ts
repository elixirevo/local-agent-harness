import fs from 'node:fs';
import path from 'node:path';

/**
 * Skills: file-stored workflows expanded into the turn prompt via /name.
 * Loaded once at startup (session-static, cache-safe) from the user's own
 * directories only — a skill is prompt injection by design, so third-party
 * skills should be reviewed like code before installing.
 */

export interface Skill {
  name: string;
  description: string;
  body: string;
  /** File it was loaded from, for /help and warnings. */
  source: string;
}

export interface SkillsLoad {
  skills: Skill[];
  warnings: string[];
}

export interface LoadOptions {
  /** Project skills: <cwd>/.harness/skills — shadows global on name clash. */
  projectDir: string;
  /** Global skills: ~/.harness/skills. */
  globalDir?: string;
  /** Built-in command names skills may not take (without the slash). */
  reserved?: Set<string>;
}

const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/i;

export function loadSkills(opts: LoadOptions): SkillsLoad {
  const warnings: string[] = [];
  const byName = new Map<string, Skill>();
  const reserved = opts.reserved ?? new Set();

  // Global first, project second — later set() wins, giving project shadowing.
  for (const dir of [opts.globalDir, opts.projectDir]) {
    if (!dir || !fs.existsSync(dir)) continue;
    const seenInScope = new Set<string>();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      let file: string | undefined;
      let defaultName: string | undefined;
      if (entry.isFile() && entry.name.endsWith('.md')) {
        file = path.join(dir, entry.name);
        defaultName = entry.name.slice(0, -3);
      } else if (entry.isDirectory()) {
        const candidate = path.join(dir, entry.name, 'SKILL.md');
        if (fs.existsSync(candidate)) {
          file = candidate;
          defaultName = entry.name;
        }
      }
      if (!file || !defaultName) continue;

      let raw: string;
      try {
        raw = fs.readFileSync(file, 'utf8');
      } catch (e) {
        warnings.push(`${file}: unreadable (${(e as Error).message})`);
        continue;
      }
      const { meta, body, malformed } = parseFrontmatter(raw);
      if (malformed) warnings.push(`${file}: frontmatter has no closing "---" — treating the whole file as the body`);

      const name = meta.name ?? defaultName;
      if (!NAME_RE.test(name)) {
        warnings.push(`${file}: invalid skill name "${name}" (letters/digits/-/_ only) — skipped`);
        continue;
      }
      const key = name.toLowerCase();
      if (reserved.has(key)) {
        warnings.push(`${file}: "${name}" collides with a built-in command — skipped`);
        continue;
      }
      if (!body) {
        warnings.push(`${file}: empty body — skipped`);
        continue;
      }
      let description = meta.description;
      if (!description) {
        warnings.push(`${file}: missing description — it will show as "(no description)"`);
        description = '(no description)';
      }
      if (seenInScope.has(key)) warnings.push(`${file}: duplicate skill "${name}" in the same directory — the later file wins`);
      seenInScope.add(key);
      byName.set(key, { name, description, body, source: file });
    }
  }

  return {
    skills: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
    warnings,
  };
}

/**
 * Expand a skill into the turn prompt. $ARGUMENTS is replaced with the
 * invocation args; without a placeholder, args are appended as an Input
 * line. The step-by-step framing is what makes skills lift small models —
 * they follow given steps far better than they plan their own.
 */
export function expandSkill(skill: Skill, args: string): string {
  let body = skill.body;
  if (body.includes('$ARGUMENTS')) {
    body = body.split('$ARGUMENTS').join(args);
  } else if (args) {
    body = `${body}\n\nInput: ${args}`;
  }
  return `Follow this workflow step by step:\n\n${body}`;
}

function parseFrontmatter(raw: string): {
  meta: Record<string, string>;
  body: string;
  malformed: boolean;
} {
  const text = raw.replace(/\r\n/g, '\n');
  if (!text.startsWith('---\n')) return { meta: {}, body: text.trim(), malformed: false };
  const close = text.indexOf('\n---', 3);
  if (close === -1) return { meta: {}, body: text.trim(), malformed: true };
  const header = text.slice(4, close);
  const afterClose = text.indexOf('\n', close + 1);
  const body = afterClose === -1 ? '' : text.slice(afterClose + 1).trim();
  const meta: Record<string, string> = {};
  for (const line of header.split('\n')) {
    const m = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (m) meta[m[1].toLowerCase()] = m[2].trim();
  }
  return { meta, body, malformed: false };
}
