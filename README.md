# Ghostcord

Take back your message history.

Discord keeps every message you've ever sent, visible indefinitely to anyone in those channels. Ghostcord gives you two ways to deal with that: wipe everything at once, or make messages disappear automatically after a time limit you set.

One script, one panel, shared engine.

> Core delete logic originally based on [Deletecord](https://github.com/bekkibau/deletecord) by bekkibau.

---

## Modes

**Purge** — Bulk delete every message your account has ever sent across every server, DM, and group chat. Discovers channels via live API and optional data package import.

**AutoDelete** — Background daemon that scans enabled channels on a timer and deletes any of your messages older than a configurable TTL. Per-channel overrides supported. Runs every 60 seconds by default and fires immediately when you tab back in.

Both modes share authentication, exclusions, the deletion engine, and a persistent history log.

---

## Setup

### Option A — Console (one-time, no install)

1. Open [discord.com](https://discord.com) in a browser
2. Press `F12`, go to Console
3. Paste the contents of `ghostcord.user.js` and hit Enter
4. A ghost icon appears in the Discord toolbar — click it
5. Go to the **Auth** tab and click **Auto-detect**

### Option B — Tampermonkey / Violentmonkey (persistent)

Install [Tampermonkey](https://www.tampermonkey.net/) or [Violentmonkey](https://violentmonkey.github.io/), create a new userscript, paste the contents, save. The script loads automatically on every Discord session. Credentials, channel settings, exclusions, and history persist between sessions.

---

## Auth

Ghostcord captures your token passively by listening to requests Discord is already making in the background. No extra network traffic — it reads the `Authorization` header off the next outgoing API call (presence updates, typing events, etc). One click fills both your token and author ID.

Credentials are saved to local storage so the AutoDelete daemon works across page reloads without re-detecting.

---

## Purge

### How it works

The script searches Discord's API for messages authored by your account and deletes them one by one. It covers three sources automatically:

1. **Open DMs and group DMs** currently in your sidebar
2. **Friends list** — re-opens a DM channel with every friend, catching conversations you've dismissed from the sidebar
3. **All text channels and active threads** in every server you're in

For complete coverage, import your **Discord data package** which indexes every channel you've ever sent a message in, including servers you've left, closed DMs, and deleted-user conversations.

### Importing your data package

1. Discord → User Settings → Privacy & Safety → Request Data Export
2. Wait for the email (usually hours, can take up to 30 days)
3. Download the zip
4. In the **Import** tab, drop in `messages/index.json` or the entire zip — the script extracts what it needs
5. Imported channels are merged with live discovery, duplicates removed

### Time estimates

Discord rate limits deletions to roughly 1–2 seconds each. This is server-side and cannot be bypassed.

| Messages | Estimate |
|----------|----------|
| 1,000 | ~30 minutes |
| 10,000 | ~4–5 hours |
| 50,000+ | Overnight |

The script handles rate limits automatically — backs off when Discord asks, resumes without intervention.

---

## AutoDelete

### How it works

On a configurable interval (default 60 seconds), the daemon scans each enabled channel for your messages and deletes any older than the TTL. Also fires immediately when you switch back to the Discord tab.

### Setup

1. Go to the **AutoDelete** tab
2. Set a Global TTL in seconds (e.g. `3600` = 1 hour)
3. Optionally adjust the scan interval
4. Click **Save settings**
5. Navigate to any channel and click **Enable** to turn on AutoDelete for that channel

### Per-channel overrides

Each channel can have its own TTL. Set it in the **Channels** tab or when enabling a channel. If no override is set, the global TTL applies.

### TTL reference

| Seconds | Duration |
|---------|----------|
| `3600` | 1 hour |
| `86400` | 1 day |
| `604800` | 1 week |

---

## Exclusions

Excluded channels are skipped by both Purge and AutoDelete. Add them from the **Exclusions** tab by navigating to a channel and clicking **Exclude Current Channel**, or by pasting a channel ID manually.

---

## History

Every deletion from both modes is logged with a content preview, channel name, timestamp, and mode tag (🗑️ purge / ⏱️ autodelete). History persists across sessions, capped at 500 entries. Viewable in the **History** tab.

---

## Message types deleted

Ghostcord deletes these message types when authored by your account:

- Default messages (type 0)
- Pin notifications (type 6)
- Replies (type 19)
- Slash command responses (type 20)
- Thread starter messages (type 21)

System messages and messages by other users are never touched.

---

## FAQ

**Does this actually delete messages?**
Yes. It sends DELETE requests to Discord's API. Messages are removed from their servers and won't appear in future data exports.

**What about messages in servers I've left?**
The live API can't reach those. Import your data package — it indexes every channel you've ever messaged in regardless of membership.

**Will Discord flag my account?**
Automating a user account violates Discord's Terms of Service. The script is deliberately slow to avoid unusual traffic patterns, but there's no guarantee. Use your own judgment.

**Can it delete other people's messages?**
No. The API only allows users to delete their own messages.

**Is my token safe?**
Your token is never sent anywhere except Discord's own API. When using Tampermonkey it's stored in browser-local extension storage. When pasting into the console it exists only in memory for that session.

---

## Disclaimer

Deletions are permanent. This script uses Discord's API with your own credentials. Automating a user account is against Discord's Terms of Service. Use at your own risk.

---

## Credits

[bekkibau/deletecord](https://github.com/bekkibau/deletecord) — original single-channel delete logic

---

## License

[MIT](./LICENSE)
