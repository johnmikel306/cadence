const BACKEND_BASE_URL = "http://127.0.0.1:5000";
const OFFSCREEN_DOCUMENT_PATH = "offscreen.html";
const ACTIVE_TAB_STORAGE_KEY = "runtime:activeSpeechTabId";
const TAB_STATE_STORAGE_PREFIX = "runtime:tabState:";
const DEFAULT_SETTINGS = {
    voiceName: "en-US-AriaNeural",
    rate: "+0%",
    clickMode: false
};
const VALID_RATES = new Set(["-25%", "+0%", "+25%", "+50%"]);

const tabStates = new Map();
let activeSpeechTabId = null;
let offscreenCreation = null;


chrome.runtime.onInstalled.addListener(async () => {
    const stored = await storageLocalGet(DEFAULT_SETTINGS);
    await storageLocalSet({ ...DEFAULT_SETTINGS, ...stored });
});


chrome.tabs.onRemoved.addListener((tabId) => {
    void cleanupRemovedTab(tabId);
});


chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.target === "offscreen") {
        return undefined;
    }

    handleMessage(message, sender)
        .then((result) => sendResponse({ ok: true, ...result }))
        .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
});


chrome.commands.onCommand.addListener((command) => {
    void handleCommand(command).catch((error) => {
        console.error("Cadence command failed:", error);
    });
});


async function handleMessage(message, sender) {
    const tabId = message.tabId || sender.tab?.id;

    switch (message.type) {
        case "CONTENT_READY":
            if (!tabId) {
                return { state: null };
            }
            await syncTabStateWithOffscreen(tabId);
            return { state: await getSerializableState(tabId) };

        case "GET_TAB_STATE":
            if (!tabId) {
                throw new Error("No active tab available.");
            }
            await syncTabStateWithOffscreen(tabId);
            return { state: await getSerializableState(tabId) };

        case "GET_BACKEND_VOICES":
            return { voices: await fetchBackendVoices() };

        case "START_READING_TOP":
            if (!tabId) {
                throw new Error("No active tab available.");
            }
            await refreshDocumentText(tabId);
            await startSpeech(tabId, 0, { autoplay: true });
            return { state: await getSerializableState(tabId) };

        case "PAGE_CLICK_READING_REQUEST":
            if (!tabId) {
                throw new Error("No tab available for click-to-read.");
            }
            await setDocumentText(tabId, message.text || "");
            await startSpeech(tabId, Number(message.offset) || 0, { autoplay: true });
            return { state: await getSerializableState(tabId) };

        case "PAUSE_READING":
            if (!tabId) {
                throw new Error("No active tab available.");
            }
            await pauseSpeech(tabId);
            return { state: await getSerializableState(tabId) };

        case "RESUME_READING":
            if (!tabId) {
                throw new Error("No active tab available.");
            }
            await resumeSpeech(tabId);
            return { state: await getSerializableState(tabId) };

        case "STOP_READING":
            if (!tabId) {
                throw new Error("No active tab available.");
            }
            await stopSpeech(tabId, { clearHighlights: true, resetOffset: true });
            return { state: await getSerializableState(tabId) };

        case "UPDATE_SETTINGS":
            if (!tabId) {
                throw new Error("No active tab available.");
            }
            await updateSettings(tabId, message.settings || {});
            return { state: await getSerializableState(tabId) };

        case "FLOATING_TOGGLE_PLAYBACK":
            if (!tabId) {
                throw new Error("No active tab available.");
            }
            await togglePlayback(tabId);
            return { state: await getSerializableState(tabId) };

        case "FLOATING_STOP_READING":
            if (!tabId) {
                throw new Error("No active tab available.");
            }
            await stopSpeech(tabId, { clearHighlights: true, resetOffset: true });
            return { state: await getSerializableState(tabId) };

        case "OFFSCREEN_PROGRESS":
            await handleOffscreenProgress(message);
            return {};

        case "OFFSCREEN_STATUS":
            await handleOffscreenStatus(message);
            return {};

        default:
            return {};
    }
}


async function handleCommand(command) {
    const tab = await getActiveTab();
    if (!tab || !tab.id) {
        return;
    }

    if (command === "read-from-top") {
        await refreshDocumentText(tab.id);
        await startSpeech(tab.id, 0, { autoplay: true });
        return;
    }

    if (command === "toggle-playback") {
        await togglePlayback(tab.id);
    }
}


