/**
 * Bitteul teams: one dashboard session is the MD (team lead); the other members are named
 * background subagents defined through the SDK `agents` option. Members talk to each other
 * with the built-in SendMessage tool, which needs agent names, which an SDK session only
 * hands out while CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS is on. In an SDK session that flag
 * does not spawn real teammates; it only lets subagents be named and messaged.
 *
 * Which sessions are teams (and their roster) is stored in ~/.pixel-agents/bitteul-teams.json
 * so a team resumed after a server restart gets its members back.
 */

import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk' with {
  'resolution-mode': 'import',
};
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { LAYOUT_FILE_DIR } from './constants.js';
import { PLAN_TOOL, PLAN_TOOL_NAME, type TeamPlan } from './teamPlan.js';

const FILE_NAME = 'bitteul-teams.json';
const TEMPLATES_FILE = 'bitteul-team-templates.json';

export const TEAM_MODELS = ['opus', 'sonnet', 'haiku'] as const;
export const MAX_TEAM_MEMBERS = 8;
export const MAX_TEAM_NAME = 40;
export const MAX_TEAM_BUDGET_USD = 1000;
const MEMBER_KEY = /^[a-z][a-z0-9-]{0,30}$/;

export const TEAM_ENV = { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' } as const;

export interface TeamMember {
  /** Agent type and SendMessage name: ASCII so the model can address it exactly. */
  key: string;
  /** What the dashboard calls this member. */
  label: string;
  role: string;
  model: string;
}

export interface TeamRoster {
  /** Written on the team room's sign. */
  name: string;
  leadLabel: string;
  leadModel: string;
  members: TeamMember[];
  /** Work folder; absent means the folder the server runs in. */
  cwd?: string;
  /** Seats of the team room, MD first, then members in roster order. */
  seats?: number[];
  /** Spend cap in dollars for one run of the team; the SDK stops the session at it. */
  budgetUsd?: number;
}

export const DEFAULT_TEAM: TeamRoster = {
  name: '기본 팀',
  leadLabel: 'MD',
  leadModel: 'opus',
  budgetUsd: 5,
  members: [
    {
      key: 'planner',
      label: '기획자',
      role: '브리프를 구체적인 계획으로 바꿔요: 목표, 범위, 사용자 흐름, 디자이너와 개발자가 할 일 목록.',
      model: 'opus',
    },
    {
      key: 'designer',
      label: '디자이너',
      role: '계획에 맞춰 화면 구성, 레이아웃, 시각 스타일, 문구를 디자인하고 개발자가 바로 만들 수 있는 명세를 넘겨요.',
      model: 'sonnet',
    },
    {
      key: 'developer',
      label: '개발자',
      role: '계획과 디자인대로 만들고, 실행해 보고, 안 되는 곳을 고쳐요.',
      model: 'sonnet',
    },
  ],
};

/** Why a roster cannot run, or null when it can. */
export function rosterProblem(team: TeamRoster): string | null {
  if (!team.name.trim() || team.name.length > MAX_TEAM_NAME)
    return 'team name is empty or too long';
  if (!team.leadLabel.trim()) return 'the MD needs a name';
  if (team.members.length === 0) return 'a team needs at least one member';
  if (team.members.length > MAX_TEAM_MEMBERS) return `at most ${MAX_TEAM_MEMBERS} members`;
  const models: readonly string[] = TEAM_MODELS;
  if (!models.includes(team.leadModel)) return `unknown model ${team.leadModel}`;
  const keys = new Set<string>();
  for (const m of team.members) {
    if (!MEMBER_KEY.test(m.key)) return `invalid member key ${m.key}`;
    if (keys.has(m.key)) return `duplicate member key ${m.key}`;
    keys.add(m.key);
    if (!m.label.trim()) return `member ${m.key} needs a name`;
    if (!m.role.trim()) return `member ${m.key} needs a role`;
    if (!models.includes(m.model)) return `unknown model ${m.model}`;
  }
  if (team.cwd !== undefined) {
    let isDir = false;
    try {
      isDir = path.isAbsolute(team.cwd) && fs.statSync(team.cwd).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) return `work folder not found: ${team.cwd}`;
  }
  if (
    team.budgetUsd !== undefined &&
    !(team.budgetUsd > 0 && team.budgetUsd <= MAX_TEAM_BUDGET_USD)
  ) {
    return `budget must be more than 0 and at most ${MAX_TEAM_BUDGET_USD} dollars`;
  }
  return null;
}

function roster(team: TeamRoster): string {
  return team.members.map((m) => `- ${m.key} (${m.label}): ${m.role}`).join('\n');
}

/** The members as SDK agent definitions, keyed by the name the MD spawns them under. */
export function teamAgents(team: TeamRoster): Record<string, AgentDefinition> {
  const names = team.members.map((m) => m.key).join(', ');
  return Object.fromEntries(
    team.members.map((m): [string, AgentDefinition] => [
      m.key,
      {
        description: `${m.label}: ${m.role}`,
        model: m.model,
        background: true,
        disallowedTools: [PLAN_TOOL],
        prompt: [
          `You are ${m.key} (${m.label}) on a team led by the MD. Your role: ${m.role}`,
          `Your teammates: ${names}. The MD is "main".`,
          'Talk to a teammate directly with the SendMessage tool (to: their name) when you need something from them or they need your output; do not route everything through the MD.',
          'Stay inside your role. When your part is done, report the result to the MD with SendMessage (to: "main"), including where any files you made are.',
          'Write to the user in the language the brief is written in.',
        ].join('\n'),
      },
    ]),
  );
}

/** Appended to the MD's system prompt. */
export function leadInstructions(team: TeamRoster): string {
  return [
    `You are the ${team.leadLabel}, the lead of a team. The user gives you briefs; your team does the work.`,
    'Team members:',
    roster(team),
    `Before you bring anyone in, call ${PLAN_TOOL_NAME} with the plan, who does what, and the permissions the work needs (folders to write in, commands to run, sites to open). Keep the permissions narrow: anything outside them still asks the user one request at a time. Wait for the approval; if the user sends feedback instead, revise and submit again.`,
    'Bring a member in with the Agent tool, setting both subagent_type and name to the member key above, with run_in_background true. Start each member at most once; after that reach them with SendMessage (to: the key), which also wakes a member that has finished.',
    'Once the plan is approved, coordinate: hand out work, unblock members, and let them talk to each other directly. If the work turns out to need more than the approved permissions, submit a revised plan.',
    "Do not do a member's work yourself. When the work is finished, check it against the brief and give the user the final result and where it is.",
  ].join('\n');
}

interface TeamsFile {
  sessions: Record<string, TeamRoster>;
  /** Approved plans, so a resumed team keeps what the user already allowed. */
  plans: Record<string, TeamPlan>;
  /** The SDK's running cost per session; a resumed session's total starts from it. */
  costs: Record<string, number>;
}

function filePath(name: string): string {
  return path.join(os.homedir(), LAYOUT_FILE_DIR, name);
}

function writeAtomic(file: string, data: object): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, file);
}

