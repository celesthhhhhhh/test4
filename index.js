import { extension_settings, getContext } from '../../../extensions.js';
import { saveSettingsDebounced, eventSource, event_types } from '../../../../script.js';

const EXT_NAME = 'antiSlop';
const SETTINGS_DEFAULT = {
    enabled: true,
    embedUrl: 'http://127.0.0.1:11434/api/embeddings',
    embedModel: 'nomic-embed-text',
    embedKey: '',
    rewriteUrl: 'http://127.0.0.1:11434/v1/chat/completions',
    rewriteModel: 'llama3',
    rewriteKey: '',
    threshold: 0.82,
    mode: 'rewrite',
    fab_x: -1,
    fab_y: -1,
    cachedClusters: {},
    rewriteHistory: []
};

let settings = {};

const ICONS = {
    pencil: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <defs>
            <linearGradient id="slop-pencil-grad" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" style="stop-color:#d4a8ff"/>
                <stop offset="100%" style="stop-color:#8b5cf6"/>
            </linearGradient>
        </defs>
        <path d="M4 20h4L18.5 9.5a2.121 2.121 0 0 0-3-3L4 17v3z"
              stroke="url(#slop-pencil-grad)" stroke-width="1.8"
              stroke-linecap="round" stroke-linejoin="round" fill="none"/>
        <path d="m13.5 6.5 3 3" stroke="url(#slop-pencil-grad)"
              stroke-width="1.8" stroke-linecap="round"/>
        <path d="M4 20h4" stroke="url(#slop-pencil-grad)"
              stroke-width="1.8" stroke-linecap="round"/>
        <circle cx="19.5" cy="4.5" r="1.5" fill="#d4a8ff" opacity="0.6"/>
    </svg>`,

    pencilActive: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <defs>
            <linearGradient id="slop-pencil-active" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" style="stop-color:#f0d0ff"/>
                <stop offset="100%" style="stop-color:#b07df9"/>
            </linearGradient>
        </defs>
        <path d="M4 20h4L18.5 9.5a2.121 2.121 0 0 0-3-3L4 17v3z"
              stroke="url(#slop-pencil-active)" stroke-width="1.8"
              stroke-linecap="round" stroke-linejoin="round"
              fill="rgba(176,125,249,0.12)"/>
        <path d="m13.5 6.5 3 3" stroke="url(#slop-pencil-active)"
              stroke-width="1.8" stroke-linecap="round"/>
        <path d="M4 20h4" stroke="url(#slop-pencil-active)"
              stroke-width="1.8" stroke-linecap="round"/>
        <circle cx="19.5" cy="4.5" r="1.5" fill="#f0d0ff" opacity="0.9"/>
    </svg>`,

    pencilMini: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="width:12px;height:12px;display:inline-block;vertical-align:middle;margin-bottom:1px;">
        <path d="M4 20h4L18.5 9.5a2.121 2.121 0 0 0-3-3L4 17v3z"
              stroke="#b07df9" stroke-width="2"
              stroke-linecap="round" stroke-linejoin="round" fill="rgba(176,125,249,0.15)"/>
        <path d="m13.5 6.5 3 3" stroke="#b07df9" stroke-width="2" stroke-linecap="round"/>
    </svg>`,

    close: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
        <path d="M18 6L6 18M6 6l12 12"/>
    </svg>`,

    spark: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 17l-6.2 4.3 2.4-7.4L2 9.4h7.6z" fill="rgba(176,125,249,0.15)"/>
    </svg>`,

    check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="width:11px;height:11px;flex-shrink:0;"><path d="M20 6L9 17l-5-5"/></svg>`,

    historyIcon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="width:12px;height:12px;"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
};

async function init() {
    if (!extension_settings[EXT_NAME]) {
        extension_settings[EXT_NAME] = { ...SETTINGS_DEFAULT };
    }
    for (const [key, val] of Object.entries(SETTINGS_DEFAULT)) {
        if (extension_settings[EXT_NAME][key] === undefined) {
            extension_settings[EXT_NAME][key] = val;
        }
    }
    settings = extension_settings[EXT_NAME];
    setupUI();

    console.log('[Anti-Slop] init: event_types available =', typeof event_types, event_types?.MESSAGE_RECEIVED);
    console.log('[Anti-Slop] init: eventSource available =', typeof eventSource);

    // Слушаем оба возможных события — в разных версиях ST они называются по-разному
    eventSource.on(event_types.MESSAGE_RECEIVED, handleNewMessage);
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, handleNewMessage);

    console.log('[Anti-Slop] Обработчики событий зарегистрированы.');
    await loadSlopDatabase();
}

