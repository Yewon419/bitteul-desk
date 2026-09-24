import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AgentStateStore } from '../src/agentStateStore.js';
import { parseConversation } from '../src/conversationView.js';
import { createHttpServer, type HttpServerHandle } from '../src/httpServer.js';
import type { AgentState } from '../src/types.js';

const TOKEN = crypto.randomUUID();

const RECORDS = [
  { type: 'user', message: { content: '<command-name>/model</command-name>' } },
  { type: 'user', message: { content: '로봇 모양 말고 클로드로 가자' }, timestamp: 't1' },
  {
    type: 'assistant',
    message: {
      content: [
        { type: 'thinking', thinking: 'hidden' },
        { type: 'text', text: '클로드 캐릭터로 바꾸겠습니다.' },
        {
          type: 'tool_use',
          name: 'Bash',
          input: { command: 'npm run build', description: 'Build it' },
        },
      ],
    },
  },
  { type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } },
  {
    type: 'assistant',
    isSidechain: true,
    message: { content: [{ type: 'text', text: 'subagent' }] },
  },
  { type: 'ai-title', aiTitle: '빛뜰 대시보드' },
];

function jsonl(records: object[]): string {
  return records.map((r) => JSON.stringify(r)).join('\n') + '\n{"type":"assis';
}

describe('parseConversation', () => {
  it('keeps real user and assistant turns, summarises tools, and reads the title', () => {
    const view = parseConversation(jsonl(RECORDS), 100);
    expect(view.title).toBe('빛뜰 대시보드');
    expect(view.entries).toEqual([
      { kind: 'user', text: '로봇 모양 말고 클로드로 가자', timestamp: 't1' },
      { kind: 'assistant', text: '클로드 캐릭터로 바꾸겠습니다.', timestamp: undefined },
      { kind: 'tool', text: 'Bash: Build it', timestamp: undefined },
    ]);
  });

  it('prefers a custom title and caps the entry count from the end', () => {
    const records = [...RECORDS, { type: 'custom-title', customTitle: '내 제목' }];
    const view = parseConversation(jsonl(records), 2);
    expect(view.title).toBe('내 제목');
    expect(view.entries.map((e) => e.kind)).toEqual(['assistant', 'tool']);
  });
});

describe('dashboard routes', () => {
  let dir: string;
  let handle: HttpServerHandle;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitteul-dash-'));
    const file = path.join(dir, 'session.jsonl');
    fs.writeFileSync(file, jsonl(RECORDS));
    const store = new AgentStateStore();
    store.set(7, { id: 7, sessionId: 's', projectDir: dir, jsonlFile: file } as AgentState);
    handle = await createHttpServer({
      embedded: true,
      token: TOKEN,
      store,
      sceneStateFile: path.join(dir, 'scene.json'),
      deskProfileFile: path.join(dir, 'profile.json'),
    });
  });

  afterEach(async () => {
    await handle.app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const url = (p: string) => `http://127.0.0.1:${handle.port.toString()}${p}`;
  const auth = { Authorization: `Bearer ${TOKEN}` };

  it('refuses requests without the server token', async () => {
    expect((await fetch(url('/api/dashboard/agents'))).status).toBe(401);
    expect((await fetch(url('/api/dashboard/agents/7/conversation'))).status).toBe(401);
  });

  it('lists titles and returns a conversation with the token', async () => {
    const list = (await (await fetch(url('/api/dashboard/agents'), { headers: auth })).json()) as {
      agents: Array<{ id: number; title: string | null }>;
    };
    expect(list.agents).toEqual([
      {
        id: 7,
        sessionId: 'session',
        title: '빛뜰 대시보드',
        owner: 'terminal',
        busy: false,
        pending: [],
      },
    ]);
    const convo = (await (
      await fetch(url('/api/dashboard/agents/7/conversation'), { headers: auth })
    ).json()) as { entries: unknown[] };
    expect(convo.entries).toHaveLength(3);
    expect(
      (await fetch(url('/api/dashboard/agents/99/conversation'), { headers: auth })).status,
    ).toBe(404);
  });

  it('guards the write routes with the token and refuses them inside VS Code', async () => {
    const post = (p: string, body: object, headers: Record<string, string> = {}) =>
      fetch(url(p), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
    expect((await post('/api/dashboard/agents/7/messages', { text: 'hi' })).status).toBe(401);
    expect((await post('/api/dashboard/sessions', { text: 'hi' })).status).toBe(401);
    expect((await post('/api/dashboard/permissions/x', { allow: true })).status).toBe(401);
    expect((await post('/api/dashboard/agents/7/messages', { text: 'hi' }, auth)).status).toBe(503);
    expect((await post('/api/dashboard/sessions', { text: '' }, auth)).status).toBe(400);
  });

  it('stores seats and room names, readable without a token', async () => {
    const post = (p: string, body: object) =>
      fetch(url(p), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth },
        body: JSON.stringify(body),
      });
    const unauthenticated = await fetch(url('/api/dashboard/seats'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ moves: [{ agentId: 7, seat: 1 }] }),
    });
    expect(unauthenticated.status).toBe(401);
    expect((await post('/api/dashboard/seats', { moves: [{ agentId: 7, seat: 4 }] })).status).toBe(
      200,
    );
    expect((await post('/api/dashboard/rooms/1', { title: '  디자인실  ' })).status).toBe(200);
    const state = (await (await fetch(url('/api/scene/state'))).json()) as {
      seats: Record<string, number>;
      rooms: Record<string, string>;
    };
    expect(state).toEqual({ seats: { 7: 4 }, rooms: { 1: '디자인실' } });
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'scene.json'), 'utf-8')) as {
      seats: Record<string, number>;
    };
    expect(saved.seats).toEqual({ session: 4 });
  });

  it('serves neutral profile defaults, then the user file, and names a broken file', async () => {
    const profile = async () => {
      const res = await fetch(url('/api/scene/profile'));
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    expect(await profile()).toEqual({
      status: 200,
      body: { userName: '나', board: { title: '빛뜰 데스크', countdown: null, salary: null } },
    });

    const file = path.join(dir, 'profile.json');
    fs.writeFileSync(
      file,
      JSON.stringify({ userName: ' 팀장님 ', countdownDate: '2027-08-31', salaryTarget: 100 }),
    );
    expect(await profile()).toEqual({
      status: 200,
      body: {
        userName: '팀장님',
        board: {
          title: '빛뜰 데스크',
          countdown: { label: '마감까지', date: '2027-08-31' },
          salary: { thisMonth: 0, target: 100 },
        },
      },
    });

    fs.writeFileSync(file, JSON.stringify({ countdownDate: '다음 달' }));
    const broken = await profile();
    expect(broken.status).toBe(500);
    expect(String(broken.body.error)).toContain('countdownDate');
    expect(String(broken.body.error)).toContain(file);
  });
});
