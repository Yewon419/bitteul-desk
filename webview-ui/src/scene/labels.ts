/**
 * Turn a raw tool status into a filming-safe Korean label.
 *
 * Only a file's basename may survive; commands, URLs, paths and tool arguments never do.
 */

const FILE_TOOLS: Record<string, string> = {
  Read: '읽는 중',
  Edit: '고치는 중',
  Write: '쓰는 중',
};

const PLAIN_TOOLS: Record<string, string> = {
  Bash: '명령 실행 중',
  Glob: '파일 찾는 중',
  Grep: '코드 찾는 중',
  WebFetch: '웹 조사 중',
  WebSearch: '웹 검색 중',
  Task: '동료 부르는 중',
  Agent: '동료 부르는 중',
  AskUserQuestion: '답 기다리는 중',
  EnterPlanMode: '계획 세우는 중',
  ExitPlanMode: '계획 보고 중',
  NotebookEdit: '노트북 고치는 중',
  TodoWrite: '할 일 정리 중',
  Skill: '매뉴얼 보는 중',
};

const MAX_FILE_CHARS = 18;
const SAFE_FILE = /^[\w.\-가-힣 ]+$/;

export const READING_TOOLS = new Set(['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch']);

function fileFromStatus(status: string): string | null {
  const space = status.indexOf(' ');
  if (space < 0) return null;
  const name = status.slice(space + 1).trim();
  if (!name || name.includes('/') || name.includes('\\') || !SAFE_FILE.test(name)) return null;
  return name.length > MAX_FILE_CHARS ? `${name.slice(0, MAX_FILE_CHARS - 1)}…` : name;
}

export function toolLabel(toolName: string | undefined, status: string): string {
  if (!toolName) return '일하는 중';
  const fileVerb = FILE_TOOLS[toolName];
  if (fileVerb) {
    const file = fileFromStatus(status);
    return file ? `${file} ${fileVerb}` : fileVerb;
  }
  const plain = PLAIN_TOOLS[toolName];
  if (plain) return plain;
  if (toolName.startsWith('mcp__claude-in-chrome__')) return '브라우저 조작 중';
  if (toolName.startsWith('mcp__')) return '도구 쓰는 중';
  return '일하는 중';
}