async function handleNewMessage(messageId) {
    console.log('[Anti-Slop] handleNewMessage вызван, messageId =', messageId, '| enabled =', settings.enabled);

    if (!settings.enabled) { console.log('[Anti-Slop] Отключён, выходим.'); return; }

    const context = getContext();
    const chat = context.chat;

    // Иногда ST передаёт объект или undefined — берём последнее сообщение как fallback
    let idx = (typeof messageId === 'number') ? messageId : chat.length - 1;
    const msg = chat[idx];

    console.log('[Anti-Slop] idx =', idx, '| chat.length =', chat.length, '| msg =', msg ? '[ok]' : '[undefined]');

    if (!msg) { console.warn('[Anti-Slop] msg undefined, выходим.'); return; }
    if (msg.is_user || msg.is_system) { console.log('[Anti-Slop] Сообщение от юзера/системы, пропускаем.'); return; }

    const originalText = msg.mes;
    console.log('[Anti-Slop] originalText длина =', originalText?.length, '| clusters =', Object.keys(settings.cachedClusters).length);

    if (!originalText) return;

    // Если кластеры ещё не загружены — пробуем загрузить
    if (Object.keys(settings.cachedClusters).length === 0) {
        console.warn('[Anti-Slop] Кластеры пусты! Запускаем loadSlopDatabase...');
        await loadSlopDatabase();
    }

    setFabState('processing');
    try {
        const cleanedText = await processText(originalText);
        console.log('[Anti-Slop] processText завершён. Изменён:', cleanedText !== originalText);
        if (cleanedText !== originalText) {
            chat[idx].mes = cleanedText +
                ` <span class="anti-slop-edited-icon" title="Anti-Slop очистил клише">${ICONS.pencilMini}</span>`;
            context.saveChat();
            const messageElement = document.querySelector(`.mes[mesid="${idx}"] .mes_text`);
            if (messageElement) {
                const converter = new showdown.Converter();
                messageElement.innerHTML = converter.makeHtml(chat[idx].mes);
            }
        }
    } catch (error) {
        console.error("[Anti-Slop] Ошибка при обработке сообщения:", error);
    } finally {
        setFabState('idle');
    }
}

async function processText(text) {
    const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
    const segments = Array.from(segmenter.segment(text));
    let resultText = "";
    let modified = false;

    for (const segment of segments) {
        let sentence = segment.segment;
        const pureSentence = sentence.trim();
        if (pureSentence.length < 10) { resultText += sentence; continue; }

        const sentenceVec = await fetchEmbedding(pureSentence);
        if (!sentenceVec) { resultText += sentence; continue; }

        let highestSim = 0, matchedCluster = null;
        for (const [clusterName, clusterVec] of Object.entries(settings.cachedClusters)) {
            const sim = cosineSimilarity(sentenceVec, clusterVec);
            if (sim > highestSim) { highestSim = sim; matchedCluster = clusterName; }
        }

        if (highestSim >= parseFloat(settings.threshold)) {
            console.log(`[Anti-Slop] Клише (${highestSim.toFixed(2)} ~ ${matchedCluster}): "${pureSentence}"`);
            if (settings.mode === 'delete') {
                addToHistory(pureSentence, '[удалено]');
                modified = true; continue;
            } else {
                const rewritten = await rewriteSentence(pureSentence);
                if (rewritten) {
                    const leadingSpace = sentence.match(/^\s*/)[0];
                    const trailingSpace = sentence.match(/\s*$/)[0];
                    resultText += leadingSpace + rewritten + trailingSpace;
                    addToHistory(pureSentence, rewritten);
                    modified = true; continue;
                }
            }
        }
        resultText += sentence;
    }
    return modified ? resultText : text;
}

function addToHistory(original, rewritten) {
    if (!Array.isArray(settings.rewriteHistory)) settings.rewriteHistory = [];
    settings.rewriteHistory.unshift({
        original,
        rewritten,
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    });
    if (settings.rewriteHistory.length > 5) settings.rewriteHistory.length = 5;
    saveSettings();
    renderHistory();
}

