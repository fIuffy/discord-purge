// ==UserScript==
// @name          Discord AutoDelete - Signal-style Expiring Messages
// @description   Automatically deletes your Discord messages after a configurable TTL. Works per-channel. Logs sent messages and schedules deletion.
// @namespace     https://github.com/fIuffy/discord-purge
// @version       2.0
// @match         https://discord.com/*
// @grant         GM_getValue
// @grant         GM_setValue
// @run-at        document-idle
// @license       MIT
// ==/UserScript==

/**
 * HOW TO USE:
 * 1. Install Tampermonkey or Violentmonkey in your browser
 * 2. Create a new script and paste this file's contents
 * 3. Open Discord - a clock button will appear in the toolbar
 * 4. Click it to open the AutoDelete panel
 * 5. Click "Get" to auto-fill your token and author ID, then Save
 * 6. Set a TTL (e.g. 3600 = 1 hour, 86400 = 1 day)
 * 7. Navigate to a channel and click Enable AutoDelete
 *
 * NOTES:
 * - TTL can be set globally or overridden per-channel
 * - Message log is stored in Tampermonkey storage (GM_setValue)
 * - The checker runs every 30 seconds while Discord is open
 * - Messages are only deleted from channels where AutoDelete is enabled
 * - Your token is stored locally in Tampermonkey only
 */

