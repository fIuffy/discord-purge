// ==UserScript==
// @name          Discord Full Account Purge
// @description   Automatically deletes all your messages across all DMs, Group DMs, and Servers
// @namespace     local
// @version       1.0
// @match         https://discord.com/*
// @grant         none
// @license       MIT
// ==/UserScript==

/**
 * HOW TO USE:
 * 1. Open Discord in your browser (discord.com)
 * 2. Open DevTools (F12) → Console tab
 * 3. Paste this entire script and press Enter
 * 4. Click the trash icon that appears in the Discord toolbar
 * 5. Click "Get Token" and "Get Author" to auto-fill your credentials
 * 6. Click "Start Full Purge"
 *
 * NOTES:
 * - This will ask for confirmation before deleting
 * - You can stop at any time with the Stop button
 * - Rate limits are handled automatically with delays
 * - Messages in servers where you lack permission will be skipped
 * - Discord only lets you delete your OWN messages; this script respects that
 */

(function () {
    'use strict';

    // ── Core delete function (works on a single channel) ──────────────────────
    async function deleteMessagesInChannel(authToken, authorId, guildId, channelId, options = {}) {
        const {
            searchDelay = 1500,
            deleteDelay = 1400,
            delayIncrement = 150,
            delayDecrement = -50,
            delayDecrementPerMsgs = 1000,
            retryAfterMultiplier = 3000,
            stopHndl = null,
            onProgress = null,
            logFn = console.log,
        } = options;

        let deleteDelayCurrent = deleteDelay;
        let delCount = 0;
        let failCount = 0;
        let avgPing = 0;
        let lastPing = 0;
        let grandTotal = null;
        let throttledCount = 0;
        let throttledTotalTime = 0;
        let offset = 0;

        const wait = ms => new Promise(r => setTimeout(r, ms));
        const msToHMS = s => `${s / 3.6e6 | 0}h ${(s % 3.6e6) / 6e4 | 0}m ${(s % 6e4) / 1000 | 0}s`;
        const toSnowflake = date => /:/.test(date) ? ((new Date(date).getTime() - 1420070400000) * Math.pow(2, 22)) : date;

        const headers = { Authorization: authToken };

        async function recurse() {
            const BASE = guildId === '@me'
                ? `https://discord.com/api/v6/channels/${channelId}/messages/search`
                : `https://discord.com/api/v6/guilds/${guildId}/messages/search`;

            const params = new URLSearchParams();
            params.set('author_id', authorId);
            if (guildId !== '@me') params.set('channel_id', channelId);
            params.set('sort_by', 'timestamp');
            params.set('sort_order', 'desc');
            params.set('offset', offset);

            let resp;
            try {
                const s = Date.now();
                resp = await fetch(`${BASE}?${params}`, { headers });
                lastPing = Date.now() - s;
                avgPing = avgPing > 0 ? avgPing * 0.9 + lastPing * 0.1 : lastPing;
            } catch (err) {
                logFn('error', `Search error: ${err.message}`);
                return;
            }

            if (resp.status === 202) {
                const { retry_after: w } = await resp.json();
                throttledCount++; throttledTotalTime += w;
                logFn('warn', `Channel not indexed yet, waiting ${w}ms…`);
                await wait(w);
                return recurse();
            }

            if (!resp.ok) {
                if (resp.status === 429) {
                    const { retry_after: w } = await resp.json();
                    throttledCount++; throttledTotalTime += w;
                    logFn('warn', `Rate limited! Cooling down ${w * retryAfterMultiplier}ms…`);
                    await wait(w * retryAfterMultiplier);
                    return recurse();
                }
                if (resp.status === 403) {
                    logFn('warn', `No search permission for channel ${channelId} in guild ${guildId}, skipping.`);
                    return;
                }
                logFn('error', `Search failed: HTTP ${resp.status}`);
                return;
            }

            const data = await resp.json();
            if (!grandTotal) grandTotal = data.total_results;

            const hits = data.messages.map(c => c.find(m => m.hit));
            const toDelete = hits.filter(m => m.type === 0 || m.type === 6);
            const skipped = hits.filter(m => !toDelete.find(d => d.id === m.id));

            if (toDelete.length === 0) {
                if (data.total_results - offset > 0) {
                    offset += 25;
                    await wait(searchDelay);
                    return recurse();
                }
                logFn('success', `Channel done. Deleted: ${delCount}, Failed: ${failCount}`);
                return;
            }

            for (let j = 0; j < toDelete.length; j++) {
                const msg = toDelete[j];
                if (stopHndl && !stopHndl()) { logFn('warn', 'Stopped by user.'); return; }

                logFn('info', `Deleting message ${msg.id} from ${msg.author.username} (${new Date(msg.timestamp).toLocaleString()})`);

                if (delCount > 0 && delCount % delayDecrementPerMsgs === 0) {
                    deleteDelayCurrent = Math.max(500, deleteDelayCurrent + delayDecrement);
                }

                try {
                    const s = Date.now();
                    const dr = await fetch(
                        `https://discord.com/api/v6/channels/${msg.channel_id}/messages/${msg.id}`,
                        { headers, method: 'DELETE' }
                    );
                    lastPing = Date.now() - s;
                    avgPing = avgPing * 0.9 + lastPing * 0.1;

                    if (!dr.ok) {
                        if (dr.status === 429) {
                            const { retry_after: w } = await dr.json();
                            throttledCount++; throttledTotalTime += w;
                            deleteDelayCurrent = Math.min(10000, deleteDelayCurrent + delayIncrement);
                            logFn('warn', `Rate limited on delete! Cooling ${w * retryAfterMultiplier}ms, new delay: ${deleteDelayCurrent}ms`);
                            await wait(w * retryAfterMultiplier);
                            j--; continue;
                        } else if (dr.status === 403 || dr.status === 400) {
                            logFn('warn', `Cannot delete ${msg.id} (${dr.status}), skipping.`);
                            offset++; failCount++;
                        } else {
                            logFn('error', `Delete error HTTP ${dr.status} for message ${msg.id}`);
                            failCount++;
                        }
                    } else {
                        delCount++;
                        if (onProgress) onProgress(delCount, grandTotal);
                    }
                } catch (err) {
                    logFn('error', `Delete threw: ${err.message}`);
                    failCount++;
                }

                await wait(deleteDelayCurrent);
            }

            if (skipped.length > 0) {
                grandTotal = Math.max(0, grandTotal - skipped.length);
                offset += skipped.length;
            }

            logFn('verb', `Next search in ${searchDelay}ms (offset: ${offset})…`);
            await wait(searchDelay);
            return recurse();
        }

        return recurse();
    }

    // ── Fetch all channels the user has access to ─────────────────────────────
    async function getAllChannels(authToken) {
        const headers = { Authorization: authToken };
        const channels = [];

        // 1. DMs and Group DMs
        try {
            const r = await fetch('https://discord.com/api/v9/users/@me/channels', { headers });
            if (r.ok) {
                const dms = await r.json();
                for (const dm of dms) {
                    channels.push({ guildId: '@me', channelId: dm.id, label: dm.name || (dm.recipients?.[0]?.username ?? 'DM') });
                }
            }
        } catch (e) { console.warn('Could not fetch DMs:', e); }

        // 2. Guilds → all channels in each
        try {
            const r = await fetch('https://discord.com/api/v9/users/@me/guilds', { headers });
            if (r.ok) {
                const guilds = await r.json();
                for (const guild of guilds) {
                    try {
                        const cr = await fetch(`https://discord.com/api/v9/guilds/${guild.id}/channels`, { headers });
                        if (cr.ok) {
                            const gchannels = await cr.json();
                            // Text channels (type 0) and announcement channels (type 5) and threads (type 10,11,12)
                            const textChannels = gchannels.filter(c => [0, 5, 10, 11, 12].includes(c.type));
                            for (const ch of textChannels) {
                                channels.push({ guildId: guild.id, channelId: ch.id, label: `${guild.name} → #${ch.name}` });
                            }
                        }
                    } catch (e) { console.warn(`Could not fetch channels for guild ${guild.name}:`, e); }
                    await new Promise(r => setTimeout(r, 300)); // small pause between guilds
                }
            }
        } catch (e) { console.warn('Could not fetch guilds:', e); }

        return channels;
    }

    // ── UI ────────────────────────────────────────────────────────────────────
    const css = `
        #dcpurge-btn{position:relative;height:24px;width:auto;flex:0 0 auto;margin:0 8px;cursor:pointer;color:var(--interactive-normal);}
        #dcpurge{position:fixed;top:60px;right:10px;bottom:10px;width:820px;z-index:9999;color:var(--text-normal);background:var(--background-secondary);box-shadow:var(--elevation-high);border-radius:6px;display:flex;flex-direction:column;font-family:sans-serif;}
        #dcpurge .hdr{padding:12px 16px;background:var(--background-tertiary);border-radius:6px 6px 0 0;font-weight:bold;display:flex;justify-content:space-between;align-items:center;}
        #dcpurge .form{padding:10px;background:var(--background-secondary);border-bottom:1px solid rgba(255,255,255,.1);}
        #dcpurge input[type=password],#dcpurge input[type=text]{background:#202225;color:#b9bbbe;border:0;border-radius:4px;padding:0 .5em;height:28px;width:220px;margin:3px;}
        #dcpurge button{color:#fff;background:#5865f2;border:0;border-radius:4px;padding:4px 12px;margin:3px;cursor:pointer;font-size:13px;}
        #dcpurge button.danger{background:#ed4245;}
        #dcpurge button.success{background:#3ba55d;}
        #dcpurge button:disabled{opacity:.4;cursor:not-allowed;}
        #dcpurge .log{overflow:auto;font-size:.72rem;font-family:Consolas,monospace;flex-grow:1;padding:10px;white-space:pre-wrap;}
        #dcpurge .status-bar{padding:6px 12px;background:var(--background-tertiary);border-radius:0 0 6px 6px;font-size:12px;display:flex;gap:16px;align-items:center;}
        #dcpurge progress{width:200px;}
        .dcpurge-info{color:#00b0f4}.dcpurge-warn{color:#faa61a}.dcpurge-error{color:#ed4245}.dcpurge-success{color:#3ba55d}.dcpurge-verb{color:#72767d}
    `;
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);

    const panel = document.createElement('div');
    panel.id = 'dcpurge';
    panel.style.display = 'none';
    panel.innerHTML = `
        <div class="hdr">
            🗑️ Discord Full Account Purge
            <button id="dcpurge-close" style="background:transparent;font-size:18px;padding:0 6px;">✕</button>
        </div>
        <div class="form">
            <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end;">
                <div>
                    <div style="font-size:12px;color:#72767d;margin-bottom:2px;">Auth Token *</div>
                    <input type="password" id="dcp-token" placeholder="Paste or use Get button">
                    <button id="dcp-get-token">Get</button>
                </div>
                <div>
                    <div style="font-size:12px;color:#72767d;margin-bottom:2px;">Author ID *</div>
                    <input type="text" id="dcp-author" placeholder="Your user ID">
                    <button id="dcp-get-author">Get</button>
                </div>
            </div>
            <div style="margin-top:10px;font-size:12px;color:#faa61a;">
                ⚠️ This will delete ALL messages sent by your account across all DMs and servers. This is irreversible.
            </div>
            <div style="margin-top:8px;display:flex;gap:8px;align-items:center;">
                <button class="success" id="dcp-start">▶ Start Full Purge</button>
                <button class="danger" id="dcp-stop" disabled>⏹ Stop</button>
                <button id="dcp-clear">Clear Log</button>
                <label style="font-size:12px;"><input type="checkbox" id="dcp-autoscroll" checked> Auto-scroll</label>
            </div>
        </div>
        <div class="log" id="dcp-log">Ready. Fill in your token and author ID, then press Start Full Purge.\n</div>
        <div class="status-bar">
            <span id="dcp-channel-status">Idle</span>
            <progress id="dcp-progress" value="0" max="1" style="display:none;"></progress>
            <span id="dcp-percent"></span>
        </div>
    `;
    document.body.appendChild(panel);

    const btn = document.createElement('div');
    btn.id = 'dcpurge-btn';
    btn.title = 'Full Account Purge';
    btn.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24"><path fill="currentColor" d="M15 3.999V2H9V3.999H3V5.999H21V3.999H15Z"/><path fill="currentColor" d="M5 6.99902V18.999C5 20.101 5.897 20.999 7 20.999H17C18.103 20.999 19 20.101 19 18.999V6.99902H5ZM11 17H9V11H11V17ZM15 17H13V11H15V17Z"/></svg>`;
    btn.onclick = () => { panel.style.display = panel.style.display === 'none' ? '' : 'none'; };

    function mountBtn() {
        const toolbar = document.querySelector('[class^=toolbar]');
        if (toolbar && !toolbar.contains(btn)) toolbar.appendChild(btn);
    }
    new MutationObserver(() => { if (!document.body.contains(btn)) mountBtn(); })
        .observe(document.body, { childList: true, subtree: true });
    mountBtn();

    // UI helpers
    const logEl = panel.querySelector('#dcp-log');
    const autoScroll = panel.querySelector('#dcp-autoscroll');
    const progress = panel.querySelector('#dcp-progress');
    const percent = panel.querySelector('#dcp-percent');
    const channelStatus = panel.querySelector('#dcp-channel-status');

    function addLog(type, msg) {
        const line = document.createElement('div');
        line.className = type ? `dcpurge-${type}` : '';
        line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
        logEl.appendChild(line);
        // Cap log at 2000 entries
        while (logEl.children.length > 2000) logEl.removeChild(logEl.firstChild);
        if (autoScroll.checked) line.scrollIntoView(false);
    }

    panel.querySelector('#dcpurge-close').onclick = () => { panel.style.display = 'none'; };
    panel.querySelector('#dcp-clear').onclick = () => { logEl.innerHTML = ''; };

    panel.querySelector('#dcp-get-token').onclick = () => {
        try {
            window.dispatchEvent(new Event('beforeunload'));
            const iframe = document.createElement('iframe');
            document.body.appendChild(iframe);
            const ls = iframe.contentWindow.localStorage;
            panel.querySelector('#dcp-token').value = JSON.parse(ls.token || localStorage.token);
            document.body.removeChild(iframe);
        } catch (e) { addLog('error', 'Could not auto-get token. Please paste it manually.'); }
    };

    panel.querySelector('#dcp-get-author').onclick = () => {
        try {
            panel.querySelector('#dcp-author').value = JSON.parse(localStorage.user_id_cache);
        } catch (e) { addLog('error', 'Could not auto-get author ID. Please paste it manually.'); }
    };

    let stopFlag = false;

    panel.querySelector('#dcp-stop').onclick = () => {
        stopFlag = true;
        addLog('warn', 'Stop requested. Will halt after current operation…');
    };

    panel.querySelector('#dcp-start').onclick = async () => {
        const authToken = panel.querySelector('#dcp-token').value.trim();
        const authorId = panel.querySelector('#dcp-author').value.trim();

        if (!authToken || !authorId) {
            addLog('error', 'Auth token and Author ID are required!');
            return;
        }

        const startBtn = panel.querySelector('#dcp-start');
        const stopBtn = panel.querySelector('#dcp-stop');
        startBtn.disabled = true;
        stopBtn.disabled = false;
        stopFlag = false;

        addLog('info', 'Discovering all channels and DMs…');
        channelStatus.textContent = 'Discovering channels…';

        let channels;
        try {
            channels = await getAllChannels(authToken);
        } catch (e) {
            addLog('error', `Failed to discover channels: ${e.message}`);
            startBtn.disabled = false;
            stopBtn.disabled = true;
            return;
        }

        addLog('success', `Found ${channels.length} channels/DMs to process.`);

        if (!window.confirm(`Found ${channels.length} channels and DMs.\n\nThis will permanently delete ALL messages you have sent across your entire Discord account.\n\nThis CANNOT be undone. Continue?`)) {
            addLog('warn', 'Aborted by user.');
            startBtn.disabled = false;
            stopBtn.disabled = true;
            return;
        }

        progress.style.display = '';
        progress.max = channels.length;
        progress.value = 0;

        for (let i = 0; i < channels.length; i++) {
            if (stopFlag) { addLog('warn', 'Purge stopped by user.'); break; }

            const ch = channels[i];
            channelStatus.textContent = `Channel ${i + 1}/${channels.length}: ${ch.label}`;
            progress.value = i + 1;
            percent.textContent = `${Math.round((i + 1) / channels.length * 100)}%`;
            addLog('info', `\n── Processing: ${ch.label} (guild: ${ch.guildId}, channel: ${ch.channelId})`);

            await deleteMessagesInChannel(authToken, authorId, ch.guildId, ch.channelId, {
                stopHndl: () => !stopFlag,
                logFn: (type, msg) => addLog(type, msg),
            });

            // Small pause between channels
            await new Promise(r => setTimeout(r, 800));
        }

        addLog('success', '\n✅ Full purge complete!');
        channelStatus.textContent = 'Done';
        startBtn.disabled = false;
        stopBtn.disabled = true;
    };

})();
