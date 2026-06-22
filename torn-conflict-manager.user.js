// ==UserScript==
// @name         Torn Conflict Manager
// @namespace    https://github.com/Nanthia/Torn-ATC
// @version      2.5.0
// @description  Airspace tracking, theatre map, Tiered Farm Tracker, Secure Zones, Auto-Sort, and High-Contrast UI.
// @author       Antheia
// @match        https://www.torn.com/*
// @updateURL    https://raw.githubusercontent.com/Nanthia/Torn-ATC/main/torn-conflict-manager.user.js
// @downloadURL  https://raw.githubusercontent.com/Nanthia/Torn-ATC/main/torn-conflict-manager.user.js
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      api.torn.com
// ==/UserScript==

(function () {
    'use strict';

    const API_BASE = "https://api.torn.com/v2/faction";

    const STANDARD_COUNTRY_NAMES = {
        "mexico": "Mexico", "canada": "Canada", "cayman islands": "Cayman Islands", "cayman": "Cayman Islands",
        "hawaii": "Hawaii", "united kingdom": "United Kingdom", "uk": "United Kingdom", "switzerland": "Switzerland",
        "argentina": "Argentina", "japan": "Japan", "china": "China", "united arab emirates": "UAE",
        "uae": "UAE", "south africa": "South Africa"
    };

    const HOSPITAL_ADJECTIVE_TO_COUNTRY = {
        "mexican": "Mexico", "canadian": "Canada", "caymanian": "Cayman Islands", "hawaiian": "Hawaii",
        "british": "United Kingdom", "swiss": "Switzerland", "argentinian": "Argentina", "japanese": "Japan",
        "chinese": "China", "emirati": "UAE", "south african": "South Africa"
    };

    const COUNTRY_FLAGS = {
        "Mexico": "🇲🇽", "Canada": "🇨🇦", "Cayman Islands": "🌴", "Hawaii": "🌺", "United Kingdom": "🇬🇧",
        "Switzerland": "🇨🇭", "Argentina": "🇦🇷", "Japan": "🇯🇵", "China": "🇨🇳", "UAE": "🇦🇪", "South Africa": "🇿🇦"
    };

    const FLIGHT_TIMES = {
        "Mexico": 20, "Canada": 37, "Cayman Islands": 57, "Hawaii": 121, "United Kingdom": 152,
        "Switzerland": 169, "Argentina": 189, "Japan": 203, "China": 219, "UAE": 259, "South Africa": 311
    };

    const COMPILED_COUNTRY_REGEXES = Object.entries(STANDARD_COUNTRY_NAMES).map(([key, val]) => ({
        regex: new RegExp(`\\b${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'), val
    }));

    let currentTab = 'map';
    let appState = 'loading';
    let lastErrorMsg = "";
    let pollMinutes = GM_getValue("torn_poll_minutes", 1);
    let targetPollTime = 0;
    let secondsLeftDisplay = pollMinutes * 60;
    let latestData = { theatreMap: {}, airspace: { ALLY: { returning: 0, outbound: 0 }, ENEMY: { returning: 0, outbound: 0 } }, timestamp: "" };

    let farmCache = JSON.parse(GM_getValue("tm_farm_cache", "{}"));
    Object.keys(farmCache).forEach(id => {
        if (typeof farmCache[id].hits === 'number') {
            farmCache[id].hitLog = [];
            delete farmCache[id].hits;
        }
    });

    function extractCountry(text) {
        if (!text) return null;
        for (const item of COMPILED_COUNTRY_REGEXES) {
            if (item.regex.test(text)) return item.val;
        }
        return null;
    }

    function getOverseasLocation(playerObj) {
        const state = playerObj.state || (playerObj.status && playerObj.status.state) || "";
        const description = playerObj.description || (playerObj.status && playerObj.status.description) || "";
        const details = (playerObj.status && playerObj.status.details) || "";
        const fullText = (description + " " + details).toLowerCase();

        if (!state || /\b(to torn|returning to torn)\b/.test(fullText)) return null;

        if (state === "Abroad") {
            const country = extractCountry(fullText);
            return country ? { country, isTransit: false, travelStatus: "LANDED" } : null;
        }
        if (state === "Hospital") {
            const match = fullText.match(/in an? ([a-z ]+?) hospital/);
            if (match) {
                const country = HOSPITAL_ADJECTIVE_TO_COUNTRY[match[1].trim()];
                if (country) return { country, isTransit: false, travelStatus: "HOSPITALISED" };
            }
            return null;
        }
        if (state === "Traveling") {
            const toMatch = fullText.match(/traveling from .+ to ([a-z\s]+)/);
            if (toMatch && !/\btorn\b/.test(toMatch[1].trim())) {
                const country = extractCountry(toMatch[1].trim());
                if (country) return { country, isTransit: true, travelStatus: "EN ROUTE" };
            }
        }
        return null;
    }

    function getAirspaceStatus(playerObj) {
        const state = playerObj.state || (playerObj.status && playerObj.status.state) || "";
        if (state !== "Traveling") return null;
        const fullText = ((playerObj.description || "") + " " + ((playerObj.status && playerObj.status.details) || "")).toLowerCase();
        return /\b(to torn|returning to torn)\b/.test(fullText) ? "RETURNING" : "OUTBOUND";
    }

    async function fetchApi(url) {
        const res = await fetch(url);
        const data = await res.json();
        if (data.error) throw new Error(typeof data.error === 'string' ? data.error : data.error.error || `Code ${data.error.code}`);
        return data;
    }

    function formatTime(totalSeconds) {
        const m = Math.floor(totalSeconds / 60);
        const s = totalSeconds % 60;
        return `${m}:${s.toString().padStart(2, '0')}`;
    }

    function formatOfflineString(lastActionMs) {
        const diff = Date.now() - lastActionMs;
        const mins = Math.floor(diff / 60000);
        if (mins < 60) return `Offline ${mins}m`;
        const hrs = Math.floor(mins / 60);
        return `Offline ${hrs}h ${mins % 60}m`;
    }

    function initUI() {
        if (document.getElementById('tm-conflict-container')) return;

        const savedPos = JSON.parse(GM_getValue("torn_ui_pos", "{}"));
        let isVisible = GM_getValue("tm_visible", true);

        const container = document.createElement('div');
        container.id = 'tm-conflict-container';
        Object.assign(container.style, {
            position: 'fixed', zIndex: '999999', background: 'rgba(30, 30, 36, 0.98)', border: '1px solid #3f3f46',
            borderRadius: '8px', fontFamily: 'monospace', boxShadow: '0 12px 40px rgba(0,0,0,0.8)',
            backdropFilter: 'blur(8px)', display: isVisible ? 'flex' : 'none', flexDirection: 'column',
            resize: 'both', overflow: 'hidden', width: savedPos.width || '300px', height: savedPos.height || 'auto',
            minWidth: '240px', minHeight: '120px'
        });

        if (savedPos.top && savedPos.left) {
            container.style.top = savedPos.top;
            container.style.left = savedPos.left;
        } else {
            container.style.bottom = '20px';
            container.style.right = '20px';
        }

        const header = document.createElement('div');
        header.id = 'tm-conflict-header';
        Object.assign(header.style, { padding: '7px 10px', background: 'rgba(40, 40, 48, 0.98)', borderBottom: '1px solid #3f3f46', cursor: 'move', color: '#e2e8f0', fontWeight: 'bold', fontSize: '11px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: '0', userSelect: 'none' });
        header.innerHTML = `
            <span style="color:#fbbf24;">🐝 Command Center</span>
            <div style="display:flex;gap:6px;align-items:center;">
                <span id="tm-refresh-data" style="cursor:pointer;font-size:11px;color:#fbbf24;padding:2px 5px;border:1px solid #475569;border-radius:3px;" title="Refresh Data">↻</span>
                <span id="tm-hide-widget" style="cursor:pointer;font-size:10px;color:#94a3b8;padding:2px 5px;border:1px solid #475569;border-radius:3px;" title="Hide">—</span>
                <span id="tm-open-settings" style="cursor:pointer;font-size:10px;color:#94a3b8;padding:2px 5px;border:1px solid #475569;border-radius:3px;" title="Settings">⚙</span>
            </div>`;

        const content = document.createElement('div');
        content.id = 'tm-conflict-content';
        Object.assign(content.style, { padding: '8px', flexGrow: '1', overflowY: 'auto', color: '#d4d4d8', fontSize: '11px' });

        container.appendChild(header);
        container.appendChild(content);
        document.body.appendChild(container);

        const fab = document.createElement('div');
        fab.id = 'tm-conflict-fab';
        Object.assign(fab.style, {
            position: 'fixed', bottom: '20px', left: '20px', zIndex: '999998', background: 'rgba(30, 30, 36, 0.98)',
            border: '1px solid #3f3f46', color: '#e2e8f0', padding: '7px 14px', borderRadius: '20px', cursor: 'pointer',
            fontWeight: 'bold', fontFamily: 'monospace', fontSize: '11px', boxShadow: '0 4px 15px rgba(0,0,0,0.5)',
            display: isVisible ? 'none' : 'flex', alignItems: 'center', gap: '5px'
        });
        fab.innerHTML = '🐝 <span style="color:#4ade80;">Radar</span>';
        document.body.appendChild(fab);

        function toggleVisibility() {
            isVisible = !isVisible;
            GM_setValue("tm_visible", isVisible);
            container.style.display = isVisible ? 'flex' : 'none';
            fab.style.display = isVisible ? 'none' : 'flex';
        }

        document.getElementById('tm-hide-widget').addEventListener('click', toggleVisibility);
        fab.addEventListener('click', toggleVisibility);

        header.querySelector('#tm-refresh-data').addEventListener('click', () => {
            const displayEl = document.getElementById('tm-countdown-display');
            if (displayEl) {
                displayEl.innerText = 'Syncing...';
                displayEl.style.color = '#4ade80';
            }
            targetPollTime = Date.now() + (pollMinutes * 60000);
            pollData();
        });

        document.getElementById('tm-open-settings').addEventListener('click', () => {
            appState = 'setup';
            renderUI();
        });

        let isDragging = false, offsetX, offsetY;
        header.addEventListener('mousedown', (e) => {
            if (['tm-open-settings', 'tm-hide-widget', 'tm-refresh-data'].includes(e.target.id)) return;
            isDragging = true;
            const rect = container.getBoundingClientRect();
            offsetX = e.clientX - rect.left;
            offsetY = e.clientY - rect.top;
        });
        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            container.style.bottom = 'auto';
            container.style.right = 'auto';
            container.style.left = Math.max(0, Math.min(e.clientX - offsetX, window.innerWidth - container.offsetWidth)) + 'px';
            container.style.top = Math.max(0, Math.min(e.clientY - offsetY, window.innerHeight - container.offsetHeight)) + 'px';
        });
        document.addEventListener('mouseup', () => {
            if (isDragging) {
                isDragging = false;
                GM_setValue("torn_ui_pos", JSON.stringify({ top: container.style.top, left: container.style.left, width: container.style.width, height: container.style.height }));
            }
        });

        new ResizeObserver(() => {
            if (!isDragging) {
                GM_setValue("torn_ui_pos", JSON.stringify({ top: container.style.top, left: container.style.left, width: container.style.width, height: container.style.height }));
            }
        }).observe(container);
    }

    function renderUI() {
        initUI();
        const contentDiv = document.getElementById('tm-conflict-content');
        if (!contentDiv) return;

        if (appState === 'setup') {
            const apiKey = GM_getValue("torn_api_key", "");
            const enemyId = GM_getValue("torn_enemy_id", "");
            const pMin = GM_getValue("torn_poll_minutes", 1);
            const canCancel = apiKey && enemyId && latestData.timestamp;

            contentDiv.innerHTML = `
                <div style="font-size:11px;">
                    <div style="margin-bottom:10px;font-weight:bold;border-bottom:1px solid #475569;padding-bottom:5px;color:#fbbf24;">⚙ Configuration</div>
                    <label style="font-size:9px;color:#94a3b8;display:block;margin-bottom:2px;">API KEY</label>
                    <input id="tm-apikey-input" type="password" placeholder="Your Torn API key" value="${apiKey}" style="width:100%;margin-bottom:8px;background:#18181b;color:#ffffff;border:1px solid #52525b;padding:5px 6px;box-sizing:border-box;border-radius:3px;font-family:monospace;font-size:11px;">
                    <label style="font-size:9px;color:#94a3b8;display:block;margin-bottom:2px;">ENEMY FACTION ID</label>
                    <input id="tm-enemyid-input" type="text" placeholder="e.g. 12345" value="${enemyId}" style="width:100%;margin-bottom:8px;background:#18181b;color:#ffffff;border:1px solid #52525b;padding:5px 6px;box-sizing:border-box;border-radius:3px;font-family:monospace;font-size:11px;">
                    <label style="font-size:9px;color:#94a3b8;display:block;margin-bottom:2px;">POLL INTERVAL</label>
                    <select id="tm-poll-input" style="width:100%;margin-bottom:12px;background:#18181b;color:#ffffff;border:1px solid #52525b;padding:5px 6px;box-sizing:border-box;border-radius:3px;font-family:monospace;font-size:11px;">
                        <option value="1"  ${pMin === 1  ? 'selected' : ''}>1 minute</option>
                        <option value="5"  ${pMin === 5  ? 'selected' : ''}>5 minutes</option>
                        <option value="10" ${pMin === 10 ? 'selected' : ''}>10 minutes</option>
                        <option value="15" ${pMin === 15 ? 'selected' : ''}>15 minutes</option>
                    </select>
                    <div style="display:flex;gap:6px;">
                        <button id="tm-save-config" style="flex:1;background:#4ade80;color:#064e3b;border:none;padding:7px;cursor:pointer;font-weight:bold;border-radius:4px;font-family:monospace;font-size:11px;">Save &amp; Launch</button>
                        ${canCancel ? `<button id="tm-cancel-config" style="flex:1;background:#3f3f46;color:#ffffff;border:1px solid #52525b;padding:7px;cursor:pointer;font-weight:bold;border-radius:4px;font-family:monospace;font-size:11px;">Cancel</button>` : ''}
                    </div>
                </div>`;

            document.getElementById('tm-save-config').addEventListener('click', () => {
                const keyVal = document.getElementById('tm-apikey-input').value.trim();
                const enemyVal = document.getElementById('tm-enemyid-input').value.trim();
                const intervalVal = parseInt(document.getElementById('tm-poll-input').value, 10);
                if (keyVal && enemyVal) {
                    GM_setValue("torn_api_key", keyVal);
                    GM_setValue("torn_enemy_id", enemyVal);
                    GM_setValue("torn_poll_minutes", intervalVal);
                    pollMinutes = intervalVal;
                    appState = 'loading';
                    renderUI();
                    targetPollTime = Date.now() + (pollMinutes * 60000);
                    pollData();
                }
            });

            if (canCancel) document.getElementById('tm-cancel-config').addEventListener('click', () => { appState = 'app'; renderUI(); });
            return;
        }

        if (appState === 'loading') {
            contentDiv.innerHTML = `<div style="text-align:center;padding:20px 0;color:#94a3b8;"><div style="font-size:16px;margin-bottom:6px;">🐝</div><div style="font-size:10px;letter-spacing:2px;color:#94a3b8;">SYNCING INTEL...</div></div>`;
            return;
        }

        if (appState === 'error') {
            contentDiv.innerHTML = `<div style="font-size:11px;"><div style="color:#ffffff;margin-bottom:8px;padding:8px;background:rgba(248,113,113,0.2);border:1px solid #ef4444;border-radius:4px;">❌ ${lastErrorMsg}</div><button id="tm-reset-error" style="width:100%;background:#3f3f46;color:#ffffff;border:1px solid #52525b;padding:6px;cursor:pointer;border-radius:4px;font-family:monospace;font-size:11px;">Return to Settings</button></div>`;
            document.getElementById('tm-reset-error').addEventListener('click', () => { appState = 'setup'; renderUI(); });
            return;
        }

        if (appState === 'app') {
            const tabActive = 'background:#224a30;color:#4ade80;font-weight:bold;border-color:#166534;';
            const tabInactive = 'background:#18181b;color:#a1a1aa;cursor:pointer;border-color:#52525b;';

            let html = `
                <div style="display:flex;justify-content:space-between;margin-bottom:12px;font-size:9px;color:#e4e4e7;background:#18181b;padding:6px 8px;border-radius:6px;border:1px solid #52525b;box-shadow:0 2px 4px rgba(0,0,0,0.3);">
                    <span>🕐 ${latestData.timestamp}</span>
                    <span id="tm-countdown-display" style="font-weight:bold;">Next: ${formatTime(secondsLeftDisplay)}</span>
                </div>
                <div style="display:flex;margin-bottom:12px;border-radius:6px;overflow:hidden;border:1px solid #52525b;font-size:10px;box-shadow:0 2px 4px rgba(0,0,0,0.3);">
                    <div id="tm-tab-map" style="flex:1;text-align:center;padding:6px 0;border:none;${currentTab === 'map' ? tabActive : tabInactive}">🗺 MAP</div>
                    <div id="tm-tab-air" style="flex:1;text-align:center;padding:6px 0;border:none;${currentTab === 'air' ? tabActive : tabInactive}">✈ AIRSPACE</div>
                    <div id="tm-tab-farm" style="flex:1;text-align:center;padding:6px 0;border:none;${currentTab === 'farm' ? tabActive : tabInactive}">🩸 CASUALTIES</div>
                </div>`;

            // ── MAP TAB ──────────────────────────────────────────────────
            if (currentTab === 'map') {
                const allDestinations = Object.keys(COUNTRY_FLAGS);
                let safeCountries = [];
                allDestinations.forEach(c => {
                    const d = latestData.theatreMap[c] || { E: 0, EH: 0, ET: 0 };
                    if (d.E === 0 && d.EH === 0 && d.ET === 0) {
                        safeCountries.push(c);
                    }
                });

                html += `<div style="margin-bottom:12px;">
                            <div style="font-size:9px;color:#4ade80;font-weight:bold;letter-spacing:1px;margin-bottom:6px;text-transform:uppercase;">🛡️ Secure Destinations</div>
                            <div style="display:flex;flex-wrap:wrap;gap:6px;">`;
                if (safeCountries.length === 0) {
                     html += `<div style="color:#a1a1aa;font-size:9px;">No secure destinations available.</div>`;
                } else {
                    safeCountries.forEach(c => {
                        html += `<div style="background:#18181b;border:1px solid #166534;color:#ffffff;font-size:10px;padding:4px 8px;border-radius:6px;display:flex;align-items:center;gap:6px;box-shadow:0 2px 4px rgba(0,0,0,0.3);"><span style="font-size:12px;">${COUNTRY_FLAGS[c]}</span> ${c}</div>`;
                    });
                }
                html += `   </div>
                         </div>`;

                const countries = Object.keys(latestData.theatreMap);

                if (countries.length === 0) {
                    html += `<div style="text-align:center;padding:18px 0;color:#a1a1aa;font-size:10px;letter-spacing:1px;">NO OVERSEAS DEPLOYMENTS</div>`;
                } else {
                    // Sorting Logic: Most Active Enemies -> Least Active Enemies
                    const sorted = countries.sort((a, b) => {
                        const da = latestData.theatreMap[a], db = latestData.theatreMap[b];
                        const enemyScoreA = da.E + da.ET;
                        const enemyScoreB = db.E + db.ET;

                        if (enemyScoreB !== enemyScoreA) {
                            return enemyScoreB - enemyScoreA;
                        }

                        const alliedScoreA = da.A + da.AT;
                        const alliedScoreB = db.A + db.AT;
                        return alliedScoreB - alliedScoreA;
                    });

                    sorted.forEach(country => {
                        const d = latestData.theatreMap[country];
                        const flightMin = FLIGHT_TIMES[country] || 0;

                        html += `
                        <div style="margin-bottom:12px;background:#18181b;border:1px solid #52525b;border-radius:6px;box-shadow:0 6px 12px rgba(0,0,0,0.4);overflow:hidden;">

                            <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 10px;border-bottom:1px solid #3f3f46;background:#27272a;">
                                <div style="display:flex;align-items:center;gap:8px;">
                                    <span style="font-size:16px;line-height:1;">${d.flag}</span>
                                    <div>
                                        <div style="color:#ffffff;font-weight:bold;font-size:12px;letter-spacing:0.5px;">${country}</div>
                                        ${flightMin ? `<div style="color:#a1a1aa;font-size:9px;">${flightMin}m flight</div>` : ''}
                                    </div>
                                </div>
                            </div>

                            <div style="display:grid;grid-template-columns:1fr 1px 1fr;gap:0;padding:8px 10px;">
                                <div>
                                    <div style="font-size:9px;color:#4ade80;font-weight:bold;letter-spacing:1px;margin-bottom:6px;text-align:center;">ALLIED</div>
                                    <div style="display:flex;justify-content:space-around;">
                                        <div style="text-align:center;"><div style="font-size:16px;font-weight:bold;color:${d.A > 0 ? '#4ade80' : '#71717a'};line-height:1;">${d.A}</div><div style="font-size:8px;color:#e4e4e7;margin-top:3px;font-weight:bold;">LANDED</div></div>
                                        <div style="text-align:center;"><div style="font-size:16px;font-weight:bold;color:${d.AH > 0 ? '#fca5a5' : '#71717a'};line-height:1;">${d.AH}</div><div style="font-size:8px;color:#e4e4e7;margin-top:3px;font-weight:bold;">HOSP</div></div>
                                        <div style="text-align:center;"><div style="font-size:16px;font-weight:bold;color:${d.AT > 0 ? '#60a5fa' : '#71717a'};line-height:1;">${d.AT}</div><div style="font-size:8px;color:#e4e4e7;margin-top:3px;font-weight:bold;">INBOUND</div></div>
                                    </div>
                                </div>
                                <div style="background:#52525b;margin:0 4px;"></div>
                                <div>
                                    <div style="font-size:9px;color:#f87171;font-weight:bold;letter-spacing:1px;margin-bottom:6px;text-align:center;">HOSTILE</div>
                                    <div style="display:flex;justify-content:space-around;">
                                        <div style="text-align:center;"><div style="font-size:16px;font-weight:bold;color:${d.E > 0 ? '#ef4444' : '#71717a'};line-height:1;">${d.E}</div><div style="font-size:8px;color:#e4e4e7;margin-top:3px;font-weight:bold;">LANDED</div></div>
                                        <div style="text-align:center;"><div style="font-size:16px;font-weight:bold;color:${d.EH > 0 ? '#fca5a5' : '#71717a'};line-height:1;">${d.EH}</div><div style="font-size:8px;color:#e4e4e7;margin-top:3px;font-weight:bold;">HOSP</div></div>
                                        <div style="text-align:center;"><div style="font-size:16px;font-weight:bold;color:${d.ET > 0 ? '#fb923c' : '#71717a'};line-height:1;">${d.ET}</div><div style="font-size:8px;color:#e4e4e7;margin-top:3px;font-weight:bold;">INBOUND</div></div>
                                    </div>
                                </div>
                            </div>
                        </div>`;
                    });
                }
            }

            // ── AIRSPACE TAB ─────────────────────────────────────────────
            else if (currentTab === 'air') {
                const a = latestData.airspace;
                const totalFlying = a.ALLY.returning + a.ALLY.outbound + a.ENEMY.returning + a.ENEMY.outbound;
                let totalConflicts = 0, totalAllied = 0, totalEnemy = 0;

                Object.keys(latestData.theatreMap).forEach(c => {
                    const d = latestData.theatreMap[c];
                    totalAllied += d.A + d.AT;
                    totalEnemy += d.E + d.ET;
                    if ((d.A + d.AT) > 0 && (d.E + d.ET) > 0) totalConflicts++;
                });

                html += `
                    <div style="display:flex;gap:6px;margin-bottom:12px;font-size:9px;">
                        <div style="flex:1;background:#18181b;border:1px solid #7f1d1d;border-radius:6px;padding:6px 8px;text-align:center;box-shadow:0 4px 8px rgba(0,0,0,0.4);"><div style="color:#ffffff;font-weight:bold;font-size:14px;">${totalConflicts}</div><div style="color:#fca5a5;letter-spacing:1px;margin-top:2px;font-weight:bold;">CONFLICTS</div></div>
                        <div style="flex:1;background:#18181b;border:1px solid #14532d;border-radius:6px;padding:6px 8px;text-align:center;box-shadow:0 4px 8px rgba(0,0,0,0.4);"><div style="color:#ffffff;font-weight:bold;font-size:14px;">${totalAllied}</div><div style="color:#86efac;letter-spacing:1px;margin-top:2px;font-weight:bold;">ALLIED</div></div>
                        <div style="flex:1;background:#18181b;border:1px solid #78350f;border-radius:6px;padding:6px 8px;text-align:center;box-shadow:0 4px 8px rgba(0,0,0,0.4);"><div style="color:#ffffff;font-weight:bold;font-size:14px;">${totalEnemy}</div><div style="color:#fcd34d;letter-spacing:1px;margin-top:2px;font-weight:bold;">HOSTILE</div></div>
                    </div>

                    <div style="text-align:center;margin-bottom:10px;font-size:11px;color:#e4e4e7;font-weight:bold;letter-spacing:1px;">${totalFlying} UNITS IN FLIGHT</div>

                    <div style="margin-bottom:12px;background:#18181b;border:1px solid #52525b;border-radius:6px;padding:10px;box-shadow:0 4px 8px rgba(0,0,0,0.4);">
                        <div style="color:#4ade80;font-size:10px;font-weight:bold;letter-spacing:2px;margin-bottom:8px;text-align:center;">ALLIED FLIGHTS</div>
                        <div style="display:flex;gap:8px;">
                            <div style="flex:1;text-align:center;background:#27272a;border:1px solid #3f3f46;border-radius:4px;padding:8px 4px;"><div style="font-size:18px;font-weight:bold;color:${a.ALLY.returning > 0 ? '#4ade80' : '#71717a'};line-height:1;">${a.ALLY.returning}</div><div style="font-size:8px;color:#e4e4e7;margin-top:4px;letter-spacing:1px;font-weight:bold;">RETURNING</div></div>
                            <div style="flex:1;text-align:center;background:#27272a;border:1px solid #3f3f46;border-radius:4px;padding:8px 4px;"><div style="font-size:18px;font-weight:bold;color:${a.ALLY.outbound > 0 ? '#86efac' : '#71717a'};line-height:1;">${a.ALLY.outbound}</div><div style="font-size:8px;color:#e4e4e7;margin-top:4px;letter-spacing:1px;font-weight:bold;">OUTBOUND</div></div>
                        </div>
                    </div>

                    <div style="background:#18181b;border:1px solid #52525b;border-radius:6px;padding:10px;box-shadow:0 4px 8px rgba(0,0,0,0.4);">
                        <div style="color:#f87171;font-size:10px;font-weight:bold;letter-spacing:2px;margin-bottom:8px;text-align:center;">HOSTILE FLIGHTS</div>
                        <div style="display:flex;gap:8px;">
                            <div style="flex:1;text-align:center;background:#27272a;border:1px solid #3f3f46;border-radius:4px;padding:8px 4px;"><div style="font-size:18px;font-weight:bold;color:${a.ENEMY.returning > 0 ? '#f87171' : '#71717a'};line-height:1;">${a.ENEMY.returning}</div><div style="font-size:8px;color:#e4e4e7;margin-top:4px;letter-spacing:1px;font-weight:bold;">RETURNING</div></div>
                            <div style="flex:1;text-align:center;background:#27272a;border:1px solid #3f3f46;border-radius:4px;padding:8px 4px;"><div style="font-size:18px;font-weight:bold;color:${a.ENEMY.outbound > 0 ? '#fb923c' : '#71717a'};line-height:1;">${a.ENEMY.outbound}</div><div style="font-size:8px;color:#e4e4e7;margin-top:4px;letter-spacing:1px;font-weight:bold;">OUTBOUND</div></div>
                        </div>
                    </div>`;
            }

            // ── FARM TAB ─────────────────────────────────────────────────
            else if (currentTab === 'farm') {
                const now = Date.now();
                let targets = [];

                Object.keys(farmCache).forEach(id => {
                    const data = farmCache[id];
                    const hitCount = data.hitLog.length;

                    if (hitCount >= 3) {
                        const offlineDuration = now - data.lastAction;
                        let category = null;
                        let color = '';
                        let sortWeight = 0;

                        if (offlineDuration <= 15 * 60 * 1000) {
                            category = 'STUCK / ACTIVE'; color = '#fca5a5'; sortWeight = 4;
                        } else if (offlineDuration > 3 * 60 * 60 * 1000 && hitCount > 5) {
                            category = 'HIGH TARGET'; color = '#ef4444'; sortWeight = 3;
                        } else if (offlineDuration > 60 * 60 * 1000 && hitCount > 3) {
                            category = 'MEDIUM TARGET'; color = '#fb923c'; sortWeight = 2;
                        } else if (offlineDuration > 15 * 60 * 1000 && hitCount >= 3) {
                            category = 'LIGHT TARGET'; color = '#fcd34d'; sortWeight = 1;
                        }

                        if (category) {
                            targets.push({ id, ...data, hitCount, category, color, sortWeight, offlineDuration });
                        }
                    }
                });

                if (targets.length === 0) {
                    html += `<div style="text-align:center;padding:18px 0;color:#a1a1aa;font-size:10px;letter-spacing:1px;">ALL UNITS SECURE</div>`;
                } else {
                    targets.sort((a, b) => b.sortWeight - a.sortWeight || b.hitCount - a.hitCount);

                    targets.forEach(p => {
                        const isStuck = p.category === 'STUCK / ACTIVE';
                        html += `
                        <div style="display:flex;align-items:center;justify-content:space-between;background:#18181b;border:1px solid #52525b;border-radius:6px;padding:8px 10px;margin-bottom:10px;box-shadow:0 4px 8px rgba(0,0,0,0.4);">
                            <div>
                                <a href="https://www.torn.com/profiles.php?XID=${p.id}" target="_blank" style="color:#ffffff;text-decoration:none;font-weight:bold;font-size:13px;letter-spacing:0.5px;">${p.name}</a>
                                <div style="display:flex;gap:8px;align-items:center;margin-top:4px;">
                                    <span style="color:${p.color};font-size:9px;font-weight:bold;letter-spacing:1px;">${p.category}</span>
                                    <span style="color:#a1a1aa;font-size:9px;">| ${isStuck ? 'Online' : formatOfflineString(p.lastAction)}</span>
                                </div>
                            </div>
                            <div style="background:#27272a;border:1px solid #3f3f46;border-radius:4px;padding:4px 8px;text-align:center;">
                                <div style="color:${p.color};font-weight:bold;font-size:14px;line-height:1;">${p.hitCount}</div>
                                <div style="color:#e4e4e7;font-size:8px;letter-spacing:1px;margin-top:2px;font-weight:bold;">HITS</div>
                            </div>
                        </div>`;
                    });
                }
            }

            contentDiv.innerHTML = html;

            const tabMap = document.getElementById('tm-tab-map');
            const tabAir = document.getElementById('tm-tab-air');
            const tabFarm = document.getElementById('tm-tab-farm');
            if (tabMap) tabMap.addEventListener('click', () => { currentTab = 'map'; renderUI(); });
            if (tabAir) tabAir.addEventListener('click', () => { currentTab = 'air'; renderUI(); });
            if (tabFarm) tabFarm.addEventListener('click', () => { currentTab = 'farm'; renderUI(); });
        }
    }

    async function pollData() {
        const apiKey = GM_getValue("torn_api_key", "");
        const enemyId = GM_getValue("torn_enemy_id", "");

        if (!apiKey || !enemyId) {
            appState = 'setup';
            renderUI();
            return;
        }

        try {
            const [myFactionData, enemyData] = await Promise.all([
                fetchApi(`${API_BASE}?selections=members&key=${apiKey}`),
                fetchApi(`${API_BASE}/${enemyId}?selections=members&key=${apiKey}`)
            ]);

            const myMembers = Array.isArray(myFactionData.members) ? myFactionData.members : Object.values(myFactionData.members || {});
            const enemyMembers = Array.isArray(enemyData.members) ? enemyData.members : Object.values(enemyData.members || {});

            const now = Date.now();
            const decayThreshold = 3 * 60 * 60 * 1000;
            const currentMemberIds = new Set(myMembers.map(m => m.id.toString()));

            myMembers.forEach(m => {
                const id = m.id.toString();
                const state = m.status.state;
                const lastAction = m.last_action.timestamp * 1000;

                if (!farmCache[id]) {
                    farmCache[id] = { name: m.name, previousState: state, hitLog: [], lastAction: lastAction, lastUpdated: now, okayCount: 0 };
                } else {
                    let cache = farmCache[id];
                    cache.name = m.name;
                    cache.lastAction = lastAction;
                    cache.lastUpdated = now;

                    if (cache.previousState === 'Okay' && state === 'Hospital') {
                        cache.hitLog.push(now);
                        cache.okayCount = 0;
                    } else if (state === 'Okay' || state === 'Traveling') {
                        if (cache.previousState === state) cache.okayCount++;
                    } else if (state === 'Hospital') {
                        cache.okayCount = 0;
                    }
                    cache.previousState = state;
                }
            });

            Object.keys(farmCache).forEach(id => {
                const cache = farmCache[id];
                cache.hitLog = cache.hitLog.filter(ts => (now - ts) <= decayThreshold);

                if (!currentMemberIds.has(id) ||
                    (now - cache.lastUpdated > decayThreshold) ||
                    (cache.hitLog.length === 0 && cache.okayCount > 2) ||
                    (cache.okayCount > 5)) {
                    delete farmCache[id];
                }
            });

            GM_setValue("tm_farm_cache", JSON.stringify(farmCache));

            const newTheatreMap = {};
            const newAirspace = { ALLY: { returning: 0, outbound: 0 }, ENEMY: { returning: 0, outbound: 0 } };

            function mapParticipant(member, type) {
                const airStatus = getAirspaceStatus(member);
                if (airStatus) {
                    if (airStatus === "RETURNING") newAirspace[type].returning++;
                    else newAirspace[type].outbound++;
                }

                const loc = getOverseasLocation(member);
                if (!loc) return;

                const country = loc.country;
                if (!newTheatreMap[country]) {
                    newTheatreMap[country] = { A: 0, AH: 0, AT: 0, E: 0, EH: 0, ET: 0, flag: COUNTRY_FLAGS[country] || "📍" };
                }

                if (loc.isTransit) {
                    if (type === "ALLY") newTheatreMap[country].AT++;
                    else newTheatreMap[country].ET++;
                } else if (loc.travelStatus === "HOSPITALISED") {
                    if (type === "ALLY") newTheatreMap[country].AH++;
                    else newTheatreMap[country].EH++;
                } else {
                    if (type === "ALLY") newTheatreMap[country].A++;
                    else newTheatreMap[country].E++;
                }
            }

            myMembers.forEach(m => mapParticipant(m, "ALLY"));
            enemyMembers.forEach(m => mapParticipant(m, "ENEMY"));

            latestData.theatreMap = newTheatreMap;
            latestData.airspace = newAirspace;
            latestData.timestamp = new Date().toLocaleTimeString();

            appState = 'app';
            targetPollTime = Date.now() + (pollMinutes * 60000);
            renderUI();

        } catch (err) {
            if (err.code === 5) {
                console.warn('[TornConflictManager] Rate limited — retrying in 60s');
                targetPollTime = Date.now() + 60000;
                const displayEl = document.getElementById('tm-countdown-display');
                if (displayEl) displayEl.innerText = 'Rate limited — 60s';
                return;
            }
            appState = 'error';
            lastErrorMsg = err.message || 'Unknown error';
            renderUI();
        }
    }

    function boot() {
        const key = GM_getValue("torn_api_key", "");
        const eid = GM_getValue("torn_enemy_id", "");

        appState = (key && eid) ? 'loading' : 'setup';
        renderUI();

        if (key && eid) {
            targetPollTime = Date.now() + (pollMinutes * 60000);
            pollData();
        }

        setInterval(() => {
            if (appState !== 'app') return;

            const now = Date.now();

            if (now >= targetPollTime) {
                targetPollTime = now + (pollMinutes * 60000);
                const displayEl = document.getElementById('tm-countdown-display');
                if (displayEl) {
                    displayEl.innerText = 'Syncing...';
                    displayEl.style.color = '#4ade80';
                }
                pollData();
            } else {
                secondsLeftDisplay = Math.ceil((targetPollTime - now) / 1000);
                const displayEl = document.getElementById('tm-countdown-display');
                if (displayEl) {
                    displayEl.innerText = `Next: ${formatTime(secondsLeftDisplay)}`;
                    displayEl.style.color = '#e4e4e7';
                }
            }
        }, 1000);
    }

    setTimeout(boot, 500);

})();
