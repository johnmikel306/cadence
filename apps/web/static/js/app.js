(function () {
    const elements = {
        fileInput: document.getElementById("file-input"),
        voiceSelect: document.getElementById("voice-select"),
        speedSelect: document.getElementById("speed-select"),
        playFromStartBtn: document.getElementById("play-from-start-btn"),
        pauseBtn: document.getElementById("pause-btn"),
        resumeBtn: document.getElementById("resume-btn"),
        stopBtn: document.getElementById("stop-btn"),
        statusText: document.getElementById("status-text"),
        documentMeta: document.getElementById("document-meta"),
        loadingIndicator: document.getElementById("loading-indicator"),
        viewerScrollArea: document.getElementById("viewer-scroll-area"),
        documentViewer: document.getElementById("document-viewer"),
        audioPlayer: document.getElementById("audio-player"),
        audioProgressBar: document.getElementById("audio-progress-bar"),
        progressFill: document.getElementById("progress-fill"),
        progressTime: document.getElementById("progress-time"),
        progressLabel: document.getElementById("progress-label"),
        progressTrack: document.querySelector(".progress-track"),
        kbdHints: document.getElementById("kbd-hints"),
        sidebarToggle: document.getElementById("sidebar-toggle"),
        readerNotes: document.getElementById("reader-notes")
    };

    const state = {
        currentDocument: null,
        readingMap: null,
        sentenceRanges: [],
        manifestReady: false,
        currentSession: null,
        sessionRequestToken: 0,
        syncFrame: null,
        highlightLayer: null,
        currentGlobalOffset: 0,
        currentVoice: "en-US-AriaNeural",
        currentRate: "+0%",
        sidebarVisible: !localStorage.getItem("sidebar-hidden"),
        progressSyncFrame: null
    };

    const BLOCK_TAGS = new Set([
        "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DD", "DIV", "DL", "DT", "FIGCAPTION", "FIGURE",
        "FOOTER", "FORM", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HR", "LI", "MAIN",
        "NAV", "OL", "P", "PRE", "SECTION", "TABLE", "TBODY", "TD", "TH", "THEAD", "TR", "UL"
    ]);

    if (window.marked) {
        marked.setOptions({ gfm: true, breaks: true });
    }

    if (window.pdfjsLib) {
        pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js";
    }

    bindEvents();
    loadVoices();

    function bindEvents() {
        elements.fileInput.addEventListener("change", async (event) => {
            const [file] = event.target.files;
            if (!file) {
                return;
            }
            await uploadAndRenderFile(file);
            elements.fileInput.value = "";
        });

        elements.playFromStartBtn.addEventListener("click", () => startReadingAt(0));
        elements.pauseBtn.addEventListener("click", pauseReading);
        elements.resumeBtn.addEventListener("click", resumeReading);
        elements.stopBtn.addEventListener("click", () => stopReading({ clearHighlights: true }));

        elements.voiceSelect.addEventListener("change", async () => {
            state.currentVoice = elements.voiceSelect.value;
            await handleVoiceChange();
        });

        elements.speedSelect.addEventListener("change", async () => {
            state.currentRate = elements.speedSelect.value;
            await handleSpeedChange();
        });

        elements.documentViewer.addEventListener("click", async (event) => {
            if (!state.readingMap || !state.manifestReady) {
                return;
            }

            const offset = state.readingMap.getOffsetFromEvent(event);
            if (offset == null) {
                return;
            }

            if (event.target.closest("a")) {
                event.preventDefault();
            }

            await startReadingAt(offset);
        });

        elements.audioPlayer.addEventListener("ended", () => {
            if (state.currentSession) {
                state.currentGlobalOffset = getDocumentTextLength();
                setStatus("Finished reading.", "success");
            }
            stopSyncLoop();
        });

        elements.audioPlayer.addEventListener("pause", () => {
            stopSyncLoop();
        });

        elements.audioPlayer.addEventListener("play", () => {
            startSyncLoop();
        });

        window.addEventListener("resize", () => {
            if (state.currentSession) {
                renderActiveHighlights();
            }
        });

        // Keyboard shortcuts
        document.addEventListener("keydown", (event) => {
            // Don't interfere with text input fields
            if (event.target.matches("input, textarea, select")) {
                return;
            }

            if (event.code === "Space") {
                event.preventDefault();
                if (elements.audioPlayer.paused) {
                    resumeReading();
                } else {
                    pauseReading();
                }
            } else if (event.code === "Escape") {
                event.preventDefault();
                stopReading({ clearHighlights: true });
            } else if (event.code === "BracketLeft") {
                event.preventDefault();
                // Previous sentence
                jumpToSentence(-1);
            } else if (event.code === "BracketRight") {
                event.preventDefault();
                // Next sentence
                jumpToSentence(1);
            }
        });

        // Sidebar toggle
        if (elements.sidebarToggle) {
            elements.sidebarToggle.addEventListener("click", () => {
                state.sidebarVisible = !state.sidebarVisible;
                if (state.sidebarVisible) {
                    elements.readerNotes.classList.remove("collapsed");
                    localStorage.removeItem("sidebar-hidden");
                } else {
                    elements.readerNotes.classList.add("collapsed");
                    localStorage.setItem("sidebar-hidden", "true");
                }
            });
        }

        // Progress bar click to seek
        if (elements.progressTrack) {
            elements.progressTrack.addEventListener("click", (event) => {
                if (!elements.audioPlayer.src || elements.audioPlayer.duration === 0) {
                    return;
                }
                const rect = elements.progressTrack.getBoundingClientRect();
                const percent = (event.clientX - rect.left) / rect.width;
                elements.audioPlayer.currentTime = percent * elements.audioPlayer.duration;
            });
        }

        // Initialize sidebar visibility
        if (!state.sidebarVisible && elements.readerNotes) {
            elements.readerNotes.classList.add("collapsed");
        }
    }

    async function loadVoices() {
        try {
            const response = await fetch("/api/voices");
            const voices = await response.json();
            if (!response.ok) {
                throw new Error(voices.error || "Failed to load voices");
            }

            // Group voices by locale
            const voicesByLocale = {};
            voices.forEach((voice) => {
                const locale = voice.locale || "Unknown";
                if (!voicesByLocale[locale]) {
                    voicesByLocale[locale] = [];
                }
                voicesByLocale[locale].push(voice);
            });

            elements.voiceSelect.innerHTML = "";

            // Create optgroups by locale
            Object.keys(voicesByLocale).sort().forEach((locale) => {
                const optgroup = document.createElement("optgroup");
                optgroup.label = locale;

                voicesByLocale[locale].forEach((voice) => {
                    const option = document.createElement("option");
                    option.value = voice.name;
                    // Use friendly name if available, otherwise use short name
                    const displayName = voice.friendly_name || voice.name;
                    option.textContent = displayName;
                    if (voice.name === state.currentVoice) {
                        option.selected = true;
                    }
                    optgroup.appendChild(option);
                });

                elements.voiceSelect.appendChild(optgroup);
            });

            if (!elements.voiceSelect.value && voices.length) {
                elements.voiceSelect.value = voices[0].name;
                state.currentVoice = voices[0].name;
            }
        } catch (error) {
            setStatus(`Voice loading failed: ${error.message}`, "error");
        }
    }

    async function handleVoiceChange() {
        if (!state.currentSession) {
            return;
        }

        if (elements.audioPlayer.ended) {
            setStatus("Voice updated for the next playback.");
            return;
        }

        const autoplay = shouldAutoplayCurrentSession();
        const reason = autoplay ? "Switching voice..." : "Updating paused session voice...";
        await hotSwapCurrentSession({ reason, autoplay });
    }

    async function handleSpeedChange() {
        if (!state.currentSession) {
            return;
        }

        if (elements.audioPlayer.ended) {
            setStatus("Speed updated for the next playback.");
            return;
        }

        const immediatePlaybackRate = rateToPlaybackRate(state.currentRate);
        elements.audioPlayer.playbackRate = immediatePlaybackRate;
        elements.audioPlayer.defaultPlaybackRate = immediatePlaybackRate;

        const autoplay = shouldAutoplayCurrentSession();
        const reason = autoplay ? "Updating speed..." : "Updating paused session speed...";
        await hotSwapCurrentSession({ reason, autoplay, resetPlaybackRateAfterSwap: true });
    }

    async function hotSwapCurrentSession(options = {}) {
        if (!state.currentSession) {
            return;
        }

        const offset = getResumeOffset();
        await startReadingAt(offset, {
            snapToSentence: false,
            autoplay: options.autoplay,
            reason: options.reason,
            successMessage: options.autoplay
                ? "Updated playback. Reading continues from your current place."
                : "Updated playback settings at the current paused position.",
            resetPlaybackRateAfterSwap: options.resetPlaybackRateAfterSwap !== false
        });
    }

    function shouldAutoplayCurrentSession() {
        return Boolean(state.currentSession && !elements.audioPlayer.paused && !elements.audioPlayer.ended);
    }

    async function uploadAndRenderFile(file) {
        setLoading(true, "Uploading...");
        setStatus("Uploading document...");

        try {
            await stopReading({ tellServer: true, clearHighlights: true });
            clearDocumentViewer();

            const formData = new FormData();
            formData.append("file", file);

            const response = await fetch("/api/upload", {
                method: "POST",
                body: formData
            });

            const payload = await response.json();
            if (!response.ok) {
                throw new Error(payload.error || "Upload failed");
            }

            state.currentDocument = {
                id: payload.document_id,
                filename: payload.filename,
                fileType: payload.file_type,
                fileUrl: payload.file_url
            };

            elements.documentMeta.textContent = `${payload.filename} - ${payload.file_type.toUpperCase()}`;
            setStatus("Rendering document...");

            const readingMap = await renderCurrentDocument();
            if (!readingMap || !readingMap.text.trim()) {
                throw new Error("This file rendered, but no readable text was found.");
            }

            state.readingMap = readingMap;
            state.sentenceRanges = buildSentenceRanges(readingMap.text);
            state.manifestReady = false;

            await saveManifest(readingMap.text);
            state.manifestReady = true;

            setStatus("Ready. Click any visible text to start streaming read aloud.");
        } catch (error) {
            resetViewer();
            state.currentDocument = null;
            state.readingMap = null;
            state.sentenceRanges = [];
            state.manifestReady = false;
            elements.documentMeta.textContent = "";
            setStatus(error.message || "Something went wrong.", "error");
        } finally {
            setLoading(false);
        }
    }

    async function renderCurrentDocument() {
        if (!state.currentDocument) {
            return null;
        }

        if (state.currentDocument.fileType === "pdf") {
            return renderPdfDocument(state.currentDocument.fileUrl);
        }

        if (state.currentDocument.fileType === "docx") {
            return renderDocxDocument(state.currentDocument.fileUrl);
        }

        if (state.currentDocument.fileType === "md") {
            return renderMarkdownDocument(state.currentDocument.fileUrl);
        }

        if (state.currentDocument.fileType === "txt") {
            return renderTextDocument(state.currentDocument.fileUrl);
        }

        throw new Error("Unsupported file type.");
    }

    async function renderPdfDocument(fileUrl) {
        if (!window.pdfjsLib || !window.pdfjsViewer) {
            throw new Error("PDF viewer library failed to load.");
        }

        const loadingTask = pdfjsLib.getDocument({ url: fileUrl, useWorkerFetch: true });
        const pdfDocument = await loadingTask.promise;
        const eventBus = new pdfjsViewer.EventBus();
        const firstPage = await pdfDocument.getPage(1);
        const baseViewport = firstPage.getViewport({ scale: 1 });
        const availableWidth = Math.max(elements.viewerScrollArea.clientWidth - 96, 320);
        const scale = Math.max(0.9, Math.min(1.8, availableWidth / baseViewport.width));

        for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
            const page = pageNumber === 1 ? firstPage : await pdfDocument.getPage(pageNumber);
            const pageContainer = document.createElement("div");
            pageContainer.className = "pdf-page";
            pageContainer.dataset.readerPage = String(pageNumber);
            elements.documentViewer.appendChild(pageContainer);

            const pageView = new pdfjsViewer.PDFPageView({
                container: pageContainer,
                id: pageNumber,
                scale,
                defaultViewport: page.getViewport({ scale }),
                eventBus,
                textLayerMode: 2
            });

            pageView.setPdfPage(page);
            await waitForPdfTextLayer(pageView, eventBus, pageNumber);
        }

        attachHighlightLayer();
        return buildPdfReadingMap(elements.documentViewer);
    }

    async function waitForPdfTextLayer(pageView, eventBus, pageNumber) {
        await new Promise((resolve, reject) => {
            let timeoutId = null;
            const onRendered = (event) => {
                if (event && event.pageNumber !== pageNumber) {
                    return;
                }
                cleanup();
                resolve();
            };

            const cleanup = () => {
                if (timeoutId) {
                    window.clearTimeout(timeoutId);
                }
                if (eventBus.off) {
                    eventBus.off("textlayerrendered", onRendered);
                }
            };

            if (eventBus.on) {
                eventBus.on("textlayerrendered", onRendered);
            }

            timeoutId = window.setTimeout(() => {
                cleanup();
                resolve();
            }, 2500);

            Promise.resolve(pageView.draw()).catch((error) => {
                cleanup();
                reject(error);
            });
        });
    }

    async function renderDocxDocument(fileUrl) {
        if (!window.docx || !window.docx.renderAsync) {
            throw new Error("DOCX renderer failed to load.");
        }

        const response = await fetch(fileUrl);
        const buffer = await response.arrayBuffer();
        if (!response.ok) {
            throw new Error("Failed to load DOCX file.");
        }

        const host = document.createElement("div");
        host.className = "docx-host";
        elements.documentViewer.appendChild(host);

        await docx.renderAsync(buffer, host, host, {
            inWrapper: true,
            breakPages: true,
            ignoreLastRenderedPageBreak: false,
            useBase64URL: true
        });

        attachHighlightLayer();
        return buildHtmlReadingMap(host);
    }

    async function renderMarkdownDocument(fileUrl) {
        const source = await fetchText(fileUrl);
        const article = document.createElement("article");
        article.className = "markdown-document rich-document";
        article.innerHTML = DOMPurify.sanitize(marked.parse(source));
        elements.documentViewer.appendChild(article);

        attachHighlightLayer();
        return buildHtmlReadingMap(article);
    }

    async function renderTextDocument(fileUrl) {
        const source = await fetchText(fileUrl);
        const article = document.createElement("article");
        article.className = "txt-document rich-document";
        const normalized = source.replace(/\r\n/g, "\n");
        const blocks = normalized.split(/\n{2,}/).filter((block) => block.length > 0);

        if (!blocks.length) {
            const paragraph = document.createElement("p");
            paragraph.textContent = normalized;
            article.appendChild(paragraph);
        } else {
            blocks.forEach((block) => {
                const paragraph = document.createElement("p");
                const lines = block.split("\n");
                lines.forEach((line, index) => {
                    if (index > 0) {
                        paragraph.appendChild(document.createElement("br"));
                    }
                    paragraph.appendChild(document.createTextNode(line));
                });
                article.appendChild(paragraph);
            });
        }

        elements.documentViewer.appendChild(article);
        attachHighlightLayer();
        return buildHtmlReadingMap(article);
    }

    async function fetchText(url) {
        const response = await fetch(url);
        const text = await response.text();
        if (!response.ok) {
            throw new Error("Failed to load document contents.");
        }
        return text;
    }

    function attachHighlightLayer() {
        if (state.highlightLayer && state.highlightLayer.parentNode) {
            state.highlightLayer.remove();
        }

        const layer = document.createElement("div");
        layer.className = "highlight-layer";
        elements.documentViewer.appendChild(layer);
        state.highlightLayer = layer;
    }

    function buildPdfReadingMap(root) {
        const spans = Array.from(root.querySelectorAll(".textLayer span"))
            .filter((span) => (span.textContent || "").trim().length > 0);

        const runs = [];
        let text = "";
        let previous = null;

        spans.forEach((span, index) => {
            span.classList.add("pdf-run");
            span.dataset.readerRun = String(index);
            const runText = span.textContent || "";
            const separator = determinePdfSeparator(previous, span);
            text += separator;

            const start = text.length;
            text += runText;
            const end = text.length;

            runs.push(createRunRecord(span, runText, start, end));
            previous = span;
        });

        return createReadingMap(text, runs);
    }

    function determinePdfSeparator(previous, current) {
        if (!previous) {
            return "";
        }

        const previousPage = previous.closest(".page");
        const currentPage = current.closest(".page");
        if (previousPage !== currentPage) {
            return "\n\n";
        }

        const previousRect = previous.getBoundingClientRect();
        const currentRect = current.getBoundingClientRect();
        const verticalDelta = Math.abs(currentRect.top - previousRect.top);
        const lineThreshold = Math.max(previousRect.height, currentRect.height) * 0.8;

        if (verticalDelta > lineThreshold * 1.9) {
            return "\n\n";
        }

        if (verticalDelta > lineThreshold) {
            return "\n";
        }

        const gap = currentRect.left - previousRect.right;
        if (gap > 1.5 && !endsWithJoiner(previous.textContent || "") && !startsWithPunctuation(current.textContent || "")) {
            return " ";
        }

        return "";
    }

    function buildHtmlReadingMap(root) {
        wrapTextNodes(root);
        const runs = Array.from(root.querySelectorAll(".reader-run"))
            .filter((run) => (run.textContent || "").trim().length > 0);
        const blockCache = new WeakMap();

        let text = "";
        const mappedRuns = [];
        let previous = null;

        runs.forEach((run, index) => {
            run.dataset.readerRun = String(index);
            const runText = run.textContent || "";
            const separator = determineHtmlSeparator(previous, run, root, blockCache);
            text += separator;

            const start = text.length;
            text += runText;
            const end = text.length;

            mappedRuns.push(createRunRecord(run, runText, start, end));
            previous = run;
        });

        return createReadingMap(text, mappedRuns);
    }

    function wrapTextNodes(root) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
                if (!node.parentElement) {
                    return NodeFilter.FILTER_REJECT;
                }

                if (node.parentElement.closest("script, style, noscript, textarea, .highlight-layer, .textLayer")) {
                    return NodeFilter.FILTER_REJECT;
                }

                if (!node.nodeValue || !node.nodeValue.trim()) {
                    return NodeFilter.FILTER_REJECT;
                }

                if (node.parentElement.closest(".reader-run")) {
                    return NodeFilter.FILTER_REJECT;
                }

                return NodeFilter.FILTER_ACCEPT;
            }
        });

        const textNodes = [];
        while (walker.nextNode()) {
            textNodes.push(walker.currentNode);
        }

        textNodes.forEach((node) => {
            if (!node.parentNode) {
                return;
            }

            const span = document.createElement("span");
            span.className = "reader-run";
            node.parentNode.replaceChild(span, node);
            span.appendChild(node);
        });
    }

    function determineHtmlSeparator(previous, current, root, blockCache) {
        if (!previous) {
            return "";
        }

        const previousBlock = findLogicalBlock(previous, root, blockCache);
        const currentBlock = findLogicalBlock(current, root, blockCache);
        const between = getTextBetween(previous, current);

        if (previousBlock !== currentBlock) {
            if (/\n{2,}/.test(between)) {
                return "\n\n";
            }
            if (/\n/.test(between)) {
                return "\n";
            }
            return "\n\n";
        }

        if (/\n{2,}/.test(between)) {
            return "\n\n";
        }
        if (/\n/.test(between)) {
            return "\n";
        }
        if (/\s/.test(between)) {
            return " ";
        }
        return "";
    }

    function findLogicalBlock(element, root, cache) {
        if (cache.has(element)) {
            return cache.get(element);
        }

        let current = element.parentElement;
        while (current && current !== root) {
            if (isMeaningfulBlock(current)) {
                cache.set(element, current);
                return current;
            }
            current = current.parentElement;
        }

        cache.set(element, root);
        return root;
    }

    function isMeaningfulBlock(element) {
        if (!element || element.classList.contains("reader-run")) {
            return false;
        }

        if (BLOCK_TAGS.has(element.tagName)) {
            return true;
        }

        const display = window.getComputedStyle(element).display;
        return display === "block" || display === "list-item" || display === "table-cell" || display === "table-row";
    }

    function getTextBetween(previous, current) {
        try {
            const range = document.createRange();
            range.setStartAfter(previous);
            range.setEndBefore(current);
            return range.toString();
        } catch (error) {
            return "";
        }
    }

    function createRunRecord(element, text, start, end) {
        const textNode = element.firstChild && element.firstChild.nodeType === Node.TEXT_NODE
            ? element.firstChild
            : document.createTextNode(text);

        if (!element.firstChild) {
            element.appendChild(textNode);
        }

        return {
            element,
            textNode,
            text,
            start,
            end
        };
    }

    function createReadingMap(text, runs) {
        const runLookup = new WeakMap();
        runs.forEach((run) => {
            runLookup.set(run.element, run);
            runLookup.set(run.textNode, run);
        });

        return {
            text,
            runs,
            getOffsetFromEvent(event) {
                const fromCaret = getOffsetFromCaret(event.clientX, event.clientY, runLookup, event.target);
                if (fromCaret != null) {
                    return fromCaret;
                }

                const run = findRunFromTarget(event.target, runLookup);
                if (!run) {
                    return null;
                }

                return run.start + estimateOffsetWithinRun(run, event.clientX);
            },
            createDomRange(start, end) {
                return createDomRangeFromOffsets(runs, start, end);
            },
            getSentenceStart(offset) {
                const sentence = findSentenceForOffset(offset, state.sentenceRanges);
                return sentence ? sentence.start : 0;
            }
        };
    }

    function getOffsetFromCaret(clientX, clientY, runLookup, target) {
        if (document.caretPositionFromPoint) {
            const caret = document.caretPositionFromPoint(clientX, clientY);
            if (caret) {
                const offset = convertCaretToGlobalOffset(caret.offsetNode, caret.offset, runLookup, clientX);
                if (offset != null) {
                    return offset;
                }
            }
        }

        if (document.caretRangeFromPoint) {
            const range = document.caretRangeFromPoint(clientX, clientY);
            if (range) {
                const offset = convertCaretToGlobalOffset(range.startContainer, range.startOffset, runLookup, clientX);
                if (offset != null) {
                    return offset;
                }
            }
        }

        const run = findRunFromTarget(target, runLookup);
        if (!run) {
            return null;
        }

        return run.start + estimateOffsetWithinRun(run, clientX);
    }

    function convertCaretToGlobalOffset(node, localOffset, runLookup, clientX) {
        if (!node) {
            return null;
        }

        const directRun = runLookup.get(node);
        if (directRun) {
            return directRun.start + Math.max(0, Math.min(localOffset, directRun.text.length));
        }

        if (node.nodeType === Node.ELEMENT_NODE) {
            const run = findRunFromTarget(node, runLookup);
            if (!run) {
                return null;
            }
            return run.start + estimateOffsetWithinRun(run, clientX);
        }

        const run = node.parentElement ? findRunFromTarget(node.parentElement, runLookup) : null;
        if (!run) {
            return null;
        }
        return run.start + Math.max(0, Math.min(localOffset, run.text.length));
    }

    function findRunFromTarget(target, runLookup) {
        const element = target instanceof Element ? target : target && target.parentElement;
        if (!element) {
            return null;
        }

        const runElement = element.closest(".reader-run, .pdf-run");
        return runElement ? runLookup.get(runElement) : null;
    }

    function estimateOffsetWithinRun(run, clientX) {
        const textLength = run.text.length;
        if (!textLength) {
            return 0;
        }

        const rect = run.element.getBoundingClientRect();
        if (!rect.width) {
            return 0;
        }

        const ratio = clamp((clientX - rect.left) / rect.width, 0, 1);
        return Math.round(textLength * ratio);
    }

    function buildSentenceRanges(text) {
        const ranges = [];

        if (window.Intl && Intl.Segmenter) {
            const segmenter = new Intl.Segmenter(undefined, { granularity: "sentence" });
            for (const segment of segmenter.segment(text)) {
                const trimmed = trimRange(text, segment.index, segment.index + segment.segment.length);
                if (trimmed) {
                    ranges.push(trimmed);
                }
            }
        }

        if (ranges.length) {
            return ranges;
        }

        const fallback = text.matchAll(/[^.!?\n]+(?:[.!?]+|\n+|$)/g);
        for (const match of fallback) {
            const start = match.index || 0;
            const end = start + match[0].length;
            const trimmed = trimRange(text, start, end);
            if (trimmed) {
                ranges.push(trimmed);
            }
        }

        if (!ranges.length && text.trim()) {
            return [{ start: 0, end: text.length }];
        }

        return ranges;
    }

    function trimRange(text, start, end) {
        let safeStart = start;
        let safeEnd = end;

        while (safeStart < safeEnd && /\s/.test(text[safeStart])) {
            safeStart += 1;
        }
        while (safeEnd > safeStart && /\s/.test(text[safeEnd - 1])) {
            safeEnd -= 1;
        }

        if (safeEnd <= safeStart) {
            return null;
        }

        return { start: safeStart, end: safeEnd };
    }

    function findSentenceForOffset(offset, sentences) {
        for (let index = 0; index < sentences.length; index += 1) {
            const sentence = sentences[index];
            if (offset >= sentence.start && offset < sentence.end) {
                return sentence;
            }
        }

        if (sentences.length && offset >= sentences[sentences.length - 1].end) {
            return sentences[sentences.length - 1];
        }

        return sentences[0] || null;
    }

    async function saveManifest(canonicalText) {
        const response = await fetch(`/api/documents/${state.currentDocument.id}/manifest`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ canonical_text: canonicalText })
        });
        const payload = await response.json();
        if (!response.ok) {
            throw new Error(payload.error || "Failed to save reading manifest.");
        }
    }

    async function startReadingAt(offset, options = {}) {
        if (!state.currentDocument || !state.readingMap || !state.manifestReady) {
            return;
        }

        const {
            snapToSentence = true,
            autoplay = true,
            reason = "Starting audio stream...",
            successMessage,
            resetPlaybackRateAfterSwap = true
        } = options;

        const normalizedOffset = normalizeOffset(offset);
        const sentence = snapToSentence ? findSentenceForOffset(normalizedOffset, state.sentenceRanges) : null;
        const startOffset = sentence ? sentence.start : normalizedOffset;
        const previousSession = state.currentSession;
        const requestToken = ++state.sessionRequestToken;
        let session = null;

        setLoading(true, "Connecting...");
        setStatus(reason);

        try {
            const response = await fetch("/api/read-sessions", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    document_id: state.currentDocument.id,
                    start_offset: startOffset,
                    voice: state.currentVoice,
                    rate: state.currentRate
                })
            });

            const payload = await response.json();
            if (!response.ok) {
                throw new Error(payload.error || "Failed to start reading.");
            }

            if (requestToken !== state.sessionRequestToken) {
                deleteServerSession(payload.session_id);
                return;
            }

            session = {
                id: payload.session_id,
                startOffset: payload.start_offset,
                audioUrl: payload.audio_url,
                eventsUrl: payload.events_url,
                events: [],
                currentEventIndex: -1,
                lastHighlightKey: "",
                eventSource: null,
                requestToken
            };

            state.currentSession = session;
            state.currentGlobalOffset = session.startOffset;
            attachSessionEventStream(session);

            // Show audio controls
            if (elements.audioProgressBar) {
                elements.audioProgressBar.style.display = "block";
            }
            if (elements.kbdHints) {
                elements.kbdHints.style.display = "flex";
            }

            elements.audioPlayer.pause();
            elements.audioPlayer.src = `${payload.audio_url}?ts=${Date.now()}`;
            elements.audioPlayer.load();

            if (resetPlaybackRateAfterSwap) {
                elements.audioPlayer.playbackRate = 1;
                elements.audioPlayer.defaultPlaybackRate = 1;
            }

            if (autoplay) {
                await elements.audioPlayer.play();
            }

            if (requestToken !== state.sessionRequestToken) {
                releaseClientSession(session, { tellServer: true });
                return;
            }

            if (previousSession && previousSession !== session) {
                releaseClientSession(previousSession, { tellServer: true });
            }

            setStatus(successMessage || (autoplay
                ? "Streaming. Click another passage to jump there."
                : "Ready at the selected point. Press resume to keep listening."));
        } catch (error) {
            if (session) {
                releaseClientSession(session, { tellServer: true });
            }
            if (requestToken === state.sessionRequestToken) {
                if (previousSession) {
                    state.currentSession = previousSession;
                }
                if (shouldAutoplayCurrentSession()) {
                    elements.audioPlayer.playbackRate = 1;
                    elements.audioPlayer.defaultPlaybackRate = 1;
                }
            }
            setStatus(error.message || "Could not start reading.", "error");
        } finally {
            setLoading(false);
        }
    }

    function attachSessionEventStream(session) {
        const eventSource = new EventSource(session.eventsUrl);
        session.eventSource = eventSource;

        eventSource.addEventListener("word", (event) => {
            if (state.currentSession !== session) {
                return;
            }

            try {
                session.events.push(JSON.parse(event.data));
            } catch (error) {
                setStatus("A timing event could not be parsed.", "error");
            }
        });

        eventSource.addEventListener("done", () => {
            if (state.currentSession !== session) {
                return;
            }
            eventSource.close();
        });

        eventSource.addEventListener("error", (event) => {
            if (state.currentSession !== session) {
                return;
            }

            if (event && event.data) {
                try {
                    const payloadData = JSON.parse(event.data);
                    setStatus(payloadData.message || "Streaming failed.", "error");
                } catch (error) {
                    setStatus("Streaming failed.", "error");
                }
            }
        });
    }

    function releaseClientSession(session, options = {}) {
        const { tellServer = true } = options;

        if (!session) {
            return;
        }

        if (session.eventSource) {
            session.eventSource.close();
            session.eventSource = null;
        }

        if (tellServer) {
            deleteServerSession(session.id);
        }
    }

    function deleteServerSession(sessionId) {
        if (!sessionId) {
            return;
        }

        fetch(`/api/read-sessions/${sessionId}`, { method: "DELETE" }).catch(() => {});
    }

    function pauseReading() {
        if (!state.currentSession) {
            return;
        }
        state.currentGlobalOffset = getResumeOffset();
        elements.audioPlayer.pause();
        setStatus("Paused.");
    }

    async function resumeReading() {
        if (!state.currentSession) {
            return;
        }

        try {
            await elements.audioPlayer.play();
            setStatus("Resumed.");
        } catch (error) {
            setStatus("The browser blocked playback. Click play again.", "error");
        }
    }

    async function stopReading(options = {}) {
        const { tellServer = true, clearHighlights = true, invalidatePending = true } = options;
        const session = state.currentSession;

        if (invalidatePending) {
            state.sessionRequestToken += 1;
        }

        stopSyncLoop();

        releaseClientSession(session, { tellServer });

        elements.audioPlayer.pause();
        elements.audioPlayer.removeAttribute("src");
        elements.audioPlayer.load();
        elements.audioPlayer.playbackRate = 1;
        elements.audioPlayer.defaultPlaybackRate = 1;

        state.currentSession = null;
        state.currentGlobalOffset = 0;

        if (clearHighlights) {
            clearHighlightLayer();
        }
    }

    function startSyncLoop() {
        stopSyncLoop();
        startProgressBarSync();

        const tick = () => {
            if (!state.currentSession) {
                return;
            }
            renderActiveHighlights();
            if (!elements.audioPlayer.paused && !elements.audioPlayer.ended) {
                state.syncFrame = window.requestAnimationFrame(tick);
            }
        };

        state.syncFrame = window.requestAnimationFrame(tick);
    }

    function stopSyncLoop() {
        if (state.syncFrame) {
            window.cancelAnimationFrame(state.syncFrame);
            state.syncFrame = null;
        }
        stopProgressBarSync();
    }

    function renderActiveHighlights() {
        const session = state.currentSession;
        if (!session || !session.events.length || !state.readingMap) {
            return;
        }

        const activeWord = getActiveWordAtCurrentTime(session);
        if (!activeWord || !activeWord.event) {
            return;
        }

        const { event, index } = activeWord;
        session.currentEventIndex = index;

        const wordRange = {
            start: session.startOffset + event.char_start,
            end: session.startOffset + event.char_end
        };
        state.currentGlobalOffset = chooseResumeOffsetFromEvent(session, event, elements.audioPlayer.currentTime);
        const sentenceRange = findSentenceForOffset(wordRange.start, state.sentenceRanges) || wordRange;
        const highlightKey = `${wordRange.start}:${wordRange.end}:${sentenceRange.start}:${sentenceRange.end}`;

        if (highlightKey === session.lastHighlightKey) {
            return;
        }

        session.lastHighlightKey = highlightKey;
        drawHighlights(sentenceRange, wordRange);
        scrollSentenceIntoView(sentenceRange);
    }

    function getActiveWordAtCurrentTime(session) {
        const currentTime = elements.audioPlayer.currentTime;
        let index = session.currentEventIndex;
        if (index < 0) {
            index = 0;
        }

        while (index + 1 < session.events.length && session.events[index + 1].time_start <= currentTime + 0.03) {
            index += 1;
        }
        while (index > 0 && session.events[index].time_start > currentTime + 0.03) {
            index -= 1;
        }

        const event = session.events[index];
        if (!event || currentTime < event.time_start) {
            return null;
        }

        return { event, index };
    }

    function getResumeOffset() {
        const session = state.currentSession;
        if (!session) {
            return 0;
        }

        const activeWord = getActiveWordAtCurrentTime(session);
        if (!activeWord || !activeWord.event) {
            return normalizeOffset(state.currentGlobalOffset || session.startOffset);
        }

        return chooseResumeOffsetFromEvent(session, activeWord.event, elements.audioPlayer.currentTime);
    }

    function chooseResumeOffsetFromEvent(session, event, currentTime) {
        const absoluteStart = session.startOffset + event.char_start;
        const absoluteEnd = session.startOffset + event.char_end;
        const duration = Math.max(0, event.time_end - event.time_start);
        const progressThreshold = duration > 0 ? event.time_start + duration * 0.55 : event.time_start + 0.12;
        const offset = currentTime >= progressThreshold ? absoluteEnd : absoluteStart;
        return skipWhitespaceForward(offset);
    }

    function drawHighlights(sentenceRange, wordRange) {
        clearHighlightLayer();
        if (!state.highlightLayer || !state.readingMap) {
            return;
        }

        state.highlightLayer.style.width = `${elements.documentViewer.scrollWidth}px`;
        state.highlightLayer.style.height = `${elements.documentViewer.scrollHeight}px`;

        drawRangeRects(sentenceRange, "reader-highlight reader-highlight--sentence");
        drawRangeRects(wordRange, "reader-highlight reader-highlight--word");
    }

    function drawRangeRects(rangeLike, className) {
        const range = state.readingMap.createDomRange(rangeLike.start, rangeLike.end);
        if (!range) {
            return;
        }

        const rootRect = elements.documentViewer.getBoundingClientRect();
        Array.from(range.getClientRects()).forEach((rect) => {
            if (rect.width < 1 || rect.height < 1) {
                return;
            }

            const block = document.createElement("div");
            block.className = className;
            block.style.left = `${rect.left - rootRect.left}px`;
            block.style.top = `${rect.top - rootRect.top}px`;
            block.style.width = `${rect.width}px`;
            block.style.height = `${rect.height}px`;
            state.highlightLayer.appendChild(block);
        });
    }

    function clearHighlightLayer() {
        if (state.highlightLayer) {
            state.highlightLayer.innerHTML = "";
        }
    }

    function scrollSentenceIntoView(sentenceRange) {
        const range = state.readingMap.createDomRange(sentenceRange.start, sentenceRange.end);
        if (!range) {
            return;
        }

        const rect = range.getBoundingClientRect();
        const containerRect = elements.viewerScrollArea.getBoundingClientRect();
        const padding = 90;

        if (rect.top < containerRect.top + 24 || rect.bottom > containerRect.bottom - 24) {
            const offset = rect.top - containerRect.top - padding;
            elements.viewerScrollArea.scrollBy({ top: offset, behavior: "smooth" });
        }
    }

    function createDomRangeFromOffsets(runs, start, end) {
        if (!runs.length) {
            return null;
        }

        const safeStart = clamp(start, 0, runs[runs.length - 1].end);
        const safeEnd = clamp(end, safeStart, runs[runs.length - 1].end);
        if (safeEnd <= safeStart) {
            return null;
        }

        const startPosition = resolveOffsetPosition(runs, safeStart, "forward");
        const endPosition = resolveOffsetPosition(runs, safeEnd, "backward");
        if (!startPosition || !endPosition) {
            return null;
        }

        try {
            const range = document.createRange();
            range.setStart(startPosition.node, startPosition.offset);
            range.setEnd(endPosition.node, endPosition.offset);
            if (range.collapsed) {
                return null;
            }
            return range;
        } catch (error) {
            return null;
        }
    }

    function resolveOffsetPosition(runs, offset, bias) {
        let low = 0;
        let high = runs.length - 1;

        while (low <= high) {
            const mid = Math.floor((low + high) / 2);
            const run = runs[mid];
            if (offset < run.start) {
                high = mid - 1;
            } else if (offset >= run.end) {
                low = mid + 1;
            } else {
                return {
                    node: run.textNode,
                    offset: offset - run.start
                };
            }
        }

        if (bias === "forward") {
            const run = runs[Math.min(low, runs.length - 1)];
            return { node: run.textNode, offset: 0 };
        }

        const run = runs[Math.max(high, 0)];
        return { node: run.textNode, offset: run.text.length };
    }

    function getDocumentTextLength() {
        return state.readingMap ? state.readingMap.text.length : 0;
    }

    function normalizeOffset(offset) {
        const numericOffset = Number(offset);
        return clamp(Number.isFinite(numericOffset) ? numericOffset : 0, 0, getDocumentTextLength());
    }

    function skipWhitespaceForward(offset) {
        if (!state.readingMap) {
            return Math.max(0, offset);
        }

        let nextOffset = normalizeOffset(offset);
        while (nextOffset < state.readingMap.text.length && /\s/.test(state.readingMap.text[nextOffset])) {
            nextOffset += 1;
        }

        return normalizeOffset(nextOffset);
    }

    function rateToPlaybackRate(rate) {
        const match = /^([+-])(\d+)%$/.exec(rate || "+0%");
        if (!match) {
            return 1;
        }

        const direction = match[1] === "+" ? 1 : -1;
        const value = Number(match[2]) / 100;
        return clamp(1 + direction * value, 0.5, 2);
    }

    function clearDocumentViewer() {
        elements.documentViewer.innerHTML = "";
        state.highlightLayer = null;
        state.currentGlobalOffset = 0;
    }

    function resetViewer() {
        clearDocumentViewer();
        elements.documentViewer.innerHTML = `
            <div class="empty-state">
                <h2>No document loaded</h2>
                <p>Your uploaded file will render here in its own structure.</p>
            </div>
        `;
    }

    function setLoading(isLoading, label) {
        elements.loadingIndicator.textContent = label || "Working...";
        elements.loadingIndicator.classList.toggle("hidden", !isLoading);
    }

    function setStatus(message, tone) {
        elements.statusText.textContent = message;
        elements.statusText.setAttribute("data-state", tone || "ready");
    }

    function formatTime(seconds) {
        if (!Number.isFinite(seconds)) {
            return "0:00";
        }
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins}:${secs.toString().padStart(2, "0")}`;
    }

    function startProgressBarSync() {
        if (state.progressSyncFrame) {
            cancelAnimationFrame(state.progressSyncFrame);
        }

        function updateProgress() {
            if (!elements.audioPlayer.src || elements.audioPlayer.duration === 0) {
                state.progressSyncFrame = requestAnimationFrame(updateProgress);
                return;
            }

            const percent = (elements.audioPlayer.currentTime / elements.audioPlayer.duration) * 100;
            if (elements.progressFill) {
                elements.progressFill.style.width = `${percent}%`;
            }

            if (elements.progressTime) {
                elements.progressTime.textContent = formatTime(elements.audioPlayer.currentTime);
            }

            if (elements.progressLabel) {
                elements.progressLabel.textContent = elements.audioPlayer.paused ? "Paused" : "Playing";
            }

            state.progressSyncFrame = requestAnimationFrame(updateProgress);
        }

        state.progressSyncFrame = requestAnimationFrame(updateProgress);
    }

    function stopProgressBarSync() {
        if (state.progressSyncFrame) {
            cancelAnimationFrame(state.progressSyncFrame);
            state.progressSyncFrame = null;
        }
    }

    function jumpToSentence(direction) {
        if (!state.readingMap || state.sentenceRanges.length === 0) {
            return;
        }

        const offset = getResumeOffset();
        let currentSentenceIndex = -1;
        for (let i = 0; i < state.sentenceRanges.length; i++) {
            const [start, end] = state.sentenceRanges[i];
            if (offset >= start && offset <= end) {
                currentSentenceIndex = i;
                break;
            }
        }

        let targetIndex = currentSentenceIndex + direction;
        if (targetIndex < 0 || targetIndex >= state.sentenceRanges.length) {
            return;
        }

        const [targetStart] = state.sentenceRanges[targetIndex];
        startReadingAt(targetStart);
    }

    function clamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
    }

    function endsWithJoiner(text) {
        return /[-\u2010-\u2015/]$/.test(text.trim());
    }

    function startsWithPunctuation(text) {
        return /^[,.;:!?%)}\]]/.test(text.trim());
    }
})();