async function togglePlayback(tabId) {
    await syncTabStateWithOffscreen(tabId);
    const state = await ensureTabState(tabId);

    if (state.sessionId && state.isSpeaking) {
        await pauseSpeech(tabId);
        return;
    }

    if (state.sessionId && state.isPaused) {
        await resumeSpeech(tabId);
        return;
    }

    await refreshDocumentText(tabId);
    await startSpeech(tabId, 0, { autoplay: true });
}


async function getActiveTab() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs[0] || null;
}


async function getSerializableState(tabId) {
    const state = await ensureTabState(tabId);
    await ensureActiveSpeechTabId();

    return {
        tabId,
        backendBaseUrl: BACKEND_BASE_URL,
        currentOffset: state.currentOffset,
        hasDocumentText: Boolean(state.text),
        isSpeaking: state.isSpeaking,
        isPaused: state.isPaused,
        clickMode: state.settings.clickMode,
        pendingRestart: state.pendingRestart,
        voiceName: state.settings.voiceName,
        rate: state.settings.rate,
        lastError: state.lastError || "",
        isActiveTab: activeSpeechTabId === tabId
    };
}


async function ensureTabState(tabId) {
    if (tabStates.has(tabId)) {
        return tabStates.get(tabId);
    }

    const settings = await storageLocalGet(DEFAULT_SETTINGS);
    const stored = await loadPersistedTabState(tabId);
    const state = stored
        ? hydrateStoredState(stored, settings)
        : createInitialState(settings);

    tabStates.set(tabId, state);
    return state;
}


async function ensureActiveSpeechTabId() {
    if (activeSpeechTabId !== null) {
        return activeSpeechTabId;
    }

    const stored = await storageSessionGet({ [ACTIVE_TAB_STORAGE_KEY]: null });
    const nextTabId = stored[ACTIVE_TAB_STORAGE_KEY];
    activeSpeechTabId = typeof nextTabId === "number" ? nextTabId : null;
    return activeSpeechTabId;
}


async function cleanupRemovedTab(tabId) {
    const state = await ensureTabState(tabId).catch(() => null);

    if (state && state.sessionId) {
        void deleteBackendSession(state.sessionId);
    }

    await ensureActiveSpeechTabId();
    if (activeSpeechTabId === tabId) {
        activeSpeechTabId = null;
        await persistActiveSpeechTabId();
        await sendOptionalOffscreenMessage({
            target: "offscreen",
            type: "OFFSCREEN_STOP",
            tabId,
            sessionToken: state ? state.sessionToken + 1 : 0
        });
    }

    tabStates.delete(tabId);
    await clearPersistedTabState(tabId);
}


async function updateSettings(tabId, incomingSettings) {
    await syncTabStateWithOffscreen(tabId);
    const state = await ensureTabState(tabId);
    const currentSettings = await storageLocalGet(DEFAULT_SETTINGS);
    const nextSettings = {
        ...currentSettings,
        ...sanitizeSettings(incomingSettings)
    };

    await storageLocalSet(nextSettings);
    state.settings = nextSettings;
    await persistTabState(tabId, state);

    await sendOptionalMessageToTab(tabId, {
        type: "SET_CLICK_MODE",
        enabled: nextSettings.clickMode
    });

    const changedVoice = Object.prototype.hasOwnProperty.call(incomingSettings, "voiceName");
    const changedRate = Object.prototype.hasOwnProperty.call(incomingSettings, "rate");

    if (state.sessionId && state.text && (changedVoice || changedRate)) {
        if (changedRate && state.isSpeaking) {
            await sendOptionalOffscreenMessage({
                target: "offscreen",
                type: "OFFSCREEN_SET_PLAYBACK_RATE",
                tabId,
                sessionToken: state.sessionToken,
                playbackRate: rateToPlaybackRate(nextSettings.rate)
            });
        }

        await startSpeech(tabId, state.currentOffset, { autoplay: state.isSpeaking });
        return;
    }

    await broadcastState(tabId);
}


