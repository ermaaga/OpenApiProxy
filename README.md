# openproxy
> Local proxy that exposes OpenAI-compatible providers (NVIDIA NIM, Groq, OpenAI, …) through the Anthropic Messages API. Drop-in endpoint for Claude Code.

Translates `POST /v1/messages` (Anthropic format) into `POST /chat/completions` (OpenAI format) and back, with full support for streaming (SSE) and tool use. Designed to let you run Claude Code against any provider that speaks the OpenAI chat-completions API.

---

## Install

```bash
npm install -g openai-proxy
```

This installs the global `openproxy` command. Requires Node.js ≥ 18.

---

## Get an upstream API key

Pick any provider that exposes an OpenAI-compatible endpoint:

| Provider | API base | Notes |
|----------|----------|-------|
| [NVIDIA NIM](https://build.nvidia.com) | `https://integrate.api.nvidia.com/v1` | Free tier, large models (Qwen, Llama, …) |
| [Groq](https://console.groq.com) | `https://api.groq.com/openai/v1` | Free tier, fast inference |
| [OpenAI](https://platform.openai.com) | `https://api.openai.com/v1` | Paid |

---

## First-time setup

Easiest way — let the browser walk you through it:

```bash
openproxy test
```

This starts the proxy and opens the configuration page at `http://127.0.0.1:4000/test`. Fill in **API Key**, **API Base URL** and **Model**, click **Save configuration** and you're done. Settings are persisted to `~/.openproxy/config.json` (mode `600` on POSIX). Next time, just run `openproxy start`.

Prefer the CLI?

```bash
openproxy config \
  --api-key nvapi-XXXXXXXXXX \
  --model qwen/qwen3-coder-480b-a35b-instruct
```

Inspect (with API key redacted):

```bash
openproxy config
```

Clear:

```bash
openproxy config --clear
```

---

## Daily usage

```bash
openproxy start          # detach and run in background
openproxy status         # check if running
openproxy stop           # stop the background process
openproxy logs -f        # follow logs
openproxy test           # open the browser-based tester / config page
```

The proxy binds to `127.0.0.1` only (loopback), so the config endpoint isn't reachable from the network.

Override config on the fly:

```bash
openproxy start --port 5000 --model another-model
```

Run attached to the current shell (useful for debugging):

```bash
openproxy start --foreground
```

---

## Use with Claude Code

Once the proxy is running:

```bash
export ANTHROPIC_BASE_URL="http://localhost:4000"
export ANTHROPIC_API_KEY="fake-key"   # any string — the proxy uses its own server-side key
claude
```

Persist these in your shell rc (`~/.zshrc`, `~/.bashrc`):

```bash
echo 'export ANTHROPIC_BASE_URL="http://localhost:4000"' >> ~/.zshrc
echo 'export ANTHROPIC_API_KEY="fake-key"' >> ~/.zshrc
source ~/.zshrc
```

---

## Browser tester

After `openproxy start`, run:

```bash
openproxy test
```

This opens `http://localhost:4000/test` in your default browser. The page lets you:
- send a request to the proxy and see the parsed response
- toggle streaming (SSE) mode
- copy the equivalent `curl` command

You can also visit the URL directly.

---

## All commands

```
openproxy start [options]    Start the proxy in the background
openproxy stop               Stop the proxy
openproxy status             Show running state
openproxy test               Open the browser-based tester
openproxy logs [-f]          Print proxy logs (-f to follow)
openproxy config [options]   Persist config to ~/.openproxy/config.json
openproxy help               Show usage

Options (start / config):
  --api-key  <key>     Upstream API key
  --api-base <url>     Upstream base URL  (default: https://integrate.api.nvidia.com/v1)
  --model    <name>    Model to forward upstream
  --port     <n>       Local port         (default: 4000)
  --timeout  <s>       Upstream timeout   (default: 300)

start-only:
  --foreground         Run attached to current shell instead of detaching

config-only:
  --clear              Delete the saved config file
```

---

## Configuration precedence

For each setting, the first source that has a value wins:

1. CLI flag (`--api-key`, `--model`, …)
2. Environment variable (`API_KEY`, `MODEL`, `API_BASE`, `PORT`, `REQUEST_TIMEOUT`)
3. `~/.openproxy/config.json`
4. Built-in default (only for `api-base`, `port`, `timeout`)

The proxy starts even without `API_KEY` / `MODEL`, but `/v1/messages` returns **503** until both are set. Use `openproxy test` (browser UI) or `openproxy config` to finish setup.

### Shell env vars vs saved config — important caveat

If you export `API_KEY` / `MODEL` / `API_BASE` in your shell, **those win over `~/.openproxy/config.json`** at every start.

Saving from the browser config panel writes to the file. The running proxy switches to the new values immediately, but on the **next** restart the shell env var takes precedence again — making the save look like it had no effect.

The config page makes this explicit:

- Each field has a source badge: `saved` (green, from file) or `from env var` (yellow, from shell)
- A yellow banner appears at the top of the Configuration panel listing every shell env var that will override on next start, with the exact `unset` command to fix it

If you want saved config to be authoritative, `unset` the matching shell env vars and start a fresh shell session. If you prefer managing credentials via shell env, ignore the file and skip the browser save.

The proxy detects "shell" env vars via `OPENPROXY_SHELL_ENV` — set automatically by the `openproxy` CLI to record which env vars were present in the user's shell at invocation time. When the server runs without the CLI wrapper, any env var is assumed to come from the shell.

---

## Files

| Path | Purpose |
|------|---------|
| `~/.openproxy/config.json` | Persisted config (chmod 600 on POSIX) |
| `~/.openproxy/proxy.pid` | Background process PID |
| `~/.openproxy/proxy.log` | Combined stdout/stderr of the proxy |

---

## Common errors

| Error | Cause | Fix |
|-------|-------|-----|
| `503 Proxy not configured` from proxy | API key or model still unset | `openproxy test` (browser) or `openproxy config --api-key K --model M` |
| `Proxy already running` | A previous instance is still alive | `openproxy stop` |
| `401 Unauthorized` from upstream | Wrong API key | Re-run `openproxy config --api-key …` |
| `404 Not Found` from upstream | Wrong model name | Verify the exact slug on the provider's site |
| `Upstream timeout` | Slow provider | Increase: `openproxy start --timeout 600` |
| Saved values reappear after restart | Shell env vars override the file | `unset API_KEY MODEL` then restart (the test page lists which) |
| Claude Code: `model not found` | Missing client env vars | Re-export `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY` |

---

## Flow

```
Claude Code  ──(Anthropic format)──▶  openproxy (localhost:4000)
                                          │
                                          ▼  (OpenAI format)
                                    Provider API
                                          │
                                          ▼  (OpenAI response, possibly SSE)
                                       openproxy
                                          │  (Anthropic response, possibly SSE)
                                          ▼
                                      Claude Code  ✅
```

---

## License

MIT
