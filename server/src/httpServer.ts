import fastifyCors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import * as crypto from 'crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import Fastify from 'fastify';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { AgentRuntime } from './agentRuntime.js';
import type { AgentStateStore } from './agentStateStore.js';
import type {
  AssetCache,
  ReloadAssetsSideEffect,
  SetHooksEnabledSideEffect,
} from './clientMessageHandler.js';
import { handleClientMessage } from './clientMessageHandler.js';
import {
  HOOK_API_PREFIX,
  MAX_HOOK_BODY_SIZE,
  WS_CLOSE_FORBIDDEN_ORIGIN,
  WS_CLOSE_UNAUTHORIZED,
} from './constants.js';
import { ConversationCache } from './conversationView.js';
import {
  BOARD_FIELDS,
  type BoardPatch,
  DeskProfileError,
  readDeskProfile,
  updateDeskBoard,
} from './deskProfile.js';
import {
  DASHBOARD_MODES,
  type DashboardMode,
  DashboardSessionError,
  ManagedSessions,
  resolveClaudeExecutable,
} from './managedSessions.js';
import { type PhoneLink, qrSvg } from './phoneAccess.js';
import { MAX_ROOM_TITLE, SceneState } from './sceneState.js';
import type { AgentState } from './types.js';
import {
  type Attachment,
  isInsideUploads,
  MAX_UPLOAD_BYTES,
  messageContent,
  saveUpload,
  uploadsRoot,
} from './uploads.js';

/** Options for creating the HTTP + WebSocket server. */
export interface HttpServerOptions {
  /** true = VS Code embedded mode (ephemeral port, no static, quiet logging) */
  embedded: boolean;
  /** Host to bind to. Default: '127.0.0.1' */
  host?: string;
  /** Port to listen on. Default: 0 (auto-assign) */
  port?: number;
  /** Bearer auth token for hook and WebSocket endpoints */
  token: string;
  /** AgentStateStore for WebSocket broadcast piping */
  store: AgentStateStore;
  /** Shared agent lifecycle core (for toggle side effects + standalone restore). Optional in embedded mode. */
  runtime?: AgentRuntime;
  /** Path to SPA dist directory for static serving (standalone only) */
  staticDir?: string;
  /** Cached assets loaded at startup (standalone only) */
  assetCache?: AssetCache;
  /** Callback when a hook event is received */
  onHookEvent?: (providerId: string, event: Record<string, unknown>) => void;
  /** Invoked when setHooksEnabled is toggled via WebSocket. Standalone installs/uninstalls hooks here. */
  onSetHooksEnabled?: SetHooksEnabledSideEffect;
  /** Invoked when an external asset directory is added/removed. Standalone reloads + re-broadcasts assets here. */
  onReloadAssets?: ReloadAssetsSideEffect;
  /** Where the Bitteul scene arrangement is stored. Standalone defaults to ~/.pixel-agents. */
  sceneStateFile?: string;
  /** Where the user's desk profile (name, wall board) is read from. Defaults to ~/.pixel-agents. */
  deskProfileFile?: string;
  /** Where chat attachments are saved. Defaults to ~/.pixel-agents/uploads. */
  uploadsDir?: string;
  /** Phone links from `--phone`; empty when the server was started without it. */
  phoneLinks?: PhoneLink[];
}

/** Result of createHttpServer(). */
export interface HttpServerHandle {
  app: FastifyInstance;
  port: number;
}

const startTime = Date.now();

/**
 * Create a Fastify server with hook endpoint, health check, and WebSocket support.
 *
 * All Fastify-specific code lives in this file. The rest of the server layer is
 * framework-agnostic. If Fastify is ever replaced, only this file changes.
 */
