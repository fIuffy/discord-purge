// ==UserScript==
// @name          Discord AutoDelete - Signal-style Expiring Messages
// @description   Automatically deletes your Discord messages after a configurable TTL. Works per-channel.
// @namespace     https://github.com/fIuffy/discord-purge
// @version       3.0
// @match         https://discord.com/*
// @grant         GM_getValue
// @grant         GM_setValue
// @run-at        document-start
// @license       MIT
// ==/UserScript==

/**
 * HOW TO USE:
 * 1. Install Tampermonkey or Violentmonkey
 * 2. Create a new script and paste this file
 * 3. Open Discord - a clock icon appears in the toolbar
 * 4. Click Get next to Auth Token and Author ID, then Save
 * 5. Set a Global TTL in seconds (e.g. 3600 = 1 hour)
 * 6. Enable AutoDelete per-channel from the Channels tab
 *    or navigate to a channel and use the current channel toggle
 */

(function () {
    'use strict';

    const KEY_TOKEN         = 'ad_token';
    const KEY_AUTHOR        = 'ad_authorId';
    const KEY_GLOBAL_TTL    = 'ad_globalTtl';
    const KEY_ENABLED       = 'ad_enabled';
    const KEY_CHANNEL_TTL   = 'ad_channelTtl';
    const KEY_CHANNEL_NAMES = 'ad_channelNames';
    const KEY_MSG_LOG       = 'ad_msgLog';

    const MAX_LOG_DISPLAY  = 300;
    const TICK_INTERVAL_MS = 30_000;

    // ── Storage ───────────────────────────────────────────────────────────────
    const store = {
        get: (key, def) => {
            try { const v = GM_getValue(key); return v === undefined ? def : JSON.parse(v); }
            catch { return def; }
        },
        set: (key, val) => GM_setValue(key, JSON.stringify(val)),
    };

    // ── fetch() hook — installed at document-start before Discord's JS runs ──
    // Uses Object.defineProperty so Discord cannot clobber it by reassigning window.fetch.
    const _origFetch = window.fetch.bind(window);

    Object.defineProperty(window, 'fetch', {
        configurable: true,
        writable: true,
        value: async function hookedFetch(input, init) {
            const url    = typeof input === 'string' ? input : (input instanceof Request ? input.url : '');
            const method = ((init?.method) || (input instanceof Request ? input.method : '') || 'GET').toUpperCase();
            const result = await _origFetch(input, init);

            if (method === 'POST' && url && /\/api\/v\d+\/channels\/(\d+)\/messages$/.test(url) && result.ok) {
                try {
                    const data = await result.clone().json();
                    if (data?.id && data?.channel_id) onMessageSent(data);
                } catch { /* ignore */ }
            }

            return result;
        }
    });

    // ── Keep-alive — stops browser from throttling background tab timers ──────
    const keepAlive = document.createElement('div');
    keepAlive.style.display = 'none';
    document.addEventListener('DOMContentLoaded', () => document.body?.appendChild(keepAlive));
    setInterval(() => keepAlive.classList.toggle('ka'), 10_000);

    // ── API ───────────────────────────────────────────────────────────────────
    const wait = ms => new Promise(r => setTimeout(r, ms));

    async function deleteMessage(authToken, channelId, messageId) {
        let retries = 4;
        while (retries-- > 0) {
            const r = await _origFetch(
                `https://discord.com/api/v9/channels/${channelId}/messages/${messageId}`,
                { method: 'DELETE', headers: { Authorization: authToken } }
            );
            if (r.ok || r.status === 404) return { ok: true, status: r.status };
            if (r.status === 429) {
                let w = 1500;
                try { const j = await r.json(); w = ((j.retry_after ?? 1) * 1000) + 500; } catch {}
                await wait(w);
                continue;
            }
            return { ok: false, status: r.status };
        }
        return { ok: false, status: 'max_retries' };
    }

    // ── Message interceptor ───────────────────────────────────────────────────
    function onMessageSent(msg) {
        const channelId  = msg.channel_id;
        const enabledMap = store.get(KEY_ENABLED, {});
        if (!enabledMap[channelId]) return;

        const ttlMap    = store.get(KEY_CHANNEL_TTL, {});
        const globalTtl = store.get(KEY_GLOBAL_TTL, 3600);
        const ttl       = ttlMap[channelId] ?? globalTtl;

        // Best-effort: save channel name from page title
        const names = store.get(KEY_CHANNEL_NAMES, {});
        if (!names[channelId]) {
            const label = document.title?.replace(' | Discord', '').trim();
            if (label) { names[channelId] = label; store.set(KEY_CHANNEL_NAMES, names); }
        }

        const entry = {
            id:       msg.id,
            channelId,
            content:  (msg.content || '').slice(0, 100),
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
        renderChannelList();
    }

    // ── Ticker ────────────────────────────────────────────────────────────────
    let tickRunning = false;

    async function tick() {
        if (tickRunning) return;
        tickRunning = true;
        try {
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
                    addLog('verb', `Message ${entry.id} already gone.`);
                } else {
                    addLog('warn', `Failed to delete ${entry.id} (${status}), retrying next tick.`);
                    failed.push(entry);
                }
                await wait(700);
            }

            const dueIds    = new Set(due.map(e => e.id));
            const failedIds = new Set(failed.map(e => e.id));
            log = log.filter(e => !dueIds.has(e.id) || failedIds.has(e.id));
            store.set(KEY_MSG_LOG, log);
            refreshPendingCount();
            renderChannelList();
            renderQueueList();
        } finally {
            tickRunning = false;
        }
    }

    setInterval(tick, TICK_INTERVAL_MS);
    setTimeout(tick, 3000);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') tick();
    });

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

    // ── CSS ───────────────────────────────────────────────────────────────────
    const css = `
        #dcad-btn{position:relative;height:24px;width:auto;flex:0 0 auto;margin:0 8px;cursor:pointer;color:#b9bbbe;transition:color .15s;}
        #dcad-btn:hover{color:#fff;}
        #dcad-btn.active{color:#248046;}
        #dcad{position:fixed;top:60px;right:10px;bottom:10px;width:620px;z-index:9999;color:#dcddde;background:#1e1f22;border:1px solid #111214;box-shadow:0 8px 32px rgba(0,0,0,.7);border-radius:8px;display:flex;flex-direction:column;font-family:'gg sans','Noto Sans',sans-serif;}
        #dcad *{box-sizing:border-box;}
        #dcad .hdr{padding:12px 16px;background:#111214;border-radius:8px 8px 0 0;font-weight:700;font-size:14px;color:#fff;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #000;}
        #dcad .tabs{display:flex;background:#17181a;border-bottom:2px solid #111214;}
        #dcad .tab{padding:9px 18px;cursor:pointer;font-size:13px;font-weight:500;color:#949ba4;border-bottom:2px solid transparent;margin-bottom:-2px;user-select:none;transition:color .15s;}
        #dcad .tab:hover{color:#dcddde;}
        #dcad .tab.active{color:#fff;border-bottom-color:#5865f2;}
        #dcad .tab-panel{display:none;padding:12px;flex-direction:column;gap:8px;overflow-y:auto;}
        #dcad .tab-panel.active{display:flex;}
        #dcad input[type=password],#dcad input[type=text],#dcad input[type=number]{background:#111214;color:#dcddde;border:1px solid #2b2d31;border-radius:4px;padding:0 .6em;height:30px;width:180px;margin:2px;outline:none;font-size:13px;transition:border-color .15s;}
        #dcad input[type=password]:focus,#dcad input[type=text]:focus,#dcad input[type=number]:focus{border-color:#5865f2;}
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
        #dcad .pending-pill{background:#5865f2;color:#fff;font-size:10px;font-weight:700;padding:1px 7px;border-radius:10px;margin-left:4px;vertical-align:middle;}
        .dcad-info{color:#00b0f4}.dcad-warn{color:#faa61a}.dcad-error{color:#f04747}.dcad-success{color:#43b581}.dcad-verb{color:#555760}
    `;

    function injectCSS() {
        if (!document.getElementById('dcad-styles')) {
            document.head.appendChild(
                Object.assign(document.createElement('style'), { id: 'dcad-styles', textContent: css })
            );
        }
    }

    // ── UI ────────────────────────────────────────────────────────────────────
    function initUI() {
        injectCSS();

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
                <div class="tab" data-tab="queue">Queue <span class="pending-pill" id="dcad-pending-count">0</span></div>
                <div class="tab" data-tab="log">Log</div>
            </div>

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
                    <input type="number" id="dcad-global-ttl" min="30" step="60" value="3600">
                    <span style="font-size:11px;color:#949ba4;" id="dcad-ttl-preview">= 1h</span>
                </div>
                <div style="font-size:11px;color:#4e5058;">Applied to all enabled channels unless a per-channel override is set.</div>
                <button id="dcad-save-global" class="success" style="align-self:flex-start;margin-top:4px;">Save settings</button>
                <hr>
                <div class="section-title">Current channel</div>
                <div class="field-row">
                    <span id="dcad-channel-id" style="font-size:11px;color:#4e5058;font-family:monospace;">none</span>
                    <span id="dcad-channel-badge" class="badge off">OFF</span>
                    <button id="dcad-toggle" class="success">Enable</button>
                    <input type="number" class="ch-ttl-input" id="dcad-channel-ttl" min="30" step="60" placeholder="TTL (s)">
                    <span style="font-size:11px;color:#4e5058;">optional override</span>
                </div>
            </div>

            <div class="tab-panel" id="tab-channels">
                <div class="section-title">Enabled channels</div>
                <div style="font-size:11px;color:#4e5058;margin-bottom:4px;">Edit TTL or disable any channel without navigating to it. Names are learned when you send a message or visit a channel.</div>
                <ul class="ch-list" id="dcad-ch-list"></ul>
                <div class="ch-empty" id="dcad-ch-empty">No channels enabled yet.</div>
                <hr>
                <button id="dcad-disable-all" class="danger small" style="align-self:flex-start;">Disable all</button>
            </div>

            <div class="tab-panel" id="tab-queue">
                <div class="section-title">Pending deletions</div>
                <div style="font-size:11px;color:#4e5058;margin-bottom:4px;">Messages scheduled for deletion, sorted by time remaining. Checked every 30s.</div>
                <ul class="ch-list" id="dcad-queue-list"></ul>
                <div class="ch-empty" id="dcad-queue-empty">Queue is empty.</div>
                <hr>
                <div style="display:flex;gap:6px;">
                    <button id="dcad-tick-now" class="success small">Run check now</button>
                    <button id="dcad-clear-queue" class="danger small">Clear queue</button>
                </div>
            </div>

            <div class="tab-panel" id="tab-log" style="padding:0;flex-grow:1;min-height:0;">
                <div class="log" id="dcad-log" style="flex-grow:1;border-radius:0;min-height:0;">AutoDelete v3.0 loaded.\n</div>
            </div>

            <div class="status-bar">
                <span id="dcad-status">Idle</span>
                <span style="margin-left:auto;font-size:11px;" id="dcad-next-tick">Next check in 30s</span>
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

        window._dcadLog = function(type, msg) {
            const line = Object.assign(document.createElement('div'), {
                className:   type ? `dcad-${type}` : '',
                textContent: `[${new Date().toLocaleTimeString()}] ${msg}`,
            });
            logEl.appendChild(line);
            while (logEl.children.length > MAX_LOG_DISPLAY) logEl.removeChild(logEl.firstChild);
            logEl.lastElementChild?.scrollIntoView(false);
        };

        window._dcadRefreshPending = function() {
            const count = store.get(KEY_MSG_LOG, []).length;
            panel.querySelector('#dcad-pending-count').textContent = count.toLocaleString();
        };

        window._dcadRenderChannelList = function() {
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
                    <input type="number" class="ch-ttl-input" value="${channelTtl ?? ''}" placeholder="${effectiveTtl}" min="30" step="60" data-id="${channelId}">
                    <span style="font-size:11px;color:#4e5058;white-space:nowrap;">(${formatDuration(effectiveTtl)})</span>
                    <button class="small success ch-ttl-save" data-id="${channelId}">Save</button>
                    <button class="small danger ch-disable" data-id="${channelId}">Disable</button>
                `;
                li.querySelector('.ch-ttl-save').onclick = () => {
                    const val = parseInt(li.querySelector(`input[data-id="${channelId}"]`).value);
                    const ttl = store.get(KEY_CHANNEL_TTL, {});
                    if (val >= 30) { ttl[channelId] = val; } else { delete ttl[channelId]; }
                    store.set(KEY_CHANNEL_TTL, ttl);
                    addLog('success', `TTL for ${label}: ${val >= 30 ? formatDuration(val) : 'global default'}`);
                    window._dcadRenderChannelList();
                };
                li.querySelector('.ch-disable').onclick = () => {
                    const em = store.get(KEY_ENABLED, {});
                    em[channelId] = false;
                    store.set(KEY_ENABLED, em);
                    addLog('warn', `AutoDelete disabled for ${label}`);
                    window._dcadRenderChannelList();
                    refreshUI();
                };
                list.appendChild(li);
            }
        };

        window._dcadRenderQueueList = function() {
            const list  = panel.querySelector('#dcad-queue-list');
            const empty = panel.querySelector('#dcad-queue-empty');
            const log   = store.get(KEY_MSG_LOG, []).slice().sort((a, b) => a.deleteAt - b.deleteAt);

            list.innerHTML = '';
            if (log.length === 0) { empty.style.display = ''; return; }
            empty.style.display = 'none';

            const now = Date.now();
            for (const entry of log.slice(0, 200)) {
                const remaining = Math.max(0, entry.deleteAt - now);
                const label     = getChannelLabel(entry.channelId);
                const li = document.createElement('li');
                li.className = 'ch-row';
                li.style.cssText = 'flex-direction:column;align-items:flex-start;gap:2px;';
                li.innerHTML = `
                    <div style="display:flex;width:100%;align-items:center;gap:8px;">
                        <span style="font-size:12px;color:#dcddde;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">"${entry.content || '[attachment]'}"</span>
                        <span style="font-size:10px;color:${remaining < 60000 ? '#faa61a' : '#4e5058'};white-space:nowrap;">
                            ${remaining < 1000 ? 'deleting soon' : 'in ' + formatDuration(Math.round(remaining / 1000))}
                        </span>
                    </div>
                    <div style="font-size:10px;color:#4e5058;">${label} | msg ${entry.id}</div>
                `;
                list.appendChild(li);
            }
            if (log.length > 200) {
                const li = document.createElement('li');
                li.innerHTML = `<span style="color:#4e5058;font-size:11px;padding:4px 8px;">...and ${log.length - 200} more</span>`;
                list.appendChild(li);
            }
        };

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
            if (window._dcadRefreshPending) window._dcadRefreshPending();
        }
        window._dcadRefreshUI = refreshUI;

        // Tab switching
        panel.querySelectorAll('.tab').forEach(tab => {
            tab.onclick = () => {
                panel.querySelectorAll('.tab,.tab-panel').forEach(el => el.classList.remove('active'));
                tab.classList.add('active');
                panel.querySelector(`#tab-${tab.dataset.tab}`).classList.add('active');
                if (tab.dataset.tab === 'channels') window._dcadRenderChannelList();
                if (tab.dataset.tab === 'queue')    window._dcadRenderQueueList();
            };
        });

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
            if (token)     store.set(KEY_TOKEN, token);
            if (author)    store.set(KEY_AUTHOR, author);
            if (ttl >= 30) store.set(KEY_GLOBAL_TTL, ttl);
            addLog('success', `Saved. Global TTL: ${formatDuration(ttl)}`);
            refreshUI();
        };

        panel.querySelector('#dcad-toggle').onclick = () => {
            const channelId = getCurrentChannelId();
            if (!channelId) { addLog('warn', 'Navigate to a channel first.'); return; }

            const enabledMap      = store.get(KEY_ENABLED, {});
            const ttlMap          = store.get(KEY_CHANNEL_TTL, {});
            const channelTtlInput = parseInt(panel.querySelector('#dcad-channel-ttl').value);
            const nowOn           = !enabledMap[channelId];

            enabledMap[channelId] = nowOn;
            store.set(KEY_ENABLED, enabledMap);

            if (channelTtlInput >= 30) {
                ttlMap[channelId] = channelTtlInput;
                store.set(KEY_CHANNEL_TTL, ttlMap);
            }

            const names = store.get(KEY_CHANNEL_NAMES, {});
            if (!names[channelId]) {
                const label = document.title?.replace(' | Discord', '').trim() || `Channel ${channelId}`;
                names[channelId] = label;
                store.set(KEY_CHANNEL_NAMES, names);
            }

            const effectiveTtl = ttlMap[channelId] ?? store.get(KEY_GLOBAL_TTL, 3600);
            addLog(nowOn ? 'success' : 'warn',
                nowOn
                    ? `AutoDelete ON for ${getChannelLabel(channelId)} - TTL: ${formatDuration(effectiveTtl)}`
                    : `AutoDelete OFF for ${getChannelLabel(channelId)}`
            );
            refreshUI();
            window._dcadRenderChannelList();
        };

        panel.querySelector('#dcad-disable-all').onclick = () => {
            if (!window.confirm('Disable AutoDelete for all channels?')) return;
            store.set(KEY_ENABLED, {});
            addLog('warn', 'AutoDelete disabled for all channels.');
            refreshUI();
            window._dcadRenderChannelList();
        };

        panel.querySelector('#dcad-tick-now').onclick = () => {
            addLog('info', 'Running deletion check manually...');
            tick().then(() => window._dcadRenderQueueList());
        };

        panel.querySelector('#dcad-clear-queue').onclick = () => {
            if (!window.confirm('Clear the pending queue? Messages will NOT be deleted.')) return;
            store.set(KEY_MSG_LOG, []);
            addLog('warn', 'Queue cleared.');
            if (window._dcadRefreshPending) window._dcadRefreshPending();
            window._dcadRenderQueueList();
        };

        new MutationObserver(refreshUI)
            .observe(document.querySelector('title') || document.head, { childList: true, subtree: true });

        refreshUI();
        addLog('info', 'AutoDelete v3.0 ready. Set credentials in Settings, then enable channels.');
    }

    // ── Shims so hook can call UI functions before UI is built ────────────────
    function addLog(type, msg)    { if (window._dcadLog)            window._dcadLog(type, msg); }
    function refreshPendingCount(){ if (window._dcadRefreshPending) window._dcadRefreshPending(); }
    function renderChannelList()  { if (window._dcadRenderChannelList) window._dcadRenderChannelList(); }
    function renderQueueList()    { if (window._dcadRenderQueueList)   window._dcadRenderQueueList(); }

    // ── Countdown ticker in status bar ────────────────────────────────────────
    let nextTickIn = TICK_INTERVAL_MS / 1000;
    setInterval(() => {
        nextTickIn = Math.max(0, nextTickIn - 1);
        const el = document.querySelector('#dcad-next-tick');
        if (el) el.textContent = `Next check in ${nextTickIn}s`;
        if (nextTickIn === 0) nextTickIn = TICK_INTERVAL_MS / 1000;
    }, 1000);

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initUI);
    } else {
        initUI();
    }

})();
