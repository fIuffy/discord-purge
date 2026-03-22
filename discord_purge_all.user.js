// ==UserScript==
// @name          Discord Full Account Purge
// @description   Automatically deletes all your messages across all DMs, Group DMs, and Servers. Supports channel/DM exclusion lists.
// @namespace     https://github.com/YOUR_USERNAME/discord-purge
// @version       2.0
// @match         https://discord.com/*
// @grant         GM_getValue
// @grant         GM_setValue
// @run-at        document-idle
// @license       MIT
// ==/UserScript==

(function () {
    'use strict';

    // ── Persistent storage (GM if available, falls back to session Map) ───────
    const store = (() => {
        const hasgm = typeof GM_getValue !== 'undefined';
        const mem = {};
        return {
            get: (k, def) => { try { const raw = hasgm ? GM_getValue(k) : mem[k]; return raw === undefined ? def : JSON.parse(raw); } catch { return def; } },
            set: (k, v) => { const s = JSON.stringify(v); if (hasgm) GM_setValue(k, s); else mem[k] = s; },
        };
    })();

    const KEY_EXCLUSIONS = 'purge_exclusions';

    // ── Core delete function ──────────────────────────────────────────────────
    async function deleteMessagesInChannel(authToken, authorId, guildId, channelId, options = {}) {
        const { searchDelay=1500, deleteDelay=1400, delayIncrement=150, delayDecrement=-50, delayDecrementPerMsgs=1000, retryAfterMultiplier=3000, stopHndl=null, onProgress=null, logFn=console.log } = options;
        let deleteDelayCurrent = deleteDelay, delCount = 0, failCount = 0, avgPing = 0, lastPing = 0, grandTotal = null, throttledCount = 0, throttledTotalTime = 0, offset = 0;
        const wait = ms => new Promise(r => setTimeout(r, ms));
        const headers = { Authorization: authToken };

        async function recurse() {
            const BASE = guildId === '@me' ? `https://discord.com/api/v6/channels/${channelId}/messages/search` : `https://discord.com/api/v6/guilds/${guildId}/messages/search`;
            const params = new URLSearchParams();
            params.set('author_id', authorId);
            if (guildId !== '@me') params.set('channel_id', channelId);
            params.set('sort_by', 'timestamp'); params.set('sort_order', 'desc'); params.set('offset', offset);
            let resp;
            try { const s = Date.now(); resp = await fetch(`${BASE}?${params}`, { headers }); lastPing = Date.now()-s; avgPing = avgPing>0 ? avgPing*0.9+lastPing*0.1 : lastPing; }
            catch (err) { logFn('error', `Search error: ${err.message}`); return; }
            if (resp.status === 202) { const {retry_after:w} = await resp.json(); throttledCount++; throttledTotalTime+=w; logFn('warn',`Not indexed, waiting ${w}ms…`); await wait(w); return recurse(); }
            if (!resp.ok) {
                if (resp.status===429) { const {retry_after:w}=await resp.json(); throttledCount++;throttledTotalTime+=w; logFn('warn',`Rate limited! Cooling ${w*retryAfterMultiplier}ms…`); await wait(w*retryAfterMultiplier); return recurse(); }
                if (resp.status===403) { logFn('warn',`No permission for channel ${channelId}, skipping.`); return; }
                logFn('error',`Search failed: HTTP ${resp.status}`); return;
            }
            const data = await resp.json();
            if (!grandTotal) grandTotal = data.total_results;
            const hits = data.messages.map(c => c.find(m => m.hit));
            const toDelete = hits.filter(m => m.type===0 || m.type===6);
            const skipped = hits.filter(m => !toDelete.find(d => d.id===m.id));
            if (toDelete.length === 0) {
                if (data.total_results-offset > 0) { offset+=25; await wait(searchDelay); return recurse(); }
                logFn('success',`Channel done. Deleted: ${delCount}, Failed: ${failCount}`); return;
            }
            for (let j=0; j<toDelete.length; j++) {
                const msg = toDelete[j];
                if (stopHndl && !stopHndl()) { logFn('warn','Stopped by user.'); return; }
                logFn('info',`Deleting message ${msg.id} (${new Date(msg.timestamp).toLocaleString()})`);
                if (delCount>0 && delCount%delayDecrementPerMsgs===0) deleteDelayCurrent = Math.max(500, deleteDelayCurrent+delayDecrement);
                try {
                    const s = Date.now();
                    const dr = await fetch(`https://discord.com/api/v6/channels/${msg.channel_id}/messages/${msg.id}`, { headers, method:'DELETE' });
                    lastPing = Date.now()-s; avgPing = avgPing*0.9+lastPing*0.1;
                    if (!dr.ok) {
                        if (dr.status===429) { const {retry_after:w}=await dr.json(); throttledCount++;throttledTotalTime+=w; deleteDelayCurrent=Math.min(10000,deleteDelayCurrent+delayIncrement); logFn('warn',`Rate limited! Cooling ${w*retryAfterMultiplier}ms`); await wait(w*retryAfterMultiplier); j--; continue; }
                        else if (dr.status===403||dr.status===400) { logFn('warn',`Cannot delete ${msg.id} (${dr.status}), skipping.`); offset++;failCount++; }
                        else { logFn('error',`Delete error HTTP ${dr.status} for ${msg.id}`); failCount++; }
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

    // ── Fetch all channels ────────────────────────────────────────────────────
    async function getAllChannels(authToken) {
        const headers = { Authorization: authToken };
        const channels = [];
        try {
            const r = await fetch('https://discord.com/api/v9/users/@me/channels', { headers });
            if (r.ok) { const dms = await r.json(); for (const dm of dms) channels.push({ guildId:'@me', channelId:dm.id, label:dm.name||(dm.recipients?.[0]?.username??'DM') }); }
        } catch(e) { console.warn('Could not fetch DMs:',e); }
        try {
            const r = await fetch('https://discord.com/api/v9/users/@me/guilds', { headers });
            if (r.ok) {
                const guilds = await r.json();
                for (const guild of guilds) {
                    try {
                        const cr = await fetch(`https://discord.com/api/v9/guilds/${guild.id}/channels`, { headers });
                        if (cr.ok) { const gchannels = await cr.json(); gchannels.filter(c=>[0,5,10,11,12].includes(c.type)).forEach(ch => channels.push({ guildId:guild.id, channelId:ch.id, label:`${guild.name} → #${ch.name}` })); }
                    } catch(e) { console.warn(`Could not fetch channels for ${guild.name}:`,e); }
                    await new Promise(r => setTimeout(r, 300));
                }
            }
        } catch(e) { console.warn('Could not fetch guilds:',e); }
        return channels;
    }

    // ── Exclusion helpers ─────────────────────────────────────────────────────
    const getExclusions = () => store.get(KEY_EXCLUSIONS, {});
    const saveExclusions = ex => store.set(KEY_EXCLUSIONS, ex);
    const addExclusion = (channelId, label) => { const ex=getExclusions(); ex[channelId]={label,addedAt:new Date().toLocaleString()}; saveExclusions(ex); };
    const removeExclusion = channelId => { const ex=getExclusions(); delete ex[channelId]; saveExclusions(ex); };
    const isExcluded = channelId => !!getExclusions()[channelId];
    const getCurrentChannelId = () => { const m=location.href.match(/channels\/[\w@]+\/(\d+)/); return m?m[1]:null; };

    // ── CSS ───────────────────────────────────────────────────────────────────
    const css = `
        #dcpurge-btn{position:relative;height:24px;width:auto;flex:0 0 auto;margin:0 8px;cursor:pointer;color:var(--interactive-normal);}
        #dcpurge{position:fixed;top:60px;right:10px;bottom:10px;width:820px;z-index:9999;color:var(--text-normal);background:var(--background-secondary);box-shadow:var(--elevation-high);border-radius:6px;display:flex;flex-direction:column;font-family:sans-serif;}
        #dcpurge .hdr{padding:12px 16px;background:var(--background-tertiary);border-radius:6px 6px 0 0;font-weight:bold;display:flex;justify-content:space-between;align-items:center;}
        #dcpurge .tabs{display:flex;border-bottom:1px solid rgba(255,255,255,.1);background:var(--background-secondary);}
        #dcpurge .tab{padding:8px 18px;cursor:pointer;font-size:13px;color:#72767d;border-bottom:2px solid transparent;margin-bottom:-1px;user-select:none;}
        #dcpurge .tab.active{color:var(--text-normal);border-bottom-color:#5865f2;}
        #dcpurge .tab-panel{display:none;padding:10px;flex-direction:column;gap:6px;}
        #dcpurge .tab-panel.active{display:flex;}
        #dcpurge input[type=password],#dcpurge input[type=text]{background:#202225;color:#b9bbbe;border:0;border-radius:4px;padding:0 .5em;height:28px;width:220px;margin:3px;}
        #dcpurge button{color:#fff;background:#5865f2;border:0;border-radius:4px;padding:4px 12px;margin:3px;cursor:pointer;font-size:13px;}
        #dcpurge button.danger{background:#ed4245;}
        #dcpurge button.success{background:#3ba55d;}
        #dcpurge button:disabled{opacity:.4;cursor:not-allowed;}
        #dcpurge .log{overflow:auto;font-size:.72rem;font-family:Consolas,monospace;flex-grow:1;padding:10px;white-space:pre-wrap;}
        #dcpurge .status-bar{padding:6px 12px;background:var(--background-tertiary);border-radius:0 0 6px 6px;font-size:12px;display:flex;gap:16px;align-items:center;}
        #dcpurge progress{width:200px;}
        #dcpurge .ex-list{list-style:none;margin:6px 0 0;padding:0;overflow-y:auto;max-height:260px;}
        #dcpurge .ex-list li{display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:4px;font-size:12px;}
        #dcpurge .ex-list li:hover{background:rgba(255,255,255,.05);}
        #dcpurge .ex-label{flex:1;color:#b9bbbe;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
        #dcpurge .ex-id{color:#4f545c;font-size:10px;font-family:monospace;}
        #dcpurge .ex-date{color:#4f545c;font-size:10px;}
        #dcpurge .ex-add-row{display:flex;gap:6px;align-items:center;flex-wrap:wrap;}
        #dcpurge .ex-empty{color:#4f545c;font-size:12px;padding:16px;text-align:center;}
        #dcpurge .badge-count{display:inline-block;background:#ed4245;color:#fff;border-radius:8px;font-size:10px;padding:1px 6px;margin-left:4px;vertical-align:middle;}
        .dcpurge-info{color:#00b0f4}.dcpurge-warn{color:#faa61a}.dcpurge-error{color:#ed4245}.dcpurge-success{color:#3ba55d}.dcpurge-verb{color:#72767d}
    `;
    document.head.appendChild(Object.assign(document.createElement('style'), { textContent: css }));

    // ── Panel HTML ────────────────────────────────────────────────────────────
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
            <div class="tab" data-tab="exclusions">Exclusions <span class="badge-count" id="dcp-ex-badge" style="display:none"></span></div>
        </div>
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
            <div style="font-size:12px;color:#faa61a;margin-top:4px;">⚠️ Deletes ALL your messages everywhere except excluded channels. Irreversible.</div>
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
                <button class="success" id="dcp-start">▶ Start Full Purge</button>
                <button class="danger" id="dcp-stop" disabled>⏹ Stop</button>
                <button id="dcp-clear">Clear Log</button>
                <label style="font-size:12px;"><input type="checkbox" id="dcp-autoscroll" checked> Auto-scroll</label>
            </div>
        </div>
        <div class="tab-panel" id="tab-exclusions">
            <div style="font-size:12px;color:#72767d;">Excluded channels are completely skipped — your messages there will <strong>not</strong> be deleted.</div>
            <div class="ex-add-row">
                <button id="dcp-ex-add-current" class="success">＋ Exclude Current Channel</button>
                <span style="font-size:11px;color:#4f545c;">or paste an ID:</span>
                <input type="text" id="dcp-ex-manual-id" placeholder="Channel ID" style="width:150px;">
                <input type="text" id="dcp-ex-manual-label" placeholder="Label (optional)" style="width:150px;">
                <button id="dcp-ex-add-manual">Add</button>
                <button id="dcp-ex-clear-all" class="danger" style="margin-left:auto;">Clear All</button>
            </div>
            <ul class="ex-list" id="dcp-ex-list"></ul>
            <div class="ex-empty" id="dcp-ex-empty">No exclusions yet. Channels added here will be skipped during purge.</div>
        </div>
        <div class="log" id="dcp-log" style="flex-grow:1;">Ready. Fill in your token and author ID, then press Start Full Purge.\n</div>
        <div class="status-bar">
            <span id="dcp-channel-status">Idle</span>
            <progress id="dcp-progress" value="0" max="1" style="display:none;"></progress>
            <span id="dcp-percent"></span>
        </div>
    `;
    document.body.appendChild(panel);

    // ── Log helper ────────────────────────────────────────────────────────────
    const logEl = panel.querySelector('#dcp-log');
    const autoScroll = panel.querySelector('#dcp-autoscroll');
    function addLog(type, msg) {
        const line = Object.assign(document.createElement('div'), { className: type?`dcpurge-${type}`:'', textContent:`[${new Date().toLocaleTimeString()}] ${msg}` });
        logEl.appendChild(line);
        while (logEl.children.length > 2000) logEl.removeChild(logEl.firstChild);
        if (autoScroll.checked) line.scrollIntoView(false);
    }

    // ── Tab switching ─────────────────────────────────────────────────────────
    panel.querySelectorAll('.tab').forEach(tab => {
        tab.onclick = () => {
            panel.querySelectorAll('.tab, .tab-panel').forEach(el => el.classList.remove('active'));
            tab.classList.add('active');
            panel.querySelector(`#tab-${tab.dataset.tab}`).classList.add('active');
            if (tab.dataset.tab === 'exclusions') renderExclusionList();
        };
    });

    // ── Exclusion list rendering ──────────────────────────────────────────────
    function renderExclusionList() {
        const list = panel.querySelector('#dcp-ex-list');
        const empty = panel.querySelector('#dcp-ex-empty');
        const badge = panel.querySelector('#dcp-ex-badge');
        const entries = Object.entries(getExclusions());
        list.innerHTML = '';
        if (entries.length === 0) { empty.style.display=''; badge.style.display='none'; return; }
        empty.style.display = 'none';
        badge.textContent = entries.length; badge.style.display = '';
        entries.forEach(([channelId, { label, addedAt }]) => {
            const li = document.createElement('li');
            li.innerHTML = `<span class="ex-label" title="${label}">${label}</span><span class="ex-id">${channelId}</span><span class="ex-date">${addedAt}</span><button class="danger" style="padding:2px 8px;font-size:11px;" data-id="${channelId}">Remove</button>`;
            li.querySelector('button').onclick = () => { removeExclusion(channelId); addLog('warn',`Removed exclusion: ${label} (${channelId})`); renderExclusionList(); };
            list.appendChild(li);
        });
    }

    // ── Exclusion UI events ───────────────────────────────────────────────────
    panel.querySelector('#dcp-ex-add-current').onclick = () => {
        const channelId = getCurrentChannelId();
        if (!channelId) { addLog('warn','Navigate to a channel first.'); return; }
        if (isExcluded(channelId)) { addLog('warn',`Channel ${channelId} is already excluded.`); return; }
        const label = document.querySelector('title')?.textContent?.replace(' | Discord','').trim() || `Channel ${channelId}`;
        addExclusion(channelId, label);
        addLog('success',`✅ Excluded: ${label} (${channelId})`);
        panel.querySelector('.tab[data-tab="exclusions"]').click();
    };

    panel.querySelector('#dcp-ex-add-manual').onclick = () => {
        const id = panel.querySelector('#dcp-ex-manual-id').value.trim();
        const label = panel.querySelector('#dcp-ex-manual-label').value.trim() || `Channel ${id}`;
        if (!id||!/^\d+$/.test(id)) { addLog('error','Enter a valid numeric channel ID.'); return; }
        if (isExcluded(id)) { addLog('warn',`Channel ${id} is already excluded.`); return; }
        addExclusion(id, label);
        panel.querySelector('#dcp-ex-manual-id').value = '';
        panel.querySelector('#dcp-ex-manual-label').value = '';
        addLog('success',`✅ Excluded: ${label} (${id})`);
        renderExclusionList();
    };

    panel.querySelector('#dcp-ex-clear-all').onclick = () => {
        const count = Object.keys(getExclusions()).length;
        if (!count) { addLog('warn','No exclusions to clear.'); return; }
        if (!window.confirm(`Remove all ${count} exclusions?`)) return;
        saveExclusions({});
        addLog('warn',`Cleared all ${count} exclusions.`);
        renderExclusionList();
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
    panel.querySelector('#dcp-stop').onclick = () => { stopFlag=true; addLog('warn','Stop requested…'); };

    const progress = panel.querySelector('#dcp-progress');
    const percent = panel.querySelector('#dcp-percent');
    const channelStatus = panel.querySelector('#dcp-channel-status');

    panel.querySelector('#dcp-start').onclick = async () => {
        const authToken = panel.querySelector('#dcp-token').value.trim();
        const authorId = panel.querySelector('#dcp-author').value.trim();
        if (!authToken||!authorId) { addLog('error','Auth token and Author ID are required!'); return; }

        const startBtn = panel.querySelector('#dcp-start');
        const stopBtn = panel.querySelector('#dcp-stop');
        startBtn.disabled=true; stopBtn.disabled=false; stopFlag=false;
        panel.querySelector('.tab[data-tab="main"]').click();

        addLog('info','Discovering all channels and DMs…');
        channelStatus.textContent = 'Discovering channels…';

        let allChannels;
        try { allChannels = await getAllChannels(authToken); }
        catch(e) { addLog('error',`Failed to discover channels: ${e.message}`); startBtn.disabled=false; stopBtn.disabled=true; return; }

        const exclusions = getExclusions();
        const excluded = allChannels.filter(ch => exclusions[ch.channelId]);
        const channels = allChannels.filter(ch => !exclusions[ch.channelId]);

        addLog('success',`Found ${allChannels.length} total channels/DMs.`);
        if (excluded.length>0) { addLog('warn',`Skipping ${excluded.length} excluded channel(s):`); excluded.forEach(ch => addLog('verb',`  ⛔ ${ch.label} (${ch.channelId})`)); }
        addLog('info',`Will process ${channels.length} channel(s).`);

        if (!window.confirm(
            `Found ${allChannels.length} total channels/DMs.\n`+
            (excluded.length>0?`Skipping ${excluded.length} excluded channel(s).\n`:'')+
            `\nWill delete your messages from ${channels.length} channel(s).\nThis CANNOT be undone. Continue?`
        )) { addLog('warn','Aborted by user.'); startBtn.disabled=false; stopBtn.disabled=true; return; }

        progress.style.display=''; progress.max=channels.length; progress.value=0;

        for (let i=0; i<channels.length; i++) {
            if (stopFlag) { addLog('warn','Purge stopped by user.'); break; }
            const ch = channels[i];
            channelStatus.textContent = `Channel ${i+1}/${channels.length}: ${ch.label}`;
            progress.value=i+1; percent.textContent=`${Math.round((i+1)/channels.length*100)}%`;
            addLog('info',`\n── Processing: ${ch.label} (guild: ${ch.guildId}, channel: ${ch.channelId})`);
            await deleteMessagesInChannel(authToken, authorId, ch.guildId, ch.channelId, { stopHndl:()=>!stopFlag, logFn:(type,msg)=>addLog(type,msg) });
            await new Promise(r => setTimeout(r, 800));
        }

        addLog('success','\n✅ Full purge complete!');
        channelStatus.textContent='Done'; startBtn.disabled=false; stopBtn.disabled=true;
    };

    // ── Toolbar button ────────────────────────────────────────────────────────
    const btn = document.createElement('div');
    btn.id='dcpurge-btn'; btn.title='Full Account Purge';
    btn.innerHTML=`<svg width="24" height="24" viewBox="0 0 24 24"><path fill="currentColor" d="M15 3.999V2H9V3.999H3V5.999H21V3.999H15Z"/><path fill="currentColor" d="M5 6.99902V18.999C5 20.101 5.897 20.999 7 20.999H17C18.103 20.999 19 20.101 19 18.999V6.99902H5ZM11 17H9V11H11V17ZM15 17H13V11H15V17Z"/></svg>`;
    btn.onclick=()=>{ panel.style.display=panel.style.display==='none'?'':'none'; if(panel.style.display!=='none') renderExclusionList(); };
    function mountBtn() { const t=document.querySelector('[class^=toolbar]'); if(t&&!t.contains(btn)) t.appendChild(btn); }
    new MutationObserver(()=>{ if(!document.body.contains(btn)) mountBtn(); }).observe(document.body,{childList:true,subtree:true});
    mountBtn();

    renderExclusionList();
})();