export async function createHttpServer(options: HttpServerOptions): Promise<HttpServerHandle> {
  const app = Fastify({
    logger: !options.embedded,
    bodyLimit: MAX_HOOK_BODY_SIZE,
  });

  await app.register(fastifyCors, { origin: true });
  await app.register(fastifyWebsocket);

  // Static SPA serving (standalone mode only)
  if (!options.embedded && options.staticDir) {
    await app.register(fastifyStatic, {
      root: options.staticDir,
      prefix: '/',
    });
    // HTML5 history fallback: serve index.html for unmatched routes
    app.setNotFoundHandler((_req, reply) => {
      reply.sendFile('index.html');
    });
  }

  // ── Routes ──────────────────────────────────────────────────

  registerHealthRoute(app);
  registerHookRoute(app, options);
  registerWebSocketRoute(app, options);
  const scene = options.sceneStateFile
    ? new SceneState(options.sceneStateFile)
    : options.embedded
      ? null
      : new SceneState();
  registerDashboardRoutes(app, options, scene);
  registerSceneRoutes(app, options, scene);

  // ── Listen ──────────────────────────────────────────────────

  await app.listen({ host: options.host ?? '127.0.0.1', port: options.port ?? 0 });
  const address = app.server.address();
  const port = typeof address === 'object' ? (address?.port ?? 0) : 0;

  return { app, port };
}

// ── Health ──────────────────────────────────────────────────────

function registerHealthRoute(app: FastifyInstance): void {
  app.get('/api/health', async () => ({
    status: 'ok',
    uptime: Math.floor((Date.now() - startTime) / 1000),
    pid: process.pid,
  }));
}

// ── Hook Events ────────────────────────────────────────────────

function registerHookRoute(app: FastifyInstance, options: HttpServerOptions): void {
  app.post<{
    Params: { providerId: string };
    Body: Record<string, unknown>;
  }>(
    `${HOOK_API_PREFIX}/:providerId`,
    {
      preHandler: bearerAuth(options.token),
      schema: {
        params: {
          type: 'object',
          properties: {
            providerId: { type: 'string', pattern: '^[a-z0-9-]+$' },
          },
          required: ['providerId'],
        },
      },
    },
    async (request, reply) => {
      const { providerId } = request.params;
      const event = request.body;

      if (event.session_id && event.hook_event_name) {
        options.onHookEvent?.(providerId, event);
      }

      reply.send('ok');
    },
  );
}

// ── Dashboard (Bitteul) ─────────────────────────────────────────

const DASHBOARD_MAX_ENTRIES = 300;

/**
 * Read-only conversation access for the scene dashboard. Transcripts hold the user's
 * full conversations, so both routes demand the server token (Bearer), same as hooks.
 */
