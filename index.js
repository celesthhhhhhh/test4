import { extension_settings, getContext } from "../../../extensions.js";
import { eventSource, event_types } from "../../../../script.js";
import { updateMessageBlock } from "../../../../chat.js";

// Глобальные переменные
let slopDb = {};
let dbEmbeddings = [];
let panelElement = null;
let historyListElement = null;

// Настройки по умолчанию (Снижен порог для тестов)
const defaultSettings = {
    embedApiUrl: 'http://127.0.0.1:11434/api/embeddings', // ВНИМАНИЕ: Для старых версий Ollama это /api/embeddings, для новых /v1/embeddings
    embedModel: 'nomic-embed-text',
    rewriteApiUrl: 'http://127.0.0.1:11434/v1/chat/completions',
    rewriteModel: 'llama3', 
    apiKey: 'sk-1234', 
    threshold: 0.70 // Снизили до 70% для проверки работоспособности
};

let settings = Object.assign({}, defaultSettings, extension_settings.antiSlop || {});

// ==========================================
// ЛОГИКА
// ==========================================

function cosineSimilarity(vecA, vecB) {
    let dotProduct = 0, normA = 0, normB = 0;
    for (let i = 0; i < vecA.length; i++) {
        dotProduct += vecA[i] * vecB[i];
        normA += vecA[i] ** 2;
        normB += vecB[i] ** 2;
    }
    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function fetchEmbeddings(texts) {
    try {
        console.log(`[Anti-Slop] Запрос Embeddings для ${texts.length} фраз... URL:`, settings.embedApiUrl);
        
        // Поддержка как /v1/ (OpenAI формат), так и родного /api/ (Ollama)
        const isV1 = settings.embedApiUrl.includes('/v1/');
        const body = isV1 ? 
            { input: texts, model: settings.embedModel } : 
            { prompt: texts[0], model: settings.embedModel }; // Родной Ollama API поддерживает только по 1 строке, если это не v1

        // Если это массив и используется старый Ollama API - делаем хак (по-хорошему нужен цикл, но v1 поддерживает массивы)
        if (!isV1 && texts.length > 1) {
             console.warn("[Anti-Slop] Внимание: Вы используете старый эндпоинт Ollama (/api/embeddings). Лучше использовать /v1/embeddings");
        }

        const response = await fetch(settings.embedApiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${settings.apiKey}` },
            body: JSON.stringify(isV1 ? { input: texts, model: settings.embedModel } : { prompt: texts.join(" "), model: settings.embedModel })
        });
        
        if (!response.ok) throw new Error(`HTTP Error: ${response.status}`);
        const data = await response.json();
        
        if (isV1) {
            return data.data.sort((a, b) => a.index - b.index).map(item => item.embedding);
        } else {
            return [data.embedding]; // Старый Ollama API
        }
    } catch (error) {
        console.error("[Anti-Slop] Ошибка при получении Embeddings:", error);
        return null;
    }
}

async function rewriteSentence(originalSentence, slopPhrase) {
    console.log(`[Anti-Slop] Запрашиваем Rewrite у LLM. Оригинал: "${originalSentence}"`);
    const systemPrompt = "You are an expert editor. Rewrite the sentence to remove the cliché. Make it natural. Output ONLY the rewritten sentence. No quotes, no explanations.";
    const userPrompt = `Cliché to avoid: "${slopPhrase}"\n\nOriginal sentence: ${originalSentence}\n\nRewritten sentence:`;

    try {
        const response = await fetch(settings.rewriteApiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${settings.apiKey}` },
            body: JSON.stringify({
                model: settings.rewriteModel,
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: userPrompt }
                ],
                temperature: 0.7,
                max_tokens: 150
            })
        });

        if (!response.ok) throw new Error(`Rewrite HTTP Error: ${response.status}`);
        const data = await response.json();
        let rewritten = data.choices[0].message.content.trim().replace(/^["']|["']$/g, '').trim();
        console.log(`[Anti-Slop] LLM ответила: "${rewritten}"`);
        return rewritten;
    } catch (error) {
        console.error("[Anti-Slop] Ошибка Rewrite LLM:", error);
        return originalSentence; 
    }
}

