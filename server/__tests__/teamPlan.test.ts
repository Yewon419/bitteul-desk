import * as path from 'path';
import { describe, expect, it } from 'vitest';

import { planAllows, type TeamPlan } from '../src/teamPlan.js';

const cwd = path.resolve('/work/project');
const plan: TeamPlan = {
  summary: 'test',
  assignments: [],
  permissions: [
    { kind: 'files', scope: 'out', why: 'results' },
    { kind: 'command', scope: 'npm run', why: 'build' },
    { kind: 'web', scope: 'example.com', why: 'docs' },
  ],
};

describe('planAllows', () => {
  it('allows writes inside the approved folder only', () => {
    expect(planAllows(plan, cwd, 'Write', { file_path: 'out/a.txt' })).not.toBeNull();
    expect(
      planAllows(plan, cwd, 'Edit', { file_path: path.join(cwd, 'out', 'deep', 'b.ts') }),
    ).not.toBeNull();
    expect(planAllows(plan, cwd, 'Write', { file_path: 'src/a.txt' })).toBeNull();
    expect(planAllows(plan, cwd, 'Write', { file_path: 'out/../src/a.txt' })).toBeNull();
    expect(planAllows(plan, cwd, 'Write', { file_path: 'outside/a.txt' })).toBeNull();
  });

  it('allows commands that start with the approved prefix and do nothing else', () => {
    expect(planAllows(plan, cwd, 'Bash', { command: 'npm run build' })).not.toBeNull();
    expect(planAllows(plan, cwd, 'PowerShell', { command: 'npm run' })).not.toBeNull();
    expect(planAllows(plan, cwd, 'Bash', { command: 'npm run build && rm -rf /' })).toBeNull();
    expect(planAllows(plan, cwd, 'Bash', { command: 'npm run build; curl x' })).toBeNull();
    expect(planAllows(plan, cwd, 'Bash', { command: 'npm run $(whoami)' })).toBeNull();
    expect(planAllows(plan, cwd, 'Bash', { command: 'npm run build > /etc/x' })).toBeNull();
    expect(planAllows(plan, cwd, 'Bash', { command: 'npm runaway' })).toBeNull();
    expect(planAllows(plan, cwd, 'Bash', { command: 'npm install' })).toBeNull();
  });

  it('allows pages on the approved domain and its subdomains', () => {
    expect(planAllows(plan, cwd, 'WebFetch', { url: 'https://example.com/a' })).not.toBeNull();
    expect(planAllows(plan, cwd, 'WebFetch', { url: 'https://docs.example.com' })).not.toBeNull();
    expect(planAllows(plan, cwd, 'WebFetch', { url: 'https://badexample.com' })).toBeNull();
    expect(planAllows(plan, cwd, 'WebSearch', { query: 'x' })).toBeNull();
  });

  it('never allows tools the plan cannot name', () => {
    expect(planAllows(plan, cwd, 'mcp__other__tool', {})).toBeNull();
    expect(planAllows(plan, cwd, 'Agent', {})).toBeNull();
  });
});