function renderHistory() {
    const container = document.getElementById('slop-history-list');
    if (!container) return;
    const history = settings.rewriteHistory || [];
    if (history.length === 0) {
        container.innerHTML = '<div class="slop-history-empty">Исправлений ещё не было</div>';
        return;
    }
    container.innerHTML = history.map((item, i) => `
        <div class="slop-history-item">
            <div class="slop-history-meta">#${i + 1} &middot; ${item.time}</div>
            <div class="slop-history-original">${escapeHtml(item.original)}</div>
            <div class="slop-history-arrow">&#8595;</div>
            <div class="slop-history-rewritten">${escapeHtml(item.rewritten)}</div>
        </div>
    `).join('');
}

function escapeHtml(str) {
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function fetchEmbedding(text) {
    try {
        const isOllama = settings.embedUrl.includes('11434');
        const payload = isOllama
            ? { model: settings.embedModel, prompt: text }
            : { model: settings.embedModel, input: text };
        const headers = { 'Content-Type': 'application/json' };
        if (settings.embedKey) headers['Authorization'] = `Bearer ${settings.embedKey}`;
        const res = await fetch(settings.embedUrl, { method: 'POST', headers, body: JSON.stringify(payload) });
        if (!res.ok) throw new Error(`Embedding HTTP ${res.status}`);
        const data = await res.json();
        return isOllama ? data.embedding : data.data[0].embedding;
    } catch (e) {
        console.error("[Anti-Slop] Ошибка Embedding API:", e);
        return null;
    }
}

async function checkEmbedConnection() {
    const btn = document.getElementById('slop-embed-check-btn');
    const status = document.getElementById('slop-embed-check-status');
    btn.disabled = true;
    status.textContent = '…';
    status.className = 'slop-check-status slop-check-pending';
    try {
        const isOllama = settings.embedUrl.includes('11434');
        const payload = isOllama
            ? { model: settings.embedModel, prompt: 'test' }
            : { model: settings.embedModel, input: 'test' };
        const headers = { 'Content-Type': 'application/json' };
        if (settings.embedKey) headers['Authorization'] = `Bearer ${settings.embedKey}`;
        const res = await fetch(settings.embedUrl, {
            method: 'POST', headers, body: JSON.stringify(payload),
            signal: AbortSignal.timeout(8000)
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const vec = isOllama ? data.embedding : data.data?.[0]?.embedding;
        if (!vec || !Array.isArray(vec)) throw new Error('Bad response format');
        status.textContent = `OK · dim ${vec.length}`;
        status.className = 'slop-check-status slop-check-ok';
    } catch (e) {
        const msg = e.message || 'Error';
        status.textContent = msg.length > 30 ? msg.slice(0, 30) + '…' : msg;
        status.className = 'slop-check-status slop-check-err';
    } finally {
        btn.disabled = false;
    }
}

async function checkRewriteConnection() {
    const btn = document.getElementById('slop-rewrite-check-btn');
    const status = document.getElementById('slop-rewrite-check-status');
    btn.disabled = true;
    status.textContent = '…';
    status.className = 'slop-check-status slop-check-pending';
    try {
        const headers = { 'Content-Type': 'application/json' };
        if (settings.rewriteKey) headers['Authorization'] = `Bearer ${settings.rewriteKey}`;
        const res = await fetch(settings.rewriteUrl, {
            method: 'POST', headers,
            body: JSON.stringify({ model: settings.rewriteModel, messages: [{ role: 'user', content: 'Say ok' }], max_tokens: 5 }),
            signal: AbortSignal.timeout(10000)
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!data.choices?.[0]?.message) throw new Error('Bad response format');
        const modelName = (data.model || settings.rewriteModel);
        status.textContent = `OK · ${modelName.length > 18 ? modelName.slice(0,18)+'…' : modelName}`;
        status.className = 'slop-check-status slop-check-ok';
    } catch (e) {
        const msg = e.message || 'Error';
        status.textContent = msg.length > 30 ? msg.slice(0, 30) + '…' : msg;
        status.className = 'slop-check-status slop-check-err';
    } finally {
        btn.disabled = false;
    }
}

function cosineSimilarity(vecA, vecB) {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < vecA.length; i++) {
        dot += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function averageVectors(vectors) {
    const length = vectors[0].length;
    const avgVec = new Array(length).fill(0);
    for (let vec of vectors) for (let i = 0; i < length; i++) avgVec[i] += vec[i];
    for (let i = 0; i < length; i++) avgVec[i] /= vectors.length;
    return avgVec;
}

async function loadSlopDatabase() {
    try {
        const res = await fetch('/scripts/extensions/third-party/anti-slop/slop_db.json');
        const db = await res.json();
        let needsUpdate = false;
        for (const cluster in db.clusters) {
            if (!settings.cachedClusters[cluster]) { needsUpdate = true; break; }
        }
        if (needsUpdate) {
            console.log("[Anti-Slop] Генерация векторов для базы клише...");
            for (const [clusterName, phrases] of Object.entries(db.clusters)) {
                if (!settings.cachedClusters[clusterName]) {
                    const vectors = [];
                    for (const phrase of phrases) {
                        const vec = await fetchEmbedding(phrase);
                        if (vec) vectors.push(vec);
                    }
                    if (vectors.length > 0) settings.cachedClusters[clusterName] = averageVectors(vectors);
                }
            }
            saveSettings();
            console.log("[Anti-Slop] Векторы успешно сохранены.");
        }
    } catch (e) {
        console.error("[Anti-Slop] Не удалось загрузить slop_db.json", e);
    }
}

async function rewriteSentence(sentence) {
    try {
        const messages = [
            { role: "system", content: "You are an expert novel editor. The user will provide a sentence that contains overused AI cliches (slop). Rewrite the sentence to remove the cliche, making it sound entirely natural, descriptive, and human-authored. Keep the original context and meaning. Output ONLY the rewritten sentence, nothing else." },
            { role: "user", content: `Rewrite this sentence naturally: "${sentence}"` }
        ];
        const headers = { 'Content-Type': 'application/json' };
        if (settings.rewriteKey) headers['Authorization'] = `Bearer ${settings.rewriteKey}`;
        const res = await fetch(settings.rewriteUrl, {
            method: 'POST', headers,
            body: JSON.stringify({ model: settings.rewriteModel, messages, temperature: 0.7, max_tokens: 100 })
        });
        if (!res.ok) throw new Error(`Rewrite HTTP ${res.status}`);
        const data = await res.json();
        let rewritten = data.choices[0].message.content.trim();
        return rewritten.replace(/^"|"$/g, '');
    } catch (e) {
        console.error("[Anti-Slop] Ошибка Rewrite API:", e);
        return null;
    }
}

function setupUI() {
    $('body').append(`<div id="anti-slop-fab" title="Anti-Slop Settings">${ICONS.pencil}</div>`);

    $('body').append(`
        <div id="anti-slop-panel">
            <div class="slop-header">
                <div class="slop-header-left">
                    <div class="slop-header-icon">${ICONS.spark}</div>
                    <div class="slop-header-title">
                        <span class="slop-title-main">Anti-Slop</span>
                        <span class="slop-title-sub">Cliché Detection Engine</span>
                    </div>
                </div>
                <div class="slop-header-right">
                    <label class="slop-toggle" title="Enable / Disable">
                        <input type="checkbox" id="slop-enable" ${settings.enabled ? 'checked' : ''}>
                        <span class="slop-toggle-track"><span class="slop-toggle-thumb"></span></span>
                    </label>
                    <button class="slop-close-btn" id="slop-close-btn">${ICONS.close}</button>
                </div>
            </div>

            <div class="slop-body">

                <div class="slop-section">
                    <div class="slop-section-label">Detection</div>
                    <div class="slop-row">
                        <div class="slop-setting-group slop-grow">
                            <label>Action</label>
                            <select class="slop-input" id="slop-mode">
                                <option value="rewrite" ${settings.mode === 'rewrite' ? 'selected' : ''}>✦ Rewrite with LLM</option>
                                <option value="delete" ${settings.mode === 'delete' ? 'selected' : ''}>✕ Delete Cliché</option>
                            </select>
                        </div>
                        <div class="slop-setting-group slop-shrink">
                            <label>Threshold</label>
                            <input type="number" step="0.01" min="0" max="1" class="slop-input slop-input-sm" id="slop-threshold" value="${settings.threshold}">
                        </div>
                    </div>
                </div>

                <div class="slop-section">
                    <div class="slop-section-label">Embedding Model</div>
                    <div class="slop-setting-group">
                        <label>API URL</label>
                        <input type="text" class="slop-input" id="slop-embed-url" value="${settings.embedUrl}" placeholder="http://127.0.0.1:11434/api/embeddings">
                    </div>
                    <div class="slop-row">
                        <div class="slop-setting-group slop-grow">
                            <label>Model Name</label>
                            <input type="text" class="slop-input" id="slop-embed-model" value="${settings.embedModel}" placeholder="nomic-embed-text">
                        </div>
                        <div class="slop-setting-group slop-grow">
                            <label>API Key <span class="slop-optional">(optional)</span></label>
                            <input type="password" class="slop-input" id="slop-embed-key" value="${settings.embedKey}" placeholder="sk-...">
                        </div>
                    </div>
                    <div class="slop-check-row">
                        <button class="slop-check-btn" id="slop-embed-check-btn">${ICONS.check} Check Connection</button>
                        <span class="slop-check-status" id="slop-embed-check-status"></span>
                    </div>
                </div>

                <div class="slop-section">
                    <div class="slop-section-label">Rewrite Model</div>
                    <div class="slop-setting-group">
                        <label>API URL <span class="slop-hint">(v1/chat/completions)</span></label>
                        <input type="text" class="slop-input" id="slop-rewrite-url" value="${settings.rewriteUrl}" placeholder="http://127.0.0.1:11434/v1/chat/completions">
                    </div>
                    <div class="slop-row">
                        <div class="slop-setting-group slop-grow">
                            <label>Model Name</label>
                            <input type="text" class="slop-input" id="slop-rewrite-model" value="${settings.rewriteModel}" placeholder="llama3">
                        </div>
                        <div class="slop-setting-group slop-grow">
                            <label>API Key <span class="slop-optional">(optional)</span></label>
                            <input type="password" class="slop-input" id="slop-rewrite-key" value="${settings.rewriteKey}" placeholder="sk-...">
                        </div>
                    </div>
                    <div class="slop-check-row">
                        <button class="slop-check-btn" id="slop-rewrite-check-btn">${ICONS.check} Check Connection</button>
                        <span class="slop-check-status" id="slop-rewrite-check-status"></span>
                    </div>
                </div>

                <div class="slop-section">
                    <div class="slop-section-label slop-section-label-row">
                        <span>${ICONS.historyIcon} Recent Fixes</span>
                        <button class="slop-clear-history-btn" id="slop-clear-history-btn" title="Очистить историю">✕</button>
                    </div>
                    <div id="slop-history-list"></div>
                </div>

                <button class="slop-btn" id="slop-recalc-btn">
                    <span class="slop-btn-icon">⟳</span> Rebuild Database Cache
                </button>
            </div>
        </div>
    `);

    $('#slop-close-btn').on('click', () => {
        $('#anti-slop-panel').removeClass('visible');
        $('#anti-slop-fab').removeClass('active');
    });

    $('.slop-input, #slop-enable').on('change input', () => {
        settings.enabled      = $('#slop-enable').is(':checked');
        settings.mode         = $('#slop-mode').val();
        settings.threshold    = parseFloat($('#slop-threshold').val());
        settings.embedUrl     = $('#slop-embed-url').val();
        settings.embedModel   = $('#slop-embed-model').val();
        settings.embedKey     = $('#slop-embed-key').val();
        settings.rewriteUrl   = $('#slop-rewrite-url').val();
        settings.rewriteModel = $('#slop-rewrite-model').val();
        settings.rewriteKey   = $('#slop-rewrite-key').val();
        saveSettings();
    });

    $('#slop-recalc-btn').on('click', async () => {
        settings.cachedClusters = {};
        $('#slop-recalc-btn').html('<span class="slop-btn-icon">⟳</span> Building…').prop('disabled', true);
        await loadSlopDatabase();
        $('#slop-recalc-btn').html('<span class="slop-btn-icon">⟳</span> Rebuild Database Cache').prop('disabled', false);
    });

    $('#slop-embed-check-btn').on('click', checkEmbedConnection);
    $('#slop-rewrite-check-btn').on('click', checkRewriteConnection);

    $('#slop-clear-history-btn').on('click', () => {
        settings.rewriteHistory = [];
        saveSettings();
        renderHistory();
    });

    renderHistory();

    setupDrag($('#anti-slop-fab'), () => {
        const isOpen = $('#anti-slop-panel').hasClass('visible');
        $('#anti-slop-panel').toggleClass('visible', !isOpen);
        $('#anti-slop-fab').toggleClass('active', !isOpen);
        if (!isOpen) {
            $('#anti-slop-fab').html(ICONS.pencilActive);
            renderHistory();
        } else {
            $('#anti-slop-fab').html(ICONS.pencil);
        }
    });
}

function setupDrag($fab, onTap) {
    let dragging = false, dragMoved = false;
    let startX = 0, startY = 0, startLeft = 0, startTop = 0;
    const THRESHOLD = 6;
    const fabEl = $fab[0];

    function getXY(e) {
        if (e.touches && e.touches[0]) return { x: e.touches[0].clientX, y: e.touches[0].clientY };
        if (e.changedTouches && e.changedTouches[0]) return { x: e.changedTouches[0].clientX, y: e.changedTouches[0].clientY };
        return { x: e.clientX, y: e.clientY };
    }

    fabEl.addEventListener('touchstart', function(e) {
        dragging = true; dragMoved = false;
        const c = getXY(e);
        startX = c.x; startY = c.y;
        const rect = fabEl.getBoundingClientRect();
        startLeft = rect.left; startTop = rect.top;
        $fab.css({ left: startLeft + 'px', top: startTop + 'px', right: 'auto', bottom: 'auto' });
    }, { passive: true });

    // passive: false — чтобы preventDefault блокировал скролл страницы при перетаскивании
    fabEl.addEventListener('touchmove', function(e) {
        if (!dragging) return;
        const c = getXY(e);
        const dx = c.x - startX, dy = c.y - startY;
        if (Math.abs(dx) > THRESHOLD || Math.abs(dy) > THRESHOLD) {
            dragMoved = true;
            e.preventDefault();
        }
        if (!dragMoved) return;
        const w = fabEl.offsetWidth, h = fabEl.offsetHeight;
        const nx = Math.max(0, Math.min(startLeft + dx, window.innerWidth - w));
        const ny = Math.max(0, Math.min(startTop + dy, window.innerHeight - h));
        $fab.css({ left: nx + 'px', top: ny + 'px' });
    }, { passive: false });

    fabEl.addEventListener('touchend', function(e) {
        if (!dragging) return;
        dragging = false;
        if (!dragMoved) { e.preventDefault(); onTap(); }
        else {
            const rect = fabEl.getBoundingClientRect();
            saveSlopPosition(Math.round(rect.left), Math.round(rect.top));
        }
        dragMoved = false;
    }, { passive: false });

    $fab.on('mousedown', function(e) {
        dragging = true; dragMoved = false;
        startX = e.clientX; startY = e.clientY;
        const rect = fabEl.getBoundingClientRect();
        startLeft = rect.left; startTop = rect.top;
        $fab.css({ left: startLeft + 'px', top: startTop + 'px', right: 'auto', bottom: 'auto' });
        e.preventDefault();
    });

    $(document).on('mousemove.slopfab', function(e) {
        if (!dragging) return;
        const dx = e.clientX - startX, dy = e.clientY - startY;
        if (Math.abs(dx) > THRESHOLD || Math.abs(dy) > THRESHOLD) dragMoved = true;
        if (!dragMoved) return;
        const w = fabEl.offsetWidth, h = fabEl.offsetHeight;
        const nx = Math.max(0, Math.min(startLeft + dx, window.innerWidth - w));
        const ny = Math.max(0, Math.min(startTop + dy, window.innerHeight - h));
        $fab.css({ left: nx + 'px', top: ny + 'px' });
    });

    $(document).on('mouseup.slopfab', function() {
        if (!dragging) return;
        dragging = false;
        if (dragMoved) {
            const rect = fabEl.getBoundingClientRect();
            saveSlopPosition(Math.round(rect.left), Math.round(rect.top));
        } else { onTap(); }
        dragMoved = false;
    });

    const vw = window.innerWidth, vh = window.innerHeight;
    if (settings.fab_x >= 0 && settings.fab_y >= 0 && settings.fab_x < vw - 10 && settings.fab_y < vh - 10) {
        $fab.css({ left: settings.fab_x + 'px', top: settings.fab_y + 'px', right: 'auto', bottom: 'auto' });
    } else {
        $fab.css({ top: '170px', right: '15px', left: 'auto', bottom: 'auto' });
    }
}

function saveSlopPosition(x, y) { settings.fab_x = x; settings.fab_y = y; saveSettings(); }
function saveSettings() { extension_settings[EXT_NAME] = settings; saveSettingsDebounced(); }
function setFabState(state) {
    if (state === 'processing') $('#anti-slop-fab').addClass('processing');
    else $('#anti-slop-fab').removeClass('processing');
}

jQuery(async () => { await init(); });
