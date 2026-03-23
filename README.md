# discord-purge

### Two userscripts for cleaning up your Discord message history.

Discord lets you delete your account but doesn't delete the messages tied to it; they stay visible to everyone in whatever servers or DMs they were sent in. This project exists to fix that. These scripts let you actually wipe your message history before you go, or just on an ongoing basis if you'd rather not leave a permanent record behind.

> Core delete logic based on [Deletecord](https://github.com/bekkibau/deletecord) by bekkibau.

---

## Scripts

| Script | Purpose |
|--------|---------|
| [`discord_purge_all.user.js`](./discord_purge_all.user.js) | Bulk delete all your messages across every channel, DM, and server |
| [`discord_autodelete.user.js`](./discord_autodelete.user.js) | Signal-style auto-expiring messages - deletes what you send after a configurable Time to Live (TTL) |

---

## Script 1 - Full Account Purge

Finds and deletes every message your account has sent across all DMs and servers. Supports importing your Discord data package for complete coverage, including closed DMs, servers you've left, and messages sent to deleted accounts.

### Features

- Auto-discovers DMs and server channels via the live API
- Data package import to catch channels the API misses
- Channel exclusion list, skip anything you want to keep
- Adaptive rate limiting
- Live progress bar and running deleted-message counter
- Stop at any time

### Usage

**Option A - Console (no install)**

1. Open [discord.com](https://discord.com) in your browser
2. Open DevTools (`F12`) and go to the Console tab
3. Paste the script and press Enter
4. Click the trash icon that appears in the Discord toolbar
5. Hit **Get** next to Auth Token and Author ID to fill them in automatically
6. Optionally import your data package or set up exclusions
7. Click **Start Full Purge**

**Option B - Tampermonkey / Violentmonkey (persistent)**

Install [Tampermonkey](https://www.tampermonkey.net/) or [Violentmonkey](https://violentmonkey.github.io/), create a new script, and paste the contents. Settings and exclusions persist between sessions.

### Importing your data package

The live API only returns channels currently visible to you. Your Discord data package has a full record of every channel you've ever sent a message in.

**Getting it:**
1. Discord → User Settings → Privacy & Safety → Request Data Export
2. Wait for the email (a few hours to a few days)
3. Download the zip

**Importing it:**
1. Open the purge panel and go to the **Data Package** tab
2. Drop in either `messages/index.json` from the unzipped folder, or the whole zip, the script finds the right file automatically
3. Imported channels are merged with live-discovered ones, duplicates removed

### Excluding channels

Go to the **Exclusions** tab to skip channels you don't want touched.

- **Exclude Current Channel** - navigate to a channel and click this; the name is filled in from the page title
- Or paste a channel ID manually with an optional label
- Remove exclusions individually or clear all at once

### How long does it take?

Discord's API rate limits mean roughly 1–2 seconds per deletion.

| Messages | Rough estimate |
|----------|---------------|
| 1,000    | ~30 min       |
| 10,000   | ~4–5 hours    |
| 50,000+  | Overnight     |

---

## Script 2 - AutoDelete (expiring messages)

Intercepts messages you send and schedules them for deletion after a configurable TTL. Works per-channel with a global fallback default.

**Requires Tampermonkey or Violentmonkey** - needs persistent storage to survive page refreshes.

### Features

- Per-channel TTL with a global default
- Hooks Discord's `fetch()` to log outgoing messages automatically
- Background check every 30 seconds for expired messages
- Token and settings stored locally in Tampermonkey only
- Pending deletion queue is visible and clearable

### Usage

1. Install Tampermonkey or Violentmonkey
2. Create a new script and paste [`discord_autodelete.user.js`](./discord_autodelete.user.js)
3. Open Discord - a clock icon appears in the toolbar
4. Hit **Get** next to Auth Token and Author ID, then **Save**
5. Set a Global TTL (in seconds)
6. Navigate to a channel and click **Enable AutoDelete**

### TTL reference

| Seconds  | Duration |
|----------|----------|
| `60`     | 1 minute |
| `3600`   | 1 hour   |
| `86400`  | 1 day    |
| `604800` | 1 week   |

### How it works

```
You send a message
       |
fetch() hook sees the successful response
       |
Message ID + (now + TTL) saved to Tampermonkey storage
       |
30s ticker fires, finds expired entries
       |
DELETE /channels/:id/messages/:id
```

---

## Disclaimer

Deletions are permanent. These scripts use Discord's official API with your own credentials, no exploits involved. That said, automating a user account is against Discord's Terms of Service. Use at your own risk.

---

## Credits

[bekkibau/deletecord](https://github.com/bekkibau/deletecord) - original single-channel delete logic

---

## License

[MIT](./LICENSE)
