// ==UserScript==
// @name          Discord Full Account Purge
// @description   Automatically deletes all your messages across all DMs, Group DMs, and Servers. Supports Discord data package import and channel exclusion lists.
// @namespace     https://github.com/YOUR_USERNAME/discord-purge
// @version       3.0
// @match         https://discord.com/*
// @grant         GM_getValue
// @grant         GM_setValue
// @run-at        document-idle
// @license       MIT
// ==/UserScript==

/**
 * HOW TO USE:
 * 1. Open Discord in your browser (discord.com)
 * 2. Option A — paste into DevTools console (F12) for a one-time run
 *    Option B — install via Tampermonkey/Violentmonkey for persistence
 * 3. Click the 🗑️ trash icon in the Discord toolbar
 * 4. Click "Get" to auto-fill your token & author ID
 *
 * FOR BEST COVERAGE — import your Discord data package:
 *   a. Go to User Settings → Privacy & Safety → Request Data Export
 *   b. Wait for the email (can take a few days)
 *   c. Download and unzip the package
 *   d. In the Import tab, upload either:
 *      - messages/index.json  (just the channel list)
 *      - The entire package.zip  (full zip — script extracts index.json automatically)
 *   This catches closed DMs, old servers you've left, and deleted user DMs that
 *   the live API discovery cannot find.
 *
 * 5. (Optional) Go to the Exclusions tab to skip channels you want to keep
 * 6. Click "Start Full Purge"
 */

