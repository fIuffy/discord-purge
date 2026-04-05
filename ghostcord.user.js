// ==UserScript==
// @name          Ghostcord
// @description   Full account message purge + Signal-style auto-expiring messages. One tool, shared engine.
// @namespace     https://github.com/fIuffy/discord-purge
// @version       1.0
// @match         https://discord.com/*
// @grant         GM_getValue
// @grant         GM_setValue
// @run-at        document-idle
// @license       MIT
// ==/UserScript==

/**
 * GHOSTCORD
 * ─────────
 * Two modes, one panel:
 *
 *   PURGE   — Bulk delete every message your account has ever sent.
 *             Discovers channels via live API + optional data package import.
 *
 *   AUTODELETE — Background daemon that deletes your messages after a
 *                configurable TTL. Per-channel enable/disable with optional
 *                TTL overrides. Runs on a timer, also fires on tab focus.
 *
 * Both modes share: auth, exclusions, deletion engine, and history log.
 *
 * SETUP:
 *   1. Open discord.com, paste into DevTools console (F12) or install via Tampermonkey
 *   2. Click the ghost icon in the toolbar
 *   3. Click Auto-detect to fill credentials
 *   4. Use the Purge or AutoDelete tabs
 */

(function () {
    'use strict';

    // ═══════════════════════════════════════════════════════════════════════════
    // CONFIG
    // ═══════════════════════════════════════════════════════════════════════════

    const API = 'https://discord.com/api/v9';

    const DELETABLE_TYPES = new Set([0, 6, 19, 20, 21]);

    const TEXT_CHANNEL_TYPES = new Set([0, 5, 10, 11, 12, 15, 16]);

    const TIMING = {
        searchDelay: 1500, deleteDelay: 1400, deleteDelayMin: 500,
        deleteDelayMax: 10000, delayIncrement: 150, delayDecrement: -50,
        decrementEvery: 1000, retryMultiplier: 3000, channelGap: 800,
        friendGap: 350, guildGap: 300, resolveGap: 200,
    };

    const DEFAULT_SCAN_INTERVAL = 60;
    const MAX_HISTORY = 500;

    // ═══════════════════════════════════════════════════════════════════════════
    // PERSISTENT STORAGE
    // ═══════════════════════════════════════════════════════════════════════════

    const store = (() => {
        const hasGM = typeof GM_getValue !== 'undefined';
        const mem = {};
        return {
            get(k, def) {
                try {
                    const raw = hasGM ? GM_getValue(k) : mem[k];
                    return raw === undefined ? def : JSON.parse(raw);
                } catch { return def; }
            },
            set(k, v) {
                const s = JSON.stringify(v);
                if (hasGM) GM_setValue(k, s); else mem[k] = s;
            },
        };
    })();

    // Storage keys
    const K = {
        TOKEN: 'gc_token', AUTHOR: 'gc_author',
        EXCLUSIONS: 'gc_exclusions', IMPORTED: 'gc_imported',
        AD_ENABLED: 'gc_ad_enabled', AD_CHANNEL_TTL: 'gc_ad_channelTtl',
        AD_GLOBAL_TTL: 'gc_ad_globalTtl', AD_SCAN_INTERVAL: 'gc_ad_scanInterval',
        AD_CHANNEL_NAMES: 'gc_ad_channelNames', HISTORY: 'gc_history',
        AD_MASTER: 'gc_ad_master', AD_CHANNEL_GUILDS: 'gc_ad_channelGuilds',
        AD_FILTER_MODE: 'gc_ad_filterMode', AD_FILTER_PATTERNS: 'gc_ad_filterPatterns',
    };

    // ── Storage helpers ───────────────────────────────────────────────────────
    const getExclusions  = () => store.get(K.EXCLUSIONS, {});
    const saveExclusions = (v) => store.set(K.EXCLUSIONS, v);
    const isExcluded     = (id) => !!getExclusions()[id];
    const getImported    = () => store.get(K.IMPORTED, {});
    const saveImported   = (v) => store.set(K.IMPORTED, v);

    function addExclusion(id, label) {
        const ex = getExclusions();
        ex[id] = { label, addedAt: new Date().toLocaleString() };
        saveExclusions(ex);
    }
    function removeExclusion(id) {
        const ex = getExclusions();
        delete ex[id];
        saveExclusions(ex);
    }
    function getCurrentChannelId() {
        const m = location.href.match(/channels\/[\w@]+\/(\d+)/);
        return m ? m[1] : null;
    }
    function getChannelLabel(id) {
        const names = store.get(K.AD_CHANNEL_NAMES, {});
        return names[id] || `Channel ${id}`;
    }
    function saveChannelName(id, label) {
        const names = store.get(K.AD_CHANNEL_NAMES, {});
        if (!names[id]) { names[id] = label; store.set(K.AD_CHANNEL_NAMES, names); }
    }

    // ── History ───────────────────────────────────────────────────────────────
    function addHistory(entry) {
        const hist = store.get(K.HISTORY, []);
        hist.unshift(entry);
        if (hist.length > MAX_HISTORY) hist.splice(MAX_HISTORY);
        store.set(K.HISTORY, hist);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // HELPERS
    // ═══════════════════════════════════════════════════════════════════════════

    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const authHeaders = (t) => ({ Authorization: t });

    function extractHit(entry) {
        if (!entry) return null;
        if (Array.isArray(entry)) return entry.find((m) => m.hit) || entry[0] || null;
        if (typeof entry === 'object' && entry.id) return entry;
        return null;
    }

    function formatDuration(seconds) {
        if (!seconds || seconds < 0) return '?';
        if (seconds < 60) return `${seconds}s`;
        if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
        if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`;
        return `${(seconds / 86400).toFixed(1)}d`;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // TOKEN CAPTURE — PASSIVE FETCH/XHR INTERCEPTION
    // ═══════════════════════════════════════════════════════════════════════════

    function interceptToken(timeoutMs = 10000) {
        return new Promise((resolve, reject) => {
            const orig = window.fetch;
            let done = false;
            const timer = setTimeout(() => {
                if (!done) { done = true; window.fetch = orig; reject(new Error('Timed out. Click around in Discord to trigger API traffic, then retry.')); }
            }, timeoutMs);
            window.fetch = function (...args) {
                if (!done) {
                    let auth = null;
                    const [input, init] = args;
                    if (init?.headers) {
                        if (init.headers instanceof Headers) auth = init.headers.get('Authorization');
                        else if (Array.isArray(init.headers)) { const p = init.headers.find(([k]) => k.toLowerCase() === 'authorization'); if (p) auth = p[1]; }
                        else if (typeof init.headers === 'object') { for (const [k, v] of Object.entries(init.headers)) { if (k.toLowerCase() === 'authorization') { auth = v; break; } } }
                    }
                    if (!auth && input instanceof Request) auth = input.headers.get('Authorization');
                    if (auth && auth.length > 20 && !auth.startsWith('Bot ')) { done = true; clearTimeout(timer); window.fetch = orig; resolve(auth); }
                }
                return orig.apply(this, args);
            };
        });
    }

    function interceptTokenXHR(timeoutMs = 10000) {
        return new Promise((resolve, reject) => {
            const origSet = XMLHttpRequest.prototype.setRequestHeader;
            let done = false;
            const timer = setTimeout(() => { if (!done) { done = true; XMLHttpRequest.prototype.setRequestHeader = origSet; reject(new Error('XHR timeout.')); } }, timeoutMs);
            XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
                if (!done && name.toLowerCase() === 'authorization' && value?.length > 20 && !value.startsWith('Bot ')) {
                    done = true; clearTimeout(timer); XMLHttpRequest.prototype.setRequestHeader = origSet; resolve(value);
                }
                return origSet.call(this, name, value);
            };
        });
    }

    async function captureToken(timeoutMs = 10000) {
        try { return await Promise.any([interceptToken(timeoutMs), interceptTokenXHR(timeoutMs)]); }
        catch { throw new Error('Could not capture token. Click around in Discord, then retry.'); }
    }

    async function verifyAuth(token) {
        try {
            const r = await fetch(`${API}/users/@me`, { headers: authHeaders(token) });
            if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
            return { ok: true, user: await r.json() };
        } catch (e) { return { ok: false, error: e.message }; }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // CHANNEL DISCOVERY (purge)
    // ═══════════════════════════════════════════════════════════════════════════

    async function discoverChannels(token, logFn) {
        const headers = authHeaders(token);
        const channels = [], seen = new Set();
        const push = (ch) => { if (!seen.has(ch.channelId)) { seen.add(ch.channelId); channels.push(ch); } };

        logFn('info', 'Scanning open DMs…');
        try {
            const r = await fetch(`${API}/users/@me/channels`, { headers });
            if (r.ok) { const dms = await r.json(); for (const dm of dms) push({ guildId: '@me', channelId: dm.id, label: dm.name || dm.recipients?.map(u => u.username).join(', ') || 'DM', source: 'live' }); logFn('success', `  ${dms.length} open DM(s).`); }
        } catch (e) { logFn('warn', `  DM fetch failed: ${e.message}`); }

        logFn('info', 'Scanning friends list…');
        try {
            const r = await fetch(`${API}/users/@me/relationships`, { headers });
            if (r.ok) {
                const friends = (await r.json()).filter(rel => rel.type === 1);
                let disc = 0;
                for (const f of friends) {
                    const fid = f.id ?? f.user?.id, fname = f.user?.username ?? f.user?.global_name ?? fid;
                    if (!fid) continue;
                    let att = 3;
                    while (att-- > 0) {
                        try {
                            const dr = await fetch(`${API}/users/@me/channels`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ recipient_id: fid }) });
                            if (dr.status === 429) { let ra = 1000; try { const j = await dr.json(); ra = ((j.retry_after ?? 1) * 1000) + 500; } catch {} await wait(ra); continue; }
                            if (dr.ok) { const dm = await dr.json(); if (dm?.id) { const b = seen.size; push({ guildId: '@me', channelId: dm.id, label: `DM: ${fname}`, source: 'live' }); if (seen.size > b) disc++; } }
                            break;
                        } catch { break; }
                    }
                    await wait(TIMING.friendGap);
                }
                logFn('success', `  ${disc} additional DM(s) from friends.`);
            }
        } catch (e) { logFn('warn', `  Friends list failed: ${e.message}`); }

        logFn('info', 'Scanning servers…');
        try {
            const r = await fetch(`${API}/users/@me/guilds`, { headers });
            if (r.ok) {
                const guilds = await r.json();
                for (const g of guilds) {
                    try { const cr = await fetch(`${API}/guilds/${g.id}/channels`, { headers }); if (cr.ok) { (await cr.json()).filter(c => TEXT_CHANNEL_TYPES.has(c.type)).forEach(ch => push({ guildId: g.id, channelId: ch.id, label: `${g.name} → #${ch.name}`, source: 'live' })); } } catch {}
                    try { const tr = await fetch(`${API}/guilds/${g.id}/threads/active`, { headers }); if (tr.ok) { ((await tr.json()).threads || []).forEach(t => push({ guildId: g.id, channelId: t.id, label: `${g.name} → 🧵 ${t.name}`, source: 'live' })); } } catch {}
                    await wait(TIMING.guildGap);
                }
                logFn('success', `  Scanned ${guilds.length} server(s).`);
            }
        } catch (e) { logFn('warn', `  Guild fetch failed: ${e.message}`); }

        return channels;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // DATA PACKAGE PARSING
    // ═══════════════════════════════════════════════════════════════════════════

    async function parseDataPackage(file) {
        if (file.name.endsWith('.zip')) return parseZip(file);
        return parseIndexJson(file);
    }
    async function parseIndexJson(file) {
        const json = JSON.parse(await file.text()), result = {};
        for (const [id, val] of Object.entries(json)) result[id] = typeof val === 'string' ? val : (val.name || `Channel ${id}`);
        return result;
    }
    async function parseZip(file) {
        if (!window.fflate) await new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'https://cdn.jsdelivr.net/npm/fflate@0.8.2/umd/index.js'; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
        const unzipped = window.fflate.unzipSync(new Uint8Array(await file.arrayBuffer()));
        const key = Object.keys(unzipped).find(k => k.match(/messages[/\\]index\.json$/i));
        if (!key) throw new Error('Could not find messages/index.json in zip.');
        return parseIndexJson(new Blob([unzipped[key]]));
    }
    async function resolveGuildId(token, channelId) {
        try { const r = await fetch(`${API}/channels/${channelId}`, { headers: authHeaders(token) }); if (!r.ok) return '@me'; const d = await r.json(); if (d.type === 1 || d.type === 3) return '@me'; return d.guild_id || '@me'; } catch { return '@me'; }
    }
    function mergeChannels(live, importedMap) {
        const seen = new Set(live.map(c => c.channelId)), merged = [...live];
        for (const [id, label] of Object.entries(importedMap)) { if (!seen.has(id)) { merged.push({ guildId: null, channelId: id, label: `[imported] ${label}`, source: 'import' }); seen.add(id); } }
        return merged;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // SHARED DELETION ENGINE
    // ═══════════════════════════════════════════════════════════════════════════
    //
    // cutoffTs: if set, only delete messages older than this timestamp (autodelete mode)
    //           if null, delete all messages by author (purge mode)

    async function deleteInChannel(token, authorId, guildId, channelId, ctrl) {
        const { logFn, onDelete, shouldStop, debugMode, cutoffTs } = ctrl;
        const headers = authHeaders(token);
        let deleteDelay = TIMING.deleteDelay, delCount = 0, failCount = 0, offset = 0, grandTotal = null;

        async function search() {
            if (shouldStop()) return;
            const base = guildId === '@me' ? `${API}/channels/${channelId}/messages/search` : `${API}/guilds/${guildId}/messages/search`;
            const params = new URLSearchParams({ author_id: authorId, sort_by: 'timestamp', sort_order: 'desc', offset: String(offset) });
            if (guildId !== '@me') params.set('channel_id', channelId);

            let resp;
            try { resp = await fetch(`${base}?${params}`, { headers }); } catch (e) { logFn('error', `Search error: ${e.message}`); return; }

            if (resp.status === 202) { const b = await resp.json(); await wait(b.retry_after || 2000); return search(); }
            if (resp.status === 429) { const b = await resp.json(); const w = (b.retry_after || 1) * TIMING.retryMultiplier; logFn('warn', `Rate limited, cooling ${Math.round(w)}ms…`); await wait(w); return search(); }
            if (resp.status === 403) { logFn('warn', `No access to ${channelId}, skipping.`); return; }
            if (!resp.ok) { logFn('error', `Search failed: HTTP ${resp.status}`); return; }

            const data = await resp.json();
            if (debugMode && grandTotal === null) {
                logFn('verb', `Search: total=${data.total_results}, msgs=${data.messages?.length}, isArr=${Array.isArray(data.messages?.[0])}`);
                const s = extractHit(data.messages?.[0]); if (s) logFn('verb', `Sample: id=${s.id}, type=${s.type}, author=${s.author?.id}`);
            }

            if (grandTotal === null) grandTotal = data.total_results || 0;
            if (!data.messages?.length) {
                if ((data.total_results || 0) - offset > 0) { offset += 25; await wait(TIMING.searchDelay); return search(); }
                logFn('success', `Channel done — deleted: ${delCount}, failed: ${failCount}`); return;
            }

            const hits = data.messages.map(extractHit).filter(Boolean);
            // Two-stage filter: cutoff first (drives early-exit logic), then content filter
            const passedCutoff = hits.filter(m => {
                if (m.author?.id !== authorId) return false;
                if (!DELETABLE_TYPES.has(m.type)) return false;
                if (cutoffTs !== null && cutoffTs !== undefined) {
                    const msgTs = new Date(m.timestamp).getTime();
                    if (msgTs >= cutoffTs) return false; // not expired yet
                }
                return true;
            });
            const toDelete = ctrl.filterFn ? passedCutoff.filter(ctrl.filterFn) : passedCutoff;
            const skipped = hits.length - toDelete.length;

            if (toDelete.length === 0) {
                // In autodelete mode, only stop early if the CUTOFF eliminated everything.
                // If content filter excluded them, keep paging — older messages may still match.
                if (cutoffTs !== null && passedCutoff.length === 0) { logFn('success', `Channel done — deleted: ${delCount}, failed: ${failCount}`); return; }
                if ((data.total_results || 0) - offset > 0) { offset += skipped || 25; await wait(TIMING.searchDelay); return search(); }
                logFn('success', `Channel done — deleted: ${delCount}, failed: ${failCount}`); return;
            }

            for (let j = 0; j < toDelete.length; j++) {
                if (shouldStop()) { logFn('warn', 'Stopped.'); return; }
                const msg = toDelete[j];
                const ts = new Date(msg.timestamp).toLocaleString();
                const preview = (msg.content || '').substring(0, 50);
                logFn('info', `Deleting ${msg.id} (${ts}) ${preview ? `"${preview}…"` : '[no text]'}`);

                if (delCount > 0 && delCount % TIMING.decrementEvery === 0) deleteDelay = Math.max(TIMING.deleteDelayMin, deleteDelay + TIMING.delayDecrement);

                try {
                    const dr = await fetch(`${API}/channels/${msg.channel_id}/messages/${msg.id}`, { headers, method: 'DELETE' });
                    if (dr.ok || dr.status === 204) {
                        delCount++;
                        onDelete(msg);
                    } else if (dr.status === 429) {
                        const b = await dr.json(); const w = (b.retry_after || 1) * TIMING.retryMultiplier;
                        deleteDelay = Math.min(TIMING.deleteDelayMax, deleteDelay + TIMING.delayIncrement);
                        logFn('warn', `Rate limited on delete, cooling ${Math.round(w)}ms`);
                        await wait(w); j--; continue;
                    } else if ([400, 403, 404].includes(dr.status)) {
                        logFn('warn', `Cannot delete ${msg.id} (HTTP ${dr.status}), skipping.`);
                        offset++; failCount++;
                    } else { logFn('error', `Delete error HTTP ${dr.status}`); failCount++; }
                } catch (e) { logFn('error', `Delete threw: ${e.message}`); failCount++; }
                await wait(deleteDelay);
            }

            if (skipped > 0) { offset += skipped; if (grandTotal > 0) grandTotal = Math.max(0, grandTotal - skipped); }
            logFn('verb', `Next search in ${TIMING.searchDelay}ms (offset: ${offset})…`);
            await wait(TIMING.searchDelay);
            return search();
        }
        return search();
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // AUTODELETE DAEMON
    // ═══════════════════════════════════════════════════════════════════════════

    function getCurrentGuildId() {
        const m = location.href.match(/channels\/([\w@]+)\/\d+/);
        return m ? m[1] : '@me';
    }

    let adTickRunning = false;
    let adSessionDeleted = 0;

    async function adTick() {
        if (!store.get(K.AD_MASTER, true)) return;
        if (adTickRunning) return;
        const token = store.get(K.TOKEN, '');
        const authorId = store.get(K.AUTHOR, '');
        if (!token || !authorId) return;

        const enabled = store.get(K.AD_ENABLED, {});
        const channels = Object.entries(enabled).filter(([, v]) => v).map(([id]) => id);
        if (channels.length === 0) return;

        const exclusions = getExclusions();

        adTickRunning = true;
        updateAdStatus('Scanning…');

        const filterMode = store.get(K.AD_FILTER_MODE, 'all');
        const filterPatterns = store.get(K.AD_FILTER_PATTERNS, []);
        let filterFn = null;
        if (filterMode !== 'all' && filterPatterns.length > 0) {
            filterFn = (msg) => {
                const content = (msg.content || '').toLowerCase();
                const matches = filterPatterns.some(p => content.includes(p.toLowerCase()));
                return filterMode === 'whitelist' ? matches : !matches;
            };
        }

        try {
            for (const channelId of channels) {
                if (exclusions[channelId]) continue;
                const ttlMap = store.get(K.AD_CHANNEL_TTL, {});
                const globalTtl = store.get(K.AD_GLOBAL_TTL, 3600);
                const ttl = (ttlMap[channelId] ?? globalTtl) * 1000;
                const cutoff = Date.now() - ttl;

                updateAdStatus(`Scanning ${getChannelLabel(channelId)}…`);

                const guildMap = store.get(K.AD_CHANNEL_GUILDS, {});
                const guildId = guildMap[channelId] || '@me';
                await deleteInChannel(token, authorId, guildId, channelId, {
                    logFn: addLog,
                    debugMode: false,
                    cutoffTs: cutoff,
                    filterFn,
                    shouldStop: () => false,
                    onDelete: (msg) => {
                        adSessionDeleted++;
                        updateAdCounter();
                        addHistory({
                            id: msg.id, channelId, mode: 'autodelete',
                            content: (msg.content || '').slice(0, 100),
                            deletedAt: Date.now(),
                        });
                    },
                });
                await wait(500);
            }
        } finally {
            adTickRunning = false;
            updateAdStatus('Idle');
            adNextTickSecs = getAdTickMs() / 1000;
        }
    }

    function getAdTickMs() { return store.get(K.AD_SCAN_INTERVAL, DEFAULT_SCAN_INTERVAL) * 1000; }
    let adNextTickSecs = getAdTickMs() / 1000;
    let adInterval = setInterval(adTick, getAdTickMs());
    setTimeout(adTick, 4000);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') adTick(); });
    setInterval(() => {
        const masterOn = store.get(K.AD_MASTER, true);
        if (masterOn) adNextTickSecs = Math.max(0, adNextTickSecs - 1);
        const el = document.querySelector('#gc-ad-next');
        if (el) {
            if (!masterOn) el.textContent = 'AutoDelete paused';
            else el.textContent = adTickRunning ? 'Scanning…' : `Next scan in ${adNextTickSecs}s`;
        }
        if (masterOn && adNextTickSecs === 0 && !adTickRunning) adNextTickSecs = getAdTickMs() / 1000;
    }, 1000);

    function updateAdStatus(t) { const el = document.querySelector('#gc-ad-next'); if (el) el.textContent = t; }
    function updateAdCounter() { const el = document.querySelector('#gc-ad-counter'); if (el) el.textContent = adSessionDeleted.toLocaleString(); }

    // Keep-alive to prevent throttling in background tabs
    const keepAlive = document.createElement('div');
    keepAlive.style.display = 'none';
    document.body.appendChild(keepAlive);
    setInterval(() => keepAlive.classList.toggle('ka'), 10000);

    // ═══════════════════════════════════════════════════════════════════════════
    // CSS
    // ═══════════════════════════════════════════════════════════════════════════

    const CSS = `
        #gc-btn{position:relative;height:24px;width:auto;flex:0 0 auto;margin:0 8px;cursor:pointer;color:#b9bbbe;transition:color .15s;}
        #gc-btn:hover{color:#fff;}
        #gc-btn.active{color:#248046;}
        #gc{position:fixed;top:60px;right:10px;bottom:10px;width:900px;z-index:9999;color:#dcddde;background:#1e1f22;border:1px solid #111214;box-shadow:0 8px 32px rgba(0,0,0,.7);border-radius:8px;display:flex;flex-direction:column;font-family:'gg sans','Noto Sans',sans-serif;}
        #gc *{box-sizing:border-box;}
        #gc .hdr{padding:12px 16px;background:#111214;border-radius:8px 8px 0 0;font-weight:700;font-size:14px;color:#fff;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #000;}
        #gc .ver{font-size:11px;color:#4e5058;font-weight:400;margin-left:8px;}
        #gc .tabs{display:flex;background:#17181a;border-bottom:2px solid #111214;flex-wrap:wrap;}
        #gc .tab{padding:9px 14px;cursor:pointer;font-size:13px;font-weight:500;color:#949ba4;border-bottom:2px solid transparent;margin-bottom:-2px;user-select:none;transition:color .15s;}
        #gc .tab:hover{color:#dcddde;}
        #gc .tab.active{color:#fff;border-bottom-color:#5865f2;}
        #gc .tp{display:none;padding:12px;flex-direction:column;gap:8px;background:#1e1f22;}
        #gc .tp.active{display:flex;flex:0 0 auto;overflow-y:auto;max-height:55vh;}
        #gc input[type=password],#gc input[type=text],#gc input[type=number]{background:#111214;color:#dcddde;border:1px solid #2b2d31;border-radius:4px;padding:0 .6em;height:30px;width:200px;margin:2px;outline:none;font-size:13px;transition:border-color .15s;}
        #gc input[type=number]{width:90px;}
        #gc input:focus{border-color:#5865f2;}
        #gc input::placeholder{color:#4e5058;}
        #gc button{color:#fff;background:#5865f2;border:0;border-radius:4px;padding:5px 14px;margin:2px;cursor:pointer;font-size:13px;font-weight:500;transition:filter .15s;}
        #gc button:hover{filter:brightness(1.1);}
        #gc button.danger{background:#c03537;}
        #gc button.success{background:#248046;}
        #gc button.muted{background:#383a40;}
        #gc button.sm{padding:3px 10px;font-size:11px;}
        #gc button:disabled{opacity:.35;cursor:not-allowed;filter:none;}
        #gc .log{overflow:auto;font-size:.72rem;font-family:Consolas,'Courier New',monospace;flex:1 1 0;min-height:120px;padding:10px 12px;white-space:pre-wrap;background:#111214;color:#c7cad1;border-top:1px solid #2b2d31;}
        #gc .sbar{padding:7px 14px;background:#111214;border-radius:0 0 8px 8px;border-top:1px solid #000;font-size:12px;color:#949ba4;display:flex;gap:14px;align-items:center;flex-wrap:wrap;}
        #gc progress{width:140px;height:6px;border-radius:3px;border:none;background:#2b2d31;vertical-align:middle;}
        #gc progress::-webkit-progress-bar{background:#2b2d31;border-radius:3px;}
        #gc progress::-webkit-progress-value{background:#5865f2;border-radius:3px;}
        #gc .pill{background:#248046;color:#fff;font-size:11px;font-weight:700;padding:2px 10px;border-radius:10px;letter-spacing:.3px;}
        #gc .pill.active{background:#5865f2;}
        #gc .ch-list{list-style:none;margin:4px 0 0;padding:0;overflow-y:auto;max-height:220px;}
        #gc .ch-list li{display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:4px;font-size:12px;}
        #gc .ch-list li:hover{background:#2b2d31;}
        #gc .ch-label{flex:1;color:#dcddde;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
        #gc .ch-id{color:#4e5058;font-size:10px;font-family:monospace;}
        #gc .ch-date{color:#4e5058;font-size:10px;white-space:nowrap;}
        #gc .ch-empty{color:#4e5058;font-size:12px;padding:20px;text-align:center;}
        #gc .add-row{display:flex;gap:6px;align-items:center;flex-wrap:wrap;}
        #gc .badge{display:inline-block;color:#fff;border-radius:8px;font-size:10px;font-weight:700;padding:1px 6px;margin-left:4px;vertical-align:middle;}
        #gc .badge.red{background:#c03537;}
        #gc .badge.green{background:#248046;}
        #gc .drop-zone{border:2px dashed #2b2d31;border-radius:6px;padding:24px;text-align:center;color:#949ba4;font-size:13px;cursor:pointer;background:#17181a;transition:border-color .2s,background .2s;}
        #gc .drop-zone:hover,#gc .drop-zone.drag-over{border-color:#5865f2;background:#1e1f2e;color:#dcddde;}
        #gc .drop-zone input[type=file]{display:none;}
        #gc .import-stats{background:#17181a;border:1px solid #2b2d31;border-radius:4px;padding:8px 12px;font-size:12px;color:#b5bac1;}
        #gc code{background:#111214;border-radius:3px;padding:1px 5px;font-size:11px;color:#b5bac1;}
        #gc .auth-ok{color:#43b581;font-size:12px;}
        #gc .auth-fail{color:#f04747;font-size:12px;}
        #gc .auth-wait{color:#faa61a;font-size:12px;}
        #gc hr{border:none;border-top:1px solid #2b2d31;margin:4px 0;}
        #gc .fl{font-size:11px;color:#949ba4;min-width:80px;}
        #gc .fr{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
        #gc .section{font-size:11px;font-weight:700;color:#949ba4;text-transform:uppercase;letter-spacing:.5px;margin-bottom:2px;}
        #gc .ch-row{display:flex;align-items:center;gap:8px;padding:8px 10px;background:#17181a;border-radius:6px;border:1px solid #2b2d31;}
        #gc .ch-row:hover{background:#1a1b1e;}
        #gc .ch-name{flex:1;font-size:13px;color:#dcddde;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
        #gc .badge-on{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:700;background:#248046;color:#fff;}
        #gc .badge-off{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:700;background:#383a40;color:#949ba4;}
        #gc .mode-slider{display:flex;background:#111214;border-radius:6px;padding:2px;gap:2px;align-self:flex-start;}
        #gc .mode-btn{flex:1;padding:5px 14px;font-size:12px;font-weight:500;border-radius:4px;background:transparent;color:#949ba4;border:none;cursor:pointer;transition:background .15s,color .15s;}
        #gc .mode-btn.active{background:#5865f2;color:#fff;}
        #gc .mode-btn:hover:not(.active){background:#2b2d31;color:#dcddde;}
        .gc-info{color:#00b0f4}.gc-warn{color:#faa61a}.gc-error{color:#f04747}.gc-success{color:#43b581}.gc-verb{color:#555760}
        @keyframes gc-spin{to{transform:rotate(360deg)}}
        #gc .spinner{display:inline-block;width:12px;height:12px;border:2px solid #4e5058;border-top-color:#5865f2;border-radius:50%;animation:gc-spin .6s linear infinite;vertical-align:middle;margin-right:6px;}
    `;
    document.head.appendChild(Object.assign(document.createElement('style'), { textContent: CSS }));

    // ═══════════════════════════════════════════════════════════════════════════
    // UI
    // ═══════════════════════════════════════════════════════════════════════════

    const panel = document.createElement('div');
    panel.id = 'gc';
    panel.style.display = 'none';
    panel.innerHTML = `
        <div class="hdr">
            👻 Ghostcord <span class="ver">v1.0</span>
            <button id="gc-close" style="background:transparent;font-size:18px;padding:0 6px;">✕</button>
        </div>
        <div class="tabs">
            <div class="tab active" data-tab="auth">Auth</div>
            <div class="tab" data-tab="purge">Purge</div>
            <div class="tab" data-tab="autodelete">AutoDelete</div>
            <div class="tab" data-tab="ad-channels">Channels <span class="badge green" id="gc-ad-ch-badge" style="display:none;"></span></div>
            <div class="tab" data-tab="history">History</div>
            <div class="tab" data-tab="import">Import <span class="badge green" id="gc-import-badge" style="display:none;"></span></div>
            <div class="tab" data-tab="exclusions">Exclusions <span class="badge red" id="gc-ex-badge" style="display:none;"></span></div>
        </div>

        <!-- AUTH -->
        <div class="tp active" id="tab-auth">
            <div style="font-size:12px;color:#72767d;">Shared credentials for both Purge and AutoDelete modes.</div>
            <div class="fr">
                <div>
                    <div style="font-size:12px;color:#72767d;margin-bottom:2px;">Auth Token</div>
                    <input type="password" id="gc-token" placeholder="Auto-detected or paste">
                </div>
                <div>
                    <div style="font-size:12px;color:#72767d;margin-bottom:2px;">Author ID</div>
                    <input type="text" id="gc-author" placeholder="Auto-detected" readonly>
                </div>
                <button id="gc-autodetect" class="success" style="height:30px;">🔑 Auto-detect</button>
            </div>
            <div id="gc-auth-status"></div>
            <div style="font-size:11px;color:#4e5058;margin-top:4px;">Auto-detect passively listens for Discord's own API traffic to capture your token. No extra requests sent. Credentials are saved for AutoDelete persistence.</div>
        </div>

        <!-- PURGE -->
        <div class="tp" id="tab-purge">
            <div id="gc-source-summary" style="font-size:12px;color:#72767d;"></div>
            <div style="font-size:12px;color:#faa61a;">⚠️ Deletes ALL your messages everywhere except excluded channels. Irreversible.</div>
            <div class="fr">
                <button class="success" id="gc-start">▶ Start Full Purge</button>
                <button class="danger" id="gc-stop" disabled>⏹ Stop</button>
                <button id="gc-clear-log">Clear Log</button>
                <label style="font-size:12px;display:flex;align-items:center;gap:4px;"><input type="checkbox" id="gc-autoscroll" checked> Auto-scroll</label>
                <label style="font-size:12px;display:flex;align-items:center;gap:4px;"><input type="checkbox" id="gc-debug"> Debug</label>
            </div>
        </div>

        <!-- AUTODELETE -->
        <div class="tp" id="tab-autodelete">
            <div class="fr" style="justify-content:space-between;align-items:center;">
                <div style="display:flex;align-items:center;gap:8px;">
                    <span class="section" style="margin:0;">AutoDelete Daemon</span>
                    <span id="gc-ad-master-badge" class="badge-on">RUNNING</span>
                </div>
                <button id="gc-ad-master-toggle" class="danger sm">Pause</button>
            </div>
            <hr>
            <div class="section">Global TTL</div>
            <div class="fr">
                <span class="fl">Seconds</span>
                <input type="number" id="gc-ad-ttl" min="60" step="60" value="3600">
                <span style="font-size:11px;color:#949ba4;" id="gc-ad-ttl-preview">= 1h</span>
            </div>
            <div style="font-size:11px;color:#4e5058;">Messages older than this are deleted. Per-channel overrides available in the Channels tab.</div>
            <hr>
            <div class="section">Scan interval</div>
            <div class="fr">
                <span class="fl">Seconds</span>
                <input type="number" id="gc-ad-interval" min="30" step="30" value="60">
                <span style="font-size:11px;color:#949ba4;" id="gc-ad-interval-preview">= 1m</span>
            </div>
            <div style="font-size:11px;color:#4e5058;">How often to check enabled channels. Lower = faster, but more API calls.</div>
            <hr>
            <button id="gc-ad-save" class="success" style="align-self:flex-start;">Save settings</button>
            <hr>
            <div class="section">Current channel</div>
            <div class="fr">
                <span id="gc-ad-ch-id" style="font-size:11px;color:#4e5058;font-family:monospace;">none</span>
                <span id="gc-ad-ch-badge-inline" class="badge-off">OFF</span>
                <button id="gc-ad-toggle" class="success">Enable</button>
                <input type="number" id="gc-ad-ch-ttl" min="60" step="60" placeholder="TTL override" style="width:110px;">
            </div>
            <hr>
            <div class="fr">
                <button id="gc-ad-scan-now" class="success sm">Scan now</button>
            </div>
            <hr>
            <div class="section">Message filter</div>
            <div style="font-size:11px;color:#4e5058;margin-bottom:6px;"><b>All</b> — delete any message past TTL &nbsp;·&nbsp; <b>Whitelist</b> — only delete messages containing a keyword &nbsp;·&nbsp; <b>Blacklist</b> — delete all except messages containing a keyword</div>
            <div class="mode-slider" id="gc-ad-filter-slider">
                <button class="mode-btn active" data-mode="all">All</button>
                <button class="mode-btn" data-mode="whitelist">Whitelist</button>
                <button class="mode-btn" data-mode="blacklist">Blacklist</button>
            </div>
            <div id="gc-ad-filter-patterns" style="display:none;">
                <div class="add-row" style="margin-top:6px;">
                    <input type="text" id="gc-ad-filter-input" placeholder="Keyword or phrase" style="flex:1;width:auto;max-width:260px;">
                    <button id="gc-ad-filter-add" class="sm success">Add</button>
                </div>
                <ul class="ch-list" id="gc-ad-filter-list" style="max-height:150px;margin-top:4px;"></ul>
                <div class="ch-empty" id="gc-ad-filter-empty" style="font-size:11px;color:#4e5058;padding:8px 0;">No keywords yet — all messages past TTL will be skipped.</div>
            </div>
        </div>

        <!-- AD CHANNELS -->
        <div class="tp" id="tab-ad-channels">
            <div class="section">Enabled channels</div>
            <div style="font-size:11px;color:#4e5058;margin-bottom:4px;">Edit TTL or disable without navigating. Names learned on visit.</div>
            <ul class="ch-list" id="gc-ad-ch-list" style="max-height:340px;"></ul>
            <div class="ch-empty" id="gc-ad-ch-empty">No channels enabled yet.</div>
            <hr>
            <button id="gc-ad-disable-all" class="danger sm">Disable all</button>
        </div>

        <!-- HISTORY -->
        <div class="tp" id="tab-history">
            <div class="section">Deletion history</div>
            <div style="font-size:11px;color:#4e5058;margin-bottom:4px;">Both Purge and AutoDelete deletions. Persists across sessions (up to ${MAX_HISTORY}).</div>
            <ul class="ch-list" id="gc-hist-list" style="max-height:340px;"></ul>
            <div class="ch-empty" id="gc-hist-empty">No deletions recorded yet.</div>
            <hr>
            <button id="gc-hist-clear" class="danger sm">Clear history</button>
        </div>

        <!-- IMPORT -->
        <div class="tp" id="tab-import">
            <div style="font-size:12px;color:#72767d;">Import your Discord data package for full purge coverage.</div>
            <div class="drop-zone" id="gc-drop-zone">
                <input type="file" id="gc-file-input" accept=".json,.zip">
                <div style="font-size:28px;margin-bottom:8px;">📦</div>
                <div><strong>Drop your file here</strong> or <span style="color:#5865f2;text-decoration:underline;cursor:pointer;" id="gc-browse">browse</span></div>
                <div style="font-size:11px;margin-top:6px;">Accepts <code>messages/index.json</code> or full <code>package.zip</code></div>
            </div>
            <div class="import-stats" id="gc-import-stats" style="display:none;"></div>
            <button id="gc-import-clear" class="danger" style="display:none;">🗑️ Clear imported</button>
            <ul class="ch-list" id="gc-import-list"></ul>
            <div class="ch-empty" id="gc-import-empty">No data package imported yet.</div>
        </div>

        <!-- EXCLUSIONS -->
        <div class="tp" id="tab-exclusions">
            <div style="font-size:12px;color:#72767d;">Excluded channels are skipped by both Purge and AutoDelete.</div>
            <div class="add-row">
                <button id="gc-ex-add-current" class="success">＋ Exclude Current Channel</button>
                <input type="text" id="gc-ex-id" placeholder="Channel ID" style="width:140px;">
                <input type="text" id="gc-ex-label" placeholder="Label" style="width:140px;">
                <button id="gc-ex-add">Add</button>
                <button id="gc-ex-clear" class="danger" style="margin-left:auto;">Clear All</button>
            </div>
            <ul class="ch-list" id="gc-ex-list"></ul>
            <div class="ch-empty" id="gc-ex-empty">No exclusions yet.</div>
        </div>

        <div class="log" id="gc-log">Ghostcord v1.0 ready.\n</div>
        <div class="sbar">
            <span id="gc-status">Idle</span>
            <progress id="gc-progress" value="0" max="1" style="display:none;"></progress>
            <span id="gc-percent"></span>
            <span style="margin-left:auto;display:flex;align-items:center;gap:10px;">
                <span style="font-size:11px;" id="gc-ad-next">AutoDelete idle</span>
                <span style="font-size:11px;">AD deleted:</span>
                <span class="pill" id="gc-ad-counter">0</span>
                <span style="font-size:11px;">Purge deleted:</span>
                <span class="pill" id="gc-purge-counter">0</span>
            </span>
        </div>
    `;
    document.body.appendChild(panel);

    // ── Refs ──────────────────────────────────────────────────────────────────
    const $ = (s) => panel.querySelector(s);
    const logEl = $('#gc-log');
    const autoScrollEl = $('#gc-autoscroll');
    const debugEl = $('#gc-debug');
    const tokenEl = $('#gc-token');
    const authorEl = $('#gc-author');
    const startBtn = $('#gc-start');
    const stopBtn = $('#gc-stop');
    const progressEl = $('#gc-progress');
    const percentEl = $('#gc-percent');
    const statusEl = $('#gc-status');
    const purgeCounterEl = $('#gc-purge-counter');
    const authStatusEl = $('#gc-auth-status');

    // ── Logging ───────────────────────────────────────────────────────────────
    function addLog(type, msg) {
        if (type === 'verb' && debugEl && !debugEl.checked) return;
        const line = Object.assign(document.createElement('div'), {
            className: type ? `gc-${type}` : '',
            textContent: `[${new Date().toLocaleTimeString()}] ${msg}`,
        });
        logEl.appendChild(line);
        while (logEl.children.length > 3000) logEl.removeChild(logEl.firstChild);
        if (autoScrollEl?.checked) logEl.scrollTop = logEl.scrollHeight;
    }

    // ── Tabs ──────────────────────────────────────────────────────────────────
    panel.querySelectorAll('.tab').forEach(tab => {
        tab.onclick = () => {
            panel.querySelectorAll('.tab,.tp').forEach(el => el.classList.remove('active'));
            tab.classList.add('active');
            $(`#tab-${tab.dataset.tab}`).classList.add('active');
            if (tab.dataset.tab === 'exclusions') renderExclusionList();
            if (tab.dataset.tab === 'import') renderImportList();
            if (tab.dataset.tab === 'purge') updateSourceSummary();
            if (tab.dataset.tab === 'ad-channels') renderAdChannelList();
            if (tab.dataset.tab === 'history') renderHistoryList();
            if (tab.dataset.tab === 'autodelete') refreshAdSettings();
        };
    });

    // ── Auth tab ──────────────────────────────────────────────────────────────
    // Load persisted credentials on init
    tokenEl.value = store.get(K.TOKEN, '');
    authorEl.value = store.get(K.AUTHOR, '');

    $('#gc-autodetect').onclick = async () => {
        const btn = $('#gc-autodetect');
        btn.disabled = true;

        const existing = tokenEl.value.trim();
        if (existing) {
            authStatusEl.innerHTML = '<span class="spinner"></span> Verifying…';
            authStatusEl.className = 'auth-wait';
            const r = await verifyAuth(existing);
            if (r.ok) {
                authorEl.value = r.user.id;
                store.set(K.TOKEN, existing);
                store.set(K.AUTHOR, r.user.id);
                authStatusEl.textContent = `✓ ${r.user.username}#${r.user.discriminator || '0'} (${r.user.id})`;
                authStatusEl.className = 'auth-ok';
                addLog('success', `Verified: ${r.user.username} (${r.user.id})`);
                btn.disabled = false;
                return;
            }
            addLog('warn', 'Existing token invalid. Capturing fresh…');
        }

        authStatusEl.innerHTML = '<span class="spinner"></span> Listening for Discord API traffic…';
        authStatusEl.className = 'auth-wait';

        let token;
        try { token = await captureToken(10000); } catch (e) {
            authStatusEl.textContent = `✗ ${e.message}`;
            authStatusEl.className = 'auth-fail';
            addLog('error', e.message);
            btn.disabled = false;
            return;
        }

        tokenEl.value = token;
        addLog('success', 'Token captured.');
        authStatusEl.innerHTML = '<span class="spinner"></span> Verifying…';
        const r = await verifyAuth(token);
        if (r.ok) {
            authorEl.value = r.user.id;
            store.set(K.TOKEN, token);
            store.set(K.AUTHOR, r.user.id);
            authStatusEl.textContent = `✓ ${r.user.username}#${r.user.discriminator || '0'} (${r.user.id})`;
            authStatusEl.className = 'auth-ok';
            addLog('success', `Authenticated as ${r.user.username} (${r.user.id})`);
        } else {
            authStatusEl.textContent = `✗ Verification failed: ${r.error}`;
            authStatusEl.className = 'auth-fail';
        }
        btn.disabled = false;
    };

    // ── Source summary (purge tab) ────────────────────────────────────────────
    function updateSourceSummary() {
        const ic = Object.keys(getImported()).length, ec = Object.keys(getExclusions()).length;
        const el = $('#gc-source-summary'), parts = [];
        if (ic > 0) parts.push(`<span style="color:#3ba55d;">📦 ${ic} imported</span>`);
        if (ec > 0) parts.push(`<span style="color:#faa61a;">⛔ ${ec} exclusion(s)</span>`);
        el.innerHTML = parts.length ? parts.join(' · ') : `Live API only. <span style="color:#5865f2;cursor:pointer;text-decoration:underline;" id="gc-go-import">Import data package</span> for full coverage.`;
        $('#gc-go-import')?.addEventListener('click', () => $(`.tab[data-tab="import"]`).click());
    }

    // ── Purge flow ────────────────────────────────────────────────────────────
    let purgeStopFlag = false, purgeTotalDeleted = 0;
    stopBtn.onclick = () => { purgeStopFlag = true; addLog('warn', 'Stop requested…'); };

    startBtn.onclick = async () => {
        const token = tokenEl.value.trim(), authorId = authorEl.value.trim();
        if (!token || !authorId) { addLog('error', 'Go to Auth tab and click Auto-detect first.'); return; }

        addLog('info', 'Verifying…');
        const auth = await verifyAuth(token);
        if (!auth.ok) { addLog('error', `Auth failed: ${auth.error}`); return; }
        const confirmedId = auth.user.id;
        if (confirmedId !== authorId) { authorEl.value = confirmedId; store.set(K.AUTHOR, confirmedId); }

        startBtn.disabled = true; stopBtn.disabled = false; purgeStopFlag = false; purgeTotalDeleted = 0;
        purgeCounterEl.textContent = '0'; purgeCounterEl.className = 'pill active';

        addLog('info', '── Channel discovery ──');
        statusEl.textContent = 'Discovering…';
        let live = [];
        try { live = await discoverChannels(token, addLog); } catch (e) { addLog('error', e.message); }
        addLog('success', `Live: ${live.length} channels.`);

        const importedMap = getImported(), importedCount = Object.keys(importedMap).length;
        let all = mergeChannels(live, importedMap);
        if (importedCount > 0) addLog('success', `Import: +${all.filter(c => c.source === 'import').length} additional.`);

        const needsResolve = all.filter(c => c.source === 'import');
        if (needsResolve.length > 0) {
            addLog('info', `Resolving ${needsResolve.length} imported channels…`);
            for (const ch of needsResolve) { if (purgeStopFlag) break; ch.guildId = await resolveGuildId(token, ch.channelId); await wait(TIMING.resolveGap); }
        }

        const exclusions = getExclusions();
        const excluded = all.filter(ch => exclusions[ch.channelId]);
        const channels = all.filter(ch => !exclusions[ch.channelId]);
        if (excluded.length > 0) addLog('warn', `Skipping ${excluded.length} excluded.`);

        addLog('info', `── Purge ${channels.length} channel(s) ──`);
        if (!confirm(`Purge ${channels.length} channels?\n\nLive: ${live.length}\n${importedCount > 0 ? `Import: +${all.filter(c => c.source === 'import').length}\n` : ''}${excluded.length > 0 ? `Excluded: ${excluded.length}\n` : ''}\nThis CANNOT be undone.`)) {
            addLog('warn', 'Aborted.'); startBtn.disabled = false; stopBtn.disabled = true; purgeCounterEl.className = 'pill'; return;
        }

        progressEl.style.display = ''; progressEl.max = channels.length; progressEl.value = 0;

        for (let i = 0; i < channels.length; i++) {
            if (purgeStopFlag) { addLog('warn', 'Stopped.'); break; }
            const ch = channels[i];
            statusEl.textContent = `${i + 1}/${channels.length}: ${ch.label}`;
            progressEl.value = i + 1; percentEl.textContent = `${Math.round(((i + 1) / channels.length) * 100)}%`;
            addLog('info', `\n── [${i + 1}/${channels.length}] ${ch.label}`);

            await deleteInChannel(token, confirmedId, ch.guildId, ch.channelId, {
                logFn: addLog, debugMode: debugEl.checked, cutoffTs: null,
                shouldStop: () => purgeStopFlag,
                onDelete: (msg) => {
                    purgeTotalDeleted++;
                    purgeCounterEl.textContent = purgeTotalDeleted.toLocaleString();
                    addHistory({ id: msg.id, channelId: ch.channelId, mode: 'purge', content: (msg.content || '').slice(0, 100), deletedAt: Date.now() });
                },
            });
            await wait(TIMING.channelGap);
        }

        addLog('success', `\n✅ Purge complete. ${purgeTotalDeleted.toLocaleString()} deleted.`);
        statusEl.textContent = 'Done'; purgeCounterEl.className = 'pill'; startBtn.disabled = false; stopBtn.disabled = true;
    };

    $('#gc-close').onclick = () => { panel.style.display = 'none'; };
    $('#gc-clear-log').onclick = () => { logEl.innerHTML = ''; };

    // ── AutoDelete settings tab ───────────────────────────────────────────────
    function updateMasterToggleUI() {
        const on = store.get(K.AD_MASTER, true);
        const badge = $('#gc-ad-master-badge');
        const btn = $('#gc-ad-master-toggle');
        if (!badge || !btn) return;
        badge.textContent = on ? 'RUNNING' : 'PAUSED';
        badge.className = on ? 'badge-on' : 'badge-off';
        btn.textContent = on ? 'Pause' : 'Resume';
        btn.className = on ? 'danger sm' : 'success sm';
    }

    function refreshAdSettings() {
        const globalTtl = store.get(K.AD_GLOBAL_TTL, 3600);
        const scanInt = store.get(K.AD_SCAN_INTERVAL, DEFAULT_SCAN_INTERVAL);
        $('#gc-ad-ttl').value = globalTtl;
        $('#gc-ad-ttl-preview').textContent = `= ${formatDuration(globalTtl)}`;
        $('#gc-ad-interval').value = scanInt;
        $('#gc-ad-interval-preview').textContent = `= ${formatDuration(scanInt)}`;

        const chId = getCurrentChannelId();
        const enabled = store.get(K.AD_ENABLED, {});
        const ttlMap = store.get(K.AD_CHANNEL_TTL, {});
        if (chId) {
            $('#gc-ad-ch-id').textContent = chId;
            const isOn = !!enabled[chId];
            const badge = $('#gc-ad-ch-badge-inline');
            badge.textContent = isOn ? 'ON' : 'OFF';
            badge.className = isOn ? 'badge-on' : 'badge-off';
            const tog = $('#gc-ad-toggle');
            tog.textContent = isOn ? 'Disable' : 'Enable';
            tog.className = isOn ? 'danger' : 'success';
            $('#gc-ad-ch-ttl').value = ttlMap[chId] ?? '';
        } else {
            $('#gc-ad-ch-id').textContent = 'none';
        }
        updateMasterToggleUI();
        updateFilterSlider();
    }

    $('#gc-ad-ttl').oninput = function () { $('#gc-ad-ttl-preview').textContent = `= ${formatDuration(parseInt(this.value) || 0)}`; };
    $('#gc-ad-interval').oninput = function () { $('#gc-ad-interval-preview').textContent = `= ${formatDuration(parseInt(this.value) || 0)}`; };

    $('#gc-ad-save').onclick = () => {
        const ttl = parseInt($('#gc-ad-ttl').value);
        const scanSecs = parseInt($('#gc-ad-interval').value);
        let anySaved = false;

        if (!isNaN(ttl) && ttl >= 60) {
            store.set(K.AD_GLOBAL_TTL, ttl);
            anySaved = true;
        } else {
            const stored = store.get(K.AD_GLOBAL_TTL, 3600);
            addLog('warn', `Global TTL not saved — must be ≥ 60s. Reverted to ${formatDuration(stored)}.`);
            $('#gc-ad-ttl').value = stored;
            $('#gc-ad-ttl-preview').textContent = `= ${formatDuration(stored)}`;
        }

        if (!isNaN(scanSecs) && scanSecs >= 30) {
            store.set(K.AD_SCAN_INTERVAL, scanSecs);
            clearInterval(adInterval);
            adInterval = setInterval(adTick, getAdTickMs());
            adNextTickSecs = getAdTickMs() / 1000;
            anySaved = true;
        } else {
            const stored = store.get(K.AD_SCAN_INTERVAL, DEFAULT_SCAN_INTERVAL);
            addLog('warn', `Scan interval not saved — must be ≥ 30s. Reverted to ${formatDuration(stored)}.`);
            $('#gc-ad-interval').value = stored;
            $('#gc-ad-interval-preview').textContent = `= ${formatDuration(stored)}`;
        }

        if (anySaved) addLog('success', `AutoDelete saved. TTL: ${formatDuration(store.get(K.AD_GLOBAL_TTL, 3600))}, interval: ${formatDuration(store.get(K.AD_SCAN_INTERVAL, DEFAULT_SCAN_INTERVAL))}`);
    };

    $('#gc-ad-toggle').onclick = () => {
        const chId = getCurrentChannelId();
        if (!chId) { addLog('warn', 'Navigate to a channel first.'); return; }
        const enabled = store.get(K.AD_ENABLED, {});
        const nowOn = !enabled[chId];
        enabled[chId] = nowOn;
        store.set(K.AD_ENABLED, enabled);

        if (nowOn) {
            const guildId = getCurrentGuildId();
            const guildMap = store.get(K.AD_CHANNEL_GUILDS, {});
            guildMap[chId] = guildId;
            store.set(K.AD_CHANNEL_GUILDS, guildMap);
        }

        const ttlInput = parseInt($('#gc-ad-ch-ttl').value);
        if (ttlInput >= 60) { const ttlMap = store.get(K.AD_CHANNEL_TTL, {}); ttlMap[chId] = ttlInput; store.set(K.AD_CHANNEL_TTL, ttlMap); }

        const label = document.title?.replace(' | Discord', '').trim() || `Channel ${chId}`;
        saveChannelName(chId, label);

        const effectiveTtl = store.get(K.AD_CHANNEL_TTL, {})[chId] ?? store.get(K.AD_GLOBAL_TTL, 3600);
        addLog(nowOn ? 'success' : 'warn', nowOn ? `AutoDelete ON: ${label} (TTL: ${formatDuration(effectiveTtl)})` : `AutoDelete OFF: ${label}`);
        refreshAdSettings();
        updateAdBadge();
    };

    $('#gc-ad-scan-now').onclick = () => { addLog('info', 'Manual scan…'); adTick(); };

    // ── Message filter (whitelist / blacklist / all) ──────────────────────────
    function renderFilterPatterns() {
        const mode = store.get(K.AD_FILTER_MODE, 'all');
        const patterns = store.get(K.AD_FILTER_PATTERNS, []);
        const container = $('#gc-ad-filter-patterns');
        const list = $('#gc-ad-filter-list');
        const empty = $('#gc-ad-filter-empty');
        if (!container) return;
        container.style.display = mode === 'all' ? 'none' : '';
        list.innerHTML = '';
        if (patterns.length === 0) { empty.style.display = ''; return; }
        empty.style.display = 'none';
        for (const p of patterns) {
            const li = document.createElement('li');
            li.className = 'ch-row';
            li.innerHTML = `<span class="ch-name">${p}</span><button class="sm danger gc-filter-remove" data-pattern="${p.replace(/"/g, '&quot;')}">Remove</button>`;
            li.querySelector('.gc-filter-remove').onclick = () => {
                const updated = store.get(K.AD_FILTER_PATTERNS, []).filter(x => x !== p);
                store.set(K.AD_FILTER_PATTERNS, updated);
                renderFilterPatterns();
            };
            list.appendChild(li);
        }
    }

    function updateFilterSlider() {
        const mode = store.get(K.AD_FILTER_MODE, 'all');
        $('#gc-ad-filter-slider')?.querySelectorAll('.mode-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.mode === mode);
        });
        renderFilterPatterns();
    }

    $('#gc-ad-filter-slider')?.querySelectorAll('.mode-btn').forEach(btn => {
        btn.onclick = () => {
            store.set(K.AD_FILTER_MODE, btn.dataset.mode);
            updateFilterSlider();
            addLog('info', `Message filter: ${btn.dataset.mode}`);
        };
    });

    $('#gc-ad-filter-add').onclick = () => {
        const input = $('#gc-ad-filter-input');
        const val = input.value.trim();
        if (!val) return;
        const patterns = store.get(K.AD_FILTER_PATTERNS, []);
        if (patterns.includes(val)) { addLog('warn', 'Keyword already in list.'); return; }
        patterns.push(val);
        store.set(K.AD_FILTER_PATTERNS, patterns);
        input.value = '';
        renderFilterPatterns();
        addLog('success', `Filter keyword added: "${val}"`);
    };

    $('#gc-ad-filter-input').onkeydown = (e) => { if (e.key === 'Enter') $('#gc-ad-filter-add').click(); };

    $('#gc-ad-master-toggle').onclick = () => {
        const current = store.get(K.AD_MASTER, true);
        store.set(K.AD_MASTER, !current);
        updateMasterToggleUI();
        addLog(!current ? 'success' : 'warn', !current ? 'AutoDelete daemon resumed.' : 'AutoDelete daemon paused.');
        if (!current) adTick(); // fire immediately on resume
    };

    // ── AD Channels tab ───────────────────────────────────────────────────────
    function renderAdChannelList() {
        const list = $('#gc-ad-ch-list'), empty = $('#gc-ad-ch-empty');
        const enabled = store.get(K.AD_ENABLED, {}), ttlMap = store.get(K.AD_CHANNEL_TTL, {}), globalTtl = store.get(K.AD_GLOBAL_TTL, 3600);
        const entries = Object.entries(enabled).filter(([, v]) => v);
        list.innerHTML = '';
        if (entries.length === 0) { empty.style.display = ''; return; }
        empty.style.display = 'none';
        for (const [chId] of entries) {
            const label = getChannelLabel(chId), chTtl = ttlMap[chId], eff = chTtl ?? globalTtl;
            const li = document.createElement('li');
            li.className = 'ch-row';
            li.innerHTML = `
                <div style="display:flex;flex-direction:column;flex:1;min-width:0;">
                    <span class="ch-name" title="${label}">${label}</span>
                    <span class="ch-id">${chId}</span>
                </div>
                <span style="font-size:11px;color:#949ba4;">TTL:</span>
                <input type="number" style="width:80px!important;height:26px!important;font-size:11px!important;" value="${chTtl ?? ''}" placeholder="${eff}" min="60" step="60" data-id="${chId}">
                <span style="font-size:11px;color:#4e5058;">(${formatDuration(eff)})</span>
                <button class="sm success gc-ad-save-ttl" data-id="${chId}">Save</button>
                <button class="sm danger gc-ad-disable" data-id="${chId}">Disable</button>
            `;
            li.querySelector('.gc-ad-save-ttl').onclick = () => {
                const val = parseInt(li.querySelector(`input[data-id="${chId}"]`).value);
                const t = store.get(K.AD_CHANNEL_TTL, {});
                if (val >= 60) t[chId] = val; else delete t[chId];
                store.set(K.AD_CHANNEL_TTL, t);
                addLog('success', `TTL for ${label}: ${val >= 60 ? formatDuration(val) : 'global default'}`);
                renderAdChannelList();
            };
            li.querySelector('.gc-ad-disable').onclick = () => {
                const e = store.get(K.AD_ENABLED, {}); e[chId] = false; store.set(K.AD_ENABLED, e);
                addLog('warn', `AutoDelete off: ${label}`);
                renderAdChannelList(); updateAdBadge();
            };
            list.appendChild(li);
        }
    }

    $('#gc-ad-disable-all').onclick = () => {
        if (!confirm('Disable AutoDelete for all channels?')) return;
        store.set(K.AD_ENABLED, {});
        addLog('warn', 'All channels disabled.');
        renderAdChannelList(); updateAdBadge();
    };

    function updateAdBadge() {
        const enabled = store.get(K.AD_ENABLED, {});
        const count = Object.values(enabled).filter(Boolean).length;
        const badge = $('#gc-ad-ch-badge');
        if (count > 0) { badge.textContent = count; badge.style.display = ''; }
        else badge.style.display = 'none';
        // Update toolbar icon state
        const btn = document.querySelector('#gc-btn');
        if (btn) btn.className = count > 0 ? 'active' : '';
    }

    // ── History tab ───────────────────────────────────────────────────────────
    function renderHistoryList() {
        const list = $('#gc-hist-list'), empty = $('#gc-hist-empty');
        const hist = store.get(K.HISTORY, []);
        list.innerHTML = '';
        if (hist.length === 0) { empty.style.display = ''; return; }
        empty.style.display = 'none';
        for (const entry of hist.slice(0, 200)) {
            const label = getChannelLabel(entry.channelId);
            const modeTag = entry.mode === 'purge' ? '🗑️' : '⏱️';
            const li = document.createElement('li');
            li.className = 'ch-row';
            li.style.cssText = 'flex-direction:column;align-items:flex-start;gap:2px;';
            li.innerHTML = `
                <div style="font-size:12px;color:#dcddde;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;width:100%;">
                    ${modeTag} "${entry.content || '[attachment]'}"
                </div>
                <div style="font-size:10px;color:#4e5058;">
                    ${label} · ${new Date(entry.deletedAt).toLocaleString()}
                </div>
            `;
            list.appendChild(li);
        }
        if (hist.length > 200) {
            const li = document.createElement('li');
            li.innerHTML = `<span style="color:#4e5058;font-size:11px;padding:4px 8px;">…and ${hist.length - 200} more</span>`;
            list.appendChild(li);
        }
    }
    $('#gc-hist-clear').onclick = () => {
        if (!confirm('Clear all deletion history?')) return;
        store.set(K.HISTORY, []);
        addLog('warn', 'History cleared.');
        renderHistoryList();
    };

    // ── Import tab ────────────────────────────────────────────────────────────
    function renderImportList() {
        const imported = getImported(), entries = Object.entries(imported);
        const list = $('#gc-import-list'), empty = $('#gc-import-empty');
        const stats = $('#gc-import-stats'), clearBtn = $('#gc-import-clear'), badge = $('#gc-import-badge');
        list.innerHTML = '';
        if (entries.length === 0) { empty.style.display = ''; stats.style.display = 'none'; clearBtn.style.display = 'none'; badge.style.display = 'none'; return; }
        empty.style.display = 'none'; stats.style.display = ''; clearBtn.style.display = '';
        badge.textContent = entries.length; badge.style.display = '';
        stats.innerHTML = `✅ <strong>${entries.length}</strong> channels loaded.`;
        entries.slice(0, 300).forEach(([id, label]) => {
            const li = document.createElement('li');
            li.innerHTML = `<span class="ch-label" title="${label}">${label}</span><span class="ch-id">${id}</span>`;
            list.appendChild(li);
        });
        if (entries.length > 300) { const li = document.createElement('li'); li.innerHTML = `<span style="color:#72767d;font-size:11px;">…and ${entries.length - 300} more</span>`; list.appendChild(li); }
    }

    const dropZone = $('#gc-drop-zone'), fileInput = $('#gc-file-input');
    $('#gc-browse').onclick = () => fileInput.click();
    dropZone.onclick = (e) => { if (e.target.id !== 'gc-browse') fileInput.click(); };
    dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
    dropZone.addEventListener('drop', e => { e.preventDefault(); dropZone.classList.remove('drag-over'); if (e.dataTransfer.files[0]) handleImport(e.dataTransfer.files[0]); });
    fileInput.addEventListener('change', () => { if (fileInput.files[0]) handleImport(fileInput.files[0]); });

    async function handleImport(file) {
        const stats = $('#gc-import-stats'); stats.style.display = ''; stats.innerHTML = `⏳ Parsing <strong>${file.name}</strong>…`;
        try {
            const parsed = await parseDataPackage(file), count = Object.keys(parsed).length;
            if (count === 0) throw new Error('No channels found.');
            saveImported(parsed); addLog('success', `📦 Imported ${count} channels.`);
            renderImportList(); updateSourceSummary();
        } catch (e) { stats.innerHTML = `❌ <span style="color:#ed4245;">${e.message}</span>`; addLog('error', `Import failed: ${e.message}`); }
    }
    $('#gc-import-clear').onclick = () => { if (!confirm('Clear imported?')) return; saveImported({}); addLog('warn', 'Cleared.'); renderImportList(); updateSourceSummary(); };

    // ── Exclusions tab ────────────────────────────────────────────────────────
    function renderExclusionList() {
        const list = $('#gc-ex-list'), empty = $('#gc-ex-empty'), badge = $('#gc-ex-badge');
        const entries = Object.entries(getExclusions());
        list.innerHTML = '';
        if (entries.length === 0) { empty.style.display = ''; badge.style.display = 'none'; return; }
        empty.style.display = 'none'; badge.textContent = entries.length; badge.style.display = '';
        entries.forEach(([id, { label, addedAt }]) => {
            const li = document.createElement('li');
            li.innerHTML = `<span class="ch-label" title="${label}">${label}</span><span class="ch-id">${id}</span><span class="ch-date">${addedAt}</span><button class="danger" style="padding:2px 8px;font-size:11px;">Remove</button>`;
            li.querySelector('button').onclick = () => { removeExclusion(id); addLog('warn', `Removed: ${label}`); renderExclusionList(); };
            list.appendChild(li);
        });
    }
    $('#gc-ex-add-current').onclick = () => {
        const id = getCurrentChannelId();
        if (!id) { addLog('warn', 'Navigate to a channel first.'); return; }
        if (isExcluded(id)) { addLog('warn', 'Already excluded.'); return; }
        const label = document.querySelector('title')?.textContent?.replace(' | Discord', '').trim() || `Channel ${id}`;
        addExclusion(id, label); addLog('success', `✅ Excluded: ${label}`);
        $(`.tab[data-tab="exclusions"]`).click();
    };
    $('#gc-ex-add').onclick = () => {
        const id = $('#gc-ex-id').value.trim(), label = $('#gc-ex-label').value.trim() || `Channel ${id}`;
        if (!id || !/^\d+$/.test(id)) { addLog('error', 'Invalid channel ID.'); return; }
        if (isExcluded(id)) { addLog('warn', 'Already excluded.'); return; }
        addExclusion(id, label); $('#gc-ex-id').value = ''; $('#gc-ex-label').value = '';
        addLog('success', `✅ Excluded: ${label}`); renderExclusionList();
    };
    $('#gc-ex-clear').onclick = () => {
        const c = Object.keys(getExclusions()).length;
        if (!c) return; if (!confirm(`Remove all ${c} exclusions?`)) return;
        saveExclusions({}); addLog('warn', `Cleared ${c} exclusions.`); renderExclusionList();
    };

    // ── Title observer for AD current channel updates ─────────────────────────
    new MutationObserver(() => {
        if (panel.style.display !== 'none') {
            const activeTab = panel.querySelector('.tab.active');
            if (activeTab?.dataset.tab === 'autodelete') refreshAdSettings();
        }
    }).observe(document.querySelector('title') || document.head, { childList: true, subtree: true });

    // ═══════════════════════════════════════════════════════════════════════════
    // TOOLBAR BUTTON
    // ═══════════════════════════════════════════════════════════════════════════

    const btn = document.createElement('div');
    btn.id = 'gc-btn';
    btn.title = 'Ghostcord';
    btn.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C7.58 2 4 5.58 4 10v4c0 1.1-.9 2-2 2v2h4.27A2 2 0 0 0 8 19.73V22h2v-2h4v2h2v-2.27A2 2 0 0 0 17.73 18H20v-2c-1.1 0-2-.9-2-2v-4c0-4.42-3.58-8-8-8zm-2 14a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm4 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z"/></svg>`;
    btn.onclick = () => {
        panel.style.display = panel.style.display === 'none' ? '' : 'none';
        if (panel.style.display !== 'none') {
            renderExclusionList(); renderImportList(); updateSourceSummary();
            renderAdChannelList(); renderHistoryList(); refreshAdSettings(); updateAdBadge();
        }
    };
    function mountBtn() { const t = document.querySelector('[class^=toolbar]'); if (t && !t.contains(btn)) t.appendChild(btn); }
    new MutationObserver(() => { if (!document.body.contains(btn)) mountBtn(); }).observe(document.body, { childList: true, subtree: true });
    mountBtn();

    // Initial render
    renderExclusionList(); renderImportList(); updateSourceSummary();
    renderAdChannelList(); updateAdBadge(); refreshAdSettings();
})();