(function () {
    'use strict';

    // ── Storage keys ──────────────────────────────────────────────────────────
    const KEY_TOKEN       = 'ad_token';
    const KEY_AUTHOR      = 'ad_authorId';
    const KEY_GLOBAL_TTL  = 'ad_globalTtl';
    const KEY_ENABLED     = 'ad_enabled';      // { channelId: true/false }
    const KEY_CHANNEL_TTL = 'ad_channelTtl';   // { channelId: seconds }
    const KEY_MSG_LOG     = 'ad_msgLog';        // [ { id, channelId, ts, content, deleteAt, ttl } ]

    const MAX_LOG_DISPLAY  = 200;
    const TICK_INTERVAL_MS = 30_000;

    // ── Storage helpers ───────────────────────────────────────────────────────
    const store = {
        get: (key, def) => { try { const v = GM_getValue(key); return v === undefined ? def : JSON.parse(v); } catch { return def; } },
        set: (key, val) => GM_setValue(key, JSON.stringify(val)),
    };

    // ── API helpers ───────────────────────────────────────────────────────────
    const wait = ms => new Promise(r => setTimeout(r, ms));

    async function deleteMessage(authToken, channelId, messageId) {
        const url = `https://discord.com/api/v9/channels/${channelId}/messages/${messageId}`;
        let retries = 3;
        while (retries-- > 0) {
            const r = await fetch(url, { method: 'DELETE', headers: { Authorization: authToken } });
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

    // ── fetch() hook - intercept outgoing messages ────────────────────────────
    const _fetch = window.fetch.bind(window);
    window.fetch = async function (input, init) {
        const url    = typeof input === 'string' ? input : input?.url;
        const method = (init?.method || input?.method || 'GET').toUpperCase();
        const result = await _fetch(input, init);

        if (method === 'POST' && url && /\/api\/v\d+\/channels\/(\d+)\/messages$/.test(url) && result.ok) {
            try {
                const data = await result.clone().json();
                if (data?.id && data?.channel_id) onMessageSent(data);
            } catch { /* ignore */ }
        }
        return result;
    };

    function onMessageSent(msg) {
        const channelId  = msg.channel_id;
        const enabledMap = store.get(KEY_ENABLED, {});
        if (!enabledMap[channelId]) return;

        const ttlMap   = store.get(KEY_CHANNEL_TTL, {});
        const globalTtl = store.get(KEY_GLOBAL_TTL, 3600);
        const ttl      = ttlMap[channelId] ?? globalTtl;

        const entry = {
            id:       msg.id,
            channelId,
            content:  (msg.content || '').slice(0, 80),
            ts:       Date.now(),
            deleteAt: Date.now() + ttl * 1000,
            ttl,
        };

        const log = store.get(KEY_MSG_LOG, []);
        log.push(entry);
        if (log.length > 5000) log.splice(0, log.length - 5000);
        store.set(KEY_MSG_LOG, log);

        addLog('success', `Logged: "${entry.content || '[attachment]'}" - deletes in ${formatDuration(ttl)}`);
        refreshPendingCount();
    }

    // ── Deletion ticker ───────────────────────────────────────────────────────
    async function tick() {
        const authToken = store.get(KEY_TOKEN, '');
        if (!authToken) return;

        const now = Date.now();
        let log   = store.get(KEY_MSG_LOG, []);
        const due = log.filter(e => e.deleteAt <= now);
        if (due.length === 0) return;

        addLog('info', `${due.length} message(s) due for deletion...`);

        const failed = [];
        for (const entry of due) {
            const { ok, status } = await deleteMessage(authToken, entry.channelId, entry.id);
            if (ok) {
                addLog('verb', `Deleted ${entry.id} (was: "${entry.content || '[attachment]'}")`);
            } else if (status === 404) {
                addLog('verb', `Message ${entry.id} already gone, removing from queue.`);
            } else {
                addLog('warn', `Failed to delete ${entry.id} (${status}), will retry next tick.`);
                failed.push(entry);
            }
            await wait(600);
        }

        const dueIds    = new Set(due.map(e => e.id));
        const failedIds = new Set(failed.map(e => e.id));
        log = log.filter(e => !dueIds.has(e.id) || failedIds.has(e.id));
        store.set(KEY_MSG_LOG, log);
        refreshPendingCount();
    }

    setInterval(tick, TICK_INTERVAL_MS);
    setTimeout(tick, 5000); // catch anything that expired while Discord was closed

    // ── Utilities ─────────────────────────────────────────────────────────────
    function formatDuration(seconds) {
        if (seconds < 60)    return `${seconds}s`;
        if (seconds < 3600)  return `${Math.round(seconds / 60)}m`;
        if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`;
        return `${(seconds / 86400).toFixed(1)}d`;
    }

    function getCurrentChannelId() {
        const m = location.href.match(/channels\/[\w@]+\/(\d+)/);
        return m ? m[1] : null;
    }

    // ── CSS ───────────────────────────────────────────────────────────────────
    const css = `
        #dcad-btn{position:relative;height:24px;width:auto;flex:0 0 auto;margin:0 8px;cursor:pointer;color:#b9bbbe;transition:color .15s;}
        #dcad-btn:hover{color:#fff;}
        #dcad-btn.active{color:#248046;}
        #dcad{position:fixed;top:60px;right:10px;bottom:10px;width:520px;z-index:9999;
            color:#dcddde;background:#1e1f22;
            border:1px solid #111214;
            box-shadow:0 8px 32px rgba(0,0,0,.7);
            border-radius:8px;display:flex;flex-direction:column;font-family:'gg sans','Noto Sans',sans-serif;}
        #dcad *{box-sizing:border-box;}
        #dcad .hdr{padding:12px 16px;background:#111214;border-radius:8px 8px 0 0;font-weight:700;font-size:14px;color:#fff;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #000;}
        #dcad .form{padding:12px;border-bottom:1px solid #2b2d31;display:flex;flex-direction:column;gap:8px;}
        #dcad input[type=password],#dcad input[type=text],#dcad input[type=number]{
            background:#111214;color:#dcddde;border:1px solid #2b2d31;border-radius:4px;
            padding:0 .6em;height:30px;margin:2px;outline:none;font-size:13px;transition:border-color .15s;}
        #dcad input[type=password],#dcad input[type=text]{width:200px;}
        #dcad input[type=number]{width:90px;}
        #dcad input:focus{border-color:#5865f2;}
        #dcad input::placeholder{color:#4e5058;}
        #dcad button{color:#fff;background:#5865f2;border:0;border-radius:4px;padding:5px 14px;margin:2px;cursor:pointer;font-size:13px;font-weight:500;transition:filter .15s;}
        #dcad button:hover{filter:brightness(1.1);}
        #dcad button.danger{background:#c03537;}
        #dcad button.success{background:#248046;}
        #dcad button.off{background:#383a40;}
        #dcad .toggle-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:4px 0;}
        #dcad .badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:700;}
        #dcad .badge.on{background:#248046;color:#fff;}
        #dcad .badge.off{background:#383a40;color:#949ba4;}
        #dcad .pending-bar{padding:5px 12px;font-size:11px;color:#949ba4;border-bottom:1px solid #2b2d31;background:#17181a;}
        #dcad .pending-bar strong{color:#fff;}
        #dcad .log{overflow:auto;font-size:.72rem;font-family:Consolas,'Courier New',monospace;flex-grow:1;padding:10px 12px;white-space:pre-wrap;background:#111214;color:#c7cad1;}
        #dcad .status-bar{padding:7px 14px;background:#111214;border-radius:0 0 8px 8px;border-top:1px solid #000;font-size:12px;color:#949ba4;}
        #dcad label{font-size:12px;color:#949ba4;display:flex;align-items:center;gap:4px;}
        #dcad hr{border:none;border-top:1px solid #2b2d31;margin:4px 0;}
        .dcad-info{color:#00b0f4}.dcad-warn{color:#faa61a}.dcad-error{color:#f04747}.dcad-success{color:#43b581}.dcad-verb{color:#555760}
    `;
    document.head.appendChild(Object.assign(document.createElement('style'), { textContent: css }));

    // ── Panel HTML ────────────────────────────────────────────────────────────
    const panel = document.createElement('div');
    panel.id = 'dcad';
    panel.style.display = 'none';
    panel.innerHTML = `
        <div class="hdr">
            AutoDelete
            <small style="font-weight:400;color:#949ba4;margin-left:6px;font-size:12px;">expiring messages</small>
            <button id="dcad-close" style="background:transparent;font-size:18px;padding:0 6px;margin-left:auto;">x</button>
        </div>
        <div class="form">
            <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:flex-end;">
                <div>
                    <div style="font-size:11px;color:#949ba4;margin-bottom:2px;">Auth Token</div>
                    <input type="password" id="dcad-token" placeholder="Paste or use Get">
                    <button id="dcad-get-token">Get</button>
                </div>
                <div>
                    <div style="font-size:11px;color:#949ba4;margin-bottom:2px;">Author ID</div>
                    <input type="text" id="dcad-author" placeholder="Your user ID">
                    <button id="dcad-get-author">Get</button>
                </div>
            </div>
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                <div>
                    <div style="font-size:11px;color:#949ba4;margin-bottom:2px;">Global TTL (seconds)</div>
                    <input type="number" id="dcad-global-ttl" min="30" step="60" value="3600">
                    <span style="font-size:11px;color:#4e5058;" id="dcad-ttl-preview">= 1h</span>
                </div>
                <button id="dcad-save-global" class="success" style="margin-top:14px;">Save</button>
            </div>
            <hr>
            <div class="toggle-row">
                <span style="font-size:12px;color:#949ba4;">Current channel:</span>
                <span id="dcad-channel-id" style="font-size:11px;color:#4e5058;font-family:monospace;">none</span>
                <span id="dcad-channel-badge" class="badge off">OFF</span>
                <button id="dcad-toggle" class="success">Enable AutoDelete</button>
            </div>
            <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                <div style="font-size:11px;color:#949ba4;">Channel TTL override (s, optional)</div>
                <input type="number" id="dcad-channel-ttl" min="30" step="60" placeholder="Uses global">
            </div>
            <div style="display:flex;gap:6px;margin-top:2px;">
                <button id="dcad-clear-log-btn" class="off">Clear log</button>
                <button id="dcad-clear-msg-log" class="danger">Purge pending queue</button>
            </div>
        </div>
        <div class="pending-bar">
            Pending deletions: <strong id="dcad-pending-count">0</strong> &nbsp;|&nbsp; checks every 30s
        </div>
        <div class="log" id="dcad-log">AutoDelete ready.\n</div>
        <div class="status-bar" id="dcad-status">Idle</div>
    `;
    document.body.appendChild(panel);

    // ── Toolbar button ────────────────────────────────────────────────────────
    const btn = document.createElement('div');
    btn.id = 'dcad-btn';
    btn.title = 'AutoDelete Settings';
    btn.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
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

    // ── Log helper ────────────────────────────────────────────────────────────
    const logEl = panel.querySelector('#dcad-log');

    function addLog(type, msg) {
        const line = document.createElement('div');
        if (type) line.className = `dcad-${type}`;
        line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
        logEl.appendChild(line);
        while (logEl.children.length > MAX_LOG_DISPLAY) logEl.removeChild(logEl.firstChild);
        logEl.lastElementChild?.scrollIntoView(false);
    }

    function refreshPendingCount() {
        const log = store.get(KEY_MSG_LOG, []);
        panel.querySelector('#dcad-pending-count').textContent = log.length.toLocaleString();
    }

    function refreshUI() {
        const channelId  = getCurrentChannelId();
        const enabledMap = store.get(KEY_ENABLED, {});
        const ttlMap     = store.get(KEY_CHANNEL_TTL, {});
        const globalTtl  = store.get(KEY_GLOBAL_TTL, 3600);

        panel.querySelector('#dcad-token').value      = store.get(KEY_TOKEN, '');
        panel.querySelector('#dcad-author').value     = store.get(KEY_AUTHOR, '');
        panel.querySelector('#dcad-global-ttl').value = globalTtl;
        panel.querySelector('#dcad-ttl-preview').textContent = `= ${formatDuration(globalTtl)}`;

        if (channelId) {
            panel.querySelector('#dcad-channel-id').textContent = channelId;
            const isOn       = !!enabledMap[channelId];
            const badge      = panel.querySelector('#dcad-channel-badge');
            badge.textContent = isOn ? 'ON' : 'OFF';
            badge.className   = `badge ${isOn ? 'on' : 'off'}`;
            const toggleBtn   = panel.querySelector('#dcad-toggle');
            toggleBtn.textContent = isOn ? 'Disable AutoDelete' : 'Enable AutoDelete';
            toggleBtn.className   = isOn ? 'danger' : 'success';
            panel.querySelector('#dcad-channel-ttl').value = ttlMap[channelId] ?? '';
            btn.className = Object.values(enabledMap).some(Boolean) ? 'active' : '';
        } else {
            panel.querySelector('#dcad-channel-id').textContent = 'none';
        }
        refreshPendingCount();
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
        const token  = panel.querySelector('#dcad-token').value.trim();
        const author = panel.querySelector('#dcad-author').value.trim();
        const ttl    = parseInt(panel.querySelector('#dcad-global-ttl').value);
        if (token)  store.set(KEY_TOKEN, token);
        if (author) store.set(KEY_AUTHOR, author);
        if (ttl >= 30) store.set(KEY_GLOBAL_TTL, ttl);
        addLog('success', `Settings saved. Global TTL: ${formatDuration(ttl)}`);
        refreshUI();
    };

    panel.querySelector('#dcad-toggle').onclick = () => {
        const channelId = getCurrentChannelId();
        if (!channelId) { addLog('warn', 'Navigate to a channel first.'); return; }

        const enabledMap       = store.get(KEY_ENABLED, {});
        const ttlMap           = store.get(KEY_CHANNEL_TTL, {});
        const channelTtlInput  = parseInt(panel.querySelector('#dcad-channel-ttl').value);
        const nowOn            = !enabledMap[channelId];

        enabledMap[channelId] = nowOn;
        store.set(KEY_ENABLED, enabledMap);

        if (channelTtlInput >= 30) {
            ttlMap[channelId] = channelTtlInput;
            store.set(KEY_CHANNEL_TTL, ttlMap);
        }

        const effectiveTtl = ttlMap[channelId] ?? store.get(KEY_GLOBAL_TTL, 3600);
        addLog(nowOn ? 'success' : 'warn',
            nowOn
                ? `AutoDelete ON for channel ${channelId} - TTL: ${formatDuration(effectiveTtl)}`
                : `AutoDelete OFF for channel ${channelId}`
        );
        refreshUI();
    };

    panel.querySelector('#dcad-clear-log-btn').onclick = () => { logEl.innerHTML = ''; };

    panel.querySelector('#dcad-clear-msg-log').onclick = () => {
        if (window.confirm('Clear the pending deletion queue? Messages already logged will NOT be deleted.')) {
            store.set(KEY_MSG_LOG, []);
            addLog('warn', 'Pending queue cleared.');
            refreshPendingCount();
        }
    };

    // Refresh UI on channel navigation
    new MutationObserver(refreshUI)
        .observe(document.querySelector('title') || document.head, { childList: true, subtree: true });

    refreshUI();
    addLog('info', 'AutoDelete loaded. Configure your token and enable per-channel.');

})();
