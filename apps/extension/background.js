const DEFAULT_SETTINGS = {
    voiceName: "",
    rate: 1,
    clickMode: false
};

const tabStates = new Map();
let activeSpeechTabId = null;


chrome.runtime.onInstalled.addListener(async () => {
    const stored = await storageGet(DEFAULT_SETTINGS);
    await storageSet({ ...DEFAULT_SETTINGS, ...stored });
});


chrome.tabs.onRemoved.addListener((tabId) => {
    if (activeSpeechTabId === tabId) {
        chrome.tts.stop();
        activeSpeechTabId = null;
    }
    tabStates.delete(tabId);
});


chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    handleMessage(message, sender)
        .then((result) => sendResponse({ ok: true, ...result }))
        .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
});


async function handleMessage(message, sender) {
    const tabId = message.tabId || sender.tab?.id;

    switch (message.type) {
        case "CONTENT_READY":
            if (!tabId) {
                return { state: null };
            }
            return { state: await getSerializableState(tabId) };

        case "GET_TAB_STATE":
            if (!tabId) {
                throw new Error("No active tab available.");
            }
            return { state: await getSerializableState(tabId) };

        case "START_READING_TOP":
            if (!tabId) {
                throw new Error("No active tab available.");
            }
            await refreshDocumentText(tabId);
            await startSpeech(tabId, 0);
            return { state: await getSerializableState(tabId) };

        case "PAGE_CLICK_READING_REQUEST":
            if (!tabId) {
                throw new Error("No tab available for click-to-read.");
            }
            await setDocumentText(tabId, message.text || "");
            await startSpeech(tabId, Number(message.offset) || 0);
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

        default:
            return {};
    }
}