async function refreshDocumentText(tabId) {
    const response = await sendMessageToTab(tabId, { type: "GET_READING_SNAPSHOT" });
    if (!response || !response.text || !response.text.trim()) {
        throw new Error("This page does not expose readable text for the extension.");
    }

    await setDocumentText(tabId, response.text);
}


async function setDocumentText(tabId, text) {
    const state = await ensureTabState(tabId);
    state.text = text || "";
    state.currentOffset = clamp(state.currentOffset, 0, state.text.length);
    state.lastError = "";
    await persistTabState(tabId, state);
}


async function startSpeech(tabId, offset, options = {}) {
    const { autoplay = true } = options;
    const state = await ensureTabState(tabId);

    if (!state.text || !state.text.trim()) {
        await refreshDocumentText(tabId);
    }

    const text = state.text || "";
    const startOffset = clamp(Number(offset) || 0, 0, text.length);
    if (!text.slice(startOffset).trim()) {
        throw new Error("Nothing left to read from this location.");
    }

    await ensureActiveSpeechTabId();
    if (activeSpeechTabId !== null && activeSpeechTabId !== tabId) {
        await stopSpeech(activeSpeechTabId, { clearHighlights: true, resetOffset: false });
    }

    const previousSessionId = state.sessionId;
    const sessionToken = state.sessionToken + 1;
    const session = await createPageReadSession({
        text,
        startOffset,
        voice: state.settings.voiceName,
        rate: state.settings.rate
    });

    await ensureOffscreenDocument();

    state.sessionToken = sessionToken;
    state.sessionId = session.session_id;
    state.sessionStartOffset = session.start_offset;
    state.currentOffset = session.start_offset;
    state.isSpeaking = false;
    state.isPaused = !autoplay;
    state.pendingRestart = false;
    state.lastError = "";
    activeSpeechTabId = tabId;

    await persistTabState(tabId, state);
    await persistActiveSpeechTabId();

    try {
        await sendOptionalMessageToTab(tabId, {
            type: "READER_STARTED",
            startOffset: session.start_offset
        });

        await sendOffscreenMessage({
            target: "offscreen",
            type: "OFFSCREEN_START_SESSION",
            tabId,
            sessionId: session.session_id,
            sessionToken,
            startOffset: session.start_offset,
            audioUrl: absoluteBackendUrl(session.audio_url),
            eventsUrl: absoluteBackendUrl(session.events_url),
            autoplay,
            playbackRate: 1
        });
    } catch (error) {
        state.sessionId = null;
        state.isSpeaking = false;
        state.isPaused = false;
        state.lastError = error.message || "Audio playback could not start.";
        if (activeSpeechTabId === tabId) {
            activeSpeechTabId = null;
        }
        await persistTabState(tabId, state);
        await persistActiveSpeechTabId();
        void deleteBackendSession(session.session_id);
        await broadcastState(tabId);
        throw error;
    }

    if (previousSessionId && previousSessionId !== session.session_id) {
        void deleteBackendSession(previousSessionId);
    }

    await broadcastState(tabId);
}


async function pauseSpeech(tabId) {
    await syncTabStateWithOffscreen(tabId);
    const state = await ensureTabState(tabId);
    if (!state.sessionId) {
        return;
    }

    await sendOffscreenMessage({
        target: "offscreen",
        type: "OFFSCREEN_PAUSE",
        tabId,
        sessionToken: state.sessionToken
    });

    state.isSpeaking = false;
    state.isPaused = true;
    await persistTabState(tabId, state);
    await broadcastState(tabId);
}


async function resumeSpeech(tabId) {
    await syncTabStateWithOffscreen(tabId);
    const state = await ensureTabState(tabId);
    if (!state.text) {
        await refreshDocumentText(tabId);
    }

    if (!state.sessionId) {
        await startSpeech(tabId, state.currentOffset, { autoplay: true });
        return;
    }

    try {
        await ensureOffscreenDocument();
        await sendOffscreenMessage({
            target: "offscreen",
            type: "OFFSCREEN_RESUME",
            tabId,
            sessionToken: state.sessionToken
        });
    } catch (error) {
        await startSpeech(tabId, state.currentOffset, { autoplay: true });
        return;
    }

    state.isPaused = false;
    state.isSpeaking = true;
    activeSpeechTabId = tabId;
    await persistTabState(tabId, state);
    await persistActiveSpeechTabId();
    await broadcastState(tabId);
}


