# 🗑️ Discord Purge

A pair of browser userscripts for taking back control of your Discord message history.

> Built on top of the excellent [Deletecord](https://github.com/bekkibau/deletecord) by bekkibau.

---

## 📦 Scripts

| Script | Purpose |
|--------|---------|
| [`discord_purge_all.user.js`](./discord_purge_all.user.js) | One-time **bulk delete** of all your messages across every channel, DM, and server |
| [`discord_autodelete.user.js`](./discord_autodelete.user.js) | **Signal-style auto-expiry** — logs every message you send and deletes it after a configurable TTL |

---

## 🧹 Script 1 — Full Account Purge

Discovers and iterates every DM, Group DM, and server text channel, deleting every message your account has ever sent.

### Features
- 🔍 Auto-discovers all your DMs and server channels
- 🗑️ Deletes every message your account has sent
- ⏱️ Adaptive rate limiting — slows down when throttled, speeds up over time
- 📊 Live progress UI embedded in Discord
- ⏹️ Stop/resume at any time

### Usage

**Option A — Paste into Console (no install needed)**

1. Open [discord.com](https://discord.com) in your browser
2. Press **F12** → **Console** tab
3. Paste the contents of [`discord_purge_all.user.js`](./discord_purge_all.user.js) and press **Enter**
4. A **🗑️ trash icon** appears in the Discord toolbar — click it
5. Click **Get** next to *Auth Token* and *Author ID*
6. Click **▶ Start Full Purge** and confirm

**Option B — Userscript Manager (persistent)**

Install [Tampermonkey](https://www.tampermonkey.net/) or [Violentmonkey](https://violentmonkey.github.io/), create a new script, and paste the file contents.

### How long will it take?

| Messages | Estimated Time |
|----------|---------------|
| 1,000    | ~30 min       |
| 10,000   | ~4–5 hours    |
| 50,000+  | Overnight     |

---

## ⏱️ Script 2 — AutoDelete (Signal-style Expiring Messages)

Intercepts every message you send and schedules it for automatic deletion after a configurable TTL. Inspired by Signal's disappearing messages feature.

### Features
- 🕐 **Per-channel TTL** — different expiry times per channel, or a global default
- 📝 **Message log** — every sent message logged with its scheduled delete time
- 🔄 **Persistent** — survives page refreshes via Tampermonkey storage
- ⏰ **Background ticker** — checks for expired messages every 30 seconds
- 🔒 Token stored locally in Tampermonkey only — never leaves your browser
- ✋ **Queue management** — view and clear the pending deletion queue anytime

### Usage

> Requires [Tampermonkey](https://www.tampermonkey.net/) or [Violentmonkey](https://violentmonkey.github.io/).

1. Install Tampermonkey/Violentmonkey
2. Create a new script and paste [`discord_autodelete.user.js`](./discord_autodelete.user.js)
3. Open Discord — a **🕐 clock icon** appears in the toolbar
4. Click **Get** next to *Auth Token* and *Author ID*, then **💾 Save**
5. Set your **Global TTL** (e.g. `3600` = 1 hour, `86400` = 1 day)
6. Navigate to a channel and click **Enable AutoDelete**
7. Done — messages you send in that channel will auto-delete after the TTL

### TTL reference

| Value    | Duration |
|----------|---------|
| `60`     | 1 minute |
| `3600`   | 1 hour   |
| `86400`  | 1 day    |
| `604800` | 1 week   |

### How it works

The script wraps Discord's native `fetch()` to intercept outgoing message requests. When a send succeeds in an enabled channel, it saves the message ID and a `deleteAt` timestamp. A background timer fires every 30 seconds, finds expired entries, and sends DELETE requests with automatic rate-limit handling.

```
You send a message
       │
       ▼
fetch() hook intercepts the response
       │
       ▼
Message ID + (now + TTL) saved to Tampermonkey storage
       │
       ▼
⏰ 30s ticker fires → finds expired entries
       │
       ▼
DELETE /channels/:id/messages/:id
```

---

## ⚠️ Disclaimer

- **Deletions are irreversible.**
- These scripts use Discord's official API with your own credentials — no exploits.
- Automating a user account (self-botting) is against Discord's Terms of Service. Use at your own discretion.
- The authors are not responsible for any account actions taken by Discord.

---

## 🙏 Credits

- [bekkibau/deletecord](https://github.com/bekkibau/deletecord) — original single-channel delete logic

---

## 📄 License

[MIT](./LICENSE)
