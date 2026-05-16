const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const CONFIG_DIR = path.join(os.homedir(), '.openproxy');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const TESTER_HTML = path.join(__dirname, 'tester.html');

const DEFAULT_API_BASE = 'https://integrate.api.nvidia.com/v1';
const DEFAULT_PORT = 4000;
const DEFAULT_TIMEOUT = 300;
const HOST = process.env.HOST || '127.0.0.1';

const config = {
  apiKey: '',
  apiBase: DEFAULT_API_BASE,
  model: '',
  port: DEFAULT_PORT,
  timeout: DEFAULT_TIMEOUT,
};

const sources = {
  apiKey: null,
  apiBase: null,
  model: null,
};

function getShellEnvKeys() {
  if (process.env.OPENPROXY_SHELL_ENV !== undefined) {
    return new Set(process.env.OPENPROXY_SHELL_ENV.split(',').filter(Boolean));
  }
  return new Set(['API_KEY', 'API_BASE', 'MODEL', 'PORT', 'REQUEST_TIMEOUT']
    .filter(k => process.env[k] !== undefined));
}

function loadConfigFile() {
  if (!fs.existsSync(CONFIG_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch { return {}; }
}

function persistConfig() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({
    apiKey: config.apiKey,
    apiBase: config.apiBase,
    model: config.model,
    port: config.port,
    timeout: config.timeout,
  }, null, 2));
  try { fs.chmodSync(CONFIG_FILE, 0o600); } catch { /* windows */ }
}

function initConfig() {
  const file = loadConfigFile();
  if (file.apiKey) { config.apiKey = file.apiKey; sources.apiKey = 'file'; }
  if (file.apiBase) { config.apiBase = file.apiBase; sources.apiBase = 'file'; }
  if (file.model) { config.model = file.model; sources.model = 'file'; }
  if (file.port) config.port = parseInt(file.port, 10);
  if (file.timeout) config.timeout = parseInt(file.timeout, 10);

  const shell = getShellEnvKeys();
  if (process.env.API_KEY) {
    config.apiKey = process.env.API_KEY;
    if (shell.has('API_KEY')) sources.apiKey = 'env';
  }
  if (process.env.API_BASE) {
    config.apiBase = process.env.API_BASE;
    if (shell.has('API_BASE')) sources.apiBase = 'env';
  }
  if (process.env.MODEL) {
    config.model = process.env.MODEL;
    if (shell.has('MODEL')) sources.model = 'env';
  }
  if (process.env.PORT) config.port = parseInt(process.env.PORT, 10);
  if (process.env.REQUEST_TIMEOUT) config.timeout = parseInt(process.env.REQUEST_TIMEOUT, 10);
}

function configSummary() {
  const shell = getShellEnvKeys();
  const shellEnvOverrides = ['API_KEY', 'API_BASE', 'MODEL'].filter(k => shell.has(k));
  return {
    configured: !!(config.apiKey && config.model),
    hasApiKey: !!config.apiKey,
    apiKeyMasked: config.apiKey ? config.apiKey.slice(0, 8) + '…' : '',
    apiBase: config.apiBase,
    model: config.model,
    port: config.port,
    timeout: config.timeout,
    sources: { ...sources },
    shellEnvOverrides,
  };
}

const FINISH_REASON_MAP = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  function_call: 'tool_use',
  content_filter: 'end_turn',
};

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS, GET',
  'Access-Control-Allow-Headers': 'Content-Type, x-api-key, anthropic-version, authorization',
};

function uuidHex(n) {
  return crypto.randomBytes(Math.ceil(n / 2)).toString('hex').slice(0, n);
}

function flattenText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(c => c && typeof c === 'object' && c.type === 'text')
      .map(c => c.text || '')
      .join('');
  }
  return '';
}

