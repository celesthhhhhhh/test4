import { extension_settings, getContext } from "../../../extensions.js";
import { eventSource, event_types } from "../../../../script.js";
import { updateMessageBlock } from "../../../../chat.js";

// Глобальные переменные
let slopDb = {};
let dbEmbeddings = []; // Кэш векторов базы: [{ phrase, cluster, vector }]
let panelElement = null;
let historyListElement = null;

// Настройки по умолчанию
const defaultSettings = {
    // Настройки для векторного поиска (Embeddings)
    embedApiUrl: 'http://127.0.0.1:11434/v1/embeddings',
    embedModel: 'nomic-embed-text',
    
    // Настройки для переписывания (LLM Chat Completions)
    rewriteApiUrl: 'http://127.0.0.1:11434/v1/chat/completions',
    rewriteModel: 'llama3', // Замените на вашу модель (например, gpt-4o-mini, llama-3.1-8b и т.д.)
    
    apiKey: 'sk-1234', // Общий ключ (для локалок не важен, для OpenAI обязателен)
    threshold: 0.82 // Порог чувствительности (0.82 = 82% сходства)
};

// Загружаем настройки из ST
let settings = Object.assign({}, defaultSettings, extension_settings.antiSlop || {});

// ==========================================
// МАТЕМАТИКА И API ЗАПРОСЫ
// ==========================================

// Косинусное сходство (от 0 до 1)
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

