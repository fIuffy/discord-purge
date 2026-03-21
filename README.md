# 🗑️ Discord Purge

A browser userscript that **automatically deletes all messages your account has ever sent** across every DM, Group DM, and server channel on Discord — in one run.

> Built on top of the excellent [Deletecord](https://github.com/bekkibau/deletecord) by bekkibau, extended to discover and iterate all channels automatically.

---

## ✨ Features

- 🔍 **Auto-discovers** all your DMs, Group DMs, and server text channels
- 🗑️ Deletes every message your account has sent across all of them
- ⏱️ **Adaptive rate limiting** — automatically slows down when Discord throttles, speeds up over time
- 📊 **Live progress UI** built into the Discord interface
- ⏹️ **Stop/resume** at any time
- 🔒 No data leaves your browser — your token is never stored or transmitted anywhere except Discord's own API

---

## 🚀 Usage

### Option A — Paste into Console (quickest)

1. Open [discord.com](https://discord.com) in your browser
2. Press **F12** to open DevTools → go to the **Console** tab
3. Copy the contents of [`discord_purge_all.user.js`](./discord_purge_all.user.js) and paste it into the console, then press **Enter**
4. A **trash icon** (🗑️) will appear in the Discord toolbar — click it
5. Click **Get** next to *Auth Token* and *Author ID* to auto-fill
6. Click **▶ Start Full Purge** and confirm the prompt

### Option B — Userscript Manager (persistent)

Install a userscript manager like [Tampermonkey](https://www.tampermonkey.net/) or [Violentmonkey](https://violentmonkey.github.io/), then install the script directly — it will run automatically every time you open Discord.

---

## ⚙️ How It Works

1. Uses Discord's search API to find all messages authored by you in a given channel
2. Sends `DELETE` requests for each message
3. Handles `429 Too Many Requests` rate limit responses gracefully with exponential back-off
4. Moves on to the next channel when a channel is clean

**This only deletes your own messages.** Discord's API does not allow deleting other users' messages (unless you are a server admin using a bot, which is out of scope here).

---

## ⏳ How Long Will It Take?

It depends on how many messages you've sent. Discord's API rate limits mean deletions take roughly **1–2 seconds each**. Some rough estimates:

| Messages | Estimated Time |
|----------|---------------|
| 1,000    | ~30 minutes   |
| 10,000   | ~4–5 hours    |
| 50,000+  | Overnight run |

You can stop and restart at any time — already-deleted messages won't reappear.

---

## ⚠️ Disclaimer

- **This is irreversible.** Deleted Discord messages cannot be recovered.
- This tool uses Discord's official API endpoints with your own credentials — no unofficial hacks or exploits.
- Use responsibly. This tool is intended for personal privacy management.
- The authors are not responsible for any account actions taken by Discord. Self-botting (automating a user account) is against Discord's ToS — use at your own discretion.

---

## 🙏 Credits

- [bekkibau/deletecord](https://github.com/bekkibau/deletecord) — original single-channel delete logic this project builds on

---

## 📄 License

[MIT](./LICENSE)
