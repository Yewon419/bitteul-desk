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

const FILE_NAME = 'bitteul-teams.json';

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
  leadLabel: string;
  leadModel: string;
  members: TeamMember[];
}

export const DEFAULT_TEAM: TeamRoster = {
  leadLabel: 'MD',
  leadModel: 'opus',
  members: [
    {
      key: 'planner',
      label: '기획자',
      role: 'Turns the brief into a concrete plan: goals, scope, user flow, and the task list for the designer and the developer.',
      model: 'opus',
    },
    {
      key: 'designer',
      label: '디자이너',
      role: 'Designs the screens, layout, visual style and copy the plan calls for, and hands the developer specs precise enough to build from.',
      model: 'sonnet',
    },
    {
      key: 'developer',
      label: '개발자',
      role: 'Builds what the plan and the design specify, runs it, and fixes what fails.',
      model: 'sonnet',
    },
  ],
};

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
    'Bring a member in with the Agent tool, setting both subagent_type and name to the member key above, with run_in_background true. Start each member at most once; after that reach them with SendMessage (to: the key), which also wakes a member that has finished.',
    'Before you bring anyone in, tell the user in a few lines who will do what. Then coordinate: hand out work, unblock members, and let them talk to each other directly.',
    "Do not do a member's work yourself. When the work is finished, check it against the brief and give the user the final result and where it is.",
  ].join('\n');
}

interface TeamsFile {
  sessions: Record<string, TeamRoster>;
}

function filePath(): string {
  return path.join(os.homedir(), LAYOUT_FILE_DIR, FILE_NAME);
}

export class TeamRegistry {
  private data: TeamsFile;

  constructor(private readonly file: string = filePath()) {
    this.data = TeamRegistry.read(file);
  }

  private static read(file: string): TeamsFile {
    if (!fs.existsSync(file)) return { sessions: {} };
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<TeamsFile>;
    return { sessions: parsed.sessions ?? {} };
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf-8');
    fs.renameSync(tmp, this.file);
  }

  rosterOf(sessionId: string): TeamRoster | undefined {
    return this.data.sessions[sessionId];
  }

  remember(sessionId: string, team: TeamRoster): void {
    this.data.sessions[sessionId] = team;
    this.save();
  }
}
