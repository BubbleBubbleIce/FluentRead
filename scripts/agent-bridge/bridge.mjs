#!/usr/bin/env node
// FluentRead 的本机 ACP 桥接：只接受带令牌的扩展请求，并把 Chat Completions 文本交给无工具权限的 Agent。

import {spawn} from 'node:child_process';
import {createHash, randomBytes, timingSafeEqual} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const MAX_BODY_BYTES = 256 * 1024;
const MAX_ACP_LINE_BYTES = 1024 * 1024;
const TURN_TIMEOUT_MS = 90_000;
const MAX_QUEUED_TURNS = 16;
const EXTENSION_ORIGIN = /^(?:chrome-extension|moz-extension):\/\/[a-zA-Z0-9-]+$/;

class BridgeError extends Error {
  constructor(message, status = 502, code = 'agent_error') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function safeEqual(left, right) {
  const a = createHash('sha256').update(left).digest();
  const b = createHash('sha256').update(right).digest();
  return timingSafeEqual(a, b);
}

function textContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) throw new BridgeError('仅支持文本翻译请求。', 400, 'text_only');
  return content.map((part) => {
    if (part?.type !== 'text' || typeof part.text !== 'string') {
      throw new BridgeError('ACP 桥接目前仅支持文本内容。', 400, 'text_only');
    }
    return part.text;
  }).join('\n');
}

export function parseChatRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || !Array.isArray(body.messages) || body.messages.length < 1 || body.messages.length > 32
    || typeof body.model !== 'string' || !body.model.trim() || body.stream === true) {
    throw new BridgeError('请求需要模型与非流式文本消息。', 400, 'invalid_request');
  }
  const messages = body.messages.map((message) => {
    if (!message || !['system', 'developer', 'user', 'assistant'].includes(message.role)) {
      throw new BridgeError('不支持的消息角色。', 400, 'invalid_request');
    }
    return {role: message.role, text: textContent(message.content)};
  });
  if (!messages.some(({role}) => role === 'user')) {
    throw new BridgeError('请求缺少用户消息。', 400, 'invalid_request');
  }
  const prompt = messages.map(({role, text}) => `[${role}]\n${text}`).join('\n\n');
  if (prompt.length > 160_000) throw new BridgeError('翻译文本过长。', 413, 'request_too_large');
  return {model: body.model.trim(), prompt};
}

export function agentProfile(agent, environment = process.env) {
  if (agent === 'copilot') {
    return {
      command: environment.FLUENTREAD_COPILOT_PATH || 'copilot',
      args: ['--acp', '--stdio', '--available-tools=', '--deny-tool=read,write,shell,url,memory', '--disable-builtin-mcps'],
      env: environment,
    };
  }
  if (agent === 'opencode') {
    let existing = {};
    if (environment.OPENCODE_CONFIG_CONTENT) {
      try { existing = JSON.parse(environment.OPENCODE_CONFIG_CONTENT); }
      catch { throw new BridgeError('OpenCode 内联配置不是有效 JSON。', 500, 'invalid_agent_config'); }
    }
    const deny = {action: '*', resource: '*', effect: 'deny'};
    const translationAgent = {
      description: 'Translate supplied text without using tools or files.',
      mode: 'primary',
      permission: {'*': 'deny'},
      tools: {'*': false},
      prompt: 'Return only the requested translation. Never use tools or access files.',
    };
    return {
      command: environment.FLUENTREAD_OPENCODE_PATH || 'opencode',
      args: ['acp'],
      env: {
        ...environment,
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          ...existing,
          default_agent: 'fluentread_translate',
          permission: {'*': 'deny'},
          tools: {'*': false},
          permissions: [deny],
          agent: {
            ...existing.agent,
            build: {...existing.agent?.build, permission: {'*': 'deny'}, tools: {'*': false}},
            plan: {...existing.agent?.plan, permission: {'*': 'deny'}, tools: {'*': false}},
            fluentread_translate: translationAgent,
          },
          agents: {
            ...existing.agents,
            build: {...existing.agents?.build, permissions: [deny]},
            plan: {...existing.agents?.plan, permissions: [deny]},
            fluentread_translate: {
              description: translationAgent.description,
              mode: 'primary',
              system: translationAgent.prompt,
              permissions: [deny],
            },
          },
        }),
      },
    };
  }
  throw new BridgeError('仅支持 copilot 或 opencode。', 400, 'invalid_agent');
}

