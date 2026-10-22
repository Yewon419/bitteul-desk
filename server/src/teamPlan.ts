/**
 * Team plans: before the MD brings anyone in, it submits a plan (who does what) and the
 * permissions the work needs. The user approves it once in the chat; after that, requests
 * inside the approved scope are allowed without asking, and every decision is written to
 * an audit log (~/.pixel-agents/bitteul-team-audit.jsonl).
 */

import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk' with {
  'resolution-mode': 'import',
};
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { LAYOUT_FILE_DIR } from './constants.js';

export const PLAN_SERVER = 'bitteul';
export const PLAN_TOOL_NAME = 'submit_team_plan';
/** The plan tool as the model and canUseTool see it. */
export const PLAN_TOOL = `mcp__${PLAN_SERVER}__${PLAN_TOOL_NAME}`;
/** Waiting for the user to read a plan can take hours; the default MCP timeout cannot. */
const PLAN_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const AUDIT_FILE = 'bitteul-team-audit.jsonl';

export type PlanPermissionKind = 'files' | 'command' | 'web';

export interface PlanPermission {
  kind: PlanPermissionKind;
  /** files: a folder; command: how the command starts; web: a domain, or "search". */
  scope: string;
  why: string;
}

export interface TeamPlan {
  summary: string;
  assignments: Array<{ member: string; task: string }>;
  permissions: PlanPermission[];
}

export interface PlanDecision {
  approved: boolean;
  feedback?: string;
}

const FILE_TOOLS: Record<string, string> = {
  Write: 'file_path',
  Edit: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
  Read: 'file_path',
};
const COMMAND_TOOLS = new Set(['Bash', 'PowerShell']);
/** Anything that chains, redirects or substitutes could run more than the approved prefix. */
const SHELL_META = /[;&|`$<>\r\n]/;

function within(dir: string, file: string): boolean {
  const norm = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p);
  const rel = path.relative(norm(dir), norm(file));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** The approved permission a tool request falls under, or null when the user must be asked. */
export function planAllows(
  plan: TeamPlan,
  cwd: string,
  toolName: string,
  input: Record<string, unknown>,
): PlanPermission | null {
  const fileKey = FILE_TOOLS[toolName];
  if (fileKey) {
    const file = input[fileKey];
    if (typeof file !== 'string' || !file) return null;
    const target = path.resolve(cwd, file);
    return (
      plan.permissions.find(
        (p) => p.kind === 'files' && within(path.resolve(cwd, p.scope), target),
      ) ?? null
    );
  }
  if (COMMAND_TOOLS.has(toolName)) {
    const command = typeof input.command === 'string' ? input.command.trim() : '';
    if (!command || SHELL_META.test(command)) return null;
    return (
      plan.permissions.find((p) => {
        const prefix = p.scope.trim();
        return (
          p.kind === 'command' &&
          !!prefix &&
          (command === prefix || command.startsWith(`${prefix} `))
        );
      }) ?? null
    );
  }
  if (toolName === 'WebSearch') {
    return plan.permissions.find((p) => p.kind === 'web' && p.scope.trim() === 'search') ?? null;
  }
  if (toolName === 'WebFetch') {
    let host: string;
    try {
      host = new URL(String(input.url)).hostname.toLowerCase();
    } catch {
      return null;
    }
    return (
      plan.permissions.find((p) => {
        const domain = p.scope.trim().toLowerCase();
        return p.kind === 'web' && !!domain && (host === domain || host.endsWith(`.${domain}`));
      }) ?? null
    );
  }
  return null;
}

/** The in-process MCP server carrying the plan tool. `submit` resolves once the user decides. */
export async function planServer(
  submit: (plan: TeamPlan) => Promise<PlanDecision>,
): Promise<McpSdkServerConfigWithInstance> {
  const { createSdkMcpServer, tool } = await import('@anthropic-ai/claude-agent-sdk');
  const { z } = await import('zod/v4');
  const submitPlan = tool(
    PLAN_TOOL_NAME,
    'Submit the team plan to the user and wait for approval. Call it before bringing any member in, and again with a revised plan when the work needs permissions the approved plan does not cover.',
    {
      summary: z.string().describe('The plan in a few short lines, in the language of the brief.'),
      assignments: z
        .array(z.object({ member: z.string(), task: z.string() }))
        .describe('Who does what: member key and their task.'),
      permissions: z
        .array(
          z.object({
            kind: z.enum(['files', 'command', 'web']),
            scope: z
              .string()
              .describe(
                'files: the folder members will write in; command: how the command starts, e.g. "npm run"; web: a domain, or "search" for web search.',
              ),
            why: z.string().describe('Why the team needs it, in one short line.'),
          }),
        )
        .describe('Everything the team will need to do without asking each time. Keep it narrow.'),
    },
    async (args) => {
      const decision = await submit(args);
      const text = decision.approved
        ? 'The user approved the plan. Requests inside the approved permissions now run without asking; anything else still asks the user. Bring the members in and start.'
        : `The user did not approve the plan.${decision.feedback ? ` Their feedback: ${decision.feedback}` : ''} Revise the plan and submit it again; do not start the work yet.`;
      return { content: [{ type: 'text', text }] };
    },
    { alwaysLoad: true },
  );
  return createSdkMcpServer({
    name: PLAN_SERVER,
    tools: [submitPlan],
    timeout: PLAN_TIMEOUT_MS,
  });
}

export interface AuditEntry {
  sessionId: string;
  member?: string;
  tool: string;
  summary: string;
  decision: 'auto-allowed' | 'allowed' | 'denied' | 'plan-approved' | 'plan-rejected';
  rule?: string;
}

/** One line per decision; a failed write is logged, never fatal to the session. */
export function appendAudit(
  entry: AuditEntry,
  log: (msg: string, extra?: Record<string, unknown>) => void,
  file: string = path.join(os.homedir(), LAYOUT_FILE_DIR, AUDIT_FILE),
): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
  } catch (err) {
    log('team audit write failed', { file, error: String(err) });
  }
}

export function describePermission(p: PlanPermission): string {
  return `${p.kind}:${p.scope}`;
}