function anthropicToOpenaiMessages(body) {
  const out = [];
  if (body.system) out.push({ role: 'system', content: flattenText(body.system) });

  for (const m of body.messages || []) {
    const role = m.role;
    const content = m.content;
    if (typeof content === 'string') {
      out.push({ role, content });
      continue;
    }

    const textParts = [];
    const toolCalls = [];
    const toolResults = [];

    for (const block of Array.isArray(content) ? content : []) {
      if (!block || typeof block !== 'object') continue;
      switch (block.type) {
        case 'text':
          textParts.push(block.text || '');
          break;
        case 'tool_use':
          toolCalls.push({
            id: block.id || '',
            type: 'function',
            function: {
              name: block.name || '',
              arguments: JSON.stringify(block.input || {}),
            },
          });
          break;
        case 'tool_result': {
          let tr = block.content || '';
          if (Array.isArray(tr)) {
            tr = tr
              .filter(c => c && typeof c === 'object' && c.type === 'text')
              .map(c => c.text || '')
              .join('');
          } else if (typeof tr !== 'string') {
            tr = JSON.stringify(tr);
          }
          toolResults.push({
            role: 'tool',
            tool_call_id: block.tool_use_id || '',
            content: tr,
          });
          break;
        }
        case 'image':
          textParts.push('[image omitted by proxy]');
          break;
      }
    }

    if (role === 'assistant') {
      const msg = { role: 'assistant' };
      const text = textParts.join('');
      msg.content = text || null;
      if (toolCalls.length) msg.tool_calls = toolCalls;
      out.push(msg);
    } else {
      out.push(...toolResults);
      const text = textParts.join('');
      if (text) out.push({ role: 'user', content: text });
    }
  }

  return out;
}

function anthropicToOpenaiTools(tools) {
  if (!Array.isArray(tools) || !tools.length) return null;
  return tools.map(t => ({
    type: 'function',
    function: {
      name: t.name || '',
      description: t.description || '',
      parameters: t.input_schema || { type: 'object', properties: {} },
    },
  }));
}

function anthropicToOpenaiToolChoice(tc) {
  if (!tc) return null;
  if (tc.type === 'auto') return 'auto';
  if (tc.type === 'any') return 'required';
  if (tc.type === 'tool') return { type: 'function', function: { name: tc.name } };
  return null;
}

function buildOpenaiBody(body, stream) {
  const openaiBody = {
    model: config.model,
    messages: anthropicToOpenaiMessages(body),
    max_tokens: body.max_tokens || 4096,
    stream: !!stream,
  };
  if (stream) openaiBody.stream_options = { include_usage: true };
  if (body.temperature !== undefined) openaiBody.temperature = body.temperature;
  if (body.top_p !== undefined) openaiBody.top_p = body.top_p;
  if (body.stop_sequences) openaiBody.stop = body.stop_sequences;
  const tools = anthropicToOpenaiTools(body.tools);
  if (tools) {
    openaiBody.tools = tools;
    const choice = anthropicToOpenaiToolChoice(body.tool_choice);
    if (choice !== null) openaiBody.tool_choice = choice;
  }
  return openaiBody;
}

function convertNonStreamResponse(body, oai) {
  const choice = (oai.choices || [])[0];
  if (!choice) throw new Error('Malformed upstream response: no choices');
  const msg = choice.message || {};
  const finish = choice.finish_reason || 'stop';

  const contentBlocks = [];
  if (msg.content) contentBlocks.push({ type: 'text', text: msg.content });
  for (const tc of msg.tool_calls || []) {
    let args = {};
    try { args = JSON.parse((tc.function || {}).arguments || '{}'); } catch {}
    contentBlocks.push({
      type: 'tool_use',
      id: tc.id || `toolu_${uuidHex(16)}`,
      name: (tc.function || {}).name || '',
      input: args,
    });
  }
  if (!contentBlocks.length) contentBlocks.push({ type: 'text', text: '' });

  const usage = oai.usage || {};
  return {
    id: oai.id || `msg_${uuidHex(16)}`,
    type: 'message',
    role: 'assistant',
    content: contentBlocks,
    model: body.model || config.model,
    stop_reason: FINISH_REASON_MAP[finish] || 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: usage.prompt_tokens || 0,
      output_tokens: usage.completion_tokens || 0,
    },
  };
}

function callUpstream(body, stream) {
  const openaiBody = buildOpenaiBody(body, stream);
  const url = new URL(`${config.apiBase}/chat/completions`);
  const lib = url.protocol === 'https:' ? https : http;
  const data = Buffer.from(JSON.stringify(openaiBody));
  const options = {
    method: 'POST',
    hostname: url.hostname,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path: url.pathname + url.search,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': data.length,
      'Authorization': `Bearer ${config.apiKey}`,
    },
    timeout: config.timeout * 1000,
  };
  return new Promise((resolve, reject) => {
    const req = lib.request(options, resolve);
    req.on('error', reject);
    req.on('timeout', () => req.destroy(Object.assign(new Error('Upstream timeout'), { timeout: true })));
    req.write(data);
    req.end();
  });
}

function writeJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': body.length,
    ...CORS_HEADERS,
  });
  res.end(body);
}

function writeError(res, status, message) {
  writeJson(res, status, {
    type: 'error',
    error: { type: 'proxy_error', message },
  });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

async function drainText(resp) {
  let buf = '';
  for await (const c of resp) buf += c;
  return buf;
}

async function handleConfigPost(req, res) {
  let body;
  try { body = await readJsonBody(req); }
  catch (e) { return writeError(res, 400, `Invalid JSON: ${e.message}`); }

  if (typeof body.apiKey === 'string' && body.apiKey !== '') {
    config.apiKey = body.apiKey;
    sources.apiKey = 'file';
  }
  if (typeof body.apiBase === 'string' && body.apiBase !== '') {
    config.apiBase = body.apiBase;
    sources.apiBase = 'file';
  }
  if (typeof body.model === 'string' && body.model !== '') {
    config.model = body.model;
    sources.model = 'file';
  }

  try { persistConfig(); }
  catch (e) { return writeError(res, 500, `Failed to save config: ${e.message}`); }

  console.log(`[proxy] config updated via web: model=${config.model} apiBase=${config.apiBase}`);
  writeJson(res, 200, configSummary());
}

async function handleNonStream(body, res) {
  let upstream;
  try { upstream = await callUpstream(body, false); }
  catch (e) {
    if (e.timeout) return writeError(res, 504, 'Upstream timeout');
    return writeError(res, 502, `Upstream connection error: ${e.message}`);
  }

  if (upstream.statusCode >= 400) {
    const err = await drainText(upstream);
    console.log(`[proxy] upstream ${upstream.statusCode}: ${err.slice(0, 500)}`);
    res.writeHead(upstream.statusCode, { 'Content-Type': 'application/json', ...CORS_HEADERS });
    return res.end(err);
  }

  const raw = await drainText(upstream);
  let oai;
  try { oai = JSON.parse(raw); }
  catch { return writeError(res, 502, 'Malformed upstream JSON'); }
  try { writeJson(res, 200, convertNonStreamResponse(body, oai)); }
  catch (e) { writeError(res, 500, e.message); }
}

async function handleStream(body, res) {
  let upstream;
  try { upstream = await callUpstream(body, true); }
  catch (e) {
    if (e.timeout) return writeError(res, 504, 'Upstream timeout');
    return writeError(res, 502, `Upstream connection error: ${e.message}`);
  }

  if (upstream.statusCode >= 400) {
    const err = await drainText(upstream);
    console.log(`[proxy] upstream ${upstream.statusCode}: ${err.slice(0, 500)}`);
    res.writeHead(upstream.statusCode, { 'Content-Type': 'application/json', ...CORS_HEADERS });
    return res.end(err);
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    ...CORS_HEADERS,
  });

  const msgId = `msg_${uuidHex(24)}`;
  const state = {
    msgStarted: false,
    textOpen: false,
    textIdx: null,
    toolBlocks: new Map(),
    nextIdx: 0,
    finish: null,
    inputTokens: 0,
    outputTokens: 0,
  };

  const sse = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const startMessage = () => {
    state.msgStarted = true;
    sse('message_start', {
      type: 'message_start',
      message: {
        id: msgId,
        type: 'message',
        role: 'assistant',
        content: [],
        model: body.model || config.model,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  };

  const openText = () => {
    state.textIdx = state.nextIdx++;
    state.textOpen = true;
    sse('content_block_start', {
      type: 'content_block_start',
      index: state.textIdx,
      content_block: { type: 'text', text: '' },
    });
  };

  const closeText = () => {
    if (state.textOpen) {
      sse('content_block_stop', { type: 'content_block_stop', index: state.textIdx });
      state.textOpen = false;
    }
  };

  const openTool = (oaiIdx, callId, name) => {
    if (state.textOpen) closeText();
    const anthIdx = state.nextIdx++;
    state.toolBlocks.set(oaiIdx, { anthIdx, id: callId, name });
    sse('content_block_start', {
      type: 'content_block_start',
      index: anthIdx,
      content_block: { type: 'tool_use', id: callId, name, input: {} },
    });
  };

  let buffer = '';
  upstream.setEncoding('utf8');
  try {
    for await (const chunk of upstream) {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line || !line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') { buffer = ''; break; }
        let oaiChunk;
        try { oaiChunk = JSON.parse(payload); } catch { continue; }

        const u = oaiChunk.usage;
        if (u) {
          if (u.prompt_tokens != null) state.inputTokens = u.prompt_tokens;
          if (u.completion_tokens != null) state.outputTokens = u.completion_tokens;
        }

        const ch = (oaiChunk.choices || [])[0];
        if (!ch) continue;
        const delta = ch.delta || {};

        if (!state.msgStarted) startMessage();

        const txt = delta.content;
        if (txt) {
          if (!state.textOpen) openText();
          sse('content_block_delta', {
            type: 'content_block_delta',
            index: state.textIdx,
            delta: { type: 'text_delta', text: txt },
          });
        }

        for (const tc of delta.tool_calls || []) {
          const oaiIdx = tc.index != null ? tc.index : 0;
          const fn = tc.function || {};
          if (!state.toolBlocks.has(oaiIdx)) {
            const callId = tc.id || `toolu_${uuidHex(16)}`;
            openTool(oaiIdx, callId, fn.name || '');
          }
          const argsPiece = fn.arguments || '';
          if (argsPiece) {
            sse('content_block_delta', {
              type: 'content_block_delta',
              index: state.toolBlocks.get(oaiIdx).anthIdx,
              delta: { type: 'input_json_delta', partial_json: argsPiece },
            });
          }
        }

        if (ch.finish_reason) state.finish = ch.finish_reason;
      }
    }

    if (state.textOpen) closeText();
    for (const t of state.toolBlocks.values()) {
      sse('content_block_stop', { type: 'content_block_stop', index: t.anthIdx });
    }
    if (!state.msgStarted) startMessage();
    sse('message_delta', {
      type: 'message_delta',
      delta: {
        stop_reason: FINISH_REASON_MAP[state.finish || 'stop'] || 'end_turn',
        stop_sequence: null,
      },
      usage: { output_tokens: state.outputTokens },
    });
    sse('message_stop', { type: 'message_stop' });
  } catch (e) {
    if (e.code !== 'EPIPE' && e.code !== 'ECONNRESET') {
      console.error('[proxy] stream error:', e);
    }
  } finally {
    try { res.end(); } catch {}
  }
}

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  console.log(`[proxy] ${req.method} ${url}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    return res.end();
  }

  if (req.method === 'GET' && (url === '/test' || url === '/test.html' || url === '/')) {
    fs.readFile(TESTER_HTML, (err, data) => {
      if (err) { res.writeHead(500); return res.end('tester.html missing'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...CORS_HEADERS });
      res.end(data);
    });
    return;
  }

  if (url === '/config') {
    if (req.method === 'GET') return writeJson(res, 200, configSummary());
    if (req.method === 'POST') return handleConfigPost(req, res);
    res.writeHead(405, CORS_HEADERS);
    return res.end();
  }

  if (req.method !== 'POST') {
    res.writeHead(405, CORS_HEADERS);
    return res.end();
  }

  if (!config.apiKey || !config.model) {
    return writeError(res, 503,
      'Proxy not configured. Run `openproxy test` and use the Configuration panel, ' +
      'or `openproxy config --api-key K --model M`.');
  }

  let body;
  try { body = await readJsonBody(req); }
  catch (e) { return writeError(res, 400, `Invalid JSON: ${e.message}`); }

  try {
    if (body.stream) await handleStream(body, res);
    else await handleNonStream(body, res);
  } catch (e) {
    console.error('[proxy] handler error:', e);
    if (!res.headersSent) writeError(res, 500, `Proxy internal error: ${e.message}`);
    else { try { res.end(); } catch {} }
  }
});

server.on('clientError', (err, socket) => {
  try { socket.destroy(); } catch {}
});

function main() {
  initConfig();
  console.log(`[proxy] API_BASE   : ${config.apiBase}`);
  console.log(`[proxy] MODEL      : ${config.model || '(not configured)'}`);
  console.log(`[proxy] API_KEY    : ${config.apiKey ? config.apiKey.slice(0, 12) + '...' : '(not configured)'}`);
  console.log(`[proxy] timeout    : ${config.timeout}s`);
  console.log(`[proxy] Listening on http://${HOST}:${config.port}`);
  if (!config.apiKey || !config.model) {
    console.log(`[proxy] NOT FULLY CONFIGURED — open http://${HOST}:${config.port}/test to finish setup`);
  }
  server.listen(config.port, HOST);
}

const shutdown = () => {
  console.log('[proxy] shutting down');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

main();
