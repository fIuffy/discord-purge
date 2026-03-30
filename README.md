# discord-purge

### Take back your message history.

Discord lets you delete your account but keeps every message you ever sent. They stay visible in servers and DMs indefinitely, attached to your account ID, readable by anyone in those channels. This project gives you actual control over that.

Two scripts: one that wipes everything in bulk, one that makes messages disappear automatically after a time limit you set.

> Core delete logic based on [Deletecord](https://github.com/bekkibau/deletecord) by bekkibau.

---

## What's in here

| Script | What it does |
|--------|-------------|
| [`discord_purge_all.user.js`](./discord_purge_all.user.js) | Bulk delete every message your account has ever sent, across every server, DM, and group chat |
| [`discord_autodelete.user.js`](./discord_autodelete.user.js) | Automatically delete messages you send after a configured time limit, per-channel |

No external servers. No data collection. Everything runs in your browser using your own credentials against Discord's own API.

---

## Script 1 - Full Account Purge

### How it works

The script searches Discord's API for messages authored by your account and deletes them. It covers three sources automatically:

1. **Open DMs and group DMs** in your sidebar
2. **Friends list** - re-opens a DM channel with every friend, catching conversations you dismissed from your sidebar. Handles rate limits and retries automatically, including dormant DMs that Discord throttles harder.
3. **All text channels** in every server you are currently in

On top of that, you can import your **Discord data package**, which contains a complete index of every channel you have ever sent a message in - including servers you have left, closed DMs, and conversations with accounts that have since been deleted. This is the most thorough path to a full wipe.

### Setup

**Option A - Paste into console (no install, works once)**

1. Open [discord.com](https://discord.com) in a browser
2. Open DevTools with `F12`, go to the Console tab
3. Paste the full contents of `discord_purge_all.user.js` and hit Enter
4. A trash icon appears in the Discord toolbar - click it
5. Click **Get** next to Auth Token and Author ID to auto-fill both
6. Optionally set up exclusions or import your data package (see below)
7. Click **Start Full Purge**

**Option B - Tampermonkey / Violentmonkey (persists across sessions)**

Install [Tampermonkey](https://www.tampermonkey.net/) or [Violentmonkey](https://violentmonkey.github.io/), create a new userscript, paste the contents, and save. The script will run automatically whenever you open Discord. Your exclusions and imported channels are saved between sessions.

### Importing your Discord data package

This is the recommended step if you want complete coverage. The live API can only see channels currently accessible to your account. Your data package has the full picture.

**Requesting it:**
1. Discord -> User Settings -> Privacy & Safety -> Request Data Export
2. Select Messages and hit Request My Data
3. Wait for the email - Discord says up to 30 days but it usually arrives within a few hours
4. Download and unzip

**Importing it:**
1. Open the purge panel and go to the **Data Package** tab
2. Drop in either `messages/index.json` from the unzipped folder, or the entire zip - the script extracts what it needs automatically
3. Channels from the package are merged with live-discovered ones, duplicates removed
4. Start the purge as normal

### Excluding channels

If there are channels you want left untouched, go to the **Exclusions** tab before starting.

- Navigate to any channel and click **Exclude Current Channel** to add it by name automatically
- Or paste a channel ID manually with an optional label
- Remove exclusions individually or clear all at once

The confirmation dialog before the purge starts shows a full breakdown of what will be processed and what is being skipped.

### Time estimates

Discord rate limits deletions to roughly 1-2 seconds each. This is enforced server-side and cannot be bypassed without risking your account.

| Message count | Rough estimate |
|---------------|----------------|
| 1,000         | ~30 minutes    |
| 10,000        | ~4-5 hours     |
| 50,000+       | Overnight      |

The script handles rate limit responses automatically - it backs off when Discord asks it to and resumes without you needing to do anything.

---

## Script 2 - AutoDelete (expiring messages)

Periodically searches each enabled channel for messages you have sent and deletes any that are older than the configured TTL. Each scan fully drains expired messages per channel - it loops through paginated search results and deletes everything that has aged out, not just one page worth. Runs every 60 seconds in the background by default, and also fires immediately when you switch back to the tab.

**Requires Tampermonkey or Violentmonkey** for persistent storage.

### Setup

1. Install [Tampermonkey](https://www.tampermonkey.net/) or [Violentmonkey](https://violentmonkey.github.io/)
2. Create a new userscript and paste `discord_autodelete.user.js`
3. Open Discord - a clock icon appears in the toolbar
4. Click **Get** next to Auth Token and Author ID, then **Save settings**
5. Set a Global TTL in seconds
6. Navigate to any channel and click **Enable**, or manage all channels from the **Channels** tab

### The panel

- **Settings** - credentials, global TTL, scan interval, quick toggle for the current channel, and a manual scan button
- **Channels** - list of every enabled channel with inline TTL editing and a disable button, no navigating required
- **History** - log of every message deleted, with content preview, channel name, and timestamp. Persists across sessions up to 500 entries.
- **Log** - live event log for scans, deletions, and errors

### TTL reference

| Seconds  | Duration |
|----------|----------|
| `3600`   | 1 hour   |
| `86400`  | 1 day    |
| `604800` | 1 week   |

### How it works

```
Every N seconds (your configured scan interval, default 60):
       |
For each enabled channel:
       |
  Search for messages by your account (paginated, 25 per page)
       |
  For each result, compare the message timestamp against the TTL cutoff
       |
  If (now - message_timestamp) > TTL, delete the message
       |
  Re-search and repeat until no expired messages remain in that channel
       |
  Adaptive rate limiting: starts at ~1.2s per delete, speeds up gradually
  on sustained success, backs off automatically on failures or 429s
```

Your token is only ever stored in Tampermonkey's local storage on your own machine. It is never sent anywhere except Discord's own API.

---

## Frequently asked questions

**Does this actually delete messages or just hide them?**
It sends DELETE requests to Discord's API. The messages are removed from Discord's servers. Per their own documentation, manually deleted messages are not retained and will not appear in data packages.

**What about messages in servers I have already left?**
The live API cannot reach those. Import your data package - it indexes every channel you ever sent a message in, regardless of whether you are still a member.

**Will Discord flag my account for this?**
Automating a user account is against Discord's Terms of Service. The script is deliberately slow (1-2s per delete) to avoid unusual traffic patterns, but there is no guarantee. Use your own judgement.

**Can it delete messages sent by other people?**
No. Discord's API only permits users to delete their own messages. The script only targets messages authored by the account whose token you provide.

**Is my token safe?**
Your token is never transmitted anywhere except directly to Discord's API. When using the Tampermonkey version it is stored in browser-local Tampermonkey storage. When pasting into the console it exists only in memory for that session. Do not share your token with anyone - it gives full access to your account.

---

## Disclaimer

Deletions are permanent and cannot be undone. These scripts use Discord's official API with your own credentials. Automating a user account is against Discord's Terms of Service. Use at your own risk.

---

## Credits

[bekkibau/deletecord](https://github.com/bekkibau/deletecord) - original single-channel delete logic

---

## License

[MIT](./LICENSE)
