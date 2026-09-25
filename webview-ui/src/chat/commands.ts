/**
 * Slash commands the chat window handles itself (/model, /mode, /help). Anything else that
 * starts with "/" goes to Claude as a normal message, where the CLI runs its own commands.
 */

export const DASHBOARD_MODES = ['auto', 'default', 'acceptEdits', 'plan'] as const;
export type DashboardMode = (typeof DASHBOARD_MODES)[number];

export const MODE_LABELS: Record<DashboardMode, string> = {
  auto: '자동',
  default: '기본 (매번 확인)',
  acceptEdits: '편집만 자동',
  plan: '계획만',
};

const MODE_ALIASES: Record<string, DashboardMode> = {
  auto: 'auto',
  자동: 'auto',
  default: 'default',
  기본: 'default',
  acceptedits: 'acceptEdits',
  edit: 'acceptEdits',
  편집: 'acceptEdits',
  plan: 'plan',
  계획: 'plan',
};

export interface CatalogCommand {
  name: string;
  description: string;
  argumentHint: string;
}

export interface CatalogModel {
  value: string;
  displayName: string;
  description: string;
}

export type LocalCommand =
  { kind: 'model'; arg: string } | { kind: 'mode'; arg: string } | { kind: 'help' };

export const LOCAL_COMMANDS: CatalogCommand[] = [
  { name: 'model', description: '모델 바꾸기', argumentHint: '[모델 이름]' },
  {
    name: 'mode',
    description: '권한 모드 바꾸기 (자동, 기본, 편집, 계획)',
    argumentHint: '[모드]',
  },
  { name: 'help', description: '쓸 수 있는 명령어 보기', argumentHint: '' },
];

/** The command this window runs itself, or null when the text should go to Claude. */
export function parseLocalCommand(text: string): LocalCommand | null {
  const match = /^\/(\S+)\s*([\s\S]*)$/.exec(text.trim());
  if (!match) return null;
  const name = match[1].toLowerCase();
  const arg = match[2].trim();
  if (name === 'model') return { kind: 'model', arg };
  if (name === 'mode' || name === 'permissions') return { kind: 'mode', arg };
  if (name === 'help' && !arg) return { kind: 'help' };
  return null;
}

export function resolveMode(arg: string): DashboardMode | null {
  return MODE_ALIASES[arg.trim().toLowerCase()] ?? null;
}

/** Match what the user typed to a model the CLI offers; unknown names pass through as typed. */
export function resolveModel(arg: string, models: CatalogModel[]): string {
  const wanted = arg.trim().toLowerCase();
  const hit =
    models.find((m) => m.value.toLowerCase() === wanted) ??
    models.find((m) => m.displayName.toLowerCase() === wanted) ??
    models.find((m) => m.displayName.toLowerCase().includes(wanted));
  return hit ? hit.value : arg.trim();
}

/** Commands to suggest while "/partial" is typed: this window's own first, then the CLI's. */
export function suggestCommands(
  typed: string,
  cliCommands: CatalogCommand[],
  limit = 8,
): CatalogCommand[] {
  const match = /^\/(\S*)$/.exec(typed);
  if (!match) return [];
  const prefix = match[1].toLowerCase();
  const seen = new Set<string>();
  return [...LOCAL_COMMANDS, ...cliCommands]
    .filter((c) => {
      const name = c.name.toLowerCase();
      if (seen.has(name) || !name.startsWith(prefix)) return false;
      seen.add(name);
      return true;
    })
    .slice(0, limit);
}
