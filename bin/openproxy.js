#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const CONFIG_DIR = path.join(os.homedir(), '.openproxy');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const PID_FILE = path.join(CONFIG_DIR, 'proxy.pid');
const LOG_FILE = path.join(CONFIG_DIR, 'proxy.log');
const SERVER_SCRIPT = path.join(__dirname, '..', 'src', 'server.js');

const DEFAULT_API_BASE = 'https://integrate.api.nvidia.com/v1';
const DEFAULT_PORT = 4000;
const DEFAULT_TIMEOUT = 300;

function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch { return {}; }
}

function saveConfig(cfg) {
  ensureConfigDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
  try { fs.chmodSync(CONFIG_FILE, 0o600); } catch { /* windows */ }
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-f') { args.follow = true; continue; }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { args[key] = next; i++; }
      else { args[key] = true; }
    }
  }
  return args;
}

function resolveConfig(flags) {
  const file = loadConfig();
  return {
    apiKey: flags['api-key'] || process.env.API_KEY || file.apiKey,
    apiBase: flags['api-base'] || process.env.API_BASE || file.apiBase || DEFAULT_API_BASE,
    model: flags.model || process.env.MODEL || file.model,
    port: parseInt(flags.port || process.env.PORT || file.port || DEFAULT_PORT, 10),
    timeout: parseInt(flags.timeout || process.env.REQUEST_TIMEOUT || file.timeout || DEFAULT_TIMEOUT, 10),
  };
}

function readPid() {
  if (!fs.existsSync(PID_FILE)) return null;
  const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8'), 10);
  return Number.isFinite(pid) ? pid : null;
}

function isRunning() {
  const pid = readPid();
  if (!pid) return null;
  try { process.kill(pid, 0); return pid; }
  catch { return null; }
}

function cleanupStalePid() {
  if (fs.existsSync(PID_FILE)) { try { fs.unlinkSync(PID_FILE); } catch {} }
}

const RELEVANT_ENV_KEYS = ['API_KEY', 'API_BASE', 'MODEL', 'PORT', 'REQUEST_TIMEOUT'];

function buildSpawnEnv(cfg) {
  const shellEnvKeys = RELEVANT_ENV_KEYS.filter(k => process.env[k] !== undefined);
  const env = {
    ...process.env,
    API_BASE: cfg.apiBase,
    PORT: String(cfg.port),
    REQUEST_TIMEOUT: String(cfg.timeout),
    OPENPROXY_SHELL_ENV: shellEnvKeys.join(','),
  };
  if (cfg.apiKey) env.API_KEY = cfg.apiKey;
  if (cfg.model) env.MODEL = cfg.model;
  return env;
}

function spawnProxy(cfg) {
  ensureConfigDir();
  const env = buildSpawnEnv(cfg);

  const out = fs.openSync(LOG_FILE, 'a');
  const err = fs.openSync(LOG_FILE, 'a');
  const child = spawn(process.execPath, [SERVER_SCRIPT], {
    env,
    detached: true,
    stdio: ['ignore', out, err],
    windowsHide: true,
  });
  child.unref();
  fs.writeFileSync(PID_FILE, String(child.pid));
  return child;
}

function cmdStart(flags) {
  const existing = isRunning();
  if (existing) {
    console.error(`Proxy already running (pid ${existing}). Use 'openproxy stop' first.`);
    process.exit(1);
  }
  cleanupStalePid();

  const cfg = resolveConfig(flags);

  if (flags.foreground) {
    ensureConfigDir();
    const env = buildSpawnEnv(cfg);
    const child = spawn(process.execPath, [SERVER_SCRIPT], { env, stdio: 'inherit' });
    child.on('exit', code => process.exit(code || 0));
    return;
  }

  const child = spawnProxy(cfg);

  console.log(`Proxy started on http://localhost:${cfg.port} (pid ${child.pid})`);
  console.log(`Model    : ${cfg.model || '(not configured)'}`);
  console.log(`API_BASE : ${cfg.apiBase}`);
  console.log(`Logs     : ${LOG_FILE}`);
  if (!cfg.apiKey || !cfg.model) {
    console.log('');
    console.log('⚠  Proxy is NOT fully configured. Finish setup with one of:');
    console.log('   openproxy test                                       (browser UI)');
    console.log('   openproxy config --api-key K --model M               (CLI)');
  } else {
    console.log(`Tester   : openproxy test`);
  }
}

function waitForPort(port, timeoutMs = 5000) {
  const net = require('net');
  const start = Date.now();
  return new Promise(resolve => {
    const tryConnect = () => {
      const socket = net.connect(port, '127.0.0.1');
      socket.once('connect', () => { socket.end(); resolve(true); });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() - start > timeoutMs) return resolve(false);
        setTimeout(tryConnect, 100);
      });
    };
    tryConnect();
  });
}

function cmdStop() {
  const pid = isRunning();
  if (!pid) {
    cleanupStalePid();
    console.error('Proxy is not running.');
    process.exit(1);
  }
  try {
    process.kill(pid);
    cleanupStalePid();
    console.log(`Proxy stopped (pid ${pid}).`);
  } catch (e) {
    console.error(`Failed to stop pid ${pid}: ${e.message}`);
    process.exit(1);
  }
}

