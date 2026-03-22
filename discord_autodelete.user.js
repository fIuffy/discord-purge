// ==UserScript==
// @name          Discord AutoDelete - Signal-style Expiring Messages
// @description   Automatically deletes your Discord messages after a configurable time-to-live (TTL). Works per-channel. Logs sent messages and schedules deletion.
// @namespace     https://github.com/YOUR_USERNAME/discord-purge
// @version       1.0
// @match         https://discord.com/*
// @grant         GM_getValue
// @grant         GM_setValue
// @grant         GM_deleteValue
// @grant         GM_listValues
// @run-at        document-idle
// @license       MIT
// ==/UserScript==

/**
 * HOW TO USE:
 * 1. Install Tampermonkey or Violentmonkey in your browser
 * 2. Create a new script and paste this file's contents
 * 3. Open Discord — a small 🕐 button will appear in the toolbar
 * 4. Click it to open the AutoDelete panel
 * 5. Click "Get" to auto-fill your token & author ID
 * 6. Set a TTL (e.g. 3600 = 1 hour, 86400 = 1 day)
 * 7. Toggle AutoDelete ON — your messages in the current channel will be
 *    scheduled for deletion after the TTL expires
 *
 * NOTES:
 * - TTL can be configured globally or overridden per-channel
 * - Message log is stored in Tampermonkey's persistent storage (GM_setValue)
 * - The checker runs every 30 seconds while Discord is open
 * - Messages are only deleted from channels where AutoDelete is enabled
 * - Your token is stored in GM storage (local to your browser/Tampermonkey only)
 */