function registerDashboardRoutes(
  app: FastifyInstance,
  options: HttpServerOptions,
  scene: SceneState | null,
): void {
  const conversations = new ConversationCache(DASHBOARD_MAX_ENTRIES);
  const managed = createManagedSessions(app, options);
  const auth = { preHandler: bearerAuth(options.token) };
  const sessionOf = (agent: AgentState): string => path.basename(agent.jsonlFile, '.jsonl');
  const uploads = options.uploadsDir ?? uploadsRoot(os.homedir());

  /** Text plus attachments as one user turn; only files this server saved may be attached. */
  const turnContent = (
    text: string,
    attachments: Attachment[] | undefined,
  ): ReturnType<typeof messageContent> | { error: string } => {
    const files = attachments ?? [];
    if (!text.trim() && files.length === 0) return { error: 'empty message' };
    for (const f of files) {
      if (!isInsideUploads(uploads, f.path) || !fs.existsSync(f.path)) {
        return { error: `not an uploaded file: ${f.path}` };
      }
    }
    return messageContent(text, files);
  };

  // Raw file bytes; the name and type ride in the query so a .json file is not parsed as JSON.
  app.register((scope, _opts, done) => {
    scope.addContentTypeParser(
      '*',
      { parseAs: 'buffer', bodyLimit: MAX_UPLOAD_BYTES },
      (_request, body, next) => next(null, body),
    );
    scope.post<{ Querystring: { name: string; mime?: string } }>(
      '/api/dashboard/uploads',
      {
        ...auth,
        bodyLimit: MAX_UPLOAD_BYTES,
        schema: {
          querystring: {
            type: 'object',
            required: ['name'],
            properties: {
              name: { type: 'string', minLength: 1, maxLength: 300 },
              mime: { type: 'string', maxLength: 100 },
            },
          },
        },
      },
      async (request, reply) => {
        if (!Buffer.isBuffer(request.body)) {
          return reply.code(400).send({ error: 'send the file as application/octet-stream' });
        }
        const saved = saveUpload(
          uploads,
          request.query.name,
          request.query.mime || 'application/octet-stream',
          request.body,
        );
        app.log.info({ file: saved.path, size: saved.size }, 'dashboard: file uploaded');
        return saved;
      },
    );
    done();
  });

  app.get('/api/dashboard/agents', auth, async () => {
    let live = new Set<string>();
    let liveKnown = true;
    if (managed) {
      try {
        live = await managed.liveTerminalSessions();
      } catch (err) {
        liveKnown = false;
        app.log.warn({ err }, 'dashboard: could not list live sessions');
      }
    }
    const agents = [];
    for (const agent of options.store.values()) {
      let title: string | null = null;
      try {
        title = conversations.get(agent.jsonlFile).title;
      } catch (err) {
        app.log.warn(
          { err, id: agent.id, file: agent.jsonlFile },
          'dashboard: transcript unreadable',
        );
      }
      const sessionId = sessionOf(agent);
      agents.push({
        id: agent.id,
        sessionId,
        title,
        owner: managed && liveKnown ? managed.owner(sessionId, live) : 'terminal',
        busy: managed?.isBusy(sessionId) ?? false,
        pending: managed?.pendingFor(sessionId) ?? [],
        settings: managed?.settingsFor(sessionId) ?? null,
        activity: managed?.activity(sessionId) ?? null,
        suggestion: managed?.suggestionFor(sessionId) ?? null,
        // Terminal sessions only show up through their transcript: what tools are running now.
        activeTools: agent.activeToolStatuses ? [...agent.activeToolStatuses.values()] : [],
      });
    }
    return { canReply: !!managed, agents };
  });

  app.get<{ Params: { id: string } }>(
    '/api/dashboard/agents/:id/conversation',
    { ...auth, schema: { params: AGENT_ID_PARAMS } },
    async (request, reply) => {
      const agent = options.store.get(Number(request.params.id));
      if (!agent) return reply.code(404).send({ error: `no agent ${request.params.id}` });
      return { id: agent.id, ...conversations.get(agent.jsonlFile) };
    },
  );

  app.post<{ Params: { id: string }; Body: { text: string; attachments?: Attachment[] } }>(
    '/api/dashboard/agents/:id/messages',
    { ...auth, schema: { params: AGENT_ID_PARAMS, body: TEXT_BODY } },
    async (request, reply) => {
      const content = turnContent(request.body.text, request.body.attachments);
      if (typeof content === 'object' && 'error' in content) {
        return reply.code(400).send(content);
      }
      if (!managed) return reply.code(503).send({ error: 'dashboard sessions unavailable' });
      const agent = options.store.get(Number(request.params.id));
      if (!agent) return reply.code(404).send({ error: `no agent ${request.params.id}` });
      return sendOrFail(reply, () => managed.send(sessionOf(agent), content));
    },
  );

  app.post<{
    Body: {
      text: string;
      seat?: number;
      mode?: DashboardMode;
      model?: string | null;
      attachments?: Attachment[];
    };
  }>(
    '/api/dashboard/sessions',
    { ...auth, schema: { body: SESSION_BODY } },
    async (request, reply) => {
      const { text, mode, model, attachments } = request.body;
      const content = turnContent(text, attachments);
      if (typeof content === 'object' && 'error' in content) {
        return reply.code(400).send(content);
      }
      if (!managed) return reply.code(503).send({ error: 'dashboard sessions unavailable' });
      return sendOrFail(reply, async () => {
        const sessionId = await managed.start(content, {
          ...(mode ? { mode } : {}),
          ...(model !== undefined ? { model } : {}),
        });
        // Hired from an empty desk: that desk becomes the new staff member's seat.
        if (request.body.seat !== undefined) {
          scene?.moveSeats([{ sessionId, seat: request.body.seat }]);
        }
        return { sessionId };
      });
    },
  );

  app.post<{ Params: { requestId: string }; Body: { allow: boolean } }>(
    '/api/dashboard/permissions/:requestId',
    {
      ...auth,
      schema: {
        body: {
          type: 'object',
          properties: { allow: { type: 'boolean' } },
          required: ['allow'],
        },
      },
    },
    async (request, reply) => {
      if (!managed) return reply.code(503).send({ error: 'dashboard sessions unavailable' });
      return sendOrFail(reply, () => {
        managed.answer(request.params.requestId, request.body.allow);
        return Promise.resolve();
      });
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/dashboard/agents/:id/interrupt',
    { ...auth, schema: { params: AGENT_ID_PARAMS } },
    async (request, reply) => {
      if (!managed) return reply.code(503).send({ error: 'dashboard sessions unavailable' });
      const agent = options.store.get(Number(request.params.id));
      if (!agent) return reply.code(404).send({ error: `no agent ${request.params.id}` });
      return sendOrFail(reply, () => managed.interrupt(sessionOf(agent)));
    },
  );

  app.post<{ Params: { requestId: string }; Body: { answers: Record<string, string> } }>(
    '/api/dashboard/questions/:requestId',
    {
      ...auth,
      schema: {
        body: {
          type: 'object',
          required: ['answers'],
          properties: {
            answers: { type: 'object', additionalProperties: { type: 'string' } },
          },
        },
      },
    },
    async (request, reply) => {
      if (!managed) return reply.code(503).send({ error: 'dashboard sessions unavailable' });
      return sendOrFail(reply, () => {
        managed.answerQuestion(request.params.requestId, request.body.answers);
        return Promise.resolve();
      });
    },
  );

  app.post<{ Params: { id: string }; Body: { mode?: DashboardMode; model?: string | null } }>(
    '/api/dashboard/agents/:id/settings',
    {
      ...auth,
      schema: {
        params: AGENT_ID_PARAMS,
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            mode: { type: 'string', enum: [...DASHBOARD_MODES] },
            model: { type: ['string', 'null'], maxLength: 100 },
          },
        },
      },
    },
    async (request, reply) => {
      if (!managed) return reply.code(503).send({ error: 'dashboard sessions unavailable' });
      const agent = options.store.get(Number(request.params.id));
      if (!agent) return reply.code(404).send({ error: `no agent ${request.params.id}` });
      return sendOrFail(reply, () => managed.updateSettings(sessionOf(agent), request.body));
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/dashboard/agents/:id/catalog',
    { ...auth, schema: { params: AGENT_ID_PARAMS } },
    async (request, reply) => {
      if (!managed) return reply.code(503).send({ error: 'dashboard sessions unavailable' });
      const agent = options.store.get(Number(request.params.id));
      return sendOrFail(reply, () => managed.catalog(agent ? sessionOf(agent) : ''));
    },
  );

  app.get('/api/dashboard/catalog', auth, async (_request, reply) => {
    if (!managed) return reply.code(503).send({ error: 'dashboard sessions unavailable' });
    return sendOrFail(reply, () => managed.catalog(''));
  });

  // "퇴근": take the agent out of the office. A dashboard session is ended too; a terminal
  // session keeps running in its terminal and only leaves the office. Busy or waiting-for-
  // approval sessions are refused so nobody is sent home mid-task.
  app.post<{ Params: { id: string } }>(
    '/api/dashboard/agents/:id/dismiss',
    { ...auth, schema: { params: AGENT_ID_PARAMS } },
    async (request, reply) => {
      const runtime = options.runtime;
      if (!runtime) return reply.code(503).send({ error: 'agent runtime unavailable' });
      const agent = options.store.get(Number(request.params.id));
      if (!agent) return reply.code(404).send({ error: `no agent ${request.params.id}` });
      const sessionId = sessionOf(agent);
      if (managed?.isBusy(sessionId) || (managed?.pendingFor(sessionId).length ?? 0) > 0) {
        return reply.code(409).send({ error: 'agent is working or waiting for approval' });
      }
      managed?.end(sessionId);
      runtime.dismissalTracker.dismiss(agent.jsonlFile);
      runtime.removeAgent(agent.id);
      app.log.info({ id: agent.id, sessionId }, 'dashboard: agent dismissed');
      return { ok: true };
    },
  );
}

