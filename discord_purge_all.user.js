// ==UserScript==
// @name          Discord Full Account Purge
// @description   Deletes all your messages across DMs, Group DMs, and Servers. Supports data package import and channel exclusions.
// @namespace     https://github.com/fIuffy/discord-purge
// @version       4.1
// @match         https://discord.com/*
// @grant         GM_getValue
// @grant         GM_setValue
// @run-at        document-idle
// @license       MIT
// ==/UserScript==

/**
 * HOW TO USE
 * ──────────
 * 1. Open Discord in browser (discord.com)
 * 2. Paste into DevTools console (F12) or install via Tampermonkey
 * 3. Click the 🗑️ trash icon in the Discord toolbar
 * 4. Click "Auto-detect" to fill token & author ID automatically
 * 5. (Recommended) Import your data package for full coverage
 * 6. (Optional) Exclude channels you want to keep
 * 7. Click "Start Full Purge"
 *
 * DATA PACKAGE IMPORT
 * ───────────────────
 * User Settings → Privacy & Safety → Request Data Export
 * Upload messages/index.json or the full package.zip in the Import tab.
 * This catches closed DMs, old servers, and deleted-user DMs.
 */

(function () {
    'use strict';

    // ═══════════════════════════════════════════════════════════════════════════
    // CONFIG
    // ═══════════════════════════════════════════════════════════════════════════

    const API = 'https://discord.com/api/v9';

    const DELETABLE_TYPES = new Set([
        0,  // DEFAULT
        6,  // CHANNEL_PINNED_MESSAGE
        19, // REPLY
        20, // CHAT_INPUT_COMMAND
        21, // THREAD_STARTER_MESSAGE
    ]);

    const TEXT_CHANNEL_TYPES = new Set([
        0,  // GUILD_TEXT
        5,  // GUILD_ANNOUNCEMENT
        10, // ANNOUNCEMENT_THREAD
        11, // PUBLIC_THREAD
        12, // PRIVATE_THREAD
        15, // GUILD_FORUM
        16, // GUILD_MEDIA
    ]);

    const TIMING = {
        searchDelay: 1500,
        deleteDelay: 1400,
        deleteDelayMin: 500,
        deleteDelayMax: 10000,
        delayIncrement: 150,
        delayDecrement: -50,
        decrementEvery: 1000,
        retryMultiplier: 3000,
        channelGap: 800,
        friendGap: 350,
        guildGap: 300,
        resolveGap: 200,
    };

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

    const K_EXCLUSIONS = 'purge_exclusions';
    const K_IMPORTED   = 'purge_imported';

    const getExclusions  = ()           => store.get(K_EXCLUSIONS, {});
    const saveExclusions = (ex)         => store.set(K_EXCLUSIONS, ex);
    const isExcluded     = (id)         => !!getExclusions()[id];
    const getImported    = ()           => store.get(K_IMPORTED, {});
    const saveImported   = (m)          => store.set(K_IMPORTED, m);

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

    // ═══════════════════════════════════════════════════════════════════════════
    // HELPERS
    // ═══════════════════════════════════════════════════════════════════════════

    const wait = (ms) => new Promise((r) => setTimeout(r, ms));

    function authHeaders(token) {
        return { Authorization: token };
    }

    function extractHit(entry) {
        if (!entry) return null;
        if (Array.isArray(entry)) {
            return entry.find((m) => m.hit) || entry[0] || null;
        }
        if (typeof entry === 'object' && entry.id) return entry;
        return null;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // TOKEN EXTRACTION — PASSIVE FETCH INTERCEPTION
    // ═══════════════════════════════════════════════════════════════════════════
    //
    // Instead of digging through localStorage or webpack internals (which
    // Discord changes constantly), we hook window.fetch and passively listen
    // for the Authorization header on requests Discord is already making.
    // Zero extra network traffic — just eavesdropping on existing calls.

    function interceptToken(timeoutMs = 8000) {
        return new Promise((resolve, reject) => {
            const originalFetch = window.fetch;
            let resolved = false;

            const timer = setTimeout(() => {
                if (!resolved) {
                    resolved = true;
                    window.fetch = originalFetch;
                    reject(new Error('Timed out waiting for an authenticated request. Try switching channels or clicking around in Discord to trigger API activity.'));
                }
            }, timeoutMs);

            window.fetch = function (...args) {
                if (!resolved) {
                    // Check Request object
                    let auth = null;
                    const [input, init] = args;

                    // init.headers can be a plain object, Headers instance, or array
                    if (init?.headers) {
                        if (init.headers instanceof Headers) {
                            auth = init.headers.get('Authorization');
                        } else if (typeof init.headers === 'object') {
                            // Plain object or array of pairs
                            if (Array.isArray(init.headers)) {
                                const pair = init.headers.find(([k]) => k.toLowerCase() === 'authorization');
                                if (pair) auth = pair[1];
                            } else {
                                // Case-insensitive search on plain object
                                for (const [k, v] of Object.entries(init.headers)) {
                                    if (k.toLowerCase() === 'authorization') { auth = v; break; }
                                }
                            }
                        }
                    }

                    // Also check if input is a Request object with headers
                    if (!auth && input instanceof Request) {
                        auth = input.headers.get('Authorization');
                    }

                    if (auth && typeof auth === 'string' && auth.length > 20 && !auth.startsWith('Bot ')) {
                        resolved = true;
                        clearTimeout(timer);
                        window.fetch = originalFetch;
                        resolve(auth);
                    }
                }
                return originalFetch.apply(this, args);
            };
        });
    }

    // Also hook XMLHttpRequest as a fallback — some Discord internal
    // calls may use XHR instead of fetch
    function interceptTokenXHR(timeoutMs = 8000) {
        return new Promise((resolve, reject) => {
            const originalOpen = XMLHttpRequest.prototype.open;
            const originalSetHeader = XMLHttpRequest.prototype.setRequestHeader;
            let resolved = false;

            const timer = setTimeout(() => {
                if (!resolved) {
                    resolved = true;
                    XMLHttpRequest.prototype.open = originalOpen;
                    XMLHttpRequest.prototype.setRequestHeader = originalSetHeader;
                    reject(new Error('XHR interception timed out.'));
                }
            }, timeoutMs);

            XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
                if (!resolved && name.toLowerCase() === 'authorization' && value && value.length > 20 && !value.startsWith('Bot ')) {
                    resolved = true;
                    clearTimeout(timer);
                    XMLHttpRequest.prototype.open = originalOpen;
                    XMLHttpRequest.prototype.setRequestHeader = originalSetHeader;
                    resolve(value);
                }
                return originalSetHeader.call(this, name, value);
            };
        });
    }

    // Race both methods — whichever captures a token first wins
    async function captureToken(timeoutMs = 8000) {
        try {
            return await Promise.any([
                interceptToken(timeoutMs),
                interceptTokenXHR(timeoutMs),
            ]);
        } catch {
            throw new Error('Could not capture token. Try clicking around in Discord to trigger API calls, then retry.');
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // AUTH VERIFICATION
    // ═══════════════════════════════════════════════════════════════════════════

    async function verifyAuth(token) {
        try {
            const r = await fetch(`${API}/users/@me`, { headers: authHeaders(token) });
            if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
            const data = await r.json();
            return { ok: true, user: data };
        } catch (e) {
            return { ok: false, error: e.message };
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // CHANNEL DISCOVERY
    // ═══════════════════════════════════════════════════════════════════════════

    async function discoverChannels(token, logFn) {
        const headers = authHeaders(token);
        const channels = [];
        const seen = new Set();

        const push = (ch) => {
            if (!seen.has(ch.channelId)) {
                seen.add(ch.channelId);
                channels.push(ch);
            }
        };

        // 1. Open DMs & group DMs
        logFn('info', 'Scanning open DMs…');
        try {
            const r = await fetch(`${API}/users/@me/channels`, { headers });
            if (r.ok) {
                const dms = await r.json();
                for (const dm of dms) {
                    push({
                        guildId: '@me',
                        channelId: dm.id,
                        label: dm.name || dm.recipients?.map((u) => u.username).join(', ') || 'DM',
                        source: 'live',
                    });
                }
                logFn('success', `  Found ${dms.length} open DM(s).`);
            }
        } catch (e) {
            logFn('warn', `  DM fetch failed: ${e.message}`);
        }

        // 2. Friends list — open/reopen DM to get channel ID
        logFn('info', 'Scanning friends list for hidden DMs…');
        try {
            const r = await fetch(`${API}/users/@me/relationships`, { headers });
            if (r.ok) {
                const rels = await r.json();
                const friends = rels.filter((rel) => rel.type === 1);
                let discovered = 0;
                for (const friend of friends) {
                    const fid = friend.id ?? friend.user?.id;
                    const fname = friend.user?.username ?? friend.user?.global_name ?? fid;
                    if (!fid) continue;

                    let attempts = 3;
                    while (attempts-- > 0) {
                        try {
                            const dr = await fetch(`${API}/users/@me/channels`, {
                                method: 'POST',
                                headers: { ...headers, 'Content-Type': 'application/json' },
                                body: JSON.stringify({ recipient_id: fid }),
                            });
                            if (dr.status === 429) {
                                let ra = 1000;
                                try { const j = await dr.json(); ra = ((j.retry_after ?? 1) * 1000) + 500; } catch {}
                                await wait(ra);
                                continue;
                            }
                            if (dr.ok) {
                                const dm = await dr.json();
                                if (dm?.id) {
                                    const before = seen.size;
                                    push({ guildId: '@me', channelId: dm.id, label: `DM: ${fname}`, source: 'live' });
                                    if (seen.size > before) discovered++;
                                }
                            }
                            break;
                        } catch { break; }
                    }
                    await wait(TIMING.friendGap);
                }
                logFn('success', `  Found ${discovered} additional DM(s) from friends list.`);
            }
        } catch (e) {
            logFn('warn', `  Friends list failed: ${e.message}`);
        }

        // 3. Guilds + text channels + threads
        logFn('info', 'Scanning servers…');
        try {
            const r = await fetch(`${API}/users/@me/guilds`, { headers });
            if (r.ok) {
                const guilds = await r.json();
                for (const guild of guilds) {
                    try {
                        const cr = await fetch(`${API}/guilds/${guild.id}/channels`, { headers });
                        if (cr.ok) {
                            const gch = await cr.json();
                            const textChannels = gch.filter((c) => TEXT_CHANNEL_TYPES.has(c.type));
                            textChannels.forEach((ch) =>
                                push({
                                    guildId: guild.id,
                                    channelId: ch.id,
                                    label: `${guild.name} → #${ch.name}`,
                                    source: 'live',
                                })
                            );
                        }
                    } catch (e) {
                        logFn('warn', `  Could not fetch channels for ${guild.name}: ${e.message}`);
                    }

                    // Active threads
                    try {
                        const tr = await fetch(`${API}/guilds/${guild.id}/threads/active`, { headers });
                        if (tr.ok) {
                            const tdata = await tr.json();
                            (tdata.threads || []).forEach((t) =>
                                push({
                                    guildId: guild.id,
                                    channelId: t.id,
                                    label: `${guild.name} → 🧵 ${t.name}`,
                                    source: 'live',
                                })
                            );
                        }
                    } catch {}

                    await wait(TIMING.guildGap);
                }
                logFn('success', `  Scanned ${guilds.length} server(s).`);
            }
        } catch (e) {
            logFn('warn', `  Guild fetch failed: ${e.message}`);
        }

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
        const json = JSON.parse(await file.text());
        const result = {};
        for (const [id, val] of Object.entries(json)) {
            result[id] = typeof val === 'string' ? val : (val.name || `Channel ${id}`);
        }
        return result;
    }

    async function parseZip(file) {
        if (!window.fflate) {
            await new Promise((resolve, reject) => {
                const s = document.createElement('script');
                s.src = 'https://cdn.jsdelivr.net/npm/fflate@0.8.2/umd/index.js';
                s.onload = resolve;
                s.onerror = reject;
                document.head.appendChild(s);
            });
        }
        const buf = await file.arrayBuffer();
        const unzipped = window.fflate.unzipSync(new Uint8Array(buf));
        const indexKey = Object.keys(unzipped).find((k) => k.match(/messages[/\\]index\.json$/i));
        if (!indexKey) throw new Error('Could not find messages/index.json in zip.');
        return parseIndexJson(new Blob([unzipped[indexKey]]));
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // GUILD ID RESOLUTION
    // ═══════════════════════════════════════════════════════════════════════════

    async function resolveGuildId(token, channelId) {
        try {
            const r = await fetch(`${API}/channels/${channelId}`, { headers: authHeaders(token) });
            if (!r.ok) return '@me';
            const data = await r.json();
            if (data.type === 1 || data.type === 3) return '@me';
            return data.guild_id || '@me';
        } catch { return '@me'; }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // MERGE & FILTER
    // ═══════════════════════════════════════════════════════════════════════════

    function mergeChannels(live, importedMap) {
        const seen = new Set(live.map((c) => c.channelId));
        const merged = [...live];
        for (const [id, label] of Object.entries(importedMap)) {
            if (!seen.has(id)) {
                merged.push({ guildId: null, channelId: id, label: `[imported] ${label}`, source: 'import' });
                seen.add(id);
            }
        }
        return merged;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // MESSAGE DELETION ENGINE
    // ═══════════════════════════════════════════════════════════════════════════

    async function purgeChannel(token, authorId, guildId, channelId, ctrl) {
        const { logFn, onDelete, shouldStop, debugMode } = ctrl;
        const headers = authHeaders(token);
        let deleteDelay = TIMING.deleteDelay;
        let delCount = 0, failCount = 0, offset = 0, grandTotal = null;

        async function search() {
            if (shouldStop()) return;

            const base = guildId === '@me'
                ? `${API}/channels/${channelId}/messages/search`
                : `${API}/guilds/${guildId}/messages/search`;

            const params = new URLSearchParams({
                author_id: authorId,
                sort_by: 'timestamp',
                sort_order: 'desc',
                offset: String(offset),
            });
            if (guildId !== '@me') params.set('channel_id', channelId);

            let resp;
            try {
                resp = await fetch(`${base}?${params}`, { headers });
            } catch (e) {
                logFn('error', `Search error: ${e.message}`);
                return;
            }

            if (resp.status === 202) {
                const body = await resp.json();
                const w = body.retry_after || 2000;
                logFn('warn', `Not indexed yet, waiting ${w}ms…`);
                await wait(w);
                return search();
            }

            if (resp.status === 429) {
                const body = await resp.json();
                const w = (body.retry_after || 1) * TIMING.retryMultiplier;
                logFn('warn', `Rate limited on search, cooling ${Math.round(w)}ms…`);
                await wait(w);
                return search();
            }

            if (resp.status === 403) {
                logFn('warn', `No access to channel ${channelId}, skipping.`);
                return;
            }

            if (!resp.ok) {
                logFn('error', `Search failed: HTTP ${resp.status}`);
                if (debugMode) {
                    try { logFn('verb', `Response: ${await resp.text()}`); } catch {}
                }
                return;
            }

            const data = await resp.json();

            if (debugMode && grandTotal === null) {
                logFn('verb', `Search response: total_results=${data.total_results}, messages.length=${data.messages?.length}, first entry isArray=${Array.isArray(data.messages?.[0])}`);
                if (data.messages?.[0]) {
                    const sample = extractHit(data.messages[0]);
                    logFn('verb', `Sample: id=${sample?.id}, type=${sample?.type}, hit=${sample?.hit}, author=${sample?.author?.id}`);
                }
            }

            if (grandTotal === null) grandTotal = data.total_results || 0;
            if (!data.messages || data.messages.length === 0) {
                if ((data.total_results || 0) - offset > 0) {
                    offset += 25;
                    await wait(TIMING.searchDelay);
                    return search();
                }
                logFn('success', `Channel done — deleted: ${delCount}, failed: ${failCount}`);
                return;
            }

            const hits = data.messages.map(extractHit).filter(Boolean);
            const toDelete = hits.filter((m) => {
                if (m.author?.id !== authorId) return false;
                return DELETABLE_TYPES.has(m.type);
            });
            const skippedCount = hits.length - toDelete.length;

            if (toDelete.length === 0) {
                if ((data.total_results || 0) - offset > 0) {
                    offset += skippedCount || 25;
                    await wait(TIMING.searchDelay);
                    return search();
                }
                logFn('success', `Channel done — deleted: ${delCount}, failed: ${failCount}`);
                return;
            }

            for (let j = 0; j < toDelete.length; j++) {
                if (shouldStop()) { logFn('warn', 'Stopped.'); return; }
                const msg = toDelete[j];
                const ts = new Date(msg.timestamp).toLocaleString();
                const preview = (msg.content || '').substring(0, 50);
                logFn('info', `Deleting ${msg.id} (${ts}) ${preview ? `"${preview}…"` : '[no text]'}`);

                if (delCount > 0 && delCount % TIMING.decrementEvery === 0) {
                    deleteDelay = Math.max(TIMING.deleteDelayMin, deleteDelay + TIMING.delayDecrement);
                }

                try {
                    const dr = await fetch(`${API}/channels/${msg.channel_id}/messages/${msg.id}`, {
                        headers,
                        method: 'DELETE',
                    });

                    if (dr.ok || dr.status === 204) {
                        delCount++;
                        onDelete();
                    } else if (dr.status === 429) {
                        const body = await dr.json();
                        const w = (body.retry_after || 1) * TIMING.retryMultiplier;
                        deleteDelay = Math.min(TIMING.deleteDelayMax, deleteDelay + TIMING.delayIncrement);
                        logFn('warn', `Rate limited on delete, cooling ${Math.round(w)}ms`);
                        await wait(w);
                        j--;
                        continue;
                    } else if (dr.status === 403 || dr.status === 400 || dr.status === 404) {
                        logFn('warn', `Cannot delete ${msg.id} (HTTP ${dr.status}), skipping.`);
                        offset++;
                        failCount++;
                    } else {
                        logFn('error', `Delete error HTTP ${dr.status} for ${msg.id}`);
                        failCount++;
                    }
                } catch (e) {
                    logFn('error', `Delete threw: ${e.message}`);
                    failCount++;
                }

                await wait(deleteDelay);
            }

            if (skippedCount > 0) {
                offset += skippedCount;
                if (grandTotal > 0) grandTotal = Math.max(0, grandTotal - skippedCount);
            }

            logFn('verb', `Next search in ${TIMING.searchDelay}ms (offset: ${offset})…`);
            await wait(TIMING.searchDelay);
            return search();
        }

        return search();
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // CSS
    // ═══════════════════════════════════════════════════════════════════════════

    const CSS = `
        #dcpurge-btn{position:relative;height:24px;width:auto;flex:0 0 auto;margin:0 8px;cursor:pointer;color:#b9bbbe;transition:color .15s;}
        #dcpurge-btn:hover{color:#fff;}
        #dcpurge{position:fixed;top:60px;right:10px;bottom:10px;width:880px;z-index:9999;color:#dcddde;background:#1e1f22;border:1px solid #111214;box-shadow:0 8px 32px rgba(0,0,0,.7);border-radius:8px;display:flex;flex-direction:column;font-family:'gg sans','Noto Sans',sans-serif;}
        #dcpurge *{box-sizing:border-box;}
        #dcpurge .hdr{padding:12px 16px;background:#111214;border-radius:8px 8px 0 0;font-weight:700;font-size:14px;color:#fff;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #000;}
        #dcpurge .hdr .ver{font-size:11px;color:#4e5058;font-weight:400;margin-left:8px;}
        #dcpurge .tabs{display:flex;background:#17181a;border-bottom:2px solid #111214;}
        #dcpurge .tab{padding:9px 18px;cursor:pointer;font-size:13px;font-weight:500;color:#949ba4;border-bottom:2px solid transparent;margin-bottom:-2px;user-select:none;transition:color .15s;}
        #dcpurge .tab:hover{color:#dcddde;}
        #dcpurge .tab.active{color:#fff;border-bottom-color:#5865f2;}
        #dcpurge .tp{display:none;padding:12px;flex-direction:column;gap:8px;background:#1e1f22;}
        #dcpurge .tp.active{display:flex;}
        #dcpurge input[type=password],#dcpurge input[type=text]{background:#111214;color:#dcddde;border:1px solid #2b2d31;border-radius:4px;padding:0 .6em;height:30px;width:220px;margin:2px;outline:none;font-size:13px;transition:border-color .15s;}
        #dcpurge input:focus{border-color:#5865f2;}
        #dcpurge input::placeholder{color:#4e5058;}
        #dcpurge button{color:#fff;background:#5865f2;border:0;border-radius:4px;padding:5px 14px;margin:2px;cursor:pointer;font-size:13px;font-weight:500;transition:filter .15s;}
        #dcpurge button:hover{filter:brightness(1.1);}
        #dcpurge button.danger{background:#c03537;}
        #dcpurge button.success{background:#248046;}
        #dcpurge button.muted{background:#383a40;}
        #dcpurge button:disabled{opacity:.35;cursor:not-allowed;filter:none;}
        #dcpurge .log{overflow:auto;font-size:.72rem;font-family:Consolas,'Courier New',monospace;flex-grow:1;padding:10px 12px;white-space:pre-wrap;background:#111214;color:#c7cad1;border-top:1px solid #2b2d31;}
        #dcpurge .sbar{padding:7px 14px;background:#111214;border-radius:0 0 8px 8px;border-top:1px solid #000;font-size:12px;color:#949ba4;display:flex;gap:14px;align-items:center;flex-wrap:wrap;}
        #dcpurge .sbar strong{color:#fff;}
        #dcpurge progress{width:160px;height:6px;border-radius:3px;border:none;background:#2b2d31;vertical-align:middle;}
        #dcpurge progress::-webkit-progress-bar{background:#2b2d31;border-radius:3px;}
        #dcpurge progress::-webkit-progress-value{background:#5865f2;border-radius:3px;}
        #dcpurge .pill{background:#248046;color:#fff;font-size:11px;font-weight:700;padding:2px 10px;border-radius:10px;letter-spacing:.3px;}
        #dcpurge .pill.active{background:#5865f2;}
        #dcpurge .ch-list{list-style:none;margin:4px 0 0;padding:0;overflow-y:auto;max-height:240px;}
        #dcpurge .ch-list li{display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:4px;font-size:12px;}
        #dcpurge .ch-list li:hover{background:#2b2d31;}
        #dcpurge .ch-label{flex:1;color:#dcddde;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
        #dcpurge .ch-id{color:#4e5058;font-size:10px;font-family:monospace;}
        #dcpurge .ch-date{color:#4e5058;font-size:10px;white-space:nowrap;}
        #dcpurge .ch-empty{color:#4e5058;font-size:12px;padding:20px;text-align:center;}
        #dcpurge .add-row{display:flex;gap:6px;align-items:center;flex-wrap:wrap;}
        #dcpurge .badge{display:inline-block;color:#fff;border-radius:8px;font-size:10px;font-weight:700;padding:1px 6px;margin-left:4px;vertical-align:middle;}
        #dcpurge .badge.red{background:#c03537;}
        #dcpurge .badge.green{background:#248046;}
        #dcpurge .drop-zone{border:2px dashed #2b2d31;border-radius:6px;padding:28px;text-align:center;color:#949ba4;font-size:13px;cursor:pointer;background:#17181a;transition:border-color .2s,background .2s,color .2s;}
        #dcpurge .drop-zone:hover,#dcpurge .drop-zone.drag-over{border-color:#5865f2;background:#1e1f2e;color:#dcddde;}
        #dcpurge .drop-zone input[type=file]{display:none;}
        #dcpurge .import-stats{background:#17181a;border:1px solid #2b2d31;border-radius:4px;padding:8px 12px;font-size:12px;color:#b5bac1;}
        #dcpurge code{background:#111214;border-radius:3px;padding:1px 5px;font-size:11px;color:#b5bac1;}
        #dcpurge .auth-ok{color:#43b581;font-size:12px;}
        #dcpurge .auth-fail{color:#f04747;font-size:12px;}
        #dcpurge .auth-waiting{color:#faa61a;font-size:12px;}
        .dcpurge-info{color:#00b0f4}.dcpurge-warn{color:#faa61a}.dcpurge-error{color:#f04747}.dcpurge-success{color:#43b581}.dcpurge-verb{color:#555760}
        @keyframes dcpurge-spin{to{transform:rotate(360deg)}}
        #dcpurge .spinner{display:inline-block;width:12px;height:12px;border:2px solid #4e5058;border-top-color:#5865f2;border-radius:50%;animation:dcpurge-spin .6s linear infinite;vertical-align:middle;margin-right:6px;}
    `;
    document.head.appendChild(Object.assign(document.createElement('style'), { textContent: CSS }));

    // ═══════════════════════════════════════════════════════════════════════════
    // UI
    // ═══════════════════════════════════════════════════════════════════════════

    const panel = document.createElement('div');
    panel.id = 'dcpurge';
    panel.style.display = 'none';
    panel.innerHTML = `
        <div class="hdr">
            🗑️ Discord Full Account Purge <span class="ver">v4.1</span>
            <button id="dcpurge-close" style="background:transparent;font-size:18px;padding:0 6px;">✕</button>
        </div>
        <div class="tabs">
            <div class="tab active" data-tab="main">Purge</div>
            <div class="tab" data-tab="import">Import <span class="badge green" id="ui-import-badge" style="display:none;"></span></div>
            <div class="tab" data-tab="exclusions">Exclusions <span class="badge red" id="ui-ex-badge" style="display:none;"></span></div>
        </div>

        <!-- Purge tab -->
        <div class="tp active" id="tab-main">
            <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end;">
                <div>
                    <div style="font-size:12px;color:#72767d;margin-bottom:2px;">Auth Token</div>
                    <input type="password" id="ui-token" placeholder="Auto-detected or paste manually">
                </div>
                <div>
                    <div style="font-size:12px;color:#72767d;margin-bottom:2px;">Author ID</div>
                    <input type="text" id="ui-author" placeholder="Auto-detected" readonly>
                </div>
                <button id="ui-autodetect" class="success" style="height:30px;">🔑 Auto-detect</button>
            </div>
            <div id="ui-auth-status"></div>
            <div id="ui-source-summary" style="font-size:12px;color:#72767d;margin-top:2px;"></div>
            <div style="font-size:12px;color:#faa61a;margin-top:2px;">⚠️ Deletes ALL your messages everywhere except excluded channels. Irreversible.</div>
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
                <button class="success" id="ui-start">▶ Start Full Purge</button>
                <button class="danger" id="ui-stop" disabled>⏹ Stop</button>
                <button id="ui-clear-log">Clear Log</button>
                <label style="font-size:12px;display:flex;align-items:center;gap:4px;"><input type="checkbox" id="ui-autoscroll" checked> Auto-scroll</label>
                <label style="font-size:12px;display:flex;align-items:center;gap:4px;"><input type="checkbox" id="ui-debug"> Debug</label>
            </div>
        </div>

        <!-- Import tab -->
        <div class="tp" id="tab-import">
            <div style="font-size:12px;color:#72767d;">
                Import your Discord data package to catch <strong>closed DMs, old servers, and deleted-user DMs</strong> the live API can't find.
                <br><br>
                <strong>How:</strong> User Settings → Privacy &amp; Safety → Request Data Export → wait for email → download zip.
            </div>
            <div class="drop-zone" id="ui-drop-zone">
                <input type="file" id="ui-file-input" accept=".json,.zip">
                <div style="font-size:28px;margin-bottom:8px;">📦</div>
                <div><strong>Drop your file here</strong> or <span style="color:#5865f2;text-decoration:underline;cursor:pointer;" id="ui-browse">browse</span></div>
                <div style="font-size:11px;margin-top:6px;">Accepts <code>messages/index.json</code> or the full <code>package.zip</code></div>
            </div>
            <div class="import-stats" id="ui-import-stats" style="display:none;"></div>
            <div style="display:flex;gap:6px;margin-top:4px;">
                <button id="ui-import-clear" class="danger" style="display:none;">🗑️ Clear imported channels</button>
            </div>
            <ul class="ch-list" id="ui-import-list"></ul>
            <div class="ch-empty" id="ui-import-empty">No data package imported yet.</div>
        </div>

        <!-- Exclusions tab -->
        <div class="tp" id="tab-exclusions">
            <div style="font-size:12px;color:#72767d;">Excluded channels will be completely skipped.</div>
            <div class="add-row">
                <button id="ui-ex-add-current" class="success">＋ Exclude Current Channel</button>
                <span style="font-size:11px;color:#4f545c;">or paste an ID:</span>
                <input type="text" id="ui-ex-id" placeholder="Channel ID" style="width:150px;">
                <input type="text" id="ui-ex-label" placeholder="Label (optional)" style="width:150px;">
                <button id="ui-ex-add">Add</button>
                <button id="ui-ex-clear" class="danger" style="margin-left:auto;">Clear All</button>
            </div>
            <ul class="ch-list" id="ui-ex-list"></ul>
            <div class="ch-empty" id="ui-ex-empty">No exclusions yet.</div>
        </div>

        <div class="log" id="ui-log" style="flex-grow:1;">Ready.\n</div>
        <div class="sbar">
            <span id="ui-status">Idle</span>
            <progress id="ui-progress" value="0" max="1" style="display:none;"></progress>
            <span id="ui-percent"></span>
            <span style="margin-left:auto;display:flex;align-items:center;gap:6px;">
                Total deleted: <span class="pill" id="ui-counter">0</span>
            </span>
        </div>
    `;
    document.body.appendChild(panel);

    // ── Element refs ──────────────────────────────────────────────────────────
    const $ = (sel) => panel.querySelector(sel);
    const logEl = $('#ui-log');
    const autoScrollEl = $('#ui-autoscroll');
    const debugEl = $('#ui-debug');
    const tokenEl = $('#ui-token');
    const authorEl = $('#ui-author');
    const startBtn = $('#ui-start');
    const stopBtn = $('#ui-stop');
    const progressEl = $('#ui-progress');
    const percentEl = $('#ui-percent');
    const statusEl = $('#ui-status');
    const counterEl = $('#ui-counter');
    const authStatusEl = $('#ui-auth-status');

    // ── Logging ───────────────────────────────────────────────────────────────
    function addLog(type, msg) {
        if (type === 'verb' && !debugEl.checked) return;
        const line = Object.assign(document.createElement('div'), {
            className: type ? `dcpurge-${type}` : '',
            textContent: `[${new Date().toLocaleTimeString()}] ${msg}`,
        });
        logEl.appendChild(line);
        while (logEl.children.length > 3000) logEl.removeChild(logEl.firstChild);
        if (autoScrollEl.checked) line.scrollIntoView(false);
    }

    // ── Tabs ──────────────────────────────────────────────────────────────────
    panel.querySelectorAll('.tab').forEach((tab) => {
        tab.onclick = () => {
            panel.querySelectorAll('.tab,.tp').forEach((el) => el.classList.remove('active'));
            tab.classList.add('active');
            $(`#tab-${tab.dataset.tab}`).classList.add('active');
            if (tab.dataset.tab === 'exclusions') renderExclusionList();
            if (tab.dataset.tab === 'import') renderImportList();
            if (tab.dataset.tab === 'main') updateSourceSummary();
        };
    });

    // ── Source summary ────────────────────────────────────────────────────────
    function updateSourceSummary() {
        const ic = Object.keys(getImported()).length;
        const ec = Object.keys(getExclusions()).length;
        const el = $('#ui-source-summary');
        const parts = [];
        if (ic > 0) parts.push(`<span style="color:#3ba55d;">📦 ${ic} imported channels</span>`);
        if (ec > 0) parts.push(`<span style="color:#faa61a;">⛔ ${ec} exclusion(s)</span>`);
        if (parts.length === 0) {
            el.innerHTML = `Live API only. <span style="color:#5865f2;cursor:pointer;text-decoration:underline;" id="ui-go-import">Import data package</span> for full coverage.`;
            $('#ui-go-import')?.addEventListener('click', () => $(`.tab[data-tab="import"]`).click());
        } else {
            el.innerHTML = parts.join(' · ');
        }
    }

    // ── Import tab ────────────────────────────────────────────────────────────
    function renderImportList() {
        const imported = getImported();
        const entries = Object.entries(imported);
        const list = $('#ui-import-list');
        const empty = $('#ui-import-empty');
        const stats = $('#ui-import-stats');
        const clearBtn = $('#ui-import-clear');
        const badge = $('#ui-import-badge');
        list.innerHTML = '';
        if (entries.length === 0) {
            empty.style.display = ''; stats.style.display = 'none';
            clearBtn.style.display = 'none'; badge.style.display = 'none';
            return;
        }
        empty.style.display = 'none'; stats.style.display = '';
        clearBtn.style.display = ''; badge.textContent = entries.length; badge.style.display = '';
        stats.innerHTML = `✅ <strong>${entries.length}</strong> channels loaded. Merged with live API (deduped).`;
        entries.slice(0, 300).forEach(([id, label]) => {
            const li = document.createElement('li');
            li.innerHTML = `<span class="ch-label" title="${label}">${label}</span><span class="ch-id">${id}</span>`;
            list.appendChild(li);
        });
        if (entries.length > 300) {
            const li = document.createElement('li');
            li.innerHTML = `<span style="color:#72767d;font-size:11px;">… and ${entries.length - 300} more</span>`;
            list.appendChild(li);
        }
    }

    // Drag/drop + file input
    const dropZone = $('#ui-drop-zone');
    const fileInput = $('#ui-file-input');
    $('#ui-browse').onclick = () => fileInput.click();
    dropZone.onclick = (e) => { if (e.target.id !== 'ui-browse') fileInput.click(); };
    dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
    dropZone.addEventListener('drop', (e) => {
        e.preventDefault(); dropZone.classList.remove('drag-over');
        if (e.dataTransfer.files[0]) handleImportFile(e.dataTransfer.files[0]);
    });
    fileInput.addEventListener('change', () => { if (fileInput.files[0]) handleImportFile(fileInput.files[0]); });

    async function handleImportFile(file) {
        const stats = $('#ui-import-stats');
        stats.style.display = '';
        stats.innerHTML = `⏳ Parsing <strong>${file.name}</strong>…`;
        try {
            const parsed = await parseDataPackage(file);
            const count = Object.keys(parsed).length;
            if (count === 0) throw new Error('No channel IDs found.');
            saveImported(parsed);
            addLog('success', `📦 Imported ${count} channels.`);
            renderImportList();
            updateSourceSummary();
        } catch (e) {
            stats.innerHTML = `❌ <span style="color:#ed4245;">${e.message}</span>`;
            addLog('error', `Import failed: ${e.message}`);
        }
    }

    $('#ui-import-clear').onclick = () => {
        if (!confirm('Clear all imported channels?')) return;
        saveImported({});
        addLog('warn', 'Cleared imported channels.');
        renderImportList();
        updateSourceSummary();
    };

    // ── Exclusions tab ────────────────────────────────────────────────────────
    function renderExclusionList() {
        const list = $('#ui-ex-list');
        const empty = $('#ui-ex-empty');
        const badge = $('#ui-ex-badge');
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

    $('#ui-ex-add-current').onclick = () => {
        const id = getCurrentChannelId();
        if (!id) { addLog('warn', 'Navigate to a channel first.'); return; }
        if (isExcluded(id)) { addLog('warn', 'Already excluded.'); return; }
        const label = document.querySelector('title')?.textContent?.replace(' | Discord', '').trim() || `Channel ${id}`;
        addExclusion(id, label);
        addLog('success', `✅ Excluded: ${label} (${id})`);
        $(`.tab[data-tab="exclusions"]`).click();
    };

    $('#ui-ex-add').onclick = () => {
        const id = $('#ui-ex-id').value.trim();
        const label = $('#ui-ex-label').value.trim() || `Channel ${id}`;
        if (!id || !/^\d+$/.test(id)) { addLog('error', 'Enter a valid channel ID.'); return; }
        if (isExcluded(id)) { addLog('warn', 'Already excluded.'); return; }
        addExclusion(id, label);
        $('#ui-ex-id').value = ''; $('#ui-ex-label').value = '';
        addLog('success', `✅ Excluded: ${label} (${id})`);
        renderExclusionList();
    };

    $('#ui-ex-clear').onclick = () => {
        const count = Object.keys(getExclusions()).length;
        if (!count) { addLog('warn', 'No exclusions to clear.'); return; }
        if (!confirm(`Remove all ${count} exclusions?`)) return;
        saveExclusions({});
        addLog('warn', `Cleared ${count} exclusions.`);
        renderExclusionList();
    };

    // ── Close & Clear ─────────────────────────────────────────────────────────
    $('#dcpurge-close').onclick = () => { panel.style.display = 'none'; };
    $('#ui-clear-log').onclick = () => { logEl.innerHTML = ''; };

    // ── Auto-detect button ────────────────────────────────────────────────────
    $('#ui-autodetect').onclick = async () => {
        const autoBtn = $('#ui-autodetect');
        autoBtn.disabled = true;

        // If token is already filled and valid, just verify it
        const existingToken = tokenEl.value.trim();
        if (existingToken) {
            authStatusEl.innerHTML = '<span class="spinner"></span> Verifying existing token…';
            authStatusEl.className = 'auth-waiting';
            const result = await verifyAuth(existingToken);
            if (result.ok) {
                authorEl.value = result.user.id;
                authStatusEl.textContent = `✓ ${result.user.username}#${result.user.discriminator || '0'} (${result.user.id})`;
                authStatusEl.className = 'auth-ok';
                addLog('success', `Verified: ${result.user.username} (${result.user.id})`);
                autoBtn.disabled = false;
                return;
            }
            addLog('warn', 'Existing token is invalid. Attempting to capture a fresh one…');
        }

        // Passive interception
        authStatusEl.innerHTML = '<span class="spinner"></span> Listening for Discord API traffic… click around or switch channels if needed';
        authStatusEl.className = 'auth-waiting';
        addLog('info', 'Intercepting outgoing requests to capture auth token…');

        let token;
        try {
            token = await captureToken(10000);
        } catch (e) {
            authStatusEl.textContent = `✗ ${e.message}`;
            authStatusEl.className = 'auth-fail';
            addLog('error', e.message);
            autoBtn.disabled = false;
            return;
        }

        tokenEl.value = token;
        addLog('success', 'Token captured from network traffic.');

        // Immediately verify and fill author ID
        authStatusEl.innerHTML = '<span class="spinner"></span> Verifying token…';
        const result = await verifyAuth(token);
        if (result.ok) {
            authorEl.value = result.user.id;
            authStatusEl.textContent = `✓ ${result.user.username}#${result.user.discriminator || '0'} (${result.user.id})`;
            authStatusEl.className = 'auth-ok';
            addLog('success', `Authenticated as ${result.user.username} (${result.user.id})`);
        } else {
            authStatusEl.textContent = `✗ Token captured but verification failed: ${result.error}`;
            authStatusEl.className = 'auth-fail';
            addLog('error', `Verification failed: ${result.error}`);
        }

        autoBtn.disabled = false;
    };

    // ── Main purge flow ───────────────────────────────────────────────────────
    let stopFlag = false;
    let totalDeleted = 0;

    stopBtn.onclick = () => { stopFlag = true; addLog('warn', 'Stop requested…'); };

    startBtn.onclick = async () => {
        const token = tokenEl.value.trim();
        const authorId = authorEl.value.trim();
        if (!token || !authorId) { addLog('error', 'Click Auto-detect first, or paste token and author ID manually.'); return; }
        const debugMode = debugEl.checked;

        // Verify auth
        addLog('info', 'Verifying credentials…');
        const authCheck = await verifyAuth(token);
        if (!authCheck.ok) {
            addLog('error', `Auth failed: ${authCheck.error}. Click Auto-detect to get a fresh token.`);
            return;
        }
        addLog('success', `Authenticated as ${authCheck.user.username} (${authCheck.user.id})`);
        if (authCheck.user.id !== authorId) {
            addLog('warn', `Author ID mismatch! Using ${authCheck.user.id} from API.`);
            authorEl.value = authCheck.user.id;
        }
        const confirmedAuthorId = authCheck.user.id;

        startBtn.disabled = true;
        stopBtn.disabled = false;
        stopFlag = false;
        totalDeleted = 0;
        counterEl.textContent = '0';
        counterEl.className = 'pill active';
        $(`.tab[data-tab="main"]`).click();

        // Step 1: Discover
        addLog('info', '── Step 1: Channel discovery ──');
        statusEl.textContent = 'Discovering channels…';
        let liveChannels = [];
        try {
            liveChannels = await discoverChannels(token, addLog);
        } catch (e) {
            addLog('error', `Discovery failed: ${e.message}`);
        }
        addLog('success', `Live API: ${liveChannels.length} channels total.`);

        // Step 2: Merge imported
        const importedMap = getImported();
        const importedCount = Object.keys(importedMap).length;
        let allChannels = mergeChannels(liveChannels, importedMap);

        if (importedCount > 0) {
            const extra = allChannels.filter((c) => c.source === 'import').length;
            addLog('success', `Data package: +${extra} additional channels.`);
        }

        // Step 3: Resolve guild IDs for imports
        const needsResolve = allChannels.filter((c) => c.source === 'import');
        if (needsResolve.length > 0) {
            addLog('info', `── Step 2: Resolving ${needsResolve.length} imported channel(s) ──`);
            for (const ch of needsResolve) {
                if (stopFlag) break;
                ch.guildId = await resolveGuildId(token, ch.channelId);
                await wait(TIMING.resolveGap);
            }
        }

        // Step 4: Apply exclusions
        const exclusions = getExclusions();
        const excluded = allChannels.filter((ch) => exclusions[ch.channelId]);
        const channels = allChannels.filter((ch) => !exclusions[ch.channelId]);

        if (excluded.length > 0) {
            addLog('warn', `Skipping ${excluded.length} excluded channel(s).`);
            if (debugMode) excluded.forEach((ch) => addLog('verb', `  ⛔ ${ch.label}`));
        }

        addLog('info', `── Step 3: Purge ${channels.length} channel(s) ──`);

        if (!confirm(
            `Ready to purge.\n\n` +
            `Live channels: ${liveChannels.length}\n` +
            (importedCount > 0 ? `From data package: +${allChannels.filter((c) => c.source === 'import').length}\n` : '') +
            (excluded.length > 0 ? `Excluded: ${excluded.length}\n` : '') +
            `\nTotal to process: ${channels.length}\n\nThis CANNOT be undone. Continue?`
        )) {
            addLog('warn', 'Aborted.');
            startBtn.disabled = false;
            stopBtn.disabled = true;
            counterEl.className = 'pill';
            return;
        }

        progressEl.style.display = '';
        progressEl.max = channels.length;
        progressEl.value = 0;

        // Step 5: Purge
        for (let i = 0; i < channels.length; i++) {
            if (stopFlag) { addLog('warn', 'Purge stopped by user.'); break; }
            const ch = channels[i];
            statusEl.textContent = `${i + 1}/${channels.length}: ${ch.label}`;
            progressEl.value = i + 1;
            percentEl.textContent = `${Math.round(((i + 1) / channels.length) * 100)}%`;
            addLog('info', `\n── [${i + 1}/${channels.length}] ${ch.label} (guild:${ch.guildId}, ch:${ch.channelId})`);

            await purgeChannel(token, confirmedAuthorId, ch.guildId, ch.channelId, {
                logFn: addLog,
                debugMode,
                shouldStop: () => stopFlag,
                onDelete: () => {
                    totalDeleted++;
                    counterEl.textContent = totalDeleted.toLocaleString();
                },
            });

            await wait(TIMING.channelGap);
        }

        addLog('success', `\n✅ Purge complete. ${totalDeleted.toLocaleString()} message(s) deleted across ${channels.length} channel(s).`);
        statusEl.textContent = 'Done';
        counterEl.className = 'pill';
        startBtn.disabled = false;
        stopBtn.disabled = true;
    };

    // ═══════════════════════════════════════════════════════════════════════════
    // TOOLBAR BUTTON
    // ═══════════════════════════════════════════════════════════════════════════

    const btn = document.createElement('div');
    btn.id = 'dcpurge-btn';
    btn.title = 'Full Account Purge';
    btn.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24"><path fill="currentColor" d="M15 3.999V2H9V3.999H3V5.999H21V3.999H15Z"/><path fill="currentColor" d="M5 6.99902V18.999C5 20.101 5.897 20.999 7 20.999H17C18.103 20.999 19 20.101 19 18.999V6.99902H5ZM11 17H9V11H11V17ZM15 17H13V11H15V17Z"/></svg>`;
    btn.onclick = () => {
        panel.style.display = panel.style.display === 'none' ? '' : 'none';
        if (panel.style.display !== 'none') {
            renderExclusionList();
            renderImportList();
            updateSourceSummary();
        }
    };

    function mountBtn() {
        const t = document.querySelector('[class^=toolbar]');
        if (t && !t.contains(btn)) t.appendChild(btn);
    }

    new MutationObserver(() => {
        if (!document.body.contains(btn)) mountBtn();
    }).observe(document.body, { childList: true, subtree: true });
    mountBtn();

    // Initial render
    renderExclusionList();
    renderImportList();
    updateSourceSummary();
})();