// Запрос векторов (Embeddings)
async function fetchEmbeddings(texts) {
    try {
        const response = await fetch(settings.embedApiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${settings.apiKey}` },
            body: JSON.stringify({ input: texts, model: settings.embedModel })
        });
        if (!response.ok) throw new Error(`Embed API Error: ${response.status}`);
        const data = await response.json();
        return data.data.sort((a, b) => a.index - b.index).map(item => item.embedding);
    } catch (error) {
        console.error("[Anti-Slop] Ошибка Embeddings:", error);
        return null;
    }
}

// Нейросетевое переписывание предложения (LLM)
async function rewriteSentence(originalSentence, slopPhrase) {
    const systemPrompt = "You are an expert fiction editor. Your task is to rewrite the provided sentence to remove the common cliché. Make it sound natural, descriptive, and fitting for a roleplay context. DO NOT use the phrase provided in the cliché. Output ONLY the rewritten sentence. No quotes, no explanations, no notes.";
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

        if (!response.ok) throw new Error(`Rewrite API Error: ${response.status}`);
        const data = await response.json();
        
        // Очищаем ответ от лишних кавычек и пробелов
        let rewritten = data.choices[0].message.content.trim();
        rewritten = rewritten.replace(/^["']|["']$/g, '').trim(); 
        
        return rewritten;
    } catch (error) {
        console.error("[Anti-Slop] Ошибка LLM переписывания:", error);
        return originalSentence; // В случае ошибки возвращаем оригинал
    }
}

// Загрузка и кэширование базы
async function initDatabaseAndCacheEmbeddings() {
    try {
        const response = await fetch('./scripts/extensions/anti-slop/slop_db.json');
        if (!response.ok) throw new Error("Не удалось загрузить slop_db.json");
        
        const data = await response.json();
        slopDb = data.clusters || {};
        
        const allPhrases = [];
        for (const [cluster, phrases] of Object.entries(slopDb)) {
            for (const phrase of phrases) allPhrases.push({ phrase, cluster });
        }

        const textsToEmbed = allPhrases.map(item => item.phrase);
        const vectors = await fetchEmbeddings(textsToEmbed);
        
        if (vectors && vectors.length === allPhrases.length) {
            dbEmbeddings = allPhrases.map((item, i) => ({
                phrase: item.phrase,
                cluster: item.cluster,
                vector: vectors[i]
            }));
            document.getElementById('slop-api-status').innerText = "✅ DB Cached";
            document.getElementById('slop-api-status').className = "slop-check-status slop-check-ok";
        } else {
            throw new Error("Несовпадение векторов");
        }
    } catch (error) {
        console.error("[Anti-Slop] Ошибка инициализации:", error);
        document.getElementById('slop-api-status').innerText = "❌ API Error";
        document.getElementById('slop-api-status').className = "slop-check-status slop-check-err";
    }
}

// ==========================================
// ИНТЕРФЕЙС
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
                <div class="slop-header-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg></div>
                <div class="slop-header-title">
                    <span class="slop-title-main">Anti-Slop Engine</span>
                    <span class="slop-title-sub">AI Rewrite Active</span>
                </div>
            </div>
            <div class="slop-header-right">
                <button class="slop-close-btn" id="anti-slop-close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></button>
            </div>
        </div>
        <div class="slop-body">
            <div class="slop-section">
                <div class="slop-section-label">Detection Settings (Embeddings)</div>
                <div class="slop-setting-group">
                    <label>Embed API URL</label>
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
                    <label>API Key (Optional for Local)</label>
                    <input type="password" id="slop-api-key" class="slop-input" value="${settings.apiKey}">
                </div>
                <div class="slop-check-row">
                    <button class="slop-check-btn" id="slop-reconnect-btn">Save & Cache DB</button>
                    <span id="slop-api-status" class="slop-check-status slop-check-pending">Waiting...</span>
                </div>
            </div>

            <div class="slop-section">
                <div class="slop-section-label slop-section-label-row">
                    <span>Recent Fixes</span>
                    <button class="slop-clear-history-btn" id="anti-slop-clear-history">CLEAR</button>
                </div>
                <div id="slop-history-list">
                    <div class="slop-history-empty">No slop detected yet.</div>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(panelElement);

    historyListElement = document.getElementById('slop-history-list');

    fab.addEventListener('click', () => { panelElement.classList.toggle('visible'); fab.classList.toggle('active'); });
    document.getElementById('anti-slop-close').addEventListener('click', () => { panelElement.classList.remove('visible'); fab.classList.remove('active'); });
    document.getElementById('anti-slop-clear-history').addEventListener('click', () => historyListElement.innerHTML = '<div class="slop-history-empty">No slop detected yet.</div>');

    document.getElementById('slop-threshold').addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        document.getElementById('slop-threshold-val').innerText = val;
        settings.threshold = val;
        saveSettings();
    });

    document.getElementById('slop-reconnect-btn').addEventListener('click', async () => {
        settings.embedApiUrl = document.getElementById('slop-embed-url').value;
        settings.embedModel = document.getElementById('slop-embed-model').value;
        settings.rewriteApiUrl = document.getElementById('slop-rewrite-url').value;
        settings.rewriteModel = document.getElementById('slop-rewrite-model').value;
        settings.apiKey = document.getElementById('slop-api-key').value;
        saveSettings();
        
        document.getElementById('slop-api-status').innerText = "⏳ Processing...";
        document.getElementById('slop-api-status').className = "slop-check-status slop-check-pending";
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
        <div class="slop-history-meta">@ ${time} | CLUSTER: ${cluster.toUpperCase()} | SIM: ${Math.round(similarity * 100)}%</div>
        <div class="slop-history-original">"${original}"</div>
        <div class="slop-history-arrow">▼ LLM rewrote to ▼</div>
        <div class="slop-history-rewritten">"${rewritten}"</div>
    `;
    historyListElement.prepend(item);
}

// ==========================================
// ГЛАВНЫЙ ОБРАБОТЧИК СООБЩЕНИЙ
// ==========================================

async function processIncomingMessage(mesId) {
    if (dbEmbeddings.length === 0) return;

    const context = getContext();
    const chat = context.chat;
    const message = chat[mesId];

    if (!message || message.is_user || !message.mes) return;

    const originalText = message.mes;
    let modifiedText = originalText;
    let slopFound = false;

    // Разбиваем на предложения
    const sentences = originalText.match(/[^.!?]+[.!?]+/g) || [originalText];
    const cleanSentences = sentences.map(s => s.trim()).filter(s => s.length > 5);
    
    if (cleanSentences.length === 0) return;

    const fab = document.getElementById('anti-slop-fab');
    fab.classList.add('processing'); // Крутим иконку пока думает API

    // Получаем векторы
    const sentenceVectors = await fetchEmbeddings(cleanSentences);
    if (!sentenceVectors) {
        fab.classList.remove('processing');
        return;
    }

    // Проверяем каждое предложение
    for (let i = 0; i < cleanSentences.length; i++) {
        const sVector = sentenceVectors[i];
        const sentenceText = cleanSentences[i];
        
        let highestSim = 0;
        let matchedSlop = null;

        for (const dbItem of dbEmbeddings) {
            const sim = cosineSimilarity(sVector, dbItem.vector);
            if (sim > highestSim) {
                highestSim = sim;
                matchedSlop = dbItem;
            }
        }

        // Если нашли клише (сходство выше порога)
        if (highestSim >= settings.threshold && matchedSlop) {
            slopFound = true;
            console.log(`[Anti-Slop] Переписываем (${Math.round(highestSim*100)}% совпадения): "${matchedSlop.phrase}"`);
            
            // Запрашиваем переписывание у LLM
            const rewrittenSentence = await rewriteSentence(sentenceText, matchedSlop.phrase);
            
            if (rewrittenSentence && rewrittenSentence !== sentenceText) {
                // Заменяем точное совпадение старого предложения на новое
                modifiedText = modifiedText.replace(sentenceText, rewrittenSentence);
                addHistoryItem(sentenceText, rewrittenSentence, highestSim, matchedSlop.cluster);
            }
        }
    }

    // Если текст был изменен, обновляем сообщение в ST
    if (slopFound && modifiedText !== originalText) {
        const iconHtml = `<span class="anti-slop-edited-icon" title="Fixed AI Cliché (Slop)">✏️</span>`;
        message.mes = modifiedText + iconHtml;

        updateMessageBlock(mesId, message);
        context.saveChat();
    }

    fab.classList.remove('processing');
}

// Инициализация
jQuery(async () => {
    console.log("[Anti-Slop] Запуск (Embedding + LLM Rewrite)...");
    
    createUI();
    await initDatabaseAndCacheEmbeddings();

    eventSource.on(event_types.MESSAGE_RECEIVED, async (mesId) => {
        await processIncomingMessage(mesId);
    });
});
