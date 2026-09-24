/**
 * Sessions the Bitteul dashboard owns: started or resumed through the Claude Agent SDK
 * with a streaming prompt, so the dashboard can keep sending turns and answer tool
 * permission prompts. Sessions still open in a terminal are never touched here.
 *
 * The SDK is ESM and this bundle is CJS, so it is loaded with a dynamic import.
 */

import type {
  CanUseTool,
  PermissionResult,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk' with { 'resolution-mode': 'import' };
import { execFile } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export interface PermissionAsk {
  requestId: string;
  sessionId: string;
  toolName: string;
  summary: string;
}

export type SessionOwner = 'dashboard' | 'terminal' | 'none';

interface Managed {
  sessionId: string;
  busy: boolean;
  push: (text: string) => void;
  close: () => void;
}

interface Pending extends PermissionAsk {
  resolve: (result: PermissionResult) => void;
}

interface LiveSession {
  sessionId?: string;
  kind?: string;
  pid?: number;
}

const LIVE_CACHE_MS = 3000;
const SUMMARY_CHARS = 200;

export class DashboardSessionError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Resolve the installed claude executable: env override, else next to the npm shim on PATH. */
export function resolveClaudeExecutable(): string {
  const override = process.env.BITTEUL_CLAUDE_EXE;
  if (override) {
    if (!fs.existsSync(override)) throw new Error(`BITTEUL_CLAUDE_EXE not found: ${override}`);
    return override;
  }
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const candidates = [
      path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', exe),
      path.join(dir, exe),
    ];
    const hit = candidates.find((c) => fs.existsSync(c));
    if (hit) return hit;
  }
  throw new Error('claude executable not found on PATH; set BITTEUL_CLAUDE_EXE');
}

function summarize(toolName: string, input: Record<string, unknown>): string {
  const detail =
    (typeof input.command === 'string' && input.command) ||
    (typeof input.file_path === 'string' && input.file_path) ||
    (typeof input.url === 'string' && input.url) ||
    JSON.stringify(input);
  const text = `${toolName}: ${detail}`;
  return text.length > SUMMARY_CHARS ? `${text.slice(0, SUMMARY_CHARS - 1)}…` : text;
}

export class ManagedSessions {
  private readonly sessions = new Map<string, Managed>();
  private readonly pending = new Map<string, Pending>();
  private liveCache: { at: number; ids: Set<string> } | null = null;

  constructor(
    private readonly cwd: string,
    private readonly claudeExe: string,
    private readonly log: (msg: string, extra?: Record<string, unknown>) => void,
  ) {}

  owner(sessionId: string, liveTerminalIds: Set<string>): SessionOwner {
    if (this.sessions.has(sessionId)) return 'dashboard';
    return liveTerminalIds.has(sessionId) ? 'terminal' : 'none';
  }

  isBusy(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.busy ?? false;
  }

  pendingFor(sessionId: string): PermissionAsk[] {
    return [...this.pending.values()]
      .filter((p) => p.sessionId === sessionId)
      .map(({ requestId, sessionId: sid, toolName, summary }) => ({
        requestId,
        sessionId: sid,
        toolName,
        summary,
      }));
  }