async function stopSpeech(tabId, options = {}) {
    await syncTabStateWithOffscreen(tabId);
    const { clearHighlights = true, resetOffset = false } = options;
    const state = await ensureTabState(tabId);
    const sessionId = state.sessionId;

    state.sessionToken += 1;

    if (sessionId || activeSpeechTabId === tabId) {
        await sendOptionalOffscreenMessage({
            target: "offscreen",
            type: "OFFSCREEN_STOP",
            tabId,
            sessionToken: state.sessionToken
        });
    }

    if (sessionId) {
        void deleteBackendSession(sessionId);
    }

    if (activeSpeechTabId === tabId) {
        activeSpeechTabId = null;
    }

    state.sessionId = null;
    state.sessionStartOffset = 0;
    state.isSpeaking = false;
    state.isPaused = false;
    state.pendingRestart = false;
    state.lastError = "";
    if (resetOffset) {
        state.currentOffset = 0;
    }

    await persistTabState(tabId, state);
    await persistActiveSpeechTabId();

    if (clearHighlights) {
        await sendOptionalMessageToTab(tabId, { type: "CLEAR_READER" });
    }

    await broadcastState(tabId);
}


async function handleOffscreenProgress(message) {
    const tabId = message.tabId;
    if (!tabId) {
        return;
    }

    const state = await ensureTabState(tabId);
    if (message.sessionToken !== state.sessionToken) {
        return;
    }

    state.currentOffset = normalizeResumeOffset(state.text, message.resumeOffset);
    await persistTabState(tabId, state);

    await sendOptionalMessageToTab(tabId, {
        type: "READING_PROGRESS",
        absoluteOffset: clamp(Number(message.highlightOffset) || 0, 0, state.text.length)
    });
}


async function handleOffscreenStatus(message) {
    const tabId = message.tabId;
    if (!tabId) {
        return;
    }

    const state = await ensureTabState(tabId);
    if (message.sessionToken !== state.sessionToken) {
        return;
    }

    switch (message.status) {
        case "play":
            state.isSpeaking = true;
            state.isPaused = false;
            state.lastError = "";
            activeSpeechTabId = tabId;
            break;

        case "pause":
            state.isSpeaking = false;
            state.isPaused = true;
            break;

        case "ready":
            state.isSpeaking = false;
            state.isPaused = true;
            state.lastError = "";
            activeSpeechTabId = tabId;
            break;

        case "ended":
            if (state.sessionId) {
                void deleteBackendSession(state.sessionId);
            }
            state.currentOffset = state.text.length;
            state.isSpeaking = false;
            state.isPaused = false;
            state.pendingRestart = false;
            state.sessionId = null;
            state.sessionStartOffset = 0;
            if (activeSpeechTabId === tabId) {
                activeSpeechTabId = null;
            }
            await sendOptionalMessageToTab(tabId, { type: "READING_DONE" });
            break;

        case "error":
            if (state.sessionId) {
                void deleteBackendSession(state.sessionId);
            }
            state.isSpeaking = false;
            state.isPaused = false;
            state.pendingRestart = false;
            state.lastError = message.error || "Edge TTS playback failed.";
            state.sessionId = null;
            state.sessionStartOffset = 0;
            if (activeSpeechTabId === tabId) {
                activeSpeechTabId = null;
            }
            await sendOptionalMessageToTab(tabId, { type: "CLEAR_READER" });
            break;

        default:
            return;
    }

    await persistTabState(tabId, state);
    await persistActiveSpeechTabId();
    await broadcastState(tabId);
}


async function syncTabStateWithOffscreen(tabId) {
    await ensureActiveSpeechTabId();

    const offscreenState = await getOffscreenState();
    if (!offscreenState || !offscreenState.hasAudio) {
        if (activeSpeechTabId !== null) {
            activeSpeechTabId = null;
            await persistActiveSpeechTabId();
        }
        return false;
    }

    activeSpeechTabId = offscreenState.tabId;
    await persistActiveSpeechTabId();

    if (offscreenState.tabId !== tabId) {
        return false;
    }

    const state = await ensureTabState(tabId);
    state.sessionId = offscreenState.sessionId || state.sessionId;
    state.sessionToken = offscreenState.sessionToken;
    state.sessionStartOffset = offscreenState.startOffset;
    state.currentOffset = normalizeResumeOffset(state.text, offscreenState.currentOffset);
    state.isSpeaking = Boolean(offscreenState.isPlaying);
    state.isPaused = Boolean(offscreenState.isPaused);
    await persistTabState(tabId, state);
    return true;
}