async function initDatabaseAndCacheEmbeddings() {
    try {
        document.getElementById('slop-api-status').innerText = "⏳ Loading DB...";
        document.getElementById('slop-api-status').className = "slop-check-status slop-check-pending";
        console.log("[Anti-Slop] Начало кэширования базы...");

        const response = await fetch('./scripts/extensions/anti-slop/slop_db.json');
        if (!response.ok) throw new Error("JSON файл не найден");
        
        const data = await response.json();
        slopDb = data.clusters || {};
        
        const allPhrases = [];
        for (const [cluster, phrases] of Object.entries(slopDb)) {
            for (const phrase of phrases) allPhrases.push({ phrase, cluster });
        }

        // Векторизуем по одному для надежности (чтобы избежать проблем с Ollama, если она не поддерживает батчинг)
        document.getElementById('slop-api-status').innerText = `⏳ Embedding 0/${allPhrases.length}`;
        dbEmbeddings = [];
        
        for (let i = 0; i < allPhrases.length; i++) {
            const item = allPhrases[i];
            const vecResponse = await fetchEmbeddings([item.phrase]);
            if (vecResponse && vecResponse[0]) {
                dbEmbeddings.push({ phrase: item.phrase, cluster: item.cluster, vector: vecResponse[0] });
            }
            if (i % 10 === 0) document.getElementById('slop-api-status').innerText = `⏳ Embedding ${i}/${allPhrases.length}`;
        }

        if (dbEmbeddings.length > 0) {
            console.log(`[Anti-Slop] Успешно закэшировано ${dbEmbeddings.length} векторов.`);
            document.getElementById('slop-api-status').innerText = "✅ DB Cached";
            document.getElementById('slop-api-status').className = "slop-check-status slop-check-ok";
        } else {
            throw new Error("Векторы не получены");
        }
    } catch (error) {
        console.error("[Anti-Slop] Ошибка кэширования базы:", error);
        document.getElementById('slop-api-status').innerText = "❌ API Error (Check F12)";
        document.getElementById('slop-api-status').className = "slop-check-status slop-check-err";
    }
}

// ==========================================
// ИНТЕРФЕЙС И СОХРАНЕНИЕ
// ==========================================