export class TeamRegistry {
  private data: TeamsFile;

  constructor(private readonly file: string = filePath(FILE_NAME)) {
    this.data = TeamRegistry.read(file);
  }

  private static read(file: string): TeamsFile {
    if (!fs.existsSync(file)) return { sessions: {}, plans: {}, costs: {} };
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<TeamsFile>;
    return {
      sessions: parsed.sessions ?? {},
      plans: parsed.plans ?? {},
      costs: parsed.costs ?? {},
    };
  }

  rosterOf(sessionId: string): TeamRoster | undefined {
    return this.data.sessions[sessionId];
  }

  remember(sessionId: string, team: TeamRoster): void {
    this.data.sessions[sessionId] = team;
    writeAtomic(this.file, this.data);
  }

  planOf(sessionId: string): TeamPlan | undefined {
    return this.data.plans[sessionId];
  }

  rememberPlan(sessionId: string, plan: TeamPlan): void {
    this.data.plans[sessionId] = plan;
    writeAtomic(this.file, this.data);
  }

  costOf(sessionId: string): number {
    return this.data.costs[sessionId] ?? 0;
  }

  rememberCost(sessionId: string, costUsd: number): void {
    this.data.costs[sessionId] = costUsd;
    writeAtomic(this.file, this.data);
  }
}

/** Team setups the user saved to start again later, keyed by team name. */
export class TeamTemplates {
  private templates: TeamRoster[];

  constructor(private readonly file: string = filePath(TEMPLATES_FILE)) {
    this.templates = fs.existsSync(file)
      ? ((JSON.parse(fs.readFileSync(file, 'utf-8')) as { templates?: TeamRoster[] }).templates ??
        [])
      : [];
  }

  list(): TeamRoster[] {
    return this.templates.map((t) => ({ ...t, members: t.members.map((m) => ({ ...m })) }));
  }

  save(team: TeamRoster): void {
    const { seats: _seats, ...template } = team;
    this.templates = [...this.templates.filter((t) => t.name !== team.name), template];
    writeAtomic(this.file, { templates: this.templates });
  }

  remove(name: string): boolean {
    const before = this.templates.length;
    this.templates = this.templates.filter((t) => t.name !== name);
    if (this.templates.length === before) return false;
    writeAtomic(this.file, { templates: this.templates });
    return true;
  }
}