  /** Session ids of interactive sessions currently running in a terminal (`claude agents --json`). */
  async liveTerminalSessions(): Promise<Set<string>> {
    if (this.liveCache && Date.now() - this.liveCache.at < LIVE_CACHE_MS) return this.liveCache.ids;
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        this.claudeExe,
        ['agents', '--json'],
        { timeout: 15000, windowsHide: true },
        (err, out, errOut) => {
          if (err) reject(new Error(`claude agents --json failed: ${err.message} ${errOut}`));
          else resolve(out);
        },
      );
    });
    const list = JSON.parse(stdout) as LiveSession[];
    const ids = new Set(
      list
        .filter(
          (s) =>
            s.sessionId &&
            !this.sessions.has(s.sessionId) &&
            (s.pid !== undefined || s.kind === 'background'),
        )
        .map((s) => s.sessionId as string),
    );
    this.liveCache = { at: Date.now(), ids };
    return ids;
  }

  /** Send a turn to a session, resuming it under the dashboard if nothing else holds it. */
  async send(sessionId: string, text: string): Promise<void> {
    const managed = this.sessions.get(sessionId);
    if (managed) {
      managed.busy = true;
      managed.push(text);
      return;
    }
    if ((await this.liveTerminalSessions()).has(sessionId)) {
      throw new DashboardSessionError('session is open in a terminal', 409);
    }
    await this.open({ resume: sessionId }, text);
  }

  /** Start a brand-new session with a first message. Resolves with its session id. */
  async start(text: string): Promise<string> {
    return this.open({}, text);
  }

  answer(requestId: string, allow: boolean): void {
    const ask = this.pending.get(requestId);
    if (!ask) throw new DashboardSessionError(`no pending permission ${requestId}`, 404);
    this.pending.delete(requestId);
    this.log('permission answered', {
      requestId,
      sessionId: ask.sessionId,
      tool: ask.toolName,
      allow,
    });
    ask.resolve(
      allow
        ? { behavior: 'allow' }
        : { behavior: 'deny', message: '대표님이 대시보드에서 거부했습니다.' },
    );
  }

  dispose(): void {
    for (const s of this.sessions.values()) s.close();
    this.sessions.clear();
  }

  private async open(opts: { resume?: string }, firstText: string): Promise<string> {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    const queue: SDKUserMessage[] = [];
    let wake: (() => void) | null = null;
    let closed = false;
    const push = (text: string): void => {
      queue.push({
        type: 'user',
        message: { role: 'user', content: text },
        parent_tool_use_id: null,
      });
      wake?.();
    };
    const prompt: AsyncIterable<SDKUserMessage> = {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          while (queue.length) yield queue.shift() as SDKUserMessage;
          if (closed) return;
          await new Promise<void>((r) => (wake = r));
          wake = null;
        }
      },
    };
    let sessionId = opts.resume ?? '';
    const canUseTool: CanUseTool = (toolName, input) =>
      new Promise<PermissionResult>((resolve) => {
        const requestId = crypto.randomUUID();
        this.pending.set(requestId, {
          requestId,
          sessionId,
          toolName,
          summary: summarize(toolName, input),
          resolve,
        });
        this.log('permission requested', { requestId, sessionId, toolName });
      });
    const q = query({
      prompt,
      options: {
        pathToClaudeCodeExecutable: this.claudeExe,
        cwd: this.cwd,
        permissionMode: 'default',
        canUseTool,
        ...(opts.resume ? { resume: opts.resume } : {}),
      },
    });
    const close = (): void => {
      closed = true;
      wake?.();
    };
    push(firstText);

    const ready = new Promise<string>((resolve, reject) => {
      void (async () => {
        try {
          for await (const m of q as AsyncIterable<SDKMessage>) {
            if (m.type === 'system' && m.subtype === 'init' && !this.sessions.has(m.session_id)) {
              sessionId = m.session_id;
              this.sessions.set(sessionId, { sessionId, busy: true, push: (t) => push(t), close });
              this.log('dashboard session started', { sessionId, resumed: !!opts.resume });
              resolve(sessionId);
            }
            if (m.type === 'result') {
              const s = this.sessions.get(sessionId);
              if (s) s.busy = false;
            }
          }
        } catch (err) {
          this.log('dashboard session failed', { sessionId, error: String(err) });
          reject(err instanceof Error ? err : new Error(String(err)));
        } finally {
          this.sessions.delete(sessionId);
          for (const [id, p] of this.pending) {
            if (p.sessionId === sessionId) {
              this.pending.delete(id);
              p.resolve({ behavior: 'deny', message: 'session ended' });
            }
          }
          this.log('dashboard session ended', { sessionId });
        }
      })();
    });
    return ready;
  }
}
