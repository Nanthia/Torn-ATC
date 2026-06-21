// ==UserScript==
// @name         Torn Conflict Manager
// @namespace    https://github.com/Nanthia/Torn-ATC
// @version      1.5.8
// @description  Airspace tracking, transit splits, grid UI, floating hide button, absolute timing, and pre-compiled regex engine.
// @author       Antheia
// @match        https://www.torn.com/*
// @updateURL    https://raw.githubusercontent.com/Nanthia/Torn-ATC/main/torn-conflict-manager.user.js
// @downloadURL  https://raw.githubusercontent.com/Nanthia/Torn-ATC/main/torn-conflict-manager.user.js
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      api.torn.com
// ==/UserScript==

(function() {
    'use strict';

    const API_BASE = "https://api.torn.com/v2/faction";

    const standardCountryNames = {
        "argentina": "Argentina", "australia": "Australia", "brazil": "Brazil", "canada": "Canada",
        "cayman islands": "Cayman Islands", "cayman": "Cayman Islands", "china": "China",
        "france": "France", "germany": "Germany", "hawaii": "Hawaii", "italy": "Italy",
        "japan": "Japan", "london": "United Kingdom", "mexico": "Mexico", "netherlands": "Netherlands",
        "south africa": "South Africa", "spain": "Spain", "switzerland": "Switzerland", "uae": "UAE",
        "united arab emirates": "UAE", "uk": "United Kingdom", "united kingdom": "United Kingdom",
        "usa": "USA", "united states": "USA", "dubai": "UAE", "zurich": "Switzerland", "vancouver": "Canada"
    };

    const HOSPITAL_ADJECTIVE_TO_COUNTRY = {
        "mexican": "Mexico", "caymanian": "Cayman Islands", "canadian": "Canada", "hawaiian": "Hawaii",
        "british": "United Kingdom", "argentinian": "Argentina", "swiss": "Switzerland",
        "japanese": "Japan", "chinese": "China", "emirati": "UAE", "south african": "South Africa"
    };

    const countryFlags = {
        "argentina": "🇦🇷", "australia": "🇦🇺", "brazil": "🇧🇷", "canada": "🇨🇦", "cayman islands": "🌴",
        "china": "🇨🇳", "france": "🇫🇷", "germany": "🇩🇪", "hawaii": "🌺", "italy": "🇮🇹", "japan": "🇯🇵",
        "mexico": "🇲🇽", "netherlands": "🇳🇱", "south africa": "🇿🇦", "spain": "🇪🇸", "switzerland": "🇨🇭",
        "uae": "🇦🇪", "uk": "🇬🇧", "usa": "🇺🇸"
    };

    // --- Optimization: Pre-compile Regexes to prevent memory leaks during rapid loops ---
    const compiledCountryRegexes = Object.entries(standardCountryNames).map(([key, val]) => ({
        regex: new RegExp(`\\b${key}\\b`),
        val: val
    }));

    // --- State Management ---
    let currentTab = 'map'; 
    let appState = 'loading'; 
    let lastErrorMsg = "";
    
    let pollMinutes = GM_getValue("torn_poll_minutes", 1);
    
    // Absolute timing variables
    let targetPollTime = 0;
    let secondsLeftDisplay = pollMinutes * 60;
    
    let latestData = {
        theatreMap: {},
        airspace: {
            ALLY: { returning: 0, outbound: 0 },
            ENEMY: { returning: 0, outbound: 0 }
        },
        timestamp: ""
    };

    // --- Parsers ---
    function getOverseasLocation(playerObj) {
        const state = playerObj.state || (playerObj.status && playerObj.status.state) || "";
        const description = playerObj.description || (playerObj.status && playerObj.status.description) || "";
        const details = (playerObj.status && playerObj.status.details) || "";
        const fullText = (description + " " + details).toLowerCase();

        if (!state) return null;
        if (fullText.match(/\b(to torn|returning)\b/)) return null;

        const extractCountry = (str) => {
            for (const item of compiledCountryRegexes) {
                if (item.regex.test(str)) return item.val;
            }
            return null;
        };

        if (state === "Abroad") {
            const country = extractCountry(fullText);
            if (country) return { country, isTransit: false };
        }
        if (state === "Hospital") {
            const match = fullText.match(/in an? ([a-z ]+?) hospital/);
            if (match && HOSPITAL_ADJECTIVE_TO_COUNTRY[match[1].trim()]) {
                return { country: HOSPITAL_ADJECTIVE_TO_COUNTRY[match[1].trim()], isTransit: false };
            }
        }
        if (state === "Traveling") {
            const toMatch = fullText.match(/to\s+([a-z\s]+)/);
            if (toMatch) {
                const country = extractCountry(toMatch[1]);
                if (country) return { country, isTransit: true };
            }
        }
        return null;
    }

    function getAirspaceStatus(playerObj) {
        const state = playerObj.state || (playerObj.status && playerObj.status.state) || "";
        if (state !== "Traveling") return null;

        const description = playerObj.description || (playerObj.status && playerObj.status.description) || "";
        const details = (playerObj.status && playerObj.status.details) || "";
        const fullText = (description + " " + details).toLowerCase();

        const isReturning = fullText.match(/\b(to torn|returning)\b/);
        return isReturning ? "RETURNING" : "OUTBOUND";
    }

    async function fetchApi(url) {
        const res = await fetch(url);
        const data = await res.json();
        if (data.error) {
            const errorMsg = typeof data.error === 'string' ? data.error : data.error.error;
            throw new Error(errorMsg || "API Error");
        }
        return data;
    }

    function formatTime(totalSeconds) {
        const m = Math.floor(totalSeconds / 60);
        const s = totalSeconds % 60;
        return `${m}:${s.toString().padStart(2, '0')}`;
    }

    // --- UI Container Initialization ---
    function initUI() {
        if (document.getElementById('tm-conflict-container')) return;
        
        const savedPos = JSON.parse(GM_getValue("torn_ui_pos", "{}"));
        let isVisible = GM_getValue("tm_visible", true);

        const container = document.createElement('div');
        container.id = 'tm-conflict-container';
        container.style.position = 'fixed';
        container.style.zIndex = '999999';
        container.style.background = 'rgba(15,15,15,0.95)';
        container.style.border = '1px solid #333';
        container.style.borderRadius = '6px';
        container.style.fontFamily = 'monospace';
        container.style.boxShadow = '0 4px 15px rgba(0,0,0,0.8)';
        container.style.backdropFilter = 'blur(4px)';
        container.style.display = isVisible ? 'flex' : 'none';
        container.style.flexDirection = 'column';
        container.style.resize = 'both';
        container.style.overflow = 'hidden'; 
        container.style.width = savedPos.width || '260px';
        container.style.height = savedPos.height || 'auto';
        if (savedPos.top && savedPos.left) {
            container.style.top = savedPos.top;
            container.style.left = savedPos.left;
        } else {
            container.style.bottom = '20px';
            container.style.right = '20px';
        }

        const header = document.createElement('div');
        header.id = 'tm-conflict-header';
        header.style.padding = '8px 10px';
        header.style.background = '#222';
        header.style.borderBottom = '1px solid #444';
        header.style.cursor = 'move';
        header.style.color = '#fff';
        header.style.fontWeight = 'bold';
        header.style.fontSize = '12px';
        header.style.userSelect = 'none';
        header.style.display = 'flex';
        header.style.justifyContent = 'space-between';
        header.innerHTML = `
            <span>⚔️ Command Center</span>
            <div>
                <span id="tm-hide-widget" style="cursor:pointer; font-size:11px; color:#aaa; margin-right:8px;" title="Hide Widget">[—]</span>
                <span id="tm-open-settings" style="cursor:pointer; font-size:11px; color:#888;" title="Settings">[⚙️]</span>
            </div>`;

        const content = document.createElement('div');
        content.id = 'tm-conflict-content';
        content.style.padding = '10px';
        content.style.flexGrow = '1';
        content.style.overflowY = 'auto';
        content.style.color = '#ddd';

        container.appendChild(header);
        container.appendChild(content);
        document.body.appendChild(container);

        const fab = document.createElement('div');
        fab.id = 'tm-conflict-fab';
        fab.style.position = 'fixed';
        fab.style.bottom = '20px';
        fab.style.left = '20px';
        fab.style.zIndex = '999998';
        fab.style.background = 'rgba(15,15,15,0.95)';
        fab.style.border = '1px solid #444';
        fab.style.color = '#fff';
        fab.style.padding = '8px 14px';
        fab.style.borderRadius = '20px';
        fab.style.cursor = 'pointer';
        fab.style.fontWeight = 'bold';
        fab.style.fontFamily = 'monospace';
        fab.style.boxShadow = '0 4px 15px rgba(0,0,0,0.8)';
        fab.style.display = isVisible ? 'none' : 'flex';
        fab.style.alignItems = 'center';
        fab.style.gap = '6px';
        fab.innerHTML = '🐝 <span style="color:#4CAF50;">Radar</span>';
        document.body.appendChild(fab);

        function toggleVisibility() {
            isVisible = !isVisible;
            GM_setValue("tm_visible", isVisible);
            container.style.display = isVisible ? 'flex' : 'none';
            fab.style.display = isVisible ? 'none' : 'flex';
        }

        document.getElementById('tm-hide-widget').addEventListener('click', toggleVisibility);
        fab.addEventListener('click', toggleVisibility);

        let isDragging = false, offsetX, offsetY;
        header.addEventListener('mousedown', (e) => {
            if (e.target.id === 'tm-open-settings' || e.target.id === 'tm-hide-widget') return; 
            isDragging = true;
            const rect = container.getBoundingClientRect();
            offsetX = e.clientX - rect.left;
            offsetY = e.clientY - rect.top;
        });
        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            container.style.bottom = 'auto';
            container.style.right = 'auto';
            let newLeft = Math.max(0, Math.min(e.clientX - offsetX, window.innerWidth - container.offsetWidth));
            let newTop = Math.max(0, Math.min(e.clientY - offsetY, window.innerHeight - container.offsetHeight));
            container.style.left = newLeft + 'px';
            container.style.top = newTop + 'px';
        });
        document.addEventListener('mouseup', () => {
            if (isDragging) { isDragging = false; saveUISettings(container); }
        });
        const resizeObserver = new ResizeObserver(() => {
            if (!isDragging) saveUISettings(container);
        });
        resizeObserver.observe(container);

        document.getElementById('tm-open-settings').addEventListener('click', () => {
            appState = 'setup';
            renderUI();
        });
    }

    function saveUISettings(container) {
        GM_setValue("torn_ui_pos", JSON.stringify({
            top: container.style.top, left: container.style.left,
            width: container.style.width, height: container.style.height
        }));
    }

    // --- UI Rendering Engine ---
    function renderUI() {
        initUI();
        const contentDiv = document.getElementById('tm-conflict-content');
        let html = ``;

        if (appState === 'setup') {
            const apiKey = GM_getValue("torn_api_key", "");
            const enemyId = GM_getValue("torn_enemy_id", "");
            const pMin = GM_getValue("torn_poll_minutes", 1);
            const isCancelable = apiKey && enemyId && latestData.timestamp;

            html = `
                <div style="font-family: sans-serif; font-size: 12px;">
                    <div style="margin-bottom:12px; font-weight:bold; border-bottom:1px solid #444; padding-bottom:4px;">⚙️ Configuration</div>
                    
                    <label style="font-size:10px; color:#888;">API Key</label>
                    <input id="tm-apikey-input" type="text" placeholder="Your API Key" value="${apiKey}" style="width:100%; margin-bottom:8px; background:#222; color:#fff; border:1px solid #555; padding:4px; box-sizing: border-box;">
                    
                    <label style="font-size:10px; color:#888;">Enemy Faction ID</label>
                    <input id="tm-enemyid-input" type="text" placeholder="Enemy ID" value="${enemyId}" style="width:100%; margin-bottom:8px; background:#222; color:#fff; border:1px solid #555; padding:4px; box-sizing: border-box;">
                    
                    <label style="font-size:10px; color:#888;">Polling Interval</label>
                    <select id="tm-poll-input" style="width:100%; margin-bottom:12px; background:#222; color:#fff; border:1px solid #555; padding:4px; box-sizing: border-box;">
                        <option value="1" ${pMin === 1 ? 'selected' : ''}>1 Minute</option>
                        <option value="5" ${pMin === 5 ? 'selected' : ''}>5 Minutes</option>
                        <option value="10" ${pMin === 10 ? 'selected' : ''}>10 Minutes</option>
                        <option value="15" ${pMin === 15 ? 'selected' : ''}>15 Minutes</option>
                    </select>

                    <div style="display:flex; gap:6px;">
                        <button id="tm-save-config" style="flex:1; background:#4CAF50; color:#fff; border:none; padding:6px; cursor:pointer; font-weight:bold; border-radius:2px;">Save & Launch</button>
                        ${isCancelable ? `<button id="tm-cancel-config" style="flex:1; background:#555; color:#fff; border:none; padding:6px; cursor:pointer; font-weight:bold; border-radius:2px;">Cancel</button>` : ''}
                    </div>
                </div>
            `;
            contentDiv.innerHTML = html;

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
                    
                    // Immediately fetch data and reset the absolute timer
                    targetPollTime = Date.now() + (pollMinutes * 60000);
                    pollData();
                }
            });

            if (isCancelable) {
                document.getElementById('tm-cancel-config').addEventListener('click', () => {
                    appState = 'app';
                    renderUI();
                });
            }
            return;
        }

        if (appState === 'loading') {
            contentDiv.innerHTML = `<div style="color:#aaa;">🔄 Syncing intel...</div>`;
            return;
        }

        if (appState === 'error') {
            contentDiv.innerHTML = `
                <div style="color:#ff4444; font-family: sans-serif; font-size:12px;">
                    ❌ API Error:<br>${lastErrorMsg}<br>
                    <button id="tm-reset-error" style="margin-top:10px; width:100%; background:#333; color:#fff; border:1px solid #555; padding:5px; cursor:pointer;">Return to Settings</button>
                </div>
            `;
            document.getElementById('tm-reset-error').addEventListener('click', () => {
                appState = 'setup';
                renderUI();
            });
            return;
        }

        if (appState === 'app') {
            const activeTabStyle = 'background:#4CAF50; color:#fff; font-weight:bold; cursor:default;';
            const inactiveTabStyle = 'background:#222; color:#888; cursor:pointer;';

            html += `
                <div style="display:flex; justify-content:space-between; margin-bottom:8px; font-size:10px; color:#777; background:rgba(0,0,0,0.2); padding:4px 6px; border-radius:4px; border:1px solid #222;">
                    <span>Refreshed: ${latestData.timestamp}</span>
                    <span id="tm-countdown-display" style="color:#888;">Next in: ${formatTime(secondsLeftDisplay)}</span>
                </div>
            `;

            html += `
                <div style="display:flex; margin-bottom:10px; border-radius:4px; overflow:hidden; border:1px solid #444; font-size:11px;">
                    <div id="tm-tab-map" style="flex:1; text-align:center; padding:6px; ${currentTab === 'map' ? activeTabStyle : inactiveTabStyle}">🌍 MAP</div>
                    <div id="tm-tab-air" style="flex:1; text-align:center; padding:6px; ${currentTab === 'air' ? activeTabStyle : inactiveTabStyle}">✈️ AIRSPACE</div>
                </div>
            `;

            if (currentTab === 'map') {
                const countries = Object.keys(latestData.theatreMap).sort();
                if (countries.length === 0) {
                    html += `<div style="color:#888; font-size:11px; text-align:center; padding: 10px 0;">No overseas deployments.</div>`;
                } else {
                    html += `<div style="font-size:9px; color:#888; margin-bottom:6px; text-align:center;">A:Ally | E:Enemy | AT:Ally Transit | ET:Enemy Transit</div>`;
                }

                countries.forEach(c => {
                    const data = latestData.theatreMap[c];
                    let statusColor = "#aaa"; 
                    if (data.A > 0 && data.E > 0) statusColor = "#ff4444"; 
                    else if (data.E > 0) statusColor = "#ffaa00"; 
                    else if (data.A > 0) statusColor = "#44ff44"; 

                    html += `
                    <div style="margin-bottom:8px; border-bottom: 1px solid #222; padding-bottom: 6px;">
                        <div style="font-size:12px; font-weight:bold; margin-bottom:4px;">${data.flag} ${c}</div>
                        <div style="display: grid; grid-template-columns: repeat(4, 1fr); text-align: center; font-size: 11px; background: rgba(0,0,0,0.3); padding: 4px; border-radius: 4px;">
                            <span style="color:#44ff44;">A: ${data.A}</span>
                            <span style="color:#44ff44;">AT: ${data.AT}</span>
                            <span style="color:${statusColor};">E: ${data.E}</span>
                            <span style="color:${statusColor};">ET: ${data.ET}</span>
                        </div>
                    </div>`;
                });
            } 
            else if (currentTab === 'air') {
                html += `
                    <div style="margin-bottom: 12px; background: rgba(68, 255, 68, 0.05); padding: 8px; border: 1px solid #1a331a; border-radius: 4px;">
                        <div style="color:#44ff44; font-weight:bold; font-size:10px; margin-bottom:6px; letter-spacing:1px;">ALLIED FLIGHTS</div>
                        <div style="font-size:12px; margin-bottom:2px;">➔ Inbound to Torn: <span style="color:#fff; font-weight:bold;">${latestData.airspace.ALLY.returning}</span></div>
                        <div style="font-size:12px; color:#888;">➔ Outbound/Transit: <span style="color:#ccc;">${latestData.airspace.ALLY.outbound}</span></div>
                    </div>
                    
                    <div style="margin-bottom: 4px; background: rgba(255, 68, 68, 0.05); padding: 8px; border: 1px solid #331a1a; border-radius: 4px;">
                        <div style="color:#ff4444; font-weight:bold; font-size:10px; margin-bottom:6px; letter-spacing:1px;">HOSTILE FLIGHTS</div>
                        <div style="font-size:12px; margin-bottom:2px;">➔ Inbound to Torn: <span style="color:#fff; font-weight:bold;">${latestData.airspace.ENEMY.returning}</span></div>
                        <div style="font-size:12px; color:#888;">➔ Outbound/Transit: <span style="color:#ccc;">${latestData.airspace.ENEMY.outbound}</span></div>
                    </div>
                `;
            }

            contentDiv.innerHTML = html;

            const tabMap = document.getElementById('tm-tab-map');
            const tabAir = document.getElementById('tm-tab-air');
            if (tabMap && currentTab !== 'map') {
                tabMap.addEventListener('click', () => { currentTab = 'map'; renderUI(); });
            }
            if (tabAir && currentTab !== 'air') {
                tabAir.addEventListener('click', () => { currentTab = 'air'; renderUI(); });
            }
        }
    }

    // --- Core Data Polling ---
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
            
            const newTheatreMap = {};
            const newAirspace = {
                ALLY: { returning: 0, outbound: 0 },
                ENEMY: { returning: 0, outbound: 0 }
            };

            const mapParticipant = (member, type) => {
                const airStatus = getAirspaceStatus(member);
                if (airStatus) {
                    if (airStatus === "RETURNING") newAirspace[type].returning++;
                    else newAirspace[type].outbound++;
                }

                const loc = getOverseasLocation(member);
                if (loc) {
                    const country = loc.country;
                    if (!newTheatreMap[country]) {
                        newTheatreMap[country] = { A: 0, E: 0, AT: 0, ET: 0, flag: countryFlags[country.toLowerCase()] || "📍" };
                    }
                    
                    if (loc.isTransit) {
                        if (type === "ALLY") newTheatreMap[country].AT++;
                        if (type === "ENEMY") newTheatreMap[country].ET++;
                    } else {
                        if (type === "ALLY") newTheatreMap[country].A++;
                        if (type === "ENEMY") newTheatreMap[country].E++;
                    }
                }
            };

            myMembers.forEach(m => mapParticipant(m, "ALLY"));
            enemyMembers.forEach(m => mapParticipant(m, "ENEMY"));

            latestData.theatreMap = newTheatreMap;
            latestData.airspace = newAirspace;
            latestData.timestamp = new Date().toLocaleTimeString();
            appState = 'app';
            
            // Set exact timestamp for the next expected pull based on configuration
            targetPollTime = Date.now() + (pollMinutes * 60000);
            
            renderUI();

        } catch (err) {
            appState = 'error';
            lastErrorMsg = err.message;
            renderUI();
        }
    }

    // --- Boot ---
    setTimeout(() => {
        const key = GM_getValue("torn_api_key", "");
        const eid = GM_getValue("torn_enemy_id", "");
        appState = (key && eid) ? 'loading' : 'setup';
        renderUI();
        
        if (key && eid) {
            // Instantly pull data on load, and establish target timestamp
            targetPollTime = Date.now() + (pollMinutes * 60000);
            pollData();
        }

        // The Heartbeat Engine: Runs reliably and manages true Delta Timing
        setInterval(() => {
            if (appState === 'app') {
                const now = Date.now();
                
                if (now >= targetPollTime) {
                    // We hit 0! Push the target forward instantly to block race conditions
                    targetPollTime = now + (pollMinutes * 60000); 
                    
                    const displayEl = document.getElementById('tm-countdown-display');
                    if (displayEl) {
                        displayEl.innerText = `Syncing...`;
                        displayEl.style.color = "#4CAF50"; // Turn green to show action
                    }
                    pollData(); 
                } else {
                    // Update UI countdown
                    secondsLeftDisplay = Math.ceil((targetPollTime - now) / 1000);
                    const displayEl = document.getElementById('tm-countdown-display');
                    if (displayEl) {
                        displayEl.innerText = `Next in: ${formatTime(secondsLeftDisplay)}`;
                        displayEl.style.color = "#888"; // Revert to gray
                    }
                }
            }
        }, 1000);

    }, 500);

})();