function cmdStatus() {
  const pid = isRunning();
  const cfg = resolveConfig({});
  if (pid) {
    console.log(`Running  • pid ${pid} • http://localhost:${cfg.port}`);
    console.log(`Model    : ${cfg.model || '(not set)'}`);
    console.log(`API_BASE : ${cfg.apiBase}`);
  } else {
    console.log('Not running.');
  }
}

function openBrowser(url) {
  const platform = process.platform;
  let cmd, args;
  if (platform === 'darwin') { cmd = 'open'; args = [url]; }
  else if (platform === 'win32') { cmd = 'cmd'; args = ['/c', 'start', '', url]; }
  else { cmd = 'xdg-open'; args = [url]; }
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
}

async function cmdTest() {
  const cfg = resolveConfig({});
  let pid = isRunning();
  if (!pid) {
    cleanupStalePid();
    console.log('Proxy not running — starting it...');
    const child = spawnProxy(cfg);
    pid = child.pid;
    const ready = await waitForPort(cfg.port, 5000);
    if (!ready) {
      console.error(`Proxy started (pid ${pid}) but is not responding on port ${cfg.port}. Check 'openproxy logs'.`);
      process.exit(1);
    }
    console.log(`Started (pid ${pid}).`);
  }
  const url = `http://localhost:${cfg.port}/test`;
  console.log(`Opening ${url}`);
  openBrowser(url);
}

function cmdLogs(flags) {
  if (!fs.existsSync(LOG_FILE)) {
    console.error('No logs yet.');
    process.exit(1);
  }
  if (!(flags.follow || flags.f)) {
    process.stdout.write(fs.readFileSync(LOG_FILE, 'utf8'));
    return;
  }
  let position = fs.statSync(LOG_FILE).size;
  process.stdout.write(fs.readFileSync(LOG_FILE, 'utf8'));
  fs.watch(LOG_FILE, () => {
    fs.stat(LOG_FILE, (err, stats) => {
      if (err) return;
      if (stats.size < position) position = 0;
      if (stats.size === position) return;
      const stream = fs.createReadStream(LOG_FILE, { start: position, end: stats.size });
      stream.pipe(process.stdout, { end: false });
      position = stats.size;
    });
  });
  process.on('SIGINT', () => process.exit(0));
}

function cmdConfig(flags) {
  const current = loadConfig();
  const next = { ...current };
  const mapping = [
    ['api-key', 'apiKey'],
    ['api-base', 'apiBase'],
    ['model', 'model'],
    ['port', 'port'],
    ['timeout', 'timeout'],
  ];
  let changed = false;
  for (const [flag, key] of mapping) {
    if (flags[flag] !== undefined && flags[flag] !== true) {
      next[key] = flags[flag];
      changed = true;
    }
  }
  if (flags.clear) {
    if (fs.existsSync(CONFIG_FILE)) fs.unlinkSync(CONFIG_FILE);
    console.log('Config cleared.');
    return;
  }
  if (changed) {
    saveConfig(next);
    console.log(`Saved to ${CONFIG_FILE}`);
  } else if (!fs.existsSync(CONFIG_FILE)) {
    console.log('No config yet. Run with --api-key and --model to create one.');
    return;
  }
  const display = { ...next };
  if (display.apiKey) display.apiKey = display.apiKey.slice(0, 8) + '...';
  console.log(JSON.stringify(display, null, 2));
}

function cmdHelp() {
  console.log(`openproxy — local Anthropic ↔ OpenAI-compatible proxy

Usage:
  openproxy start [options]    Start the proxy in the background
  openproxy stop               Stop the proxy
  openproxy status             Show running state
  openproxy test               Open the browser-based tester
  openproxy logs [-f]          Print proxy logs (-f to follow)
  openproxy config [options]   Persist config to ~/.openproxy/config.json
  openproxy help               Show this message

Options (start / config):
  --api-key  <key>     Upstream API key
  --api-base <url>     Upstream base URL  (default: ${DEFAULT_API_BASE})
  --model    <name>    Model to forward to upstream
  --port     <n>       Local port         (default: ${DEFAULT_PORT})
  --timeout  <s>       Upstream timeout   (default: ${DEFAULT_TIMEOUT})

start-only:
  --foreground         Run attached to current shell instead of detaching

config-only:
  --clear              Delete the saved config file

Examples:
  openproxy config --api-key nvapi-XXXX --model qwen/qwen3-coder-480b-a35b-instruct
  openproxy start
  openproxy test
  openproxy stop
`);
}

const [, , cmd, ...rest] = process.argv;
const flags = parseArgs(rest);

switch (cmd) {
  case 'start': cmdStart(flags); break;
  case 'stop': cmdStop(); break;
  case 'status': cmdStatus(); break;
  case 'test': cmdTest().catch(e => { console.error(e.message); process.exit(1); }); break;
  case 'logs': cmdLogs(flags); break;
  case 'config': cmdConfig(flags); break;
  case 'help':
  case '--help':
  case '-h':
  case undefined: cmdHelp(); break;
  default:
    console.error(`Unknown command: ${cmd}\n`);
    cmdHelp();
    process.exit(1);
}