function availableModelOptions(session) {
  const option = session.configOptions?.find((item) => item.category === 'model' || item.id === 'model');
  if (!option) return null;
  const values = (option.options || []).flatMap((item) => item.options || [item]);
  return {id: option.id, current: option.currentValue, values: values.map((item) => item.value)};
}

export class AcpClient {
  constructor(profile, cwd, spawnProcess = spawn) {
    this.profile = profile;
    this.cwd = cwd;
    this.spawnProcess = spawnProcess;
    this.pending = new Map();
    this.nextId = 1;
    this.buffer = '';
    this.activeSession = null;
    this.chunks = [];
    this.process = null;
    this.capabilities = {};
    this.stopping = new Set();
    this.stopError = null;
  }

  async start() {
    if (this.process) return;
    const child = this.spawnProcess(this.profile.command, this.profile.args, {
      cwd: this.cwd, env: this.profile.env, stdio: ['pipe', 'pipe', 'ignore'],
    });
    this.process = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { if (this.process === child) this.onData(chunk); });
    child.on('error', () => {
      if (this.process === child) this.fail(new BridgeError('无法启动 Agent，请检查 CLI 是否已安装。', 503, 'agent_unavailable'));
    });
    child.on('exit', () => {
      if (this.process === child) this.fail(new BridgeError('Agent 已退出，请检查登录状态或 CLI 配置。', 503, 'agent_exited'));
    });
    child.stdin.on('error', () => {
      if (this.process === child) this.fail(new BridgeError('Agent 输入连接已断开。', 503, 'agent_unavailable'));
    });
    try {
    const initialized = await this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {fs: {readTextFile: false, writeTextFile: false}, terminal: false},
      clientInfo: {name: 'fluentread-agent-bridge', title: 'FluentRead Agent Bridge', version: '0.1.0'},
    }, 10_000);
    if (initialized?.protocolVersion !== 1) {
      this.fail(new BridgeError('Agent 不支持 ACP v1。', 502, 'protocol_mismatch'));
      throw new BridgeError('Agent 不支持 ACP v1。', 502, 'protocol_mismatch');
    }
    this.capabilities = initialized.agentCapabilities || {};
    } catch (error) {
      // initialize 拒绝/超时后不能把半初始化进程当作可复用连接。
      if (this.process === child) this.fail(error);
      throw error;
    }
  }

  send(message) {
    if (!this.process?.stdin.writable) throw new BridgeError('Agent 连接不可用。', 503, 'agent_unavailable');
    this.process.stdin.write(`${JSON.stringify({jsonrpc: '2.0', ...message})}\n`);
  }

  request(method, params, timeoutMs = 10_000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeError('Agent 响应超时。', 504, 'agent_timeout'));
      }, timeoutMs);
      this.pending.set(id, {resolve, reject, timer});
      try { this.send({id, method, params}); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  onData(chunk) {
    this.buffer += chunk;
    let newline;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (Buffer.byteLength(line, 'utf8') > MAX_ACP_LINE_BYTES) {
        this.fail(new BridgeError('Agent 返回的协议消息过大。', 502, 'protocol_error'));
        return;
      }
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); }
      catch { this.fail(new BridgeError('Agent 返回了无效的 ACP 消息。', 502, 'protocol_error')); return; }
      if (!message || typeof message !== 'object' || Array.isArray(message)) {
        this.fail(new BridgeError('Agent 返回了无效的 ACP 消息。', 502, 'protocol_error'));
        return;
      }
      this.onMessage(message);
    }
    if (Buffer.byteLength(this.buffer, 'utf8') > MAX_ACP_LINE_BYTES) {
      this.fail(new BridgeError('Agent 返回的协议消息过大。', 502, 'protocol_error'));
    }
  }

  onMessage(message) {
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new BridgeError('Agent 拒绝了请求，请检查模型或登录状态。', 502, 'agent_rejected'));
      else pending.resolve(message.result);
      return;
    }
    if (message.method === 'session/request_permission' && message.id !== undefined) {
      this.send({id: message.id, result: {outcome: {outcome: 'cancelled'}}});
      return;
    }
    if (message.method === 'session/update' && message.params?.sessionId === this.activeSession) {
      const update = message.params.update;
      if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
        this.chunks.push(update.content.text);
      } else if (update?.sessionUpdate === 'tool_call' || update?.sessionUpdate === 'tool_call_update') {
        this.fail(new BridgeError('Agent 尝试调用工具，翻译已中止。', 502, 'tool_call_blocked'));
      }
      return;
    }
    if (message.id !== undefined && message.method) {
      this.send({id: message.id, error: {code: -32601, message: 'Client capability unavailable'}});
    }
  }

  fail(error) {
    const child = this.process;
    this.process = null;
    this.buffer = '';
    this.capabilities = {};
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    if (child) {
      // killed 只表示已发送信号；必须等到 close，才能确认自有进程及管道已释放。
      const stopped = new Promise((resolve, reject) => {
        let termTimer, killTimer, firstError;
        const finish = (error) => {
          clearTimeout(termTimer);
          clearTimeout(killTimer);
          child.off('close', closed);
          if (error || firstError) reject(firstError || error);
          else resolve();
        };
        const closed = () => finish();
        child.once('close', closed);
        termTimer = setTimeout(() => {
          killTimer = setTimeout(() => {
            finish(new BridgeError('Agent 停止后未确认进程与管道关闭。', 503, 'agent_stop_timeout'));
            for (const stream of [child.stdin, child.stdout, child.stderr]) {
              try { stream?.destroy(); } catch { /* 已记录停止错误；继续释放其他自有管道。 */ }
            }
          }, 2_000);
          try { child.kill('SIGKILL'); }
          catch (error) { firstError ||= error; }
        }, 2_000);
        try { child.kill('SIGTERM'); }
        catch (error) { firstError ||= error; }
      });
      this.stopping.add(stopped);
      void stopped.then(() => this.stopping.delete(stopped), (error) => {
        this.stopError ||= error;
        this.stopping.delete(stopped);
      });
    }
  }

  async turn(model, prompt) {
    await this.start();
    const session = await this.request('session/new', {cwd: this.cwd, mcpServers: []});
    if (typeof session?.sessionId !== 'string') throw new BridgeError('Agent 未创建会话。', 502, 'protocol_error');
    const sessionId = session.sessionId;
    this.activeSession = sessionId;
    this.chunks = [];
    try {
      if (model !== 'default') {
        const options = availableModelOptions(session);
        if (options) {
          if (!options.values.includes(model)) {
            throw new BridgeError('Agent 未提供所选模型；请使用它返回的模型 ID。', 422, 'model_unavailable');
          }
          if (options.current !== model) {
            await this.request('session/set_config_option', {sessionId, configId: options.id, value: model});
          }
        } else if (session.models?.availableModels?.some((item) => item.modelId === model)) {
          await this.request('session/set_model', {sessionId, modelId: model});
        } else {
          throw new BridgeError('Agent 未提供所选模型；请使用 default。', 422, 'model_unavailable');
        }
      }
      const result = await this.request('session/prompt', {
        sessionId, prompt: [{type: 'text', text: prompt}],
      }, TURN_TIMEOUT_MS);
      const content = this.chunks.join('');
      if (result?.stopReason !== 'end_turn' || !content.trim()) {
        throw new BridgeError('Agent 未完成文本回答。', 502, 'empty_response');
      }
      return content;
    } finally {
      this.activeSession = null;
      this.chunks = [];
      // 每次翻译使用独立会话；关闭并删除桥接创建的会话，避免跨网页串入上下文。
      if (this.process && this.capabilities.sessionCapabilities?.close) {
        await this.request('session/close', {sessionId}, 2_000).catch(() => {});
      }
      if (this.process && this.capabilities.sessionCapabilities?.delete) {
        await this.request('session/delete', {sessionId}, 2_000).catch(() => {});
      }
    }
  }

  async close() {
    this.fail(new BridgeError('桥接已停止。', 503, 'bridge_stopped'));
    await Promise.allSettled(this.stopping);
    if (this.stopError) throw this.stopError;
  }
}

