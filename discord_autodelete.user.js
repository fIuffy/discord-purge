// ==UserScript==
// @name          Discord AutoDelete - Signal-style Expiring Messages
// @description   Automatically deletes your Discord messages after a configurable TTL. Polls each enabled channel for your messages and deletes ones older than the TTL.
// @namespace     https://github.com/fIuffy/discord-purge
// @version       4.1
// @match         https://discord.com/*
// @grant         GM_getValue
// @grant         GM_setValue
// @run-at        document-idle
// @license       MIT
// ==/UserScript==

/**
 * HOW TO USE:
 * 1. Install Tampermonkey or Violentmonkey
 * 2. Create a new script and paste this file
 * 3. Open Discord - a clock icon appears in the toolbar
 * 4. Click Get next to Auth Token and Author ID, then Save settings
 * 5. Set a Global TTL in seconds (e.g. 3600 = 1 hour)
 * 6. Enable AutoDelete per-channel from the Channels tab,
 *    or navigate to a channel and use the current channel toggle
 *
 * HOW IT WORKS:
 * Instead of trying to intercept outgoing messages (unreliable due to
 * Discord's bundler), this script periodically searches each enabled
 * channel for messages sent by your account and deletes any that are
 * older than the configured TTL. The check runs every 60 seconds and
 * also fires when you switch back to the tab.
 */