async function getSerializableState(tabId) {
    const state = await ensureTabState(tabId);
    return {
        tabId,
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
    if (!tabStates.has(tabId)) {
        tabStates.set(tabId, {
            settings: await storageGet(DEFAULT_SETTINGS),
            text: "",
            currentOffset: 0,
            isSpeaking: false,
            isPaused: false,
            pendingRestart: false,
            lastError: "",
            utteranceToken: 0
        });
    }

    const state = tabStates.get(tabId);
    if (!state.settings) {
        state.settings = await storageGet(DEFAULT_SETTINGS);
    }
    return state;
}


async function updateSettings(tabId, incomingSettings) {
    const state = await ensureTabState(tabId);
    const currentSettings = await storageGet(DEFAULT_SETTINGS);
    const nextSettings = {
        ...currentSettings,
        ...sanitizeSettings(incomingSettings)
    };

    await storageSet(nextSettings);
    state.settings = nextSettings;

    await sendOptionalMessageToTab(tabId, {
        type: "SET_CLICK_MODE",
        enabled: nextSettings.clickMode
    });

    const changedVoice = Object.prototype.hasOwnProperty.call(incomingSettings, "voiceName");
    const changedRate = Object.prototype.hasOwnProperty.call(incomingSettings, "rate");

    if (activeSpeechTabId === tabId && state.text && (changedVoice || changedRate)) {
        if (state.isSpeaking) {
            await startSpeech(tabId, state.currentOffset);
        } else if (state.isPaused) {
            state.pendingRestart = true;
        }
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
}


async function startSpeech(tabId, offset) {
    const state = await ensureTabState(tabId);
    if (!state.text || !state.text.trim()) {
        await refreshDocumentText(tabId);
    }

    const text = state.text || "";
    const startOffset = clamp(offset, 0, text.length);
    if (!text.slice(startOffset).trim()) {
        throw new Error("Nothing left to read from this location.");
    }

    if (activeSpeechTabId !== null && activeSpeechTabId !== tabId) {
        await stopSpeech(activeSpeechTabId, { clearHighlights: true, resetOffset: false });
    }

    state.currentOffset = startOffset;
    state.isPaused = false;
    state.isSpeaking = false;
    state.pendingRestart = false;
    state.lastError = "";
    state.utteranceToken += 1;
    const token = state.utteranceToken;
    activeSpeechTabId = tabId;

    await chromeTtsStop();
    await sendOptionalMessageToTab(tabId, { type: "READER_STARTED", startOffset });

    await chromeTtsSpeak(text.slice(startOffset), {
        enqueue: false,
        voiceName: state.settings.voiceName || undefined,
        rate: state.settings.rate,
        onEvent: (event) => {
            void handleSpeechEvent(tabId, token, startOffset, event);
        }
    });

    await broadcastState(tabId);
}


async function handleSpeechEvent(tabId, token, startOffset, event) {
    const state = tabStates.get(tabId);
    if (!state || state.utteranceToken !== token) {
        return;
    }

    if (event.type === "start") {
        state.isSpeaking = true;
        state.isPaused = false;
        await broadcastState(tabId);
        return;
    }

    if (typeof event.charIndex === "number") {
        state.currentOffset = clamp(startOffset + event.charIndex, 0, state.text.length);
        await sendOptionalMessageToTab(tabId, {
            type: "READING_PROGRESS",
            absoluteOffset: state.currentOffset,
            eventType: event.type || "word"
        });
    }

    if (event.type === "end") {
        state.currentOffset = state.text.length;
        state.isSpeaking = false;
        state.isPaused = false;
        state.pendingRestart = false;
        if (activeSpeechTabId === tabId) {
            activeSpeechTabId = null;
        }
        await sendOptionalMessageToTab(tabId, { type: "READING_DONE" });
        await broadcastState(tabId);
        return;
    }

    if (event.type === "interrupted" || event.type === "cancelled") {
        state.isSpeaking = false;
        state.isPaused = false;
        await broadcastState(tabId);
        return;
    }

    if (event.type === "error") {
        state.isSpeaking = false;
        state.isPaused = false;
        state.lastError = event.errorMessage || "Speech playback failed.";
        if (activeSpeechTabId === tabId) {
            activeSpeechTabId = null;
        }
        await sendOptionalMessageToTab(tabId, { type: "CLEAR_READER" });
        await broadcastState(tabId);
    }
}


async function pauseSpeech(tabId) {
    const state = await ensureTabState(tabId);
    if (activeSpeechTabId !== tabId || !state.isSpeaking) {
        return;
    }

    chrome.tts.pause();
    state.isSpeaking = false;
    state.isPaused = true;
    await broadcastState(tabId);
}


async function resumeSpeech(tabId) {
    const state = await ensureTabState(tabId);
    if (!state.text) {
        await refreshDocumentText(tabId);
    }

    if (state.pendingRestart || activeSpeechTabId !== tabId) {
        await startSpeech(tabId, state.currentOffset);
        return;
    }

    if (!state.isPaused) {
        return;
    }

    chrome.tts.resume();
    state.isPaused = false;
    state.isSpeaking = true;
    await broadcastState(tabId);
}


async function stopSpeech(tabId, options = {}) {
    const { clearHighlights = true, resetOffset = false } = options;
    const state = await ensureTabState(tabId);
    const shouldStopEngine = activeSpeechTabId === tabId;

    if (shouldStopEngine) {
        activeSpeechTabId = null;
        state.utteranceToken += 1;
        await chromeTtsStop();
    }

    state.isSpeaking = false;
    state.isPaused = false;
    state.pendingRestart = false;
    state.lastError = "";
    if (resetOffset) {
        state.currentOffset = 0;
    }

    if (clearHighlights) {
        await sendOptionalMessageToTab(tabId, { type: "CLEAR_READER" });
    }

    await broadcastState(tabId);
}


async function broadcastState(tabId) {
    const payload = {
        type: "STATE_UPDATED",
        state: await getSerializableState(tabId)
    };

    try {
        await chrome.runtime.sendMessage(payload);
    } catch (error) {
        // Ignore when no extension page is listening.
    }
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


function sanitizeSettings(settings) {
    const next = {};

    if (Object.prototype.hasOwnProperty.call(settings, "voiceName")) {
        next.voiceName = typeof settings.voiceName === "string" ? settings.voiceName : "";
    }

    if (Object.prototype.hasOwnProperty.call(settings, "rate")) {
        const numericRate = Number(settings.rate);
        next.rate = clamp(Number.isFinite(numericRate) ? numericRate : 1, 0.5, 2);
    }

    if (Object.prototype.hasOwnProperty.call(settings, "clickMode")) {
        next.clickMode = Boolean(settings.clickMode);
    }

    return next;
}


function chromeTtsSpeak(text, options) {
    return new Promise((resolve, reject) => {
        chrome.tts.speak(text, options, () => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
                return;
            }
            resolve();
        });
    });
}


function chromeTtsStop() {
    return new Promise((resolve) => {
        chrome.tts.stop(() => resolve());
    });
}


function storageGet(defaults) {
    return new Promise((resolve) => {
        chrome.storage.local.get(defaults, (value) => {
            resolve(value);
        });
    });
}


function storageSet(values) {
    return new Promise((resolve) => {
        chrome.storage.local.set(values, () => resolve());
    });
}


function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}