async function ensureOffscreenDocument() {
    if (await hasOffscreenDocument()) {
        return;
    }

    if (offscreenCreation) {
        await offscreenCreation;
        return;
    }

    offscreenCreation = chrome.offscreen.createDocument({
        url: OFFSCREEN_DOCUMENT_PATH,
        reasons: ["AUDIO_PLAYBACK"],
        justification: "Play streamed Edge TTS audio for webpage reading."
    });

    try {
        await offscreenCreation;
    } finally {
        offscreenCreation = null;
    }
}


async function hasOffscreenDocument() {
    const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);

    if ("getContexts" in chrome.runtime) {
        const contexts = await chrome.runtime.getContexts({
            contextTypes: ["OFFSCREEN_DOCUMENT"],
            documentUrls: [offscreenUrl]
        });
        return contexts.length > 0;
    }

    return false;
}


async function getOffscreenState() {
    if (!(await hasOffscreenDocument())) {
        return null;
    }

    const response = await sendOptionalOffscreenMessage({
        target: "offscreen",
        type: "OFFSCREEN_GET_STATE"
    });

    if (!response || !response.state) {
        return null;
    }

    return response.state;
}


async function fetchBackendVoices() {
    return fetchBackendJson("/api/voices");
}


async function createPageReadSession(payload) {
    return fetchBackendJson("/api/page-read-sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            text: payload.text,
            start_offset: payload.startOffset,
            voice: payload.voice,
            rate: payload.rate
        })
    });
}


async function deleteBackendSession(sessionId) {
    if (!sessionId) {
        return;
    }

    try {
        await fetch(absoluteBackendUrl(`/api/read-sessions/${sessionId}`), {
            method: "DELETE"
        });
    } catch (error) {
        // Ignore cleanup errors.
    }
}


async function fetchBackendJson(path, options = {}) {
    const response = await fetch(absoluteBackendUrl(path), options);
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
        throw new Error(payload.error || `Backend request failed with ${response.status}`);
    }

    return payload;
}


function absoluteBackendUrl(path) {
    if (/^https?:\/\//.test(path)) {
        return path;
    }
    return `${BACKEND_BASE_URL}${path}`;
}


async function broadcastState(tabId) {
    const state = await getSerializableState(tabId);
    const payload = {
        type: "STATE_UPDATED",
        state
    };

    try {
        await chrome.runtime.sendMessage(payload);
    } catch (error) {
        // Ignore when no popup is listening.
    }

    await sendOptionalMessageToTab(tabId, {
        type: "READER_STATE_UPDATED",
        state
    });
}


async function sendMessageToTab(tabId, message) {
    try {
        return await chrome.tabs.sendMessage(tabId, message);
    } catch (error) {
        const fallback = chrome.runtime.lastError?.message;
        if (fallback) {
            throw new Error(fallback);
        }
        throw error;
    }
}


async function sendOptionalMessageToTab(tabId, message) {
    try {
        return await sendMessageToTab(tabId, message);
    } catch (error) {
        return null;
    }
}


async function sendOffscreenMessage(message) {
    const response = await chrome.runtime.sendMessage(message);
    if (!response || response.ok === false) {
        throw new Error(response?.error || "Offscreen audio controller did not respond.");
    }
    return response;
}


async function sendOptionalOffscreenMessage(message) {
    try {
        return await sendOffscreenMessage(message);
    } catch (error) {
        return null;
    }
}


function createInitialState(settings) {
    return {
        settings,
        text: "",
        currentOffset: 0,
        sessionId: null,
        sessionToken: 0,
        sessionStartOffset: 0,
        isSpeaking: false,
        isPaused: false,
        pendingRestart: false,
        lastError: ""
    };
}