function writeJson(response, status, body, origin) {
  const headers = {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store'};
  if (origin && EXTENSION_ORIGIN.test(origin)) {
    headers['access-control-allow-origin'] = origin;
    headers.vary = 'Origin';
  }
  response.writeHead(status, headers);
  response.end(JSON.stringify(body));
}

async function readBody(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new BridgeError('请求体过大。', 413, 'request_too_large');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new BridgeError('请求体必须是 JSON。', 400, 'invalid_json'); }
}

export async function createBridge({agent = 'copilot', port = 47627, token = randomBytes(32).toString('hex'),
  spawnProcess = spawn, environment = process.env} = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new BridgeError('端口无效。', 400, 'invalid_port');
  if (typeof token !== 'string' || token.length < 32) throw new BridgeError('桥接令牌至少需要 32 个字符。', 400, 'invalid_token');
  const profile = agentProfile(agent, environment);
  const cwd = mkdtempSync(join(tmpdir(), 'fluentread-agent-'));
  const acp = new AcpClient(profile, cwd, spawnProcess);
  let queued = 0;
  let tail = Promise.resolve();
  let closing;
  const server = createServer(async (request, response) => {
    const origin = request.headers.origin;
    const host = request.headers.host;
    const localHost = host === `127.0.0.1:${server.address()?.port}`;
    if (!localHost || (origin && !EXTENSION_ORIGIN.test(origin))) {
      writeJson(response, 403, {error: {message: '仅允许本机扩展访问。', code: 'forbidden'}}, null);
      return;
    }
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'access-control-allow-origin': origin || '',
        'access-control-allow-methods': 'POST, OPTIONS',
        'access-control-allow-headers': 'authorization, content-type',
        vary: 'Origin',
      });
      response.end();
      return;
    }
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      writeJson(response, 404, {error: {message: '接口不存在。', code: 'not_found'}}, origin);
      return;
    }
    const supplied = request.headers.authorization?.replace(/^Bearer /i, '') || '';
    if (!safeEqual(supplied, token)) {
      writeJson(response, 401, {error: {message: '桥接令牌无效。', code: 'unauthorized'}}, origin);
      return;
    }
    try {
      const {model, prompt} = parseChatRequest(await readBody(request));
      if (queued >= MAX_QUEUED_TURNS) throw new BridgeError('Agent 正忙，请稍后重试。', 429, 'agent_busy');
      queued++;
      let active = false;
      response.once('close', () => {
        if (active && !response.writableEnded) void acp.close().catch(() => {});
      });
      const job = tail.then(async () => {
        if (response.destroyed) throw new BridgeError('请求已取消。', 499, 'cancelled');
        active = true;
        try { return await acp.turn(model, prompt); }
        finally { active = false; }
      });
      tail = job.catch(() => {});
      let content;
      try { content = await job; }
      finally { queued--; }
      if (!response.destroyed) writeJson(response, 200, {
        id: `acp-${randomBytes(8).toString('hex')}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{index: 0, message: {role: 'assistant', content}, finish_reason: 'stop'}],
      }, origin);
    } catch (error) {
      if (error?.code === 'agent_timeout' || error?.code === 'protocol_error') void acp.close().catch(() => {});
      if (!response.destroyed) {
        const known = error instanceof BridgeError ? error : new BridgeError('桥接处理失败。');
        writeJson(response, known.status, {error: {message: known.message, code: known.code}}, origin);
      }
    }
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
  } catch (error) {
    await acp.close().catch(() => {});
    try { rmSync(cwd, {recursive: true, force: true}); } catch { /* 保留监听失败这一首错。 */ }
    throw error;
  }
  return {
    server, token, port: server.address().port,
    close() {
      return closing ||= (async () => {
        let firstError, serverError;
        // 先停止接收/销毁连接，避免等待 Agent 退出时新请求又取得自有进程。
        try { server.closeAllConnections(); } catch (error) { serverError = error; }
        const serverClosed = new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        void serverClosed.catch((error) => { serverError ||= error; });
        try { await acp.close(); } catch (error) { firstError ||= error; }
        try { await serverClosed; } catch (error) { serverError ||= error; }
        firstError ||= serverError;
        try { rmSync(cwd, {recursive: true, force: true}); } catch (error) { firstError ||= error; }
        if (firstError) throw firstError;
      })();
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = Object.fromEntries(process.argv.slice(2).map((value) => {
    const match = value.match(/^--(agent|port)=(.+)$/);
    if (!match) throw new Error('用法：node scripts/agent-bridge/bridge.mjs [--agent=copilot|opencode] [--port=47627]');
    return [match[1], match[2]];
  }));
  const bridge = await createBridge({
    agent: args.agent || 'copilot',
    port: args.port === undefined ? 47627 : Number(args.port),
    token: process.env.FLUENTREAD_AGENT_BRIDGE_TOKEN || randomBytes(32).toString('hex'),
  });
  console.log(`FluentRead ACP 桥接已启动： http://127.0.0.1:${bridge.port}/v1/chat/completions`);
  console.log(`Agent: ${args.agent || 'copilot'}；将此令牌填入 FluentRead 自定义服务的 API Key：${bridge.token}`);
  const stop = async () => {
    try { await bridge.close(); process.exit(0); }
    catch (error) { console.error(error); process.exit(1); }
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