function createUI() {
    const fab = document.createElement('button');
    fab.id = 'anti-slop-fab';
    fab.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>`;
    document.body.appendChild(fab);

    panelElement = document.createElement('div');
    panelElement.id = 'anti-slop-panel';
    panelElement.innerHTML = `
        <div class="slop-header">
            <div class="slop-header-left">
                <div class="slop-header-title">
                    <span class="slop-title-main">Anti-Slop Engine</span>
                    <span class="slop-title-sub">AI Rewrite Active</span>
                </div>
            </div>
            <div class="slop-header-right">
                <button class="slop-close-btn" id="anti-slop-close">X</button>
            </div>
        </div>
        <div class="slop-body">
            <div class="slop-section">
                <div class="slop-section-label">Detection Settings (Embeddings)</div>
                <div class="slop-setting-group">
                    <label>Embed API URL (Use /v1/embeddings if possible)</label>
                    <input type="text" id="slop-embed-url" class="slop-input" value="${settings.embedApiUrl}">
                </div>
                <div class="slop-setting-group">
                    <label>Embed Model</label>
                    <input type="text" id="slop-embed-model" class="slop-input" value="${settings.embedModel}">
                </div>
                <div class="slop-setting-group">
                    <label>Threshold: <span id="slop-threshold-val">${settings.threshold}</span></label>
                    <input type="range" id="slop-threshold" min="0.5" max="0.99" step="0.01" value="${settings.threshold}">
                </div>
            </div>

            <div class="slop-section">
                <div class="slop-section-label">Rewrite Settings (LLM)</div>
                <div class="slop-setting-group">
                    <label>Chat API URL</label>
                    <input type="text" id="slop-rewrite-url" class="slop-input" value="${settings.rewriteApiUrl}">
                </div>
                <div class="slop-setting-group">
                    <label>Chat Model Name</label>
                    <input type="text" id="slop-rewrite-model" class="slop-input" value="${settings.rewriteModel}">
                </div>
                <div class="slop-setting-group">
                    <label>API Key</label>
                    <input type="password" id="slop-api-key" class="slop-input" value="${settings.apiKey}">
                </div>
                <div class="slop-check-row">
                    <button class="slop-check-btn" id="slop-reconnect-btn">Save & Reload DB</button>
                    <span id="slop-api-status" class="slop-check-status slop-check-pending">Waiting...</span>
                </div>
            </div>

            <div class="slop-section">
                <div class="slop-section-label slop-section-label-row">
                    <span>Recent Fixes</span>
                    <button class="slop-clear-history-btn" id="anti-slop-clear-history">CLEAR</button>
                </div>
                <div id="slop-history-list"><div class="slop-history-empty">No slop detected yet.</div></div>
            </div>
        </div>
    `;
    document.body.appendChild(panelElement);

    historyListElement = document.getElementById('slop-history-list');

    fab.addEventListener('click', () => { panelElement.classList.toggle('visible'); fab.classList.toggle('active'); });
    document.getElementById('anti-slop-close').addEventListener('click', () => { panelElement.classList.remove('visible'); fab.classList.remove('active'); });
    document.getElementById('anti-slop-clear-history').addEventListener('click', () => historyListElement.innerHTML = '<div class="slop-history-empty">No slop detected yet.</div>');

    document.getElementById('slop-threshold').addEventListener('input', (e) => {
        settings.threshold = parseFloat(e.target.value);
        document.getElementById('slop-threshold-val').innerText = settings.threshold;
        saveSettings();
    });

    document.getElementById('slop-reconnect-btn').addEventListener('click', async () => {
        settings.embedApiUrl = document.getElementById('slop-embed-url').value;
        settings.embedModel = document.getElementById('slop-embed-model').value;
        settings.rewriteApiUrl = document.getElementById('slop-rewrite-url').value;
        settings.rewriteModel = document.getElementById('slop-rewrite-model').value;
        settings.apiKey = document.getElementById('slop-api-key').value;
        saveSettings();
        await initDatabaseAndCacheEmbeddings();
    });
}

function saveSettings() {
    extension_settings.antiSlop = settings;
    getContext().saveSettings(); 
}

function addHistoryItem(original, rewritten, similarity, cluster) {
    const emptyMsg = historyListElement.querySelector('.slop-history-empty');
    if (emptyMsg) emptyMsg.remove();
    const item = document.createElement('div');
    item.className = 'slop-history-item';
    const time = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
    item.innerHTML = `
        <div class="slop-history-meta">@ ${time} | ${cluster.toUpperCase()} | SIM: ${Math.round(similarity * 100)}%</div>
        <div class="slop-history-original">"${original}"</div>
        <div class="slop-history-arrow">▼ LLM rewrote to ▼</div>
        <div class="slop-history-rewritten">"${rewritten}"</div>
    `;
    historyListElement.prepend(item);
}

// ==========================================
// ОБРАБОТЧИК СООБЩЕНИЙ
// ==========================================

async function processIncomingMessage(mesId) {
    console.log(`[Anti-Slop] -----------------------------------------`);
    console.log(`[Anti-Slop] Получено новое сообщение (ID: ${mesId})`);

    if (dbEmbeddings.length === 0) {
        console.warn("[Anti-Slop] ОТМЕНА: База векторов пуста. Сначала проверьте настройки API и нажмите 'Save & Reload DB'.");
        return;
    }

    const context = getContext();
    const chat = context.chat;
    const message = chat[mesId];

    if (!message || message.is_user || !message.mes) {
        console.log("[Anti-Slop] Пропуск: сообщение пустое или от пользователя.");
        return;
    }

    const originalText = message.mes;
    let modifiedText = originalText;
    let slopFound = false;

    // Разбиваем на предложения (улучшенная регулярка)
    const sentences = originalText.replace(/([.?!])\s*(?=[A-Z])/g, "$1|").split("|");
    const cleanSentences = sentences.map(s => s.trim()).filter(s => s.length > 5);
    
    console.log(`[Anti-Slop] Сообщение разбито на ${cleanSentences.length} предложений для проверки.`);

    const fab = document.getElementById('anti-slop-fab');
    fab.classList.add('processing'); 

    for (let i = 0; i < cleanSentences.length; i++) {
        const sentenceText = cleanSentences[i];
        
        // Векторизуем одно предложение
        const sVectorResponse = await fetchEmbeddings([sentenceText]);
        if (!sVectorResponse || !sVectorResponse[0]) {
            console.error(`[Anti-Slop] Ошибка векторизации предложения: "${sentenceText}"`);
            continue;
        }
        const sVector = sVectorResponse[0];
        
        let highestSim = 0;
        let matchedSlop = null;

        // Ищем сходство
        for (const dbItem of dbEmbeddings) {
            const sim = cosineSimilarity(sVector, dbItem.vector);
            if (sim > highestSim) {
                highestSim = sim;
                matchedSlop = dbItem;
            }
        }

        console.log(`[Anti-Slop] Анализ: "${sentenceText.substring(0,30)}..." -> Макс. сходство: ${(highestSim*100).toFixed(1)}% (с "${matchedSlop?.phrase}")`);

        // Сравниваем с порогом (Threshold)
        if (highestSim >= settings.threshold && matchedSlop) {
            slopFound = true;
            console.log(`[Anti-Slop] 🔥 НАЙДЕНО КЛИШЕ: сходство ${(highestSim*100).toFixed(1)}% >= ${settings.threshold*100}%`);
            
            // Запрашиваем переписывание
            const rewrittenSentence = await rewriteSentence(sentenceText, matchedSlop.phrase);
            
            if (rewrittenSentence && rewrittenSentence !== sentenceText) {
                modifiedText = modifiedText.replace(sentenceText, rewrittenSentence);
                addHistoryItem(sentenceText, rewrittenSentence, highestSim, matchedSlop.cluster);
            }
        }
    }

    if (slopFound && modifiedText !== originalText) {
        console.log("[Anti-Slop] ✅ Текст изменен, обновляем сообщение в чате.");
        const iconHtml = `<span class="anti-slop-edited-icon" title="Fixed AI Cliché (Slop)">✏️</span>`;
        message.mes = modifiedText + "\n\n" + iconHtml;

        updateMessageBlock(mesId, message);
        context.saveChat();
    } else {
        console.log("[Anti-Slop] ⚪ Клише не найдены или текст не изменился.");
    }

    fab.classList.remove('processing');
    console.log(`[Anti-Slop] -----------------------------------------`);
}

// Инициализация
jQuery(async () => {
    console.log("[Anti-Slop] Инициализация расширения...");
    createUI();
    await initDatabaseAndCacheEmbeddings();

    eventSource.on(event_types.MESSAGE_RECEIVED, async (mesId) => {
        await processIncomingMessage(mesId);
    });
});