/**
 * Seat arrangement and room signs. Reading is open (the filming view has no token and the
 * data is only seat numbers and room names); changing it needs the server token.
 */
function registerSceneRoutes(
  app: FastifyInstance,
  options: HttpServerOptions,
  scene: SceneState | null,
): void {
  const auth = { preHandler: bearerAuth(options.token) };
  const sessionOf = (agent: AgentState): string => path.basename(agent.jsonlFile, '.jsonl');

  app.get('/api/scene/state', async () => {
    const seats: Record<number, number> = {};
    if (scene) {
      for (const agent of options.store.values()) {
        const seat = scene.seatOf(sessionOf(agent));
        if (seat !== undefined) seats[agent.id] = seat;
      }
    }
    return { seats, rooms: scene?.rooms() ?? {} };
  });

  app.get('/api/dashboard/phone-link', auth, async () => {
    const links = options.phoneLinks ?? [];
    const qr = links.length ? await qrSvg(links[0].url) : null;
    return { links, qr };
  });

  app.post<{ Body: BoardPatch }>(
    '/api/dashboard/profile/board',
    {
      ...auth,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: Object.fromEntries(
            BOARD_FIELDS.map((key) => [key, { type: ['string', 'number', 'null'] }]),
          ),
        },
      },
    },
    async (request, reply) => {
      try {
        return updateDeskBoard(request.body, options.deskProfileFile);
      } catch (err) {
        if (!(err instanceof DeskProfileError)) throw err;
        return reply.code(400).send({ error: err.message });
      }
    },
  );

  app.get('/api/scene/profile', async (_request, reply) => {
    try {
      return readDeskProfile(options.deskProfileFile);
    } catch (err) {
      if (!(err instanceof DeskProfileError)) throw err;
      return reply.code(500).send({ error: err.message });
    }
  });

  app.post<{ Body: { moves: Array<{ agentId: number; seat: number }> } }>(
    '/api/dashboard/seats',
    {
      ...auth,
      schema: {
        body: {
          type: 'object',
          required: ['moves'],
          properties: {
            moves: {
              type: 'array',
              minItems: 1,
              maxItems: 2,
              items: {
                type: 'object',
                required: ['agentId', 'seat'],
                properties: {
                  agentId: { type: 'integer' },
                  seat: { type: 'integer', minimum: 0, maximum: 999 },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      if (!scene) return reply.code(503).send({ error: 'scene state unavailable' });
      const moves = [];
      for (const { agentId, seat } of request.body.moves) {
        const agent = options.store.get(agentId);
        if (!agent) return reply.code(404).send({ error: `no agent ${agentId}` });
        moves.push({ sessionId: sessionOf(agent), seat });
      }
      scene.moveSeats(moves);
      return { ok: true };
    },
  );

  app.post<{ Params: { index: string }; Body: { title: string } }>(
    '/api/dashboard/rooms/:index',
    {
      ...auth,
      schema: {
        params: {
          type: 'object',
          properties: { index: { type: 'string', pattern: '^[0-9]{1,3}$' } },
          required: ['index'],
        },
        body: {
          type: 'object',
          required: ['title'],
          properties: { title: { type: 'string', maxLength: MAX_ROOM_TITLE } },
        },
      },
    },
    async (request, reply) => {
      if (!scene) return reply.code(503).send({ error: 'scene state unavailable' });
      scene.setRoomTitle(Number(request.params.index), request.body.title);
      return { ok: true };
    },
  );
}

const ATTACHMENTS_SCHEMA = {
  type: 'array',
  maxItems: 20,
  items: {
    type: 'object',
    required: ['path', 'name', 'size', 'mime'],
    properties: {
      path: { type: 'string', maxLength: 1000 },
      name: { type: 'string', maxLength: 300 },
      size: { type: 'integer', minimum: 0 },
      mime: { type: 'string', maxLength: 100 },
    },
  },
} as const;

const SESSION_BODY = {
  type: 'object',
  properties: {
    text: { type: 'string', maxLength: 20000 },
    attachments: ATTACHMENTS_SCHEMA,
    seat: { type: 'integer', minimum: 0, maximum: 999 },
    mode: { type: 'string', enum: ['auto', 'default', 'acceptEdits', 'plan'] },
    model: { type: ['string', 'null'], maxLength: 100 },
  },
  required: ['text'],
} as const;

const AGENT_ID_PARAMS = {
  type: 'object',
  properties: { id: { type: 'string', pattern: '^-?[0-9]+$' } },
  required: ['id'],
} as const;

const TEXT_BODY = {
  type: 'object',
  properties: {
    text: { type: 'string', maxLength: 20000 },
    attachments: ATTACHMENTS_SCHEMA,
  },
  required: ['text'],
} as const;

async function sendOrFail<T>(reply: FastifyReply, run: () => Promise<T>): Promise<T | undefined> {
  try {
    return (await run()) ?? ({ ok: true } as T);
  } catch (err) {
    const status = err instanceof DashboardSessionError ? err.status : 500;
    reply.code(status).send({ error: err instanceof Error ? err.message : String(err) });
    return undefined;
  }
}

/** Dashboard-owned sessions exist only for the standalone CLI (never inside VS Code). */
function createManagedSessions(
  app: FastifyInstance,
  options: HttpServerOptions,
): ManagedSessions | null {
  if (options.embedded) return null;
  let exe: string;
  try {
    exe = resolveClaudeExecutable();
  } catch (err) {
    app.log.warn({ err }, 'dashboard: replies disabled');
    return null;
  }
  const managed = new ManagedSessions(process.cwd(), exe, (msg, extra) =>
    app.log.info(extra ?? {}, `dashboard: ${msg}`),
  );
  app.addHook('onClose', async () => managed.dispose());
  return managed;
}

// ── WebSocket ──────────────────────────────────────────────────

function registerWebSocketRoute(app: FastifyInstance, options: HttpServerOptions): void {
  app.get('/ws', { websocket: true }, (socket, request) => {
    // CONNECTION gate. Embedded (VS Code) requires the Bearer token. Standalone
    // requires a same-origin handshake instead (isAllowedWebSocketOrigin), so a
    // non-browser local client with no Origin can still watch the office. What
    // may be DONE over an accepted connection is a separate question, decided
    // below.
    if (options.embedded) {
      if (!timingSafeStringEqual(request.headers.authorization ?? '', `Bearer ${options.token}`)) {
        socket.close(WS_CLOSE_UNAUTHORIZED, 'unauthorized');
        return;
      }
    } else if (!isAllowedWebSocketOrigin(request.headers.origin, request.headers.host)) {
      socket.close(WS_CLOSE_FORBIDDEN_ORIGIN, 'forbidden origin');
      return;
    }

    // Both modes prove privilege with the SAME out-of-band secret, differently
    // carried: embedded sends the Bearer token it was handed in-process;
    // standalone sends the `?token=` the CLI printed in the local URL and the
    // SPA forwarded on this handshake. Nothing about a network POSITION is
    // consulted, because every position is reproducible by a forwarder.
    const privileged = options.embedded || standaloneTokenValid(request.url, options.token);

    const { store } = options;

    // Pipe store events to WebSocket client
    const onAgentAdded = (id: number, agent: AgentState) => {
      safeSend(socket, {
        type: 'agentCreated',
        id,
        folderName: agent.folderName,
        isExternal: agent.isExternal || undefined,
        isTeammate: agent.leadAgentId !== undefined || undefined,
        teammateName: agent.agentName,
        parentAgentId: agent.leadAgentId,
        teamName: agent.teamName,
        hooksOnly: agent.hooksOnly || undefined,
        palette: agent.palette,
        hueShift: agent.hueShift,
      });
    };

    const onAgentRemoved = (id: number) => {
      safeSend(socket, { type: 'agentClosed', id });
    };

    const onBroadcast = (message: Record<string, unknown>) => {
      safeSend(socket, message);
    };

    store.on('agentAdded', onAgentAdded);
    store.on('agentRemoved', onAgentRemoved);
    store.on('broadcast', onBroadcast);

    // Handle incoming client messages
    socket.on('message', (data: Buffer | string) => {
      try {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        if (!options.embedded && msg.type) {
          console.log('[Pixel Agents] WS client message:', msg.type);
        }
        handleClientMessage(msg, (m) => safeSend(socket, m), {
          store,
          runtime: options.runtime,
          cache: options.assetCache ?? null,
          onSetHooksEnabled: options.onSetHooksEnabled,
          onReloadAssets: options.onReloadAssets,
          privileged,
        });
      } catch {
        // Malformed JSON, ignore
      }
    });

    socket.on('close', () => {
      store.off('agentAdded', onAgentAdded);
      store.off('agentRemoved', onAgentRemoved);
      store.off('broadcast', onBroadcast);
    });
  });
}

/**
 * Standalone `/ws` CONNECTION gate: is this handshake same-origin?
 *
 * WebSocket connects are NOT subject to CORS, so without this any web page the
 * user happens to visit could open a socket to 127.0.0.1 and start talking.
 * Comparing Origin's host against the request's own Host header makes the check
 * same-origin by construction — it tracks whatever --host/--port the server was
 * bound to with zero configuration, and treats `localhost` and `127.0.0.1`
 * correctly (a browser derives both headers from the URL that loaded the SPA).
 *
 * A missing Origin still connects: non-browser local clients send none, and the
 * standalone server's read surface is deliberately open to whatever address it
 * was told to bind (`--host 0.0.0.0` exposes the SPA to the LAN by design).
 *
 * This gate is NOT sufficient for privileged actions and never was. Both header
 * values are attacker-supplied, so a DNS-rebound page (`evil.com` → 127.0.0.1)
 * sends `Origin: http://evil.com:PORT` AND `Host: evil.com:PORT` and passes
 * equality. See standaloneTokenValid for what actually guards consent.
 */
export function isAllowedWebSocketOrigin(
  origin: string | undefined,
  host: string | undefined,
): boolean {
  if (origin === undefined || origin === '') return true;
  try {
    return new URL(origin).host === host;
  } catch {
    // An unparseable Origin is not a same-origin browser request.
    return false;
  }
}

/**
 * Whether this socket may send PRIVILEGED messages — the ones that reach
 * outside `~/.pixel-agents/`. Today that is `setHooksEnabled`, which grants
 * durable, machine-wide consent to modify `~/.claude/settings.json` and
 * installs (or removes) a 12-event hook set.
 *
 * The handshake must carry the server token in its `?token=` query. That token
 * is minted at startup (server.ts), printed by the CLI inside the LOCAL url it
 * emits to the operator's terminal, and forwarded by the SPA loaded from that
 * url (webview-ui/src/transport/index.ts). It is the Jupyter model.
 *
 * Why a secret rather than a network position: EVERY position is reproducible.
 * The predecessor of this function required a loopback peer address AND a
 * loopback `Host`, on the theory that only a real local browser satisfies both.
 * A dumb TCP forwarder bound to the LAN, piping bytes verbatim to 127.0.0.1,
 * presents the server exactly what the SPA presents — `remoteAddress` is
 * 127.0.0.1 because the forwarder terminated the hop there, and `Host` is
 * whatever the remote client typed. Reproduced against the real `dist/cli.js`:
 * a client on another machine acquired consent and a 12-event install. Peer
 * address and Host/Origin are all carried BY the channel a proxy speaks, so the
 * gate must ride something the channel never carries — an out-of-band secret
 * the operator's own URL delivers and the forwarded attacker never sees.
 *
 * A tokenless client is not locked out of Pixel Agents — it connects and
 * watches the office exactly as before (the connection gate,
 * isAllowedWebSocketOrigin, is separate and unchanged). It simply cannot
 * approve a change to a file in someone's home directory.
 */
function standaloneTokenValid(url: string | undefined, expected: string): boolean {
  // Defensive: an empty configured token would otherwise privilege every
  // handshake that omits the query (both sides compare equal as '').
  if (!expected) return false;
  let provided: string;
  try {
    // Parsed against a dummy base because `request.url` is path-relative. Read
    // from the raw url rather than a framework-parsed query so the gate does
    // not depend on @fastify/websocket populating one on the upgrade request.
    provided = new URL(url ?? '', 'http://localhost').searchParams.get('token') ?? '';
  } catch {
    return false;
  }
  return timingSafeStringEqual(provided, expected);
}

// ── Auth Helper ────────────────────────────────────────────────

/** Constant-time string compare, length-guarded (timingSafeEqual throws on a
 *  length mismatch). One implementation for all three token comparisons. */
function timingSafeStringEqual(actual: string, expected: string): boolean {
  const actualBuf = Buffer.from(actual);
  const expectedBuf = Buffer.from(expected);
  return actualBuf.length === expectedBuf.length && crypto.timingSafeEqual(actualBuf, expectedBuf);
}

function bearerAuth(expectedToken: string) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!timingSafeStringEqual(request.headers.authorization ?? '', `Bearer ${expectedToken}`)) {
      reply.code(401).send('unauthorized');
    }
  };
}

// ── Utilities ──────────────────────────────────────────────────

function safeSend(
  socket: { send: (data: string) => void; readyState: number },
  message: Record<string, unknown>,
): void {
  // WebSocket.OPEN = 1
  if (socket.readyState === 1) {
    socket.send(JSON.stringify(message));
  }
}
