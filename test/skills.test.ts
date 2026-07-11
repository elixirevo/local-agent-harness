import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { allCommands, resolveSkillInvocation } from '../src/cli/repl.js';
import { filterCommands } from '../src/cli/editor.js';
import { expandSkill, loadSkills, type Skill } from '../src/skills/loader.js';
import { tmpCtx } from './toolHelpers.js';

function seedSkills(base: string, files: Record<string, string>): string {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(base, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  return base;
}

const SKILL_MD = `---
name: fix-failing-test
description: find and fix the failing test
---
1. Run the tests.
2. Fix the cause.

Task input: $ARGUMENTS
`;

describe('loadSkills', () => {
  it('loads flat .md and folder SKILL.md forms with frontmatter', () => {
    const { dir } = tmpCtx();
    seedSkills(path.join(dir, 'skills'), {
      'fix-failing-test.md': SKILL_MD,
      'review/SKILL.md': '---\ndescription: review the diff\n---\nLook at the diff.',
    });
    const { skills, warnings } = loadSkills({ projectDir: path.join(dir, 'skills') });
    expect(skills.map((s) => s.name)).toEqual(['fix-failing-test', 'review']);
    expect(skills[0].description).toBe('find and fix the failing test');
    expect(skills[1].name).toBe('review'); // folder name as default
    expect(warnings).toEqual([]);
  });

  it('warns on missing description and treats unclosed frontmatter as body', () => {
    const { dir } = tmpCtx();
    seedSkills(path.join(dir, 'skills'), {
      'no-desc.md': 'Just a body, no frontmatter.',
      'broken.md': '---\ndescription: never closed\nThe body swallowed the header.',
    });
    const { skills, warnings } = loadSkills({ projectDir: path.join(dir, 'skills') });
    expect(skills).toHaveLength(2);
    expect(skills.find((s) => s.name === 'no-desc')?.description).toBe('(no description)');
    expect(skills.find((s) => s.name === 'broken')?.body).toContain('description: never closed');
    expect(warnings.some((w) => w.includes('missing description'))).toBe(true);
    expect(warnings.some((w) => w.includes('no closing'))).toBe(true);
  });

  it('rejects reserved and invalid names, and empty bodies', () => {
    const { dir } = tmpCtx();
    seedSkills(path.join(dir, 'skills'), {
      'help.md': '---\ndescription: x\n---\nbody',
      'bad name.md': '---\nname: bad name\ndescription: x\n---\nbody',
      'empty.md': '---\ndescription: x\n---\n',
    });
    const { skills, warnings } = loadSkills({
      projectDir: path.join(dir, 'skills'),
      reserved: new Set(['help']),
    });
    expect(skills).toEqual([]);
    expect(warnings.some((w) => w.includes('collides with a built-in'))).toBe(true);
    expect(warnings.some((w) => w.includes('invalid skill name'))).toBe(true);
    expect(warnings.some((w) => w.includes('empty body'))).toBe(true);
  });

  it('lets project skills shadow global ones by name', () => {
    const { dir } = tmpCtx();
    const globalDir = seedSkills(path.join(dir, 'global'), {
      'deploy.md': '---\ndescription: global version\n---\nglobal body',
      'only-global.md': '---\ndescription: global only\n---\nbody',
    });
    const projectDir = seedSkills(path.join(dir, 'project'), {
      'deploy.md': '---\ndescription: project version\n---\nproject body',
    });
    const { skills } = loadSkills({ projectDir, globalDir });
    expect(skills.map((s) => s.name).sort()).toEqual(['deploy', 'only-global']);
    expect(skills.find((s) => s.name === 'deploy')?.body).toBe('project body');
  });

  it('handles missing directories without failing', () => {
    const { skills, warnings } = loadSkills({ projectDir: '/nonexistent/skills' });
    expect(skills).toEqual([]);
    expect(warnings).toEqual([]);
  });
});

describe('expandSkill', () => {
  const skill: Skill = { name: 's', description: 'd', body: 'Step 1.\n\nInput: $ARGUMENTS', source: 'x' };

  it('substitutes $ARGUMENTS and adds the step-by-step framing', () => {
    const out = expandSkill(skill, 'src/calc.js');
    expect(out).toContain('Follow this workflow step by step:');
    expect(out).toContain('Input: src/calc.js');
    expect(out).not.toContain('$ARGUMENTS');
  });

  it('appends an Input line when there is no placeholder', () => {
    const plain: Skill = { ...skill, body: 'Do the thing.' };
    expect(expandSkill(plain, 'now')).toContain('Do the thing.\n\nInput: now');
    expect(expandSkill(plain, '')).not.toContain('Input:');
  });
});

describe('skill invocation dispatch', () => {
  const skills: Skill[] = [
    { name: 'fix-failing-test', description: 'fix tests', body: 'Run tests. $ARGUMENTS', source: 'x' },
  ];

  it('resolves /name with args to the expanded prompt', () => {
    const inv = resolveSkillInvocation({ skills }, '/fix-failing-test src/calc.js please');
    expect(inv?.skill.name).toBe('fix-failing-test');
    expect(inv?.prompt).toContain('Run tests. src/calc.js please');
  });

  it('leaves built-ins and unknown commands alone', () => {
    expect(resolveSkillInvocation({ skills }, '/help')).toBeUndefined();
    expect(resolveSkillInvocation({ skills }, '/nope')).toBeUndefined();
    expect(resolveSkillInvocation({ skills }, 'plain text')).toBeUndefined();
  });

  it('shows up in the merged command list and the hint filter', () => {
    const commands = allCommands(skills);
    expect(commands.some((c) => c.name === '/fix-failing-test')).toBe(true);
    const hints = filterCommands(commands, '/fi');
    expect(hints.map((c) => c.name)).toEqual(['/fix-failing-test']);
  });
});