(function () {
    'use strict';

    // ── Storage keys ──────────────────────────────────────────────────────────
    const KEY_TOKEN       = 'ad_token';
    const KEY_AUTHOR      = 'ad_authorId';
    const KEY_GLOBAL_TTL  = 'ad_globalTtl';
    const KEY_ENABLED     = 'ad_enabled';         // JSON: { channelId: true/false }
    const KEY_CHANNEL_TTL = 'ad_channelTtl';      // JSON: { channelId: seconds }
    const KEY_MSG_LOG     = 'ad_msgLog';           // JSON: [ { id, channelId, ts, content } ]

    const MAX_LOG_DISPLAY = 200;
    const TICK_INTERVAL_MS = 30_000; // check every 30 seconds

    // ── Persistent storage helpers (GM) ───────────────────────────────────────
    const store = {
        get: (key, def) => { try { const v = GM_getValue(key); return v === undefined ? def : JSON.parse(v); } catch { return def; } },
        set: (key, val) => GM_setValue(key, JSON.stringify(val)),
    };

    // ── Discord API helpers ───────────────────────────────────────────────────
    const wait = ms => new Promise(r => setTimeout(r, ms));

    async function deleteMessage(authToken, channelId, messageId) {
        const url = `https://discord.com/api/v9/channels/${channelId}/messages/${messageId}`;
        let retries = 3;
        while (retries-- > 0) {
            const r = await fetch(url, {
                method: 'DELETE',
                headers: { Authorization: authToken },
            });
            if (r.ok || r.status === 404) return { ok: true, status: r.status };
            if (r.status === 429) {
                const { retry_after } = await r.json();
                await wait((retry_after || 1) * 1000 + 500);
                continue;
            }
            return { ok: false, status: r.status };
        }
        return { ok: false, status: 'max_retries' };
    }

    // ── Intercept outgoing messages by hooking XHR/fetch ─────────────────────
    // Discord sends messages via fetch POST to /api/v9/channels/:id/messages
    // We wrap fetch to capture sent message IDs and schedule deletion.

    const _fetch = window.fetch.bind(window);
    window.fetch = async function (input, init) {
        const url = typeof input === 'string' ? input : input?.url;
        const method = (init?.method || input?.method || 'GET').toUpperCase();

        const result = await _fetch(input, init);

        // Intercept successful message sends
        if (method === 'POST' && url && /\/api\/v\d+\/channels\/(\d+)\/messages$/.test(url) && result.ok) {
            try {
                const clone = result.clone();
                const data = await clone.json();
                if (data?.id && data?.channel_id) {
                    onMessageSent(data);
                }
            } catch { /* ignore parse errors */ }
        }

        return result;
    };

    function onMessageSent(msg) {
        const channelId = msg.channel_id;
        const enabledMap = store.get(KEY_ENABLED, {});
        if (!enabledMap[channelId]) return; // AutoDelete not enabled for this channel

        const ttlMap = store.get(KEY_CHANNEL_TTL, {});
        const globalTtl = store.get(KEY_GLOBAL_TTL, 3600);
        const ttl = ttlMap[channelId] ?? globalTtl;

        const entry = {
            id: msg.id,
            channelId,
            content: (msg.content || '').slice(0, 80), // truncate for display
            ts: Date.now(),
            deleteAt: Date.now() + ttl * 1000,
            ttl,
        };

        const log = store.get(KEY_MSG_LOG, []);
        log.push(entry);
        // Cap log size to avoid excessive storage use
        if (log.length > 5000) log.splice(0, log.length - 5000);
        store.set(KEY_MSG_LOG, log);

        addLog('success', `📨 Logged: "${entry.content || '[attachment]'}" — deletes in ${formatDuration(ttl)}`);
        refreshLogDisplay();
    }

    // ── Deletion ticker ───────────────────────────────────────────────────────
    async function tick() {
        const authToken = store.get(KEY_TOKEN, '');
        if (!authToken) return;

        const now = Date.now();
        let log = store.get(KEY_MSG_LOG, []);
        const due = log.filter(e => e.deleteAt <= now);
        if (due.length === 0) return;

        addLog('info', `⏰ ${due.length} message(s) due for deletion…`);

        const failed = [];
        for (const entry of due) {
            const { ok, status } = await deleteMessage(authToken, entry.channelId, entry.id);
            if (ok) {
                addLog('verb', `🗑️ Deleted msg ${entry.id} from channel ${entry.channelId} (was: "${entry.content || '[attachment]'}")`);
            } else if (status === 404) {
                addLog('verb', `⚠️ Msg ${entry.id} already gone (404), removing from log.`);
            } else {
                addLog('warn', `❌ Failed to delete ${entry.id} (${status}), will retry next tick.`);
                failed.push(entry);
            }
            await wait(600);
        }

        // Remove successfully handled entries, keep failed ones for retry
        const dueIds = new Set(due.map(e => e.id));
        const failedIds = new Set(failed.map(e => e.id));
        log = log.filter(e => !dueIds.has(e.id) || failedIds.has(e.id));
        store.set(KEY_MSG_LOG, log);
        refreshLogDisplay();
    }

    setInterval(tick, TICK_INTERVAL_MS);
    // Also run once shortly after load to catch anything that expired while Discord was closed
    setTimeout(tick, 5000);

    // ── Utility ───────────────────────────────────────────────────────────────
    function formatDuration(seconds) {
        if (seconds < 60) return `${seconds}s`;
        if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
        if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`;
        return `${(seconds / 86400).toFixed(1)}d`;
    }

    function getCurrentChannelId() {
        const m = location.href.match(/channels\/[\w@]+\/(\d+)/);
        return m ? m[1] : null;
    }

    // ── UI ────────────────────────────────────────────────────────────────────
    const css = `
        #dcad-btn{position:relative;height:24px;width:auto;flex:0 0 auto;margin:0 8px;cursor:pointer;color:var(--interactive-normal);}
        #dcad-btn.active{color:#3ba55d;}
        #dcad{position:fixed;top:60px;right:10px;bottom:10px;width:560px;z-index:9999;color:var(--text-normal);background:var(--background-secondary);box-shadow:var(--elevation-high);border-radius:6px;display:flex;flex-direction:column;font-family:sans-serif;}
        #dcad .hdr{padding:12px 16px;background:var(--background-tertiary);border-radius:6px 6px 0 0;font-weight:bold;display:flex;justify-content:space-between;align-items:center;}
        #dcad .form{padding:10px;border-bottom:1px solid rgba(255,255,255,.1);}
        #dcad input[type=password],#dcad input[type=text],#dcad input[type=number]{background:#202225;color:#b9bbbe;border:0;border-radius:4px;padding:0 .5em;height:28px;width:180px;margin:3px;}
        #dcad input[type=number]{width:90px;}
        #dcad button{color:#fff;background:#5865f2;border:0;border-radius:4px;padding:4px 12px;margin:3px;cursor:pointer;font-size:13px;}
        #dcad button.danger{background:#ed4245;}
        #dcad button.success{background:#3ba55d;}
        #dcad button.off{background:#4f545c;}
        #dcad .toggle-row{display:flex;align-items:center;gap:10px;padding:8px 0;}
        #dcad .badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:bold;}
        #dcad .badge.on{background:#3ba55d;color:#fff;}
        #dcad .badge.off{background:#4f545c;color:#ccc;}
        #dcad .log{overflow:auto;font-size:.72rem;font-family:Consolas,monospace;flex-grow:1;padding:10px;white-space:pre-wrap;}
        #dcad .status-bar{padding:6px 12px;background:var(--background-tertiary);border-radius:0 0 6px 6px;font-size:12px;display:flex;gap:16px;align-items:center;}
        #dcad .log-table{width:100%;border-collapse:collapse;font-size:11px;}
        #dcad .log-table th{text-align:left;color:#72767d;padding:2px 6px;border-bottom:1px solid rgba(255,255,255,.1);}
        #dcad .log-table td{padding:2px 6px;vertical-align:top;color:#b9bbbe;}
        #dcad .log-table tr:hover td{background:rgba(255,255,255,.04);}
        .dcad-info{color:#00b0f4}.dcad-warn{color:#faa61a}.dcad-error{color:#ed4245}.dcad-success{color:#3ba55d}.dcad-verb{color:#72767d}
    `;
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);

    const panel = document.createElement('div');
    panel.id = 'dcad';
    panel.style.display = 'none';
    panel.innerHTML = `
        <div class="hdr">
            🕐 AutoDelete <small style="font-weight:normal;color:#72767d;margin-left:6px;">Signal-style expiring messages</small>
            <button id="dcad-close" style="background:transparent;font-size:18px;padding:0 6px;">✕</button>
        </div>
        <div class="form">
            <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:flex-end;">
                <div>
                    <div style="font-size:11px;color:#72767d;">Auth Token</div>
                    <input type="password" id="dcad-token" placeholder="Paste or use Get">
                    <button id="dcad-get-token">Get</button>
                </div>
                <div>
                    <div style="font-size:11px;color:#72767d;">Author ID</div>
                    <input type="text" id="dcad-author" placeholder="Your user ID">
                    <button id="dcad-get-author">Get</button>
                </div>
            </div>
            <div style="margin-top:8px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
                <div>
                    <div style="font-size:11px;color:#72767d;">Global TTL (seconds)</div>
                    <input type="number" id="dcad-global-ttl" min="30" step="60" value="3600">
                    <span style="font-size:11px;color:#72767d;" id="dcad-ttl-preview">= 1h</span>
                </div>
                <button id="dcad-save-global" class="success">💾 Save</button>
            </div>
            <hr style="border-color:rgba(255,255,255,.1);margin:8px 0;">
            <div class="toggle-row">
                <strong style="font-size:13px;">Current channel:</strong>
                <span id="dcad-channel-id" style="font-size:11px;color:#72767d;">—</span>
                <span id="dcad-channel-badge" class="badge off">OFF</span>
                <button id="dcad-toggle" class="success">Enable AutoDelete</button>
                <div>
                    <span style="font-size:11px;color:#72767d;">Channel TTL override (s)</span>
                    <input type="number" id="dcad-channel-ttl" min="30" step="60" placeholder="Global">
                </div>
            </div>
            <div style="display:flex;gap:6px;margin-top:4px;">
                <button id="dcad-clear-log-btn">Clear event log</button>
                <button id="dcad-clear-msg-log" class="danger">🗑️ Purge pending queue</button>
            </div>
        </div>
        <div style="padding:4px 10px;font-size:11px;color:#72767d;border-bottom:1px solid rgba(255,255,255,.1);">
            Pending deletions: <strong id="dcad-pending-count">0</strong> &nbsp;|&nbsp; Next check in ~30s
        </div>
        <div class="log" id="dcad-log">AutoDelete ready.\n</div>
        <div class="status-bar">
            <span id="dcad-status">Idle</span>
        </div>
    `;
    document.body.appendChild(panel);

    // Toolbar button
    const btn = document.createElement('div');
    btn.id = 'dcad-btn';
    btn.title = 'AutoDelete Settings';
    btn.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm.5 11H11V7h1.5zm0-8H11V3.07A8.5 8.5 0 0 1 12 3a8.45 8.45 0 0 1 .5.07z"/>
        <path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zM12 20a8 8 0 1 1 8-8 8 8 0 0 1-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"/>
    </svg>`;
    btn.onclick = () => {
        panel.style.display = panel.style.display === 'none' ? '' : 'none';
        if (panel.style.display !== 'none') refreshUI();
    };

    function mountBtn() {
        const toolbar = document.querySelector('[class^=toolbar]');
        if (toolbar && !toolbar.contains(btn)) toolbar.appendChild(btn);
    }
    new MutationObserver(() => { if (!document.body.contains(btn)) mountBtn(); })
        .observe(document.body, { childList: true, subtree: true });
    mountBtn();

    // ── UI helpers ────────────────────────────────────────────────────────────
    const logEl = panel.querySelector('#dcad-log');

    function addLog(type, msg) {
        const line = document.createElement('div');
        if (type) line.className = `dcad-${type}`;
        line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
        logEl.appendChild(line);
        while (logEl.children.length > MAX_LOG_DISPLAY) logEl.removeChild(logEl.firstChild);
        logEl.lastElementChild?.scrollIntoView(false);
    }

    function refreshLogDisplay() {
        const log = store.get(KEY_MSG_LOG, []);
        panel.querySelector('#dcad-pending-count').textContent = log.length;
    }

    function refreshUI() {
        const channelId = getCurrentChannelId();
        const enabledMap = store.get(KEY_ENABLED, {});
        const ttlMap = store.get(KEY_CHANNEL_TTL, {});
        const globalTtl = store.get(KEY_GLOBAL_TTL, 3600);

        panel.querySelector('#dcad-token').value = store.get(KEY_TOKEN, '');
        panel.querySelector('#dcad-author').value = store.get(KEY_AUTHOR, '');
        panel.querySelector('#dcad-global-ttl').value = globalTtl;
        panel.querySelector('#dcad-ttl-preview').textContent = `= ${formatDuration(globalTtl)}`;

        if (channelId) {
            panel.querySelector('#dcad-channel-id').textContent = channelId;
            const isOn = !!enabledMap[channelId];
            const badge = panel.querySelector('#dcad-channel-badge');
            badge.textContent = isOn ? 'ON' : 'OFF';
            badge.className = `badge ${isOn ? 'on' : 'off'}`;
            const toggleBtn = panel.querySelector('#dcad-toggle');
            toggleBtn.textContent = isOn ? 'Disable AutoDelete' : 'Enable AutoDelete';
            toggleBtn.className = isOn ? 'danger' : 'success';
            panel.querySelector('#dcad-channel-ttl').value = ttlMap[channelId] ?? '';
            btn.className = Object.values(enabledMap).some(Boolean) ? 'active' : '';
        } else {
            panel.querySelector('#dcad-channel-id').textContent = 'No channel selected';
        }
        refreshLogDisplay();
    }

    // ── UI event bindings ─────────────────────────────────────────────────────
    panel.querySelector('#dcad-close').onclick = () => { panel.style.display = 'none'; };

    panel.querySelector('#dcad-get-token').onclick = () => {
        try {
            window.dispatchEvent(new Event('beforeunload'));
            const iframe = document.createElement('iframe');
            document.body.appendChild(iframe);
            const token = JSON.parse(iframe.contentWindow.localStorage.token || localStorage.token);
            document.body.removeChild(iframe);
            panel.querySelector('#dcad-token').value = token;
            store.set(KEY_TOKEN, token);
            addLog('success', 'Token saved.');
        } catch { addLog('error', 'Could not auto-get token. Paste it manually.'); }
    };

    panel.querySelector('#dcad-get-author').onclick = () => {
        try {
            const id = JSON.parse(localStorage.user_id_cache);
            panel.querySelector('#dcad-author').value = id;
            store.set(KEY_AUTHOR, id);
            addLog('success', 'Author ID saved.');
        } catch { addLog('error', 'Could not auto-get author ID. Paste it manually.'); }
    };

    panel.querySelector('#dcad-global-ttl').oninput = function () {
        panel.querySelector('#dcad-ttl-preview').textContent = `= ${formatDuration(parseInt(this.value) || 0)}`;
    };

    panel.querySelector('#dcad-save-global').onclick = () => {
        const token = panel.querySelector('#dcad-token').value.trim();
        const author = panel.querySelector('#dcad-author').value.trim();
        const ttl = parseInt(panel.querySelector('#dcad-global-ttl').value);
        if (token) store.set(KEY_TOKEN, token);
        if (author) store.set(KEY_AUTHOR, author);
        if (ttl >= 30) store.set(KEY_GLOBAL_TTL, ttl);
        addLog('success', `Settings saved. Global TTL: ${formatDuration(ttl)}`);
        refreshUI();
    };

    panel.querySelector('#dcad-toggle').onclick = () => {
        const channelId = getCurrentChannelId();
        if (!channelId) { addLog('warn', 'Navigate to a channel first.'); return; }

        const enabledMap = store.get(KEY_ENABLED, {});
        const ttlMap = store.get(KEY_CHANNEL_TTL, {});
        const channelTtlInput = parseInt(panel.querySelector('#dcad-channel-ttl').value);

        const nowOn = !enabledMap[channelId];
        enabledMap[channelId] = nowOn;
        store.set(KEY_ENABLED, enabledMap);

        if (channelTtlInput >= 30) {
            ttlMap[channelId] = channelTtlInput;
            store.set(KEY_CHANNEL_TTL, ttlMap);
        }

        const effectiveTtl = ttlMap[channelId] ?? store.get(KEY_GLOBAL_TTL, 3600);
        addLog(nowOn ? 'success' : 'warn',
            nowOn
                ? `✅ AutoDelete ON for channel ${channelId} — TTL: ${formatDuration(effectiveTtl)}`
                : `🔴 AutoDelete OFF for channel ${channelId}`
        );
        refreshUI();
    };

    panel.querySelector('#dcad-clear-log-btn').onclick = () => { logEl.innerHTML = ''; };

    panel.querySelector('#dcad-clear-msg-log').onclick = () => {
        if (window.confirm('Clear the entire pending deletion queue? Logged messages will NOT be deleted.')) {
            store.set(KEY_MSG_LOG, []);
            addLog('warn', 'Pending queue cleared.');
            refreshLogDisplay();
        }
    };

    // Update UI when navigating to a different channel
    new MutationObserver(refreshUI).observe(document.querySelector('title') || document.head, { childList: true, subtree: true });

    refreshUI();
    addLog('info', 'AutoDelete loaded. Configure your token and enable per-channel.');

})();