(function () {
    'use strict';

    const KEY_TOKEN         = 'ad_token';
    const KEY_AUTHOR        = 'ad_authorId';
    const KEY_GLOBAL_TTL    = 'ad_globalTtl';
    const KEY_ENABLED       = 'ad_enabled';       // { channelId: true/false }
    const KEY_CHANNEL_TTL   = 'ad_channelTtl';    // { channelId: seconds }
    const KEY_CHANNEL_NAMES    = 'ad_channelNames';  // { channelId: label }
    const KEY_SCAN_INTERVAL    = 'ad_scanInterval';  // seconds
    const KEY_MSG_HISTORY      = 'ad_msgHistory';    // [ { id, channelId, content, deletedAt } ]

    const MAX_LOG_DISPLAY  = 300;
    const DEFAULT_SCAN_INTERVAL = 60; // seconds
    const getTickMs = () => (store.get(KEY_SCAN_INTERVAL, DEFAULT_SCAN_INTERVAL)) * 1000;

    // ── Storage ───────────────────────────────────────────────────────────────
    const store = {
        get: (key, def) => {
            try { const v = GM_getValue(key); return v === undefined ? def : JSON.parse(v); }
            catch { return def; }
        },
        set: async (key, val) => { await GM_setValue(key, JSON.stringify(val)); },
    };

    // ── Keep-alive ────────────────────────────────────────────────────────────
    const keepAlive = document.createElement('div');
    keepAlive.style.display = 'none';
    document.body.appendChild(keepAlive);
    setInterval(() => keepAlive.classList.toggle('ka'), 10_000);

    // ── API helpers ───────────────────────────────────────────────────────────
    const wait = ms => new Promise(r => setTimeout(r, ms));

    // Search a channel for messages by authorId with offset, returns array of message objects
    async function searchMessages(authToken, authorId, channelId, offset) {
        const url = `https://discord.com/api/v9/channels/${channelId}/messages/search?author_id=${authorId}&sort_by=timestamp&sort_order=desc&offset=${offset}&limit=25`;
        let retries = 5;
        while (retries-- > 0) {
            const r = await fetch(url, { headers: { Authorization: authToken } });
            if (r.ok) {
                const data = await r.json();
                const messages = (data.messages || [])
                    .flat()
                    .filter(m => m.hit === true || m.author?.id === authorId);
                return { ok: true, messages, total: data.total_results ?? 0 };
            }
            if (r.status === 202) {
                let w = 2000;
                try { const j = await r.json(); w = (j.retry_after ?? 2) * 1000; } catch {}
                addLog('verb', `Channel ${getChannelLabel(channelId)} not indexed, waiting ${Math.round(w / 1000)}s...`);
                await wait(w);
                continue;
            }
            if (r.status === 429) {
                let w = 2000;
                try { const j = await r.json(); w = ((j.retry_after ?? 2) * 1000) + 500; } catch {}
                addLog('warn', `Rate limited on search, cooling ${Math.round(w / 1000)}s...`);
                await wait(w);
                continue;
            }
            return { ok: false, status: r.status, messages: [], total: 0 };
        }
        return { ok: false, status: 'max_retries', messages: [], total: 0 };
    }

    async function deleteMessage(authToken, channelId, messageId) {
        let retries = 5;
        while (retries-- > 0) {
            const r = await fetch(
                `https://discord.com/api/v9/channels/${channelId}/messages/${messageId}`,
                { method: 'DELETE', headers: { Authorization: authToken } }
            );
            if (r.ok || r.status === 404) return { ok: true };
            if (r.status === 429) {
                let w = 1500;
                try { const j = await r.json(); w = ((j.retry_after ?? 1) * 1000) + 500; } catch {}
                addLog('warn', `Rate limited on delete, cooling ${Math.round(w / 1000)}s...`);
                await wait(w);
                continue;
            }
            return { ok: false, status: r.status };
        }
        return { ok: false, status: 'max_retries' };
    }

    // Delete all expired messages in a single channel, re-searching until none remain
    async function purgeChannel(authToken, authorId, channelId, cutoff) {
        let deleteDelay = 1200;
        let searchDelay = 1500;
        let offset = 0;
        let deleted = 0;
        let failed = 0;

        while (true) {
            const { ok, messages, total, status } = await searchMessages(authToken, authorId, channelId, offset);

            if (!ok) {
                if (status !== 403 && status !== 404) {
                    addLog('warn', `Search failed for ${getChannelLabel(channelId)} (${status})`);
                }
                break;
            }

            const toDelete = messages.filter(m => {
                const ts = new Date(m.timestamp).getTime();
                return ts < cutoff && (m.type === 0 || m.type === 6);
            });

            // No expired messages in this page
            if (toDelete.length === 0) {
                // But there may be more pages of non-expired messages -- stop here,
                // they are newer so no point paging further (sorted desc by timestamp)
                break;
            }

            const skipped = messages.length - toDelete.length;

            for (const msg of toDelete) {
                const { ok: delOk, status: delStatus } = await deleteMessage(authToken, channelId, msg.id);
                if (delOk) {
                    deleted++;
                    totalDeletedSession++;
                    addLog('verb', `Deleted: "${(msg.content || '[attachment]').slice(0, 60)}" from ${getChannelLabel(channelId)}`);
                    updateTotalCounter();

                    // Log to history
                    const hist = store.get(KEY_MSG_HISTORY, []);
                    hist.unshift({ id: msg.id, channelId, content: (msg.content || '').slice(0, 100), deletedAt: Date.now() });
                    if (hist.length > 500) hist.splice(500);
                    store.set(KEY_MSG_HISTORY, hist);

                    // Adaptive: speed up slightly every 50 deletes (floor 600ms)
                    if (deleted % 50 === 0) deleteDelay = Math.max(600, deleteDelay - 50);
                } else {
                    addLog('warn', `Failed to delete ${msg.id} (${delStatus})`);
                    failed++;
                    offset++; // skip past it on next search
                    // Back off on persistent failures
                    deleteDelay = Math.min(5000, deleteDelay + 200);
                }
                await wait(deleteDelay);
            }

            // If we skipped non-expired messages, bump offset so next search page starts past them
            if (skipped > 0) offset += skipped;

            // Check if there could be more results
            if (total <= offset + toDelete.length + skipped && total <= 25) break;

            await wait(searchDelay);
        }

        return { deleted, failed };
    }

    // ── Main tick -- search each enabled channel, delete expired messages ───────
    let tickRunning = false;
    let totalDeletedSession = 0;

    async function tick() {
        if (tickRunning) return;

        const authToken = store.get(KEY_TOKEN, '');
        const authorId  = store.get(KEY_AUTHOR, '');
        if (!authToken || !authorId) return;

        const enabledMap = store.get(KEY_ENABLED, {});
        const channels   = Object.entries(enabledMap).filter(([, v]) => v).map(([id]) => id);
        if (channels.length === 0) return;

        tickRunning = true;
        updateStatus('Scanning...');

        try {
            for (const channelId of channels) {
                const ttlMap    = store.get(KEY_CHANNEL_TTL, {});
                const globalTtl = store.get(KEY_GLOBAL_TTL, 3600);
                const ttl       = (ttlMap[channelId] ?? globalTtl) * 1000; // ms
                const cutoff    = Date.now() - ttl;

                updateStatus(`Scanning ${getChannelLabel(channelId)}...`);
                const { deleted, failed } = await purgeChannel(authToken, authorId, channelId, cutoff);

                if (deleted > 0 || failed > 0) {
                    addLog('info', `${getChannelLabel(channelId)}: deleted ${deleted}, failed ${failed}`);
                    renderHistoryList();
                }

                await wait(500); // breathe between channels
            }
        } finally {
            tickRunning = false;
            updateStatus('Idle');
            updateNextTick();
        }
    }

    // ── Utilities ─────────────────────────────────────────────────────────────
    function formatDuration(seconds) {
        if (!seconds || seconds < 0) return '?';
        if (seconds < 60)    return `${seconds}s`;
        if (seconds < 3600)  return `${Math.round(seconds / 60)}m`;
        if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`;
        return `${(seconds / 86400).toFixed(1)}d`;
    }

    function getCurrentChannelId() {
        const m = location.href.match(/channels\/[\w@]+\/(\d+)/);
        return m ? m[1] : null;
    }

    function getChannelLabel(channelId) {
        const names = store.get(KEY_CHANNEL_NAMES, {});
        return names[channelId] || `Channel ${channelId}`;
    }

    function updateStatus(text) {
        const el = document.querySelector('#dcad-status');
        if (el) el.textContent = text;
    }

    function updateTotalCounter() {
        const el = document.querySelector('#dcad-total');
        if (el) el.textContent = totalDeletedSession.toLocaleString();
    }

    let nextTickSecs = getTickMs() / 1000;
    function updateNextTick() { nextTickSecs = getTickMs() / 1000; }

    let tickInterval = setInterval(tick, getTickMs());
    setTimeout(tick, 4000); // run shortly after load

    // Re-run when tab becomes visible (catches up after backgrounding)
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') tick();
    });

    // Countdown
    setInterval(() => {
        nextTickSecs = Math.max(0, nextTickSecs - 1);
        const el = document.querySelector('#dcad-next-tick');
        if (el) el.textContent = tickRunning ? 'Running...' : `Next scan in ${nextTickSecs}s`;
        if (nextTickSecs === 0 && !tickRunning) nextTickSecs = getTickMs() / 1000;

    }, 1000);

    // ── CSS ───────────────────────────────────────────────────────────────────
    const css = `
        #dcad-btn{position:relative;height:24px;width:auto;flex:0 0 auto;margin:0 8px;cursor:pointer;color:#b9bbbe;transition:color .15s;}
        #dcad-btn:hover{color:#fff;}
        #dcad-btn.active{color:#248046;}
        #dcad{position:fixed;top:60px;right:10px;bottom:10px;width:640px;z-index:9999;color:#dcddde;background:#1e1f22;border:1px solid #111214;box-shadow:0 8px 32px rgba(0,0,0,.7);border-radius:8px;display:flex;flex-direction:column;font-family:'gg sans','Noto Sans',sans-serif;}
        #dcad *{box-sizing:border-box;}
        #dcad .hdr{padding:12px 16px;background:#111214;border-radius:8px 8px 0 0;font-weight:700;font-size:14px;color:#fff;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #000;}
        #dcad .tabs{display:flex;background:#17181a;border-bottom:2px solid #111214;}
        #dcad .tab{padding:9px 18px;cursor:pointer;font-size:13px;font-weight:500;color:#949ba4;border-bottom:2px solid transparent;margin-bottom:-2px;user-select:none;transition:color .15s;}
        #dcad .tab:hover{color:#dcddde;}
        #dcad .tab.active{color:#fff;border-bottom-color:#5865f2;}
        #dcad .tab-panel{display:none;padding:12px;flex-direction:column;gap:8px;overflow-y:auto;}
        #dcad .tab-panel.active{display:flex;}
        #dcad input[type=password],#dcad input[type=text],#dcad input[type=number]{background:#111214;color:#dcddde;border:1px solid #2b2d31;border-radius:4px;padding:0 .6em;height:30px;width:180px;margin:2px;outline:none;font-size:13px;transition:border-color .15s;}
        #dcad input:focus{border-color:#5865f2;}
        #dcad input::placeholder{color:#4e5058;}
        #dcad input[type=number]{width:90px;}
        #dcad button{color:#fff;background:#5865f2;border:0;border-radius:4px;padding:5px 14px;margin:2px;cursor:pointer;font-size:13px;font-weight:500;transition:filter .15s;}
        #dcad button:hover{filter:brightness(1.1);}
        #dcad button.danger{background:#c03537;}
        #dcad button.success{background:#248046;}
        #dcad button.muted{background:#383a40;}
        #dcad button.small{padding:3px 10px;font-size:11px;}
        #dcad .badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:700;}
        #dcad .badge.on{background:#248046;color:#fff;}
        #dcad .badge.off{background:#383a40;color:#949ba4;}
        #dcad .log{overflow:auto;font-size:.72rem;font-family:Consolas,'Courier New',monospace;flex-grow:1;padding:10px 12px;white-space:pre-wrap;background:#111214;color:#c7cad1;}
        #dcad .status-bar{padding:7px 14px;background:#111214;border-radius:0 0 8px 8px;border-top:1px solid #000;font-size:12px;color:#949ba4;display:flex;gap:14px;align-items:center;}
        #dcad hr{border:none;border-top:1px solid #2b2d31;margin:4px 0;}
        #dcad .field-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
        #dcad .field-label{font-size:11px;color:#949ba4;min-width:80px;}
        #dcad .section-title{font-size:11px;font-weight:700;color:#949ba4;text-transform:uppercase;letter-spacing:.5px;margin-bottom:2px;}
        #dcad .ch-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px;}
        #dcad .ch-row{display:flex;align-items:center;gap:8px;padding:8px 10px;background:#17181a;border-radius:6px;border:1px solid #2b2d31;}
        #dcad .ch-row:hover{background:#1a1b1e;}
        #dcad .ch-name{flex:1;font-size:13px;color:#dcddde;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
        #dcad .ch-id{font-size:10px;color:#4e5058;font-family:monospace;}
        #dcad .ch-ttl-input{width:80px !important;height:26px !important;font-size:11px !important;}
        #dcad .ch-empty{color:#4e5058;font-size:12px;padding:20px;text-align:center;}
        #dcad .counter-pill{background:#248046;color:#fff;font-size:11px;font-weight:700;padding:2px 10px;border-radius:10px;}
        .dcad-info{color:#00b0f4}.dcad-warn{color:#faa61a}.dcad-error{color:#f04747}.dcad-success{color:#43b581}.dcad-verb{color:#555760}
    `;

    // ── UI ────────────────────────────────────────────────────────────────────
    function initUI() {
        if (!document.getElementById('dcad-styles')) {
            document.head.appendChild(
                Object.assign(document.createElement('style'), { id: 'dcad-styles', textContent: css })
            );
        }

        const panel = document.createElement('div');
        panel.id = 'dcad';
        panel.style.display = 'none';
        panel.innerHTML = `
            <div class="hdr">
                AutoDelete
                <small style="font-weight:normal;color:#949ba4;font-size:12px;margin-left:6px;">expiring messages</small>
                <button id="dcad-close" style="background:transparent;font-size:18px;padding:0 6px;color:#949ba4;margin-left:auto;">x</button>
            </div>
            <div class="tabs">
                <div class="tab active" data-tab="settings">Settings</div>
                <div class="tab" data-tab="channels">Channels</div>
                <div class="tab" data-tab="history">History</div>
                <div class="tab" data-tab="log">Log</div>
            </div>

            <!-- Settings -->
            <div class="tab-panel active" id="tab-settings">
                <div class="section-title">Credentials</div>
                <div class="field-row">
                    <span class="field-label">Auth Token</span>
                    <input type="password" id="dcad-token" placeholder="Paste or use Get">
                    <button id="dcad-get-token">Get</button>
                </div>
                <div class="field-row">
                    <span class="field-label">Author ID</span>
                    <input type="text" id="dcad-author" placeholder="Your user ID">
                    <button id="dcad-get-author">Get</button>
                </div>
                <hr>
                <div class="section-title">Global TTL</div>
                <div class="field-row">
                    <span class="field-label">Seconds</span>
                    <input type="number" id="dcad-global-ttl" min="60" step="60" value="3600">
                    <span style="font-size:11px;color:#949ba4;" id="dcad-ttl-preview">= 1h</span>
                </div>
                <div style="font-size:11px;color:#4e5058;">Applied to all enabled channels unless a per-channel override is set.</div>
                <hr>
                <div class="section-title">Scan interval</div>
                <div class="field-row">
                    <span class="field-label">Seconds</span>
                    <input type="number" id="dcad-scan-interval" min="30" step="30" value="60">
                    <span style="font-size:11px;color:#949ba4;" id="dcad-interval-preview">= 1m</span>
                </div>
                <div style="font-size:11px;color:#4e5058;">How often to scan enabled channels. Lower = faster deletion but more API calls.</div>
                <button id="dcad-save-global" class="success" style="align-self:flex-start;margin-top:4px;">Save settings</button>
                <hr>
                <div class="section-title">Current channel</div>
                <div class="field-row">
                    <span id="dcad-channel-id" style="font-size:11px;color:#4e5058;font-family:monospace;">none</span>
                    <span id="dcad-channel-badge" class="badge off">OFF</span>
                    <button id="dcad-toggle" class="success">Enable</button>
                    <input type="number" class="ch-ttl-input" id="dcad-channel-ttl" min="60" step="60" placeholder="TTL (s)">
                    <span style="font-size:11px;color:#4e5058;">optional override</span>
                </div>
                <div style="font-size:11px;color:#4e5058;margin-top:2px;">
                    The script scans enabled channels on your configured interval and deletes messages older than the TTL.
                </div>
                <hr>
                <div style="display:flex;gap:6px;">
                    <button id="dcad-scan-now" class="success small">Scan now</button>
                </div>
            </div>

            <!-- Channels -->
            <div class="tab-panel" id="tab-channels">
                <div class="section-title">Enabled channels</div>
                <div style="font-size:11px;color:#4e5058;margin-bottom:4px;">
                    Edit TTL or disable any channel without navigating to it.
                    Names are learned when you visit a channel or enable it.
                </div>
                <ul class="ch-list" id="dcad-ch-list"></ul>
                <div class="ch-empty" id="dcad-ch-empty">No channels enabled yet.</div>
                <hr>
                <button id="dcad-disable-all" class="danger small" style="align-self:flex-start;">Disable all</button>
            </div>

            <!-- History -->
            <div class="tab-panel" id="tab-history">
                <div class="section-title">Deleted messages</div>
                <div style="font-size:11px;color:#4e5058;margin-bottom:4px;">Messages deleted this session and from previous sessions (up to 500).</div>
                <ul class="ch-list" id="dcad-hist-list"></ul>
                <div class="ch-empty" id="dcad-hist-empty">No messages deleted yet.</div>
                <hr>
                <button id="dcad-clear-history" class="danger small" style="align-self:flex-start;">Clear history</button>
            </div>

            <!-- Log -->
            <div class="tab-panel" id="tab-log" style="padding:0;flex-grow:1;min-height:0;">
                <div class="log" id="dcad-log" style="flex-grow:1;border-radius:0;min-height:0;">AutoDelete v4.0 loaded.\n</div>
            </div>

            <div class="status-bar">
                <span id="dcad-status">Idle</span>
                <span style="margin-left:auto;display:flex;align-items:center;gap:8px;">
                    <span style="font-size:11px;">Deleted this session:</span>
                    <span class="counter-pill" id="dcad-total">0</span>
                    <span style="font-size:11px;" id="dcad-next-tick">Next scan in 60s</span>
                </span>
            </div>
        `;
        document.body.appendChild(panel);

        const btn = document.createElement('div');
        btn.id = 'dcad-btn';
        btn.title = 'AutoDelete';
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

        const logEl = panel.querySelector('#dcad-log');

        function addLogUI(type, msg) {
            const line = Object.assign(document.createElement('div'), {
                className:   type ? `dcad-${type}` : '',
                textContent: `[${new Date().toLocaleTimeString()}] ${msg}`,
            });
            logEl.appendChild(line);
            while (logEl.children.length > MAX_LOG_DISPLAY) logEl.removeChild(logEl.firstChild);
            logEl.lastElementChild?.scrollIntoView(false);
        }
        // Make addLog available to the tick function
        window._dcadLog = addLogUI;

        function renderChannelList() {
            const list       = panel.querySelector('#dcad-ch-list');
            const empty      = panel.querySelector('#dcad-ch-empty');
            const enabledMap = store.get(KEY_ENABLED, {});
            const ttlMap     = store.get(KEY_CHANNEL_TTL, {});
            const globalTtl  = store.get(KEY_GLOBAL_TTL, 3600);
            const entries    = Object.entries(enabledMap).filter(([, v]) => v);

            list.innerHTML = '';
            if (entries.length === 0) { empty.style.display = ''; return; }
            empty.style.display = 'none';

            for (const [channelId] of entries) {
                const label        = getChannelLabel(channelId);
                const channelTtl   = ttlMap[channelId];
                const effectiveTtl = channelTtl ?? globalTtl;
                const li = document.createElement('li');
                li.className = 'ch-row';
                li.innerHTML = `
                    <div style="display:flex;flex-direction:column;flex:1;min-width:0;">
                        <span class="ch-name" title="${label}">${label}</span>
                        <span class="ch-id">${channelId}</span>
                    </div>
                    <span style="font-size:11px;color:#949ba4;">TTL:</span>
                    <input type="number" class="ch-ttl-input" value="${channelTtl ?? ''}" placeholder="${effectiveTtl}" min="60" step="60" data-id="${channelId}">
                    <span style="font-size:11px;color:#4e5058;white-space:nowrap;">(${formatDuration(effectiveTtl)})</span>
                    <button class="small success ch-ttl-save" data-id="${channelId}">Save</button>
                    <button class="small danger ch-disable" data-id="${channelId}">Disable</button>
                `;
                li.querySelector('.ch-ttl-save').onclick = async () => {
                    const val = parseInt(li.querySelector(`input[data-id="${channelId}"]`).value);
                    const ttl = store.get(KEY_CHANNEL_TTL, {});
                    if (val >= 60) { ttl[channelId] = val; } else { delete ttl[channelId]; }
                    await store.set(KEY_CHANNEL_TTL, ttl);
                    addLogUI('success', `TTL for ${label}: ${val >= 60 ? formatDuration(val) : 'global default'}`);
                    renderChannelList();
                };
                li.querySelector('.ch-disable').onclick = async () => {
                    const em = store.get(KEY_ENABLED, {});
                    em[channelId] = false;
                    await store.set(KEY_ENABLED, em);
                    addLogUI('warn', `AutoDelete disabled for ${label}`);
                    renderChannelList();
                    refreshUI();
                };
                list.appendChild(li);
            }
        }

        function renderHistoryList() {
            const list  = panel.querySelector('#dcad-hist-list');
            const empty = panel.querySelector('#dcad-hist-empty');
            if (!list) return;
            const hist = store.get(KEY_MSG_HISTORY, []);
            list.innerHTML = '';
            if (hist.length === 0) { empty.style.display = ''; return; }
            empty.style.display = 'none';
            for (const entry of hist.slice(0, 200)) {
                const label = getChannelLabel(entry.channelId);
                const li = document.createElement('li');
                li.className = 'ch-row';
                li.style.cssText = 'flex-direction:column;align-items:flex-start;gap:2px;';
                li.innerHTML = `
                    <div style="font-size:12px;color:#dcddde;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;width:100%;">
                        "${entry.content || '[attachment]'}"
                    </div>
                    <div style="font-size:10px;color:#4e5058;">
                        ${label} &nbsp;|&nbsp; ${new Date(entry.deletedAt).toLocaleString()}
                    </div>
                `;
                list.appendChild(li);
            }
            if (hist.length > 200) {
                const li = document.createElement('li');
                li.innerHTML = `<span style="color:#4e5058;font-size:11px;padding:4px 8px;">...and ${hist.length - 200} more</span>`;
                list.appendChild(li);
            }
        }

        function refreshUI(skipSettings) {
            const channelId  = getCurrentChannelId();
            const enabledMap = store.get(KEY_ENABLED, {});
            const ttlMap     = store.get(KEY_CHANNEL_TTL, {});
            const globalTtl  = store.get(KEY_GLOBAL_TTL, 3600);

            if (!skipSettings) {
                panel.querySelector('#dcad-token').value      = store.get(KEY_TOKEN, '');
                panel.querySelector('#dcad-author').value     = store.get(KEY_AUTHOR, '');
                panel.querySelector('#dcad-global-ttl').value = globalTtl;
                panel.querySelector('#dcad-ttl-preview').textContent = `= ${formatDuration(globalTtl)}`;
                const scanSecs = store.get(KEY_SCAN_INTERVAL, DEFAULT_SCAN_INTERVAL);
                panel.querySelector('#dcad-scan-interval').value = scanSecs;
                panel.querySelector('#dcad-interval-preview').textContent = `= ${formatDuration(scanSecs)}`;
            }

            if (channelId) {
                panel.querySelector('#dcad-channel-id').textContent = channelId;
                const isOn  = !!enabledMap[channelId];
                const badge = panel.querySelector('#dcad-channel-badge');
                badge.textContent = isOn ? 'ON' : 'OFF';
                badge.className   = `badge ${isOn ? 'on' : 'off'}`;
                const tog = panel.querySelector('#dcad-toggle');
                tog.textContent = isOn ? 'Disable' : 'Enable';
                tog.className   = isOn ? 'danger' : 'success';
                panel.querySelector('#dcad-channel-ttl').value = ttlMap[channelId] ?? '';
            } else {
                panel.querySelector('#dcad-channel-id').textContent = 'none';
            }

            btn.className = Object.values(enabledMap).some(Boolean) ? 'active' : '';
        }

        // Tabs
        panel.querySelectorAll('.tab').forEach(tab => {
            tab.onclick = () => {
                panel.querySelectorAll('.tab,.tab-panel').forEach(el => el.classList.remove('active'));
                tab.classList.add('active');
                panel.querySelector(`#tab-${tab.dataset.tab}`).classList.add('active');
                if (tab.dataset.tab === 'channels') renderChannelList();
                if (tab.dataset.tab === 'history')  renderHistoryList();
            };
        });

        panel.querySelector('#dcad-close').onclick = () => { panel.style.display = 'none'; };

        panel.querySelector('#dcad-get-token').onclick = async () => {
            try {
                window.dispatchEvent(new Event('beforeunload'));
                const iframe = document.createElement('iframe');
                document.body.appendChild(iframe);
                const token = JSON.parse(iframe.contentWindow.localStorage.token || localStorage.token);
                document.body.removeChild(iframe);
                panel.querySelector('#dcad-token').value = token;
                await store.set(KEY_TOKEN, token);
                addLogUI('success', 'Token saved.');
            } catch { addLogUI('error', 'Could not auto-get token. Paste it manually.'); }
        };

        panel.querySelector('#dcad-get-author').onclick = async () => {
            try {
                let id = null;

                try { id = JSON.parse(localStorage.user_id_cache); } catch {}

                if (!id) {
                    try {
                        const iframe = document.createElement('iframe');
                        document.body.appendChild(iframe);
                        const token = JSON.parse(iframe.contentWindow.localStorage.token || localStorage.token);
                        document.body.removeChild(iframe);
                        const decoded = atob(token.split('.')[0]);
                        if (/^\d+$/.test(decoded)) id = decoded;
                    } catch {}
                }

                if (!id) {
                    try {
                        const wpStore = window.webpackChunkdiscord_app?.push?.([[Symbol()], {}, r => r]);
                        if (wpStore) {
                            const mod = Object.values(wpStore.c || {}).find(m => m?.exports?.default?.getCurrentUser);
                            id = mod?.exports?.default?.getCurrentUser?.()?.id;
                        }
                    } catch {}
                }

                if (id) {
                    panel.querySelector('#dcad-author').value = id;
                    await store.set(KEY_AUTHOR, id);
                    addLogUI('success', `Author ID found: ${id}`);
                } else {
                    addLogUI('error', 'Could not auto-get author ID. Paste it manually.');
                }
            } catch { addLogUI('error', 'Could not auto-get author ID. Paste it manually.'); }
        };

        panel.querySelector('#dcad-global-ttl').oninput = function () {
            panel.querySelector('#dcad-ttl-preview').textContent = `= ${formatDuration(parseInt(this.value) || 0)}`;
        };

        panel.querySelector('#dcad-scan-interval').oninput = function () {
            panel.querySelector('#dcad-interval-preview').textContent = `= ${formatDuration(parseInt(this.value) || 0)}`;
        };

        panel.querySelector('#dcad-save-global').onclick = async () => {
            const token    = panel.querySelector('#dcad-token').value.trim();
            const author   = panel.querySelector('#dcad-author').value.trim();
            const ttl      = parseInt(panel.querySelector('#dcad-global-ttl').value);
            const scanSecs = parseInt(panel.querySelector('#dcad-scan-interval').value);

            // Await each write so GM storage has settled before anything reads back
            if (token)          await store.set(KEY_TOKEN, token);
            if (author)         await store.set(KEY_AUTHOR, author);
            if (ttl >= 60)      await store.set(KEY_GLOBAL_TTL, ttl);
            if (scanSecs >= 30) {
                await store.set(KEY_SCAN_INTERVAL, scanSecs);
                clearInterval(tickInterval);
                tickInterval = setInterval(tick, getTickMs());
                nextTickSecs = getTickMs() / 1000;
            }

            const savedTtl  = ttl >= 60 ? ttl : store.get(KEY_GLOBAL_TTL, 3600);
            const savedScan = scanSecs >= 30 ? scanSecs : store.get(KEY_SCAN_INTERVAL, DEFAULT_SCAN_INTERVAL);
            addLogUI('success', `Saved. TTL: ${formatDuration(savedTtl)}, scan every: ${formatDuration(savedScan)}`);

            // Yield so any remaining async GM writes flush, then refresh non-settings UI only
            await new Promise(r => setTimeout(r, 50));
            refreshUI(true);
        };

        panel.querySelector('#dcad-toggle').onclick = async () => {
            const channelId = getCurrentChannelId();
            if (!channelId) { addLogUI('warn', 'Navigate to a channel first.'); return; }

            const enabledMap      = store.get(KEY_ENABLED, {});
            const ttlMap          = store.get(KEY_CHANNEL_TTL, {});
            const channelTtlInput = parseInt(panel.querySelector('#dcad-channel-ttl').value);
            const nowOn           = !enabledMap[channelId];

            enabledMap[channelId] = nowOn;
            await store.set(KEY_ENABLED, enabledMap);

            if (channelTtlInput >= 60) {
                ttlMap[channelId] = channelTtlInput;
                await store.set(KEY_CHANNEL_TTL, ttlMap);
            }

            // Save channel name from page title
            const names = store.get(KEY_CHANNEL_NAMES, {});
            if (!names[channelId]) {
                const label = document.title?.replace(' | Discord', '').trim() || `Channel ${channelId}`;
                names[channelId] = label;
                await store.set(KEY_CHANNEL_NAMES, names);
            }

            const effectiveTtl = ttlMap[channelId] ?? store.get(KEY_GLOBAL_TTL, 3600);
            addLogUI(nowOn ? 'success' : 'warn',
                nowOn
                    ? `AutoDelete ON for ${getChannelLabel(channelId)} - TTL: ${formatDuration(effectiveTtl)}`
                    : `AutoDelete OFF for ${getChannelLabel(channelId)}`
            );
            refreshUI();
            renderChannelList();
        };

        panel.querySelector('#dcad-disable-all').onclick = async () => {
            if (!window.confirm('Disable AutoDelete for all channels?')) return;
            await store.set(KEY_ENABLED, {});
            addLogUI('warn', 'AutoDelete disabled for all channels.');
            refreshUI();
            renderChannelList();
        };

        panel.querySelector('#dcad-clear-history').onclick = async () => {
            if (!window.confirm('Clear deletion history?')) return;
            await store.set(KEY_MSG_HISTORY, []);
            addLogUI('warn', 'History cleared.');
            renderHistoryList();
        };

        panel.querySelector('#dcad-scan-now').onclick = () => {
            addLogUI('info', 'Manual scan triggered...');
            tick();
        };

        new MutationObserver(refreshUI)
            .observe(document.querySelector('title') || document.head, { childList: true, subtree: true });

        refreshUI();
        addLogUI('info', 'AutoDelete v4.1 ready. Set credentials in Settings, then enable channels.');
    }

    // addLog shim - works before UI is built, routes to UI once it exists
    function addLog(type, msg) { if (window._dcadLog) window._dcadLog(type, msg); }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initUI);
    } else {
        initUI();
    }

})();
