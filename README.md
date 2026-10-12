<div align="center">

# Pittacus Relay

**Local API-key vault & gateway for AI coding tools. Keep your real keys safe. Switch models instantly.**

[![release](https://img.shields.io/github/v/release/ctrlcakepro/pittacus-relay?style=flat-square)](https://github.com/ctrlcakepro/pittacus-relay/releases/latest)
[![downloads](https://img.shields.io/github/downloads/ctrlcakepro/pittacus-relay/total?style=flat-square)](https://github.com/ctrlcakepro/pittacus-relay/releases)
[![license](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-lightgrey?style=flat-square)](#-download)
[![TypeScript](https://img.shields.io/badge/TypeScript-4.x-blue?style=flat-square)]()

**[🚀 Get Started (2 min)](#-quick-start)** · **[📺 Demo](#-whats-the-problem)** · **[⬇️ Download](#-download)** · **[🔒 Security](#-security)** · **[📚 Docs](#-how-it-works)**

English · [简体中文](README.zh-CN.md)

</div>

---

## 🎯 What's the Problem?

<table>
<tr>
<td width="50%">

### ❌ The Traditional Way

You put your real API key in Claude Code's config:
```json
{
  "ANTHROPIC_AUTH_TOKEN": "sk-ant-v0-abc..."
}
```

✗ Pushed to GitHub? → **Compromised**  
✗ Screenshot/screen rec? → **Leaked**  
✗ Prompt injection? → **Stolen**  
✗ Need to revoke? → Regenerate everywhere

</td>
<td width="50%">

### ✅ With Pittacus Relay

You put only a **local key** in Claude Code:
```json
{
  "ANTHROPIC_AUTH_TOKEN": "pittacus-local-abc123"
}
```

✓ Real key locked in local gateway  
✓ Screenshot leaks nothing  
✓ Prompt injection gets useless key  
✓ Revoke instantly, one click  
✓ Switch providers without reconfiguring

</td>
</tr>
</table>

**Real keys never leave your machine. Real keys never written to config files. One local key, one revoke, done.**

<p align="center">
  <img src="design/promo/pittacus-relay-demo.gif" width="600" alt="Demo: connect Claude Code in Pittacus Relay, see that settings.json holds only a local key, then switch models from Claude Code's /model list">
  <br>
  <sub><strong>Demo:</strong> Connect Claude Code, see only a local key in settings.json, switch models in /model. Keys are blurred.</sub>
</p>

---

## 🚀 Quick Start (Install → Add Keys → Done)

### 1️⃣ Download & Run (2 minutes)

**[⬇️ Download Latest Release](https://github.com/ctrlcakepro/pittacus-relay/releases/latest)**

| OS | Download |
|---|---|
| **Windows 10/11** (x64) | `Pittacus-Relay-<version>-win-x64.exe` |
| **Windows ARM** | `Pittacus-Relay-<version>-win-arm64.exe` |
| **macOS Apple Silicon** | `Pittacus-Relay-<version>-mac-arm64.dmg` |
| **macOS Intel** | `Pittacus-Relay-<version>-mac-x64.dmg` |

> ℹ️ Not code-signed yet? First launch: Windows → click "Run anyway" | macOS → System Settings → "Open Anyway"

### 2️⃣ Add Your Providers (1 minute)

1. Open Pittacus Relay
2. Go to **Providers** tab
3. Click **Add Provider**
4. Paste your real API key (e.g., OpenAI, DeepSeek, Kimi)
5. Key is encrypted in OS keychain, never visible again

### 3️⃣ Connect Your Tools (1 minute)

Pick your AI tool:

| Tool | Connect | Then |
|---|---|---|
| **Claude Code** | Click "Connect" on Overview | Use `/model` to switch providers |
| **Codex** | Click "Connect" on Overview | Use `/model` to pick any model |
| **opencode** | Click "Connect" on Overview | Model dropdown auto-populated |

✨ **That's it.** Tools only see local keys. You see model options everywhere.

---

## ✨ Why Developers Love It

| Feature | You Get |
|---|---|
| 🔐 **Real keys encrypted** | OS keychain (DPAPI/Keychain) + no plaintext storage |
| 🔄 **One gateway, any provider** | DeepSeek, Kimi, OpenAI, Anthropic, GLM, Qwen, Ollama, custom endpoints |
| 🎯 **Instant switching** | `/model` → pick any combo in Claude Code, Codex, opencode |
| 📊 **Usage stats** | Tokens/requests/costs by provider & model, today/7d/30d |
| 🛡️ **Config leak immune** | Screenshot? GitHub push? Prompt injection? Only a useless local key leaks |
| 🔌 **Zero-config setup** | Select tool → click "Connect" → done |
| 🌐 **Local-only** | No cloud, no telemetry, no external calls except to your endpoints |
| 🎨 **Dark/light theme** | Auto-follow system or manual switch |
| 🌍 **Multilingual** | English + Simplified Chinese (system default) |

---

## 🛡️ Security: Designed for Developers Who Care

### The Vault Concept

```
Your Computer
├── Pittacus Relay (Gateway)
│   ├── 🔐 Real Keys (encrypted in OS keychain)
│   └── 🔄 Model Routing Logic
│
├── Claude Code / Codex / opencode
│   └── Local Key Only (useless outside this machine)
│
└── Endpoints
    ├── OpenAI
    ├── DeepSeek
    ├── Kimi
    └── Custom...
```

### 10-Layer Protection

1. **Local only** (`127.0.0.1`) — cross-site requests blocked
2. **OS keychain** (DPAPI/Keychain) — keys encrypted at rest
3. **Request rebuilt** — headers never passed as-is, key swapped at gateway
4. **Local key isolation** — tools never see provider keys
5. **Key bound to URL** — change endpoint = must re-enter key
6. **HTTPS only** (except local Ollama) — no unencrypted endpoints
7. **No redirects** — 3xx responses rejected (blocks MITM)
8. **PIN protection** — copy a key = enter PIN first
9. **File permissions** — config readable only by you (macOS 0600)
10. **No telemetry** — request log has only tokens & counts, never content

### Honest Boundaries

This protects against:
- Config file leaks (GitHub push, screenshot, paste for help)
- Prompt injection reading env vars
- Tools behaving badly

This does **not** protect against:
- Malware running under your OS account (OS-level problem, not solvable by any desktop app)

---

## 🔧 How It Works (Under the Hood)

```
You write in Claude Code:          Pittacus Relay sees:        Provider sees:
{                                  {                           {
  "ANTHROPIC_AUTH_TOKEN":            "LOCAL_KEY": "pitt-…"      "ANTHROPIC_AUTH_TOKEN":
  "pitt-local-xyz"                   "MODEL": "kimi/kimi-k2"    "sk-ant-v0-real-key"
}                                  }                           }
                  ↓                           ↓                         ↓
           Local-only key          Route to provider         Real key, swapped in
           ✓ safe to leak          ✓ rebuild headers         ✓ request forwarded
```

**What Pittacus Relay does:**

1. Listen on `127.0.0.1:17800` for requests from Claude Code, Codex, opencode
2. Verify the local key in the request
3. Look up which provider the model belongs to (e.g., `kimi/kimi-k2` → Kimi endpoint)
4. Fetch the real provider key from encrypted vault
5. Rebuild request headers (strip local key, add provider's real key)
6. Forward request to provider over HTTPS
7. Pass response back to tool
8. Log usage (tokens, model, time) — never conversation content

---

## 🚀 What You Can Do

### Immediately
- ✅ Use Claude Code + DeepSeek, Kimi, any model (all from one local key)
- ✅ Use Codex with providers that don't have Claude Code support
- ✅ Use opencode with any OpenAI-compatible endpoint
- ✅ View token counts & costs across providers
- ✅ Regenerate local key anytime (real keys untouched)

### Roadmap
- 🔜 macOS code signing (removes first-launch block)
- 🔜 Auto-update
- 🔜 OpenAI ↔ Anthropic format conversion (so Claude Code can use any provider)
- 🔜 HarmonyOS PC edition

---

## ❓ FAQ

<details>
<summary><strong>Q: Is this just a proxy? What's the real benefit?</strong></summary>

A: Yes, it's a local proxy. The benefit: your real keys stay encrypted on your machine. Tools only get a local key that:
- Can't be abused from anywhere else (confined to `127.0.0.1`)
- Can be regenerated in 1 click
- Doesn't require updating every tool when you rotate it

If your `settings.json` leaks, the attacker has only the local key, not your real provider keys.
</details>

<details>
<summary><strong>Q: Does it phone home? Track me?</strong></summary>

A: No. The app is 100% local. It only makes HTTPS requests to the endpoints you configure. No telemetry, no updates, no cloud sync. See [Privacy Policy](#-privacy-policy).
</details>

<details>
<summary><strong>Q: What happens if my machine crashes?</strong></summary>

A: 
- Real keys are in OS keychain (Windows DPAPI / macOS Keychain) — won't transfer to a new machine
- Local keys can be regenerated anytime from the Overview tab
- Your tool configs stay as-is, just regenerate the local key once and sync
</details>

<details>
<summary><strong>Q: Can I use this on a server or Docker?</strong></summary>

A: Not yet. Pittacus Relay is built for desktop (Windows 10+, macOS). Server/Linux support is a future idea. For now, it's a local machine tool.
</details>

<details>
<summary><strong>Q: Which providers are supported?</strong></summary>

A: Any provider with:
- **Anthropic API endpoint** (Claude Code native support)
- **OpenAI-compatible endpoint** (Chat Completions, DeepSeek, Kimi, GLM, Qwen, Ollama, etc.)
- **OpenAI Responses API** (Codex native)

Provider list kept in `src/core/providers.ts`. Easy to add more.
</details>

<details>
<summary><strong>Q: Why "Pittacus"?</strong></summary>

A: Named after Pittacus of Mytilene, one of the Seven Sages of ancient Greece — a leader known for wise counsel and pragmatism. The logo is a hydra: the body is the gateway on your machine, and each head represents a different model provider. 🐉
</details>

---

## 📦 Supported Tools

| Tool | Version | Integration | Model Switching |
|---|---|---|---|
| Claude Code | 2.1.242+ | Auto-config `settings.json` | `/model` command |
| Codex | Latest | Auto-config `config.toml` + model catalog | `/model` dropdown |
| opencode | Latest | Auto-config JSON | Model picker |

**How it works:**
- Pittacus Relay auto-writes the tool's config on first "Connect" click
- Original values are saved; "Restore" undoes only Pittacus Relay's changes
- Adding/removing providers, changing port, or regenerating key syncs automatically

---

## 💻 For Developers & Contributors

### Build & Run

```bash
# Install
npm install

# Development
npm run dev        # hot reload
npm run test       # unit tests
npm run typecheck  # TypeScript check

# Build
npm run build      # compile
npm run dist:win   # Windows installer → dist/
npm run dist:mac   # macOS installer (macOS only)
```

### Project Structure

```
src/
├── core/      Gateway, routing, vault (no Electron, easy to port)
├── main/      Electron main, windows, tray, IPC
├── preload/   Secure bridge (contextIsolation + sandbox)
├── renderer/  React UI
└── shared/    Type contracts
```

### Testing

Set env vars to test without touching your real config:
```bash
PITTACUS_RELAY_DATA_DIR=/tmp/test npm run dev
CLAUDE_CONFIG_DIR=/tmp/test npm run dev
```

### CI/CD

Every push → builds on Windows & macOS (GitHub Actions)  
Push `v*` tag → creates Release with installers + checksums

---

## 🔐 Privacy & Security Policies

### Privacy Policy

Pittacus Relay **will not** transfer any information to external networks unless you explicitly configure it. Specifically:

- **No telemetry**: zero usage stats, error reporting, or analytics
- **No updates**: no auto-check or auto-download (manual only)
- **No config syncing**: your keys stay on your machine
- **No cloud**: everything local
- **Network**: only to provider endpoints **you** configure
- **Storage**: encrypted by OS keychain

**Request logs:** token counts & summaries only. **Never** conversation content.

### Code Signing

Free signing by [SignPath.io](https://about.signpath.io/) ([SignPath Foundation](https://signpath.org/)):
- Scope: Windows executable (pending approval)
- Every release manually approved before signing
- Maintainer: [@ctrlcakepro](https://github.com/ctrlcakepro)

---

## 📄 License

[MIT](LICENSE) — free for personal and commercial use

---

## 🙏 Acknowledgments

- **Hydra logo inspiration**: ancient mythology, multi-headed wisdom
- **Security design**: inspired by browser isolation models and OS keychain best practices
- **Community**: built for developers who care about key safety

---

## 🤝 Contributing

Found a bug? Have an idea? [Open an issue](https://github.com/ctrlcakepro/pittacus-relay/issues/new).

For security issues: **DO NOT** open public issues. Please report to the maintainer directly (see Code Signing Policy).

---

## 📊 Stats

- **Latest release**: [![release](https://img.shields.io/github/v/release/ctrlcakepro/pittacus-relay?style=flat-square)](https://github.com/ctrlcakepro/pittacus-relay/releases/latest)
- **License**: [MIT](LICENSE)
- **Platform**: Windows 10+, macOS 10.12+
- **Built with**: TypeScript, Electron, React, Node.js

---

<div align="center">

**Made by [@ctrlcakepro](https://github.com/ctrlcakepro)**

If Pittacus Relay saves you time or peace of mind, consider giving it a ⭐

[⬇️ Download Latest](https://github.com/ctrlcakepro/pittacus-relay/releases/latest) · [📖 Docs](#-how-it-works) · [🐛 Report Issue](https://github.com/ctrlcakepro/pittacus-relay/issues)

</div>