function hydrateStoredState(storedState, settings) {
    return {
        settings,
        text: typeof storedState.text === "string" ? storedState.text : "",
        currentOffset: Number.isFinite(storedState.currentOffset) ? storedState.currentOffset : 0,
        sessionId: typeof storedState.sessionId === "string" ? storedState.sessionId : null,
        sessionToken: Number.isFinite(storedState.sessionToken) ? storedState.sessionToken : 0,
        sessionStartOffset: Number.isFinite(storedState.sessionStartOffset) ? storedState.sessionStartOffset : 0,
        isSpeaking: Boolean(storedState.isSpeaking),
        isPaused: Boolean(storedState.isPaused),
        pendingRestart: Boolean(storedState.pendingRestart),
        lastError: typeof storedState.lastError === "string" ? storedState.lastError : ""
    };
}


function serializeTabState(state) {
    return {
        settings: state.settings,
        text: state.text,
        currentOffset: state.currentOffset,
        sessionId: state.sessionId,
        sessionToken: state.sessionToken,
        sessionStartOffset: state.sessionStartOffset,
        isSpeaking: state.isSpeaking,
        isPaused: state.isPaused,
        pendingRestart: state.pendingRestart,
        lastError: state.lastError
    };
}


async function loadPersistedTabState(tabId) {
    const key = tabStateStorageKey(tabId);
    const stored = await storageSessionGet({ [key]: null });
    return stored[key] || null;
}


async function persistTabState(tabId, state) {
    await storageSessionSet({
        [tabStateStorageKey(tabId)]: serializeTabState(state)
    });
}


async function clearPersistedTabState(tabId) {
    await storageSessionRemove(tabStateStorageKey(tabId));
}


async function persistActiveSpeechTabId() {
    if (activeSpeechTabId === null) {
        await storageSessionRemove(ACTIVE_TAB_STORAGE_KEY);
        return;
    }

    await storageSessionSet({ [ACTIVE_TAB_STORAGE_KEY]: activeSpeechTabId });
}


function tabStateStorageKey(tabId) {
    return `${TAB_STATE_STORAGE_PREFIX}${tabId}`;
}


function sanitizeSettings(settings) {
    const next = {};

    if (Object.prototype.hasOwnProperty.call(settings, "voiceName")) {
        next.voiceName = typeof settings.voiceName === "string"
            ? settings.voiceName
            : DEFAULT_SETTINGS.voiceName;
    }

    if (Object.prototype.hasOwnProperty.call(settings, "rate")) {
        const nextRate = typeof settings.rate === "string"
            ? settings.rate
            : DEFAULT_SETTINGS.rate;
        next.rate = VALID_RATES.has(nextRate) ? nextRate : DEFAULT_SETTINGS.rate;
    }

    if (Object.prototype.hasOwnProperty.call(settings, "clickMode")) {
        next.clickMode = Boolean(settings.clickMode);
    }

    return next;
}


function normalizeResumeOffset(text, offset) {
    const safeText = text || "";
    let cursor = clamp(Number(offset) || 0, 0, safeText.length);
    while (cursor < safeText.length && /\s/.test(safeText[cursor])) {
        cursor += 1;
    }
    return clamp(cursor, 0, safeText.length);
}


function rateToPlaybackRate(rate) {
    const match = /^([+-])(\d+)%$/.exec(rate || "+0%");
    if (!match) {
        return 1;
    }

    const direction = match[1] === "+" ? 1 : -1;
    const amount = Number(match[2]) / 100;
    return clamp(1 + direction * amount, 0.5, 2);
}


function storageLocalGet(defaults) {
    return new Promise((resolve) => {
        chrome.storage.local.get(defaults, (value) => {
            resolve(value);
        });
    });
}


function storageLocalSet(values) {
    return new Promise((resolve) => {
        chrome.storage.local.set(values, () => resolve());
    });
}


function storageSessionGet(defaults) {
    return new Promise((resolve) => {
        chrome.storage.session.get(defaults, (value) => {
            resolve(value);
        });
    });
}


function storageSessionSet(values) {
    return new Promise((resolve) => {
        chrome.storage.session.set(values, () => resolve());
    });
}


function storageSessionRemove(keys) {
    return new Promise((resolve) => {
        chrome.storage.session.remove(keys, () => resolve());
    });
}


function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}