(function () {
    'use strict';

    // ── Persistent storage ────────────────────────────────────────────────────
    const store = (() => {
        const hasgm = typeof GM_getValue !== 'undefined';
        const mem = {};
        return {
            get: (k, def) => { try { const raw = hasgm ? GM_getValue(k) : mem[k]; return raw === undefined ? def : JSON.parse(raw); } catch { return def; } },
            set: (k, v) => { const s = JSON.stringify(v); if (hasgm) GM_setValue(k, s); else mem[k] = s; },
        };
    })();

    const KEY_EXCLUSIONS   = 'purge_exclusions';
    const KEY_IMPORTED     = 'purge_imported'; // { channelId: label }

    // ── Core delete function ──────────────────────────────────────────────────
    async function deleteMessagesInChannel(authToken, authorId, guildId, channelId, options = {}) {
        const { searchDelay=1500, deleteDelay=1400, delayIncrement=150, delayDecrement=-50,
                delayDecrementPerMsgs=1000, retryAfterMultiplier=3000,
                stopHndl=null, onProgress=null, logFn=console.log } = options;

        let deleteDelayCurrent=deleteDelay, delCount=0, failCount=0, avgPing=0,
            lastPing=0, grandTotal=null, throttledCount=0, throttledTotalTime=0, offset=0;
        const wait = ms => new Promise(r => setTimeout(r, ms));
        const headers = { Authorization: authToken };

        async function recurse() {
            const BASE = guildId === '@me'
                ? `https://discord.com/api/v6/channels/${channelId}/messages/search`
                : `https://discord.com/api/v6/guilds/${guildId}/messages/search`;
            const params = new URLSearchParams();
            params.set('author_id', authorId);
            if (guildId !== '@me') params.set('channel_id', channelId);
            params.set('sort_by','timestamp'); params.set('sort_order','desc'); params.set('offset', offset);

            let resp;
            try {
                const s = Date.now();
                resp = await fetch(`${BASE}?${params}`, { headers });
                lastPing = Date.now()-s;
                avgPing = avgPing>0 ? avgPing*0.9+lastPing*0.1 : lastPing;
            } catch(err) { logFn('error',`Search error: ${err.message}`); return; }

            if (resp.status===202) {
                const {retry_after:w} = await resp.json();
                throttledCount++; throttledTotalTime+=w;
                logFn('warn',`Not indexed, waiting ${w}ms…`);
                await wait(w); return recurse();
            }
            if (!resp.ok) {
                if (resp.status===429) {
                    const {retry_after:w}=await resp.json();
                    throttledCount++;throttledTotalTime+=w;
                    logFn('warn',`Rate limited! Cooling ${w*retryAfterMultiplier}ms…`);
                    await wait(w*retryAfterMultiplier); return recurse();
                }
                if (resp.status===403) { logFn('warn',`No permission for channel ${channelId}, skipping.`); return; }
                logFn('error',`Search failed: HTTP ${resp.status}`); return;
            }

            const data = await resp.json();
            if (!grandTotal) grandTotal = data.total_results;
            const hits = data.messages.map(c => c.find(m => m.hit));
            const toDelete = hits.filter(m => m.type===0||m.type===6);
            const skipped  = hits.filter(m => !toDelete.find(d => d.id===m.id));

            if (toDelete.length===0) {
                if (data.total_results-offset>0) { offset+=25; await wait(searchDelay); return recurse(); }
                logFn('success',`Channel done. Deleted: ${delCount}, Failed: ${failCount}`); return;
            }

            for (let j=0; j<toDelete.length; j++) {
                const msg = toDelete[j];
                if (stopHndl && !stopHndl()) { logFn('warn','Stopped by user.'); return; }
                logFn('info',`Deleting message ${msg.id} (${new Date(msg.timestamp).toLocaleString()})`);
                if (delCount>0 && delCount%delayDecrementPerMsgs===0)
                    deleteDelayCurrent = Math.max(500, deleteDelayCurrent+delayDecrement);
                try {
                    const s = Date.now();
                    const dr = await fetch(
                        `https://discord.com/api/v6/channels/${msg.channel_id}/messages/${msg.id}`,
                        { headers, method:'DELETE' }
                    );
                    lastPing=Date.now()-s; avgPing=avgPing*0.9+lastPing*0.1;
                    if (!dr.ok) {
                        if (dr.status===429) {
                            const {retry_after:w}=await dr.json();
                            throttledCount++;throttledTotalTime+=w;
                            deleteDelayCurrent=Math.min(10000,deleteDelayCurrent+delayIncrement);
                            logFn('warn',`Rate limited on delete! Cooling ${w*retryAfterMultiplier}ms`);
                            await wait(w*retryAfterMultiplier); j--; continue;
                        } else if (dr.status===403||dr.status===400) {
                            logFn('warn',`Cannot delete ${msg.id} (${dr.status}), skipping.`);
                            offset++;failCount++;
                        } else { logFn('error',`Delete error HTTP ${dr.status} for ${msg.id}`); failCount++; }
                    } else { delCount++; if (onProgress) onProgress(delCount, grandTotal); }
                } catch(err) { logFn('error',`Delete threw: ${err.message}`); failCount++; }
                await wait(deleteDelayCurrent);
            }
            if (skipped.length>0) { grandTotal=Math.max(0,grandTotal-skipped.length); offset+=skipped.length; }
            logFn('verb',`Next search in ${searchDelay}ms (offset: ${offset})…`);
            await wait(searchDelay); return recurse();
        }
        return recurse();
    }

    // ── Live API channel discovery ────────────────────────────────────────────
    async function getAllChannels(authToken) {
        const headers = { Authorization: authToken };
        const channels = [];
        const seenChannelIds = new Set();

        const pushChannel = (ch) => {
            if (!seenChannelIds.has(ch.channelId)) {
                seenChannelIds.add(ch.channelId);
                channels.push(ch);
            }
        };

        // 1. Open DMs and group DMs (currently visible in sidebar)
        try {
            const r = await fetch('https://discord.com/api/v9/users/@me/channels', { headers });
            if (r.ok) {
                const dms = await r.json();
                for (const dm of dms)
                    pushChannel({ guildId:'@me', channelId:dm.id, label:dm.name||(dm.recipients?.[0]?.username??'DM'), source:'live' });
            }
        } catch(e) { console.warn('Could not fetch DMs:',e); }

        // 2. Friends list — open (or re-open) a DM with each friend to get its channel ID.
        //    This catches DMs that have been closed/hidden from the sidebar but still exist.
        try {
            const r = await fetch('https://discord.com/api/v9/users/@me/relationships', { headers });
            if (r.ok) {
                const relationships = await r.json();
                // type 1 = friend
                const friends = relationships.filter(rel => rel.type === 1);
                for (const friend of friends) {
                    try {
                        // POST to create/reopen a DM — safe, just returns the channel object
                        const dr = await fetch('https://discord.com/api/v9/users/@me/channels', {
                            method: 'POST',
                            headers: { ...headers, 'Content-Type': 'application/json' },
                            body: JSON.stringify({ recipient_id: friend.id }),
                        });
                        if (dr.ok) {
                            const dm = await dr.json();
                            pushChannel({ guildId:'@me', channelId:dm.id, label:`DM with ${friend.user?.username ?? friend.id}`, source:'live' });
                        }
                    } catch(e) { console.warn(`Could not open DM for friend ${friend.id}:`, e); }
                    await new Promise(r => setTimeout(r, 200));
                }
            }
        } catch(e) { console.warn('Could not fetch friends list:',e); }
        // 3. Guild text channels
        try {
            const r = await fetch('https://discord.com/api/v9/users/@me/guilds', { headers });
            if (r.ok) {
                const guilds = await r.json();
                for (const guild of guilds) {
                    try {
                        const cr = await fetch(`https://discord.com/api/v9/guilds/${guild.id}/channels`, { headers });
                        if (cr.ok) {
                            const gchannels = await cr.json();
                            gchannels.filter(c=>[0,5,10,11,12].includes(c.type)).forEach(ch =>
                                pushChannel({ guildId:guild.id, channelId:ch.id, label:`${guild.name} → #${ch.name}`, source:'live' })
                            );
                        }
                    } catch(e) { console.warn(`Could not fetch channels for ${guild.name}:`,e); }
                    await new Promise(r => setTimeout(r, 300));
                }
            }
        } catch(e) { console.warn('Could not fetch guilds:',e); }
        return channels;
    }

    // ── Data package parsing ──────────────────────────────────────────────────
    // Accepts either messages/index.json or a full package .zip
    // index.json format: { "channelId": "Channel or DM name", ... }
    // For DM channels the script will attempt the DM search endpoint (@me),
    // falling back to a guild search if the channel looks like a guild channel.

    async function parseDataPackage(file) {
        // Try zip first (requires fflate or similar — we load it dynamically)
        if (file.name.endsWith('.zip')) {
            return await parseZip(file);
        }
        // Otherwise treat as raw JSON
        return await parseIndexJson(file);
    }

    async function parseIndexJson(file) {
        const text = await file.text();
        const json = JSON.parse(text);
        // index.json is { channelId: "label" }
        // Some older exports use { channelId: { name, type } } — handle both
        const result = {};
        for (const [id, val] of Object.entries(json)) {
            result[id] = typeof val === 'string' ? val : (val.name || `Channel ${id}`);
        }
        return result;
    }

    async function parseZip(file) {
        // Dynamically load fflate for zip parsing (small, MIT licensed)
        if (!window.fflate) {
            await new Promise((resolve, reject) => {
                const s = document.createElement('script');
                s.src = 'https://cdn.jsdelivr.net/npm/fflate@0.8.2/umd/index.js';
                s.onload = resolve; s.onerror = reject;
                document.head.appendChild(s);
            });
        }
        const buf = await file.arrayBuffer();
        const unzipped = window.fflate.unzipSync(new Uint8Array(buf));

        // Find messages/index.json in the zip
        const indexKey = Object.keys(unzipped).find(k => k.match(/messages[/\\]index\.json$/i));
        if (!indexKey) throw new Error('Could not find messages/index.json inside the zip. Make sure you are uploading the full Discord data package zip.');

        const text = new TextDecoder().decode(unzipped[indexKey]);
        const json = JSON.parse(text);
        const result = {};
        for (const [id, val] of Object.entries(json)) {
            result[id] = typeof val === 'string' ? val : (val.name || `Channel ${id}`);
        }
        return result;
    }

    // ── Resolve guildId for an imported channel ───────────────────────────────
    // The index.json doesn't tell us the guildId, so we probe the channel endpoint.
    // DM channels return type 1 or 3; guild channels return a guild_id field.
    async function resolveGuildId(authToken, channelId, logFn) {
        try {
            const r = await fetch(`https://discord.com/api/v9/channels/${channelId}`, {
                headers: { Authorization: authToken }
            });
            if (!r.ok) {
                // 403 = no access (left server, etc.) — still attempt as @me so the
                // search endpoint can try and return 0 results gracefully
                if (r.status===403||r.status===404) return '@me';
                return '@me';
            }
            const data = await r.json();
            // type 1 = DM, type 3 = group DM → use @me
            if (data.type===1||data.type===3) return '@me';
            // guild channel → use guild_id
            if (data.guild_id) return data.guild_id;
            return '@me';
        } catch { return '@me'; }
    }

    // ── Merge live + imported channels, dedup by channelId ───────────────────
    function mergeChannels(liveChannels, importedMap) {
        const seen = new Set(liveChannels.map(c => c.channelId));
        const merged = [...liveChannels];
        for (const [channelId, label] of Object.entries(importedMap)) {
            if (!seen.has(channelId)) {
                merged.push({ guildId: null, channelId, label: `[imported] ${label}`, source:'import' });
                seen.add(channelId);
            }
        }
        return merged;
    }

    // ── Exclusion helpers ─────────────────────────────────────────────────────
    const getExclusions    = ()          => store.get(KEY_EXCLUSIONS, {});
    const saveExclusions   = ex          => store.set(KEY_EXCLUSIONS, ex);
    const addExclusion     = (id, label) => { const ex=getExclusions(); ex[id]={label,addedAt:new Date().toLocaleString()}; saveExclusions(ex); };
    const removeExclusion  = id          => { const ex=getExclusions(); delete ex[id]; saveExclusions(ex); };
    const isExcluded       = id          => !!getExclusions()[id];
    const getCurrentChannelId = ()       => { const m=location.href.match(/channels\/[\w@]+\/(\d+)/); return m?m[1]:null; };

    const getImported  = ()           => store.get(KEY_IMPORTED, {});
    const saveImported = map          => store.set(KEY_IMPORTED, map);
    const clearImported = ()          => store.set(KEY_IMPORTED, {});

    // ── CSS ───────────────────────────────────────────────────────────────────
    const css = `
        #dcpurge-btn{position:relative;height:24px;width:auto;flex:0 0 auto;margin:0 8px;cursor:pointer;color:#b9bbbe;}
        #dcpurge-btn:hover{color:#fff;}
        #dcpurge{position:fixed;top:60px;right:10px;bottom:10px;width:860px;z-index:9999;color:#dcddde;background:#1e1f22;border:1px solid #111214;box-shadow:0 8px 32px rgba(0,0,0,.7);border-radius:8px;display:flex;flex-direction:column;font-family:'gg sans','Noto Sans',sans-serif;}
        #dcpurge *{box-sizing:border-box;}
        #dcpurge .hdr{padding:12px 16px;background:#111214;border-radius:8px 8px 0 0;font-weight:700;font-size:14px;color:#fff;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #000;}
        #dcpurge .tabs{display:flex;background:#17181a;border-bottom:2px solid #111214;}
        #dcpurge .tab{padding:9px 18px;cursor:pointer;font-size:13px;font-weight:500;color:#949ba4;border-bottom:2px solid transparent;margin-bottom:-2px;user-select:none;transition:color .15s;}
        #dcpurge .tab:hover{color:#dcddde;}
        #dcpurge .tab.active{color:#fff;border-bottom-color:#5865f2;}
        #dcpurge .tab-panel{display:none;padding:12px;flex-direction:column;gap:8px;background:#1e1f22;}
        #dcpurge .tab-panel.active{display:flex;}
        #dcpurge input[type=password],#dcpurge input[type=text]{background:#111214;color:#dcddde;border:1px solid #2b2d31;border-radius:4px;padding:0 .6em;height:30px;width:220px;margin:2px;outline:none;font-size:13px;transition:border-color .15s;}
        #dcpurge input[type=password]:focus,#dcpurge input[type=text]:focus{border-color:#5865f2;}
        #dcpurge input::placeholder{color:#4e5058;}
        #dcpurge button{color:#fff;background:#5865f2;border:0;border-radius:4px;padding:5px 14px;margin:2px;cursor:pointer;font-size:13px;font-weight:500;transition:filter .15s;}
        #dcpurge button:hover{filter:brightness(1.1);}
        #dcpurge button.danger{background:#c03537;}
        #dcpurge button.success{background:#248046;}
        #dcpurge button.muted{background:#383a40;}
        #dcpurge button:disabled{opacity:.35;cursor:not-allowed;filter:none;}
        #dcpurge .log{overflow:auto;font-size:.72rem;font-family:Consolas,'Courier New',monospace;flex-grow:1;padding:10px 12px;white-space:pre-wrap;background:#111214;color:#c7cad1;border-top:1px solid #2b2d31;}
        #dcpurge .status-bar{padding:7px 14px;background:#111214;border-radius:0 0 8px 8px;border-top:1px solid #000;font-size:12px;color:#949ba4;display:flex;gap:14px;align-items:center;flex-wrap:wrap;}
        #dcpurge .status-bar strong{color:#fff;}
        #dcpurge progress{width:160px;height:6px;border-radius:3px;border:none;background:#2b2d31;vertical-align:middle;}
        #dcpurge progress::-webkit-progress-bar{background:#2b2d31;border-radius:3px;}
        #dcpurge progress::-webkit-progress-value{background:#5865f2;border-radius:3px;}
        #dcpurge .counter-pill{background:#248046;color:#fff;font-size:11px;font-weight:700;padding:2px 10px;border-radius:10px;letter-spacing:.3px;}
        #dcpurge .counter-pill.counting{background:#5865f2;}
        #dcpurge .ch-list{list-style:none;margin:4px 0 0;padding:0;overflow-y:auto;max-height:240px;}
        #dcpurge .ch-list li{display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:4px;font-size:12px;}
        #dcpurge .ch-list li:hover{background:#2b2d31;}
        #dcpurge .ch-label{flex:1;color:#dcddde;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
        #dcpurge .ch-id{color:#4e5058;font-size:10px;font-family:monospace;}
        #dcpurge .ch-date{color:#4e5058;font-size:10px;white-space:nowrap;}
        #dcpurge .ch-empty{color:#4e5058;font-size:12px;padding:20px;text-align:center;}
        #dcpurge .add-row{display:flex;gap:6px;align-items:center;flex-wrap:wrap;}
        #dcpurge .badge-count{display:inline-block;background:#c03537;color:#fff;border-radius:8px;font-size:10px;font-weight:700;padding:1px 6px;margin-left:4px;vertical-align:middle;}
        #dcpurge .badge-import{display:inline-block;background:#248046;color:#fff;border-radius:8px;font-size:10px;font-weight:700;padding:1px 6px;margin-left:4px;vertical-align:middle;}
        #dcpurge .import-drop{border:2px dashed #2b2d31;border-radius:6px;padding:28px;text-align:center;color:#949ba4;font-size:13px;cursor:pointer;background:#17181a;transition:border-color .2s,background .2s,color .2s;}
        #dcpurge .import-drop:hover,#dcpurge .import-drop.drag-over{border-color:#5865f2;background:#1e1f2e;color:#dcddde;}
        #dcpurge .import-drop input[type=file]{display:none;}
        #dcpurge .import-stats{background:#17181a;border:1px solid #2b2d31;border-radius:4px;padding:8px 12px;font-size:12px;color:#b5bac1;}
        #dcpurge code{background:#111214;border-radius:3px;padding:1px 5px;font-size:11px;color:#b5bac1;}
        .dcpurge-info{color:#00b0f4}.dcpurge-warn{color:#faa61a}.dcpurge-error{color:#f04747}.dcpurge-success{color:#43b581}.dcpurge-verb{color:#555760}
    `;
    document.head.appendChild(Object.assign(document.createElement('style'), { textContent: css }));

    // ── Panel ─────────────────────────────────────────────────────────────────
    const panel = document.createElement('div');
    panel.id = 'dcpurge';
    panel.style.display = 'none';
    panel.innerHTML = `
        <div class="hdr">
            🗑️ Discord Full Account Purge
            <button id="dcpurge-close" style="background:transparent;font-size:18px;padding:0 6px;">✕</button>
        </div>
        <div class="tabs">
            <div class="tab active" data-tab="main">Purge</div>
            <div class="tab" data-tab="import">Data Package <span class="badge-import" id="dcp-import-badge" style="display:none;"></span></div>
            <div class="tab" data-tab="exclusions">Exclusions <span class="badge-count" id="dcp-ex-badge" style="display:none;"></span></div>
        </div>

        <!-- ── Purge tab ── -->
        <div class="tab-panel active" id="tab-main">
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
            <div id="dcp-source-summary" style="font-size:12px;color:#72767d;margin-top:2px;"></div>
            <div style="font-size:12px;color:#faa61a;margin-top:2px;">⚠️ Deletes ALL your messages everywhere except excluded channels. Irreversible.</div>
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
                <button class="success" id="dcp-start">▶ Start Full Purge</button>
                <button class="danger" id="dcp-stop" disabled>⏹ Stop</button>
                <button id="dcp-clear">Clear Log</button>
                <label style="font-size:12px;"><input type="checkbox" id="dcp-autoscroll" checked> Auto-scroll</label>
            </div>
        </div>

        <!-- ── Import tab ── -->
        <div class="tab-panel" id="tab-import">
            <div style="font-size:12px;color:#72767d;">
                Import your Discord data package to catch <strong>closed DMs, old servers you've left, and deleted user DMs</strong> that the live API can't find.
                <br><br>
                <strong>How to get your data package:</strong>
                User Settings → Privacy &amp; Safety → Request Data Export → wait for email → download zip.
            </div>
            <div class="import-drop" id="dcp-drop-zone">
                <input type="file" id="dcp-file-input" accept=".json,.zip">
                <div style="font-size:28px;margin-bottom:8px;">📦</div>
                <div><strong>Drop your file here</strong> or <span style="color:#5865f2;text-decoration:underline;cursor:pointer;" id="dcp-browse-link">browse</span></div>
                <div style="font-size:11px;margin-top:6px;">Accepts <code>messages/index.json</code> or the full <code>package.zip</code></div>
            </div>
            <div class="import-stats" id="dcp-import-stats" style="display:none;"></div>
            <div style="display:flex;gap:6px;margin-top:4px;">
                <button id="dcp-import-clear" class="danger" style="display:none;">🗑️ Clear imported channels</button>
            </div>
            <ul class="ch-list" id="dcp-import-list"></ul>
            <div class="ch-empty" id="dcp-import-empty">No data package imported yet.</div>
        </div>

        <!-- ── Exclusions tab ── -->
        <div class="tab-panel" id="tab-exclusions">
            <div style="font-size:12px;color:#72767d;">Excluded channels are completely skipped — your messages there will <strong>not</strong> be deleted.</div>
            <div class="add-row">
                <button id="dcp-ex-add-current" class="success">＋ Exclude Current Channel</button>
                <span style="font-size:11px;color:#4f545c;">or paste an ID:</span>
                <input type="text" id="dcp-ex-manual-id" placeholder="Channel ID" style="width:150px;">
                <input type="text" id="dcp-ex-manual-label" placeholder="Label (optional)" style="width:150px;">
                <button id="dcp-ex-add-manual">Add</button>
                <button id="dcp-ex-clear-all" class="danger" style="margin-left:auto;">Clear All</button>
            </div>
            <ul class="ch-list" id="dcp-ex-list"></ul>
            <div class="ch-empty" id="dcp-ex-empty">No exclusions yet.</div>
        </div>

        <div class="log" id="dcp-log" style="flex-grow:1;">Ready. Fill in your token and author ID, then press Start Full Purge.\n</div>
        <div class="status-bar">
            <span id="dcp-channel-status">Idle</span>
            <progress id="dcp-progress" value="0" max="1" style="display:none;"></progress>
            <span id="dcp-percent"></span>
            <span style="margin-left:auto;display:flex;align-items:center;gap:6px;">
                <span>Total deleted:</span>
                <span class="counter-pill" id="dcp-total-counter">0</span>
            </span>
        </div>
    `;
    document.body.appendChild(panel);

    // ── Log ───────────────────────────────────────────────────────────────────
    const logEl = panel.querySelector('#dcp-log');
    const autoScroll = panel.querySelector('#dcp-autoscroll');
    function addLog(type, msg) {
        const line = Object.assign(document.createElement('div'), {
            className: type ? `dcpurge-${type}` : '',
            textContent: `[${new Date().toLocaleTimeString()}] ${msg}`
        });
        logEl.appendChild(line);
        while (logEl.children.length > 2000) logEl.removeChild(logEl.firstChild);
        if (autoScroll.checked) line.scrollIntoView(false);
    }

    // ── Tabs ──────────────────────────────────────────────────────────────────
    panel.querySelectorAll('.tab').forEach(tab => {
        tab.onclick = () => {
            panel.querySelectorAll('.tab,.tab-panel').forEach(el => el.classList.remove('active'));
            tab.classList.add('active');
            panel.querySelector(`#tab-${tab.dataset.tab}`).classList.add('active');
            if (tab.dataset.tab==='exclusions') renderExclusionList();
            if (tab.dataset.tab==='import') renderImportList();
            if (tab.dataset.tab==='main') updateSourceSummary();
        };
    });

    // ── Source summary on main tab ────────────────────────────────────────────
    function updateSourceSummary() {
        const imported = getImported();
        const importCount = Object.keys(imported).length;
        const exCount = Object.keys(getExclusions()).length;
        const el = panel.querySelector('#dcp-source-summary');
        const parts = [];
        if (importCount > 0) parts.push(`<span style="color:#3ba55d;">📦 ${importCount} channels from data package</span>`);
        if (exCount > 0) parts.push(`<span style="color:#faa61a;">⛔ ${exCount} exclusion(s)</span>`);
        if (parts.length === 0) {
            el.innerHTML = `Live API discovery only. <span style="color:#5865f2;cursor:pointer;text-decoration:underline;" id="dcp-go-import">Import your data package</span> for full coverage.`;
            el.querySelector('#dcp-go-import')?.addEventListener('click', () => panel.querySelector('.tab[data-tab="import"]').click());
        } else {
            el.innerHTML = parts.join(' &nbsp;·&nbsp; ');
        }
    }

    // ── Import tab logic ──────────────────────────────────────────────────────
    function renderImportList() {
        const imported = getImported();
        const entries = Object.entries(imported);
        const list = panel.querySelector('#dcp-import-list');
        const empty = panel.querySelector('#dcp-import-empty');
        const stats = panel.querySelector('#dcp-import-stats');
        const clearBtn = panel.querySelector('#dcp-import-clear');
        const badge = panel.querySelector('#dcp-import-badge');

        list.innerHTML = '';

        if (entries.length === 0) {
            empty.style.display = ''; stats.style.display = 'none';
            clearBtn.style.display = 'none'; badge.style.display = 'none';
            return;
        }

        empty.style.display = 'none';
        stats.style.display = '';
        clearBtn.style.display = '';
        badge.textContent = entries.length; badge.style.display = '';
        stats.innerHTML = `✅ <strong>${entries.length}</strong> channels loaded from data package. These will be merged with live API results (duplicates removed).`;

        entries.slice(0, 300).forEach(([channelId, label]) => {
            const li = document.createElement('li');
            li.innerHTML = `<span class="ch-label" title="${label}">${label}</span><span class="ch-id">${channelId}</span>`;
            list.appendChild(li);
        });
        if (entries.length > 300) {
            const li = document.createElement('li');
            li.innerHTML = `<span style="color:#72767d;font-size:11px;">… and ${entries.length-300} more</span>`;
            list.appendChild(li);
        }
    }

    // Drag and drop + file input
    const dropZone = panel.querySelector('#dcp-drop-zone');
    const fileInput = panel.querySelector('#dcp-file-input');

    panel.querySelector('#dcp-browse-link').onclick = () => fileInput.click();
    dropZone.onclick = (e) => { if (e.target.id !== 'dcp-browse-link') fileInput.click(); };

    dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
    dropZone.addEventListener('drop', e => {
        e.preventDefault(); dropZone.classList.remove('drag-over');
        const file = e.dataTransfer.files[0];
        if (file) handleImportFile(file);
    });
    fileInput.addEventListener('change', () => {
        if (fileInput.files[0]) handleImportFile(fileInput.files[0]);
    });

    async function handleImportFile(file) {
        const stats = panel.querySelector('#dcp-import-stats');
        stats.style.display = '';
        stats.innerHTML = `⏳ Parsing <strong>${file.name}</strong>…`;
        try {
            const parsed = await parseDataPackage(file);
            const count = Object.keys(parsed).length;
            if (count === 0) throw new Error('No channel IDs found in file. Make sure it is a valid messages/index.json or Discord data package zip.');
            saveImported(parsed);
            addLog('success', `📦 Imported ${count} channels from data package.`);
            renderImportList();
            updateSourceSummary();
        } catch(e) {
            stats.innerHTML = `❌ <span style="color:#ed4245;">${e.message}</span>`;
            addLog('error', `Import failed: ${e.message}`);
        }
    }

    panel.querySelector('#dcp-import-clear').onclick = () => {
        if (!window.confirm('Clear all imported channels? They will no longer be included in the purge.')) return;
        clearImported();
        addLog('warn', 'Cleared imported channel list.');
        renderImportList();
        updateSourceSummary();
    };

    // ── Exclusion list ────────────────────────────────────────────────────────
    function renderExclusionList() {
        const list = panel.querySelector('#dcp-ex-list');
        const empty = panel.querySelector('#dcp-ex-empty');
        const badge = panel.querySelector('#dcp-ex-badge');
        const entries = Object.entries(getExclusions());
        list.innerHTML = '';
        if (entries.length===0) { empty.style.display=''; badge.style.display='none'; return; }
        empty.style.display='none'; badge.textContent=entries.length; badge.style.display='';
        entries.forEach(([channelId, {label, addedAt}]) => {
            const li = document.createElement('li');
            li.innerHTML = `<span class="ch-label" title="${label}">${label}</span><span class="ch-id">${channelId}</span><span class="ch-date">${addedAt}</span><button class="danger" style="padding:2px 8px;font-size:11px;" data-id="${channelId}">Remove</button>`;
            li.querySelector('button').onclick = () => { removeExclusion(channelId); addLog('warn',`Removed exclusion: ${label}`); renderExclusionList(); };
            list.appendChild(li);
        });
    }

    panel.querySelector('#dcp-ex-add-current').onclick = () => {
        const channelId = getCurrentChannelId();
        if (!channelId) { addLog('warn','Navigate to a channel first.'); return; }
        if (isExcluded(channelId)) { addLog('warn',`Already excluded.`); return; }
        const label = document.querySelector('title')?.textContent?.replace(' | Discord','').trim() || `Channel ${channelId}`;
        addExclusion(channelId, label);
        addLog('success',`✅ Excluded: ${label} (${channelId})`);
        panel.querySelector('.tab[data-tab="exclusions"]').click();
    };
    panel.querySelector('#dcp-ex-add-manual').onclick = () => {
        const id = panel.querySelector('#dcp-ex-manual-id').value.trim();
        const label = panel.querySelector('#dcp-ex-manual-label').value.trim() || `Channel ${id}`;
        if (!id||!/^\d+$/.test(id)) { addLog('error','Enter a valid numeric channel ID.'); return; }
        if (isExcluded(id)) { addLog('warn',`Already excluded.`); return; }
        addExclusion(id, label);
        panel.querySelector('#dcp-ex-manual-id').value=''; panel.querySelector('#dcp-ex-manual-label').value='';
        addLog('success',`✅ Excluded: ${label} (${id})`); renderExclusionList();
    };
    panel.querySelector('#dcp-ex-clear-all').onclick = () => {
        const count = Object.keys(getExclusions()).length;
        if (!count) { addLog('warn','No exclusions to clear.'); return; }
        if (!window.confirm(`Remove all ${count} exclusions?`)) return;
        saveExclusions({}); addLog('warn',`Cleared all ${count} exclusions.`); renderExclusionList();
    };

    // ── Main UI events ────────────────────────────────────────────────────────
    panel.querySelector('#dcpurge-close').onclick = () => { panel.style.display='none'; };
    panel.querySelector('#dcp-clear').onclick = () => { logEl.innerHTML=''; };
    panel.querySelector('#dcp-get-token').onclick = () => {
        try {
            window.dispatchEvent(new Event('beforeunload'));
            const iframe = document.createElement('iframe');
            document.body.appendChild(iframe);
            panel.querySelector('#dcp-token').value = JSON.parse(iframe.contentWindow.localStorage.token||localStorage.token);
            document.body.removeChild(iframe);
        } catch { addLog('error','Could not auto-get token. Please paste it manually.'); }
    };
    panel.querySelector('#dcp-get-author').onclick = () => {
        try { panel.querySelector('#dcp-author').value = JSON.parse(localStorage.user_id_cache); }
        catch { addLog('error','Could not auto-get author ID. Please paste it manually.'); }
    };

    let stopFlag = false;
    let totalDeleted = 0;
    panel.querySelector('#dcp-stop').onclick = () => { stopFlag=true; addLog('warn','Stop requested…'); };

    const progress = panel.querySelector('#dcp-progress');
    const percent = panel.querySelector('#dcp-percent');
    const channelStatus = panel.querySelector('#dcp-channel-status');

    panel.querySelector('#dcp-start').onclick = async () => {
        const authToken = panel.querySelector('#dcp-token').value.trim();
        const authorId  = panel.querySelector('#dcp-author').value.trim();
        if (!authToken||!authorId) { addLog('error','Auth token and Author ID are required!'); return; }

        const startBtn = panel.querySelector('#dcp-start');
        const stopBtn  = panel.querySelector('#dcp-stop');
        startBtn.disabled=true; stopBtn.disabled=false; stopFlag=false; totalDeleted=0;
        const counterEl = panel.querySelector('#dcp-total-counter');
        counterEl.textContent='0'; counterEl.className='counter-pill counting';
        panel.querySelector('.tab[data-tab="main"]').click();

        // ── Step 1: live discovery ──
        addLog('info','Discovering channels via live API (DMs, friends list, servers)…');
        channelStatus.textContent = 'Discovering channels…';
        let liveChannels = [];
        try { liveChannels = await getAllChannels(authToken); }
        catch(e) { addLog('error',`Live discovery failed: ${e.message}`); }
        addLog('success',`Live API: found ${liveChannels.length} channels/DMs.`);

        // ── Step 2: merge imported ──
        const importedMap = getImported();
        const importedCount = Object.keys(importedMap).length;
        let allChannels = mergeChannels(liveChannels, importedMap);

        if (importedCount > 0) {
            const newFromImport = allChannels.filter(c => c.source==='import').length;
            addLog('success', `Data package: +${newFromImport} additional channels not in live API (${importedCount} total in package).`);
        }

        // ── Step 3: resolve guildIds for imported channels ──
        const needsResolve = allChannels.filter(c => c.source==='import');
        if (needsResolve.length > 0) {
            addLog('info',`Resolving guild IDs for ${needsResolve.length} imported channels…`);
            for (const ch of needsResolve) {
                if (stopFlag) break;
                ch.guildId = await resolveGuildId(authToken, ch.channelId, addLog);
                await new Promise(r => setTimeout(r, 200));
            }
            addLog('success','Guild ID resolution complete.');
        }

        // ── Step 4: apply exclusions ──
        const exclusions = getExclusions();
        const excluded = allChannels.filter(ch => exclusions[ch.channelId]);
        const channels = allChannels.filter(ch => !exclusions[ch.channelId]);

        if (excluded.length>0) {
            addLog('warn',`Skipping ${excluded.length} excluded channel(s):`);
            excluded.forEach(ch => addLog('verb',`  ⛔ ${ch.label} (${ch.channelId})`));
        }
        addLog('info',`Total to process: ${channels.length} channel(s).`);

        if (!window.confirm(
            `Ready to purge.\n\n` +
            `Live API channels: ${liveChannels.length}\n` +
            (importedCount>0 ? `From data package: +${allChannels.filter(c=>c.source==='import').length} additional\n` : '') +
            (excluded.length>0 ? `Excluded (skipped): ${excluded.length}\n` : '') +
            `\nWill process: ${channels.length} channel(s)\n\nThis CANNOT be undone. Continue?`
        )) { addLog('warn','Aborted by user.'); startBtn.disabled=false; stopBtn.disabled=true; return; }

        progress.style.display=''; progress.max=channels.length; progress.value=0;

        // ── Step 5: purge ──
        for (let i=0; i<channels.length; i++) {
            if (stopFlag) { addLog('warn','Purge stopped by user.'); break; }
            const ch = channels[i];
            channelStatus.textContent = `Channel ${i+1}/${channels.length}: ${ch.label}`;
            progress.value=i+1; percent.textContent=`${Math.round((i+1)/channels.length*100)}%`;
            addLog('info',`\n── Processing: ${ch.label} (guild: ${ch.guildId}, channel: ${ch.channelId})`);
            await deleteMessagesInChannel(authToken, authorId, ch.guildId, ch.channelId, {
                stopHndl: ()=>!stopFlag,
                logFn: (type,msg)=>addLog(type,msg),
                onProgress: (count) => {
                    totalDeleted++;
                    counterEl.textContent = totalDeleted.toLocaleString();
                },
            });
            await new Promise(r => setTimeout(r, 800));
        }

        addLog('success',`\n✅ Full purge complete! ${totalDeleted.toLocaleString()} message(s) deleted.`);
        channelStatus.textContent='Done'; counterEl.className='counter-pill'; startBtn.disabled=false; stopBtn.disabled=true;
    };

    // ── Toolbar button ────────────────────────────────────────────────────────
    const btn = document.createElement('div');
    btn.id='dcpurge-btn'; btn.title='Full Account Purge';
    btn.innerHTML=`<svg width="24" height="24" viewBox="0 0 24 24"><path fill="currentColor" d="M15 3.999V2H9V3.999H3V5.999H21V3.999H15Z"/><path fill="currentColor" d="M5 6.99902V18.999C5 20.101 5.897 20.999 7 20.999H17C18.103 20.999 19 20.101 19 18.999V6.99902H5ZM11 17H9V11H11V17ZM15 17H13V11H15V17Z"/></svg>`;
    btn.onclick=()=>{
        panel.style.display=panel.style.display==='none'?'':'none';
        if (panel.style.display!=='none') { renderExclusionList(); renderImportList(); updateSourceSummary(); }
    };
    function mountBtn() { const t=document.querySelector('[class^=toolbar]'); if(t&&!t.contains(btn)) t.appendChild(btn); }
    new MutationObserver(()=>{ if(!document.body.contains(btn)) mountBtn(); }).observe(document.body,{childList:true,subtree:true});
    mountBtn();

    renderExclusionList(); renderImportList(); updateSourceSummary();
})();
