(function () {
    const elements = {
        voiceSelect: document.getElementById("voice-select"),
        rateSelect: document.getElementById("rate-select"),
        clickModeToggle: document.getElementById("click-mode-toggle"),
        readTopBtn: document.getElementById("read-top-btn"),
        pauseBtn: document.getElementById("pause-btn"),
        resumeBtn: document.getElementById("resume-btn"),
        stopBtn: document.getElementById("stop-btn"),
        statusText: document.getElementById("status-text"),
        pageMeta: document.getElementById("page-meta")
    };

    let activeTabId = null;

    init().catch((error) => {
        setStatus(error.message || "Extension popup failed to load.", true);
    });

    chrome.runtime.onMessage.addListener((message) => {
        if (message.type !== "STATE_UPDATED" || !message.state || message.state.tabId !== activeTabId) {
            return;
        }
        renderState(message.state);
    });

    async function init() {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab || !tab.id) {
            throw new Error("No active tab is available.");
        }

        activeTabId = tab.id;
        elements.pageMeta.textContent = tab.title || tab.url || "Current tab";

        await loadVoices();
        bindEvents();
        await refreshState();
    }

    function bindEvents() {
        elements.readTopBtn.addEventListener("click", () => sendAction("START_READING_TOP", "Starting webpage reading..."));
        elements.pauseBtn.addEventListener("click", () => sendAction("PAUSE_READING", "Paused."));
        elements.resumeBtn.addEventListener("click", () => sendAction("RESUME_READING", "Resumed."));
        elements.stopBtn.addEventListener("click", () => sendAction("STOP_READING", "Stopped."));

        elements.voiceSelect.addEventListener("change", async () => {
            await updateSettings({ voiceName: elements.voiceSelect.value });
            setStatus("Voice updated.");
        });

        elements.rateSelect.addEventListener("change", async () => {
            await updateSettings({ rate: Number(elements.rateSelect.value) });
            setStatus("Speed updated.");
        });

        elements.clickModeToggle.addEventListener("change", async () => {
            await updateSettings({ clickMode: elements.clickModeToggle.checked });
            setStatus(elements.clickModeToggle.checked ? "Click-to-read enabled." : "Click-to-read disabled.");
        });
    }

    async function loadVoices() {
        const voices = await new Promise((resolve) => {
            chrome.tts.getVoices((value) => resolve(value || []));
        });

        elements.voiceSelect.innerHTML = "";

        const defaultOption = document.createElement("option");
        defaultOption.value = "";
        defaultOption.textContent = "Browser default voice";
        elements.voiceSelect.appendChild(defaultOption);

        voices.forEach((voice) => {
            const option = document.createElement("option");
            option.value = voice.voiceName;
            const locale = voice.lang ? ` (${voice.lang})` : "";
            option.textContent = `${voice.voiceName}${locale}`;
            elements.voiceSelect.appendChild(option);
        });
    }

    async function refreshState() {
        const response = await chrome.runtime.sendMessage({
            type: "GET_TAB_STATE",
            tabId: activeTabId
        });

        if (!response || !response.ok) {
            throw new Error(response?.error || "Could not load tab state.");
        }

        renderState(response.state);
    }

    async function sendAction(type, successMessage) {
        const response = await chrome.runtime.sendMessage({ type, tabId: activeTabId });
        if (!response || !response.ok) {
            setStatus(response?.error || "That action could not be completed.", true);
            return;
        }

        renderState(response.state);
        setStatus(successMessage);
    }

    async function updateSettings(settings) {
        const response = await chrome.runtime.sendMessage({
            type: "UPDATE_SETTINGS",
            tabId: activeTabId,
            settings
        });

        if (!response || !response.ok) {
            setStatus(response?.error || "Settings update failed.", true);
            return;
        }

        renderState(response.state);
    }

    function renderState(state) {
        if (!state) {
            return;
        }

        elements.voiceSelect.value = state.voiceName || "";
        elements.rateSelect.value = String(state.rate || 1);
        elements.clickModeToggle.checked = Boolean(state.clickMode);

        if (state.lastError) {
            setStatus(state.lastError, true);
            return;
        }

        if (state.isSpeaking) {
            setStatus("Reading this page now.");
            return;
        }

        if (state.isPaused) {
            setStatus("Paused at the current reading position.");
            return;
        }

        if (state.hasDocumentText && state.currentOffset > 0) {
            setStatus("Ready to resume from the last reading position.");
            return;
        }

        setStatus("Open a webpage and start reading.");
    }

    function setStatus(message, isError) {
        elements.statusText.textContent = message;
        elements.statusText.style.color = isError ? "#b42318" : "";
    }
})();
