(function () {
    const BLOCK_TAGS = new Set([
        "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DD", "DIV", "DL", "DT", "FIGCAPTION", "FIGURE",
        "FOOTER", "FORM", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HR", "LI", "MAIN",
        "NAV", "OL", "P", "PRE", "SECTION", "TABLE", "TBODY", "TD", "TH", "THEAD", "TR", "UL"
    ]);

    const SKIP_TAGS = new Set([
        "AUDIO", "BUTTON", "CANVAS", "DATALIST", "IFRAME", "IMG", "INPUT", "METER", "NOSCRIPT",
        "OPTION", "PROGRESS", "SCRIPT", "SELECT", "STYLE", "SVG", "TEXTAREA", "VIDEO"
    ]);

    const LAYOUT_SKIP_TAGS = new Set(["HEADER", "NAV", "FOOTER", "ASIDE"]);
    const OVERLAY_ID = "twelve-reader-overlay";
    const STYLE_ID = "twelve-reader-style";
    const TOAST_ID = "twelve-reader-toast";

    const state = {
        clickMode: false,
        readingMap: null,
        dirty: true,
        activeSentenceRange: null,
        activeWordRange: null,
        mutationObserver: null,
        resizeScheduled: false
    };

    injectStyles();
    installMutationObserver();
    bindEvents();
    syncInitialState();

    async function syncInitialState() {
        try {
            const response = await chrome.runtime.sendMessage({ type: "CONTENT_READY" });
            if (response && response.ok && response.state) {
                state.clickMode = Boolean(response.state.clickMode);
                updateClickModeMarker();
            }
        } catch (error) {
            // Ignore when the background worker is temporarily unavailable.
        }
    }

    function bindEvents() {
        chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
            handleMessage(message)
                .then((result) => sendResponse(result || { ok: true }))
                .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
            return true;
        });

        document.addEventListener("click", onDocumentClick, true);
        window.addEventListener("scroll", scheduleHighlightRedraw, { passive: true });
        window.addEventListener("resize", scheduleHighlightRedraw, { passive: true });
    }

    async function handleMessage(message) {
        switch (message.type) {
            case "GET_READING_SNAPSHOT": {
                const readingMap = buildOrReuseReadingMap();
                return {
                    ok: true,
                    text: readingMap.text,
                    url: location.href,
                    title: document.title
                };
            }

            case "SET_CLICK_MODE":
                state.clickMode = Boolean(message.enabled);
                updateClickModeMarker();
                showToast(state.clickMode ? "12reader click-to-read enabled" : "12reader click-to-read disabled");
                return { ok: true };

            case "READER_STARTED":
                buildOrReuseReadingMap();
                return { ok: true };

            case "READING_PROGRESS":
                buildOrReuseReadingMap();
                highlightOffset(message.absoluteOffset || 0);
                return { ok: true };

            case "READING_DONE":
                scheduleHighlightRedraw();
                showToast("12reader finished this page");
                return { ok: true };

            case "CLEAR_READER":
                clearHighlights();
                return { ok: true };

            default:
                return { ok: true };
        }
    }

    async function onDocumentClick(event) {
        if (!state.clickMode) {
            return;
        }

        if (event.defaultPrevented) {
            return;
        }

        if (event.target.closest(`#${OVERLAY_ID}`)) {
            return;
        }

        if (event.target.closest("input, textarea, select, button")) {
            return;
        }

        const readingMap = buildOrReuseReadingMap();
        if (!readingMap.text.trim()) {
            return;
        }

        const offset = getOffsetFromPoint(event.clientX, event.clientY, event.target, readingMap);
        if (offset == null) {
            return;
        }

        if (event.target.closest("a")) {
            event.preventDefault();
        }
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();

        try {
            const response = await chrome.runtime.sendMessage({
                type: "PAGE_CLICK_READING_REQUEST",
                offset,
                text: readingMap.text
            });

            if (!response || !response.ok) {
                throw new Error(response?.error || "Could not start webpage reading.");
            }
        } catch (error) {
            showToast(error.message || "12reader could not start reading here.");
        }
    }

    function buildOrReuseReadingMap() {
        if (!state.dirty && state.readingMap) {
            return state.readingMap;
        }

        const textNodes = collectReadableTextNodes();
        const runs = [];
        const runLookup = new WeakMap();
        const blockCache = new WeakMap();
        let text = "";
        let previousNode = null;

        textNodes.forEach((node) => {
            const nodeText = node.nodeValue || "";
            if (!nodeText.trim()) {
                return;
            }

            const separator = determineSeparator(previousNode, node, blockCache);
            text += separator;

            const start = text.length;
            text += nodeText;
            const end = text.length;

            const run = {
                node,
                start,
                end,
                text: nodeText,
                element: node.parentElement
            };
            runs.push(run);
            runLookup.set(node, run);
            previousNode = node;
        });

        state.readingMap = {
            text,
            runs,
            runLookup,
            sentenceRanges: buildSentenceRanges(text)
        };
        state.dirty = false;
        return state.readingMap;
    }

    function collectReadableTextNodes() {
        const body = document.body;
        if (!body) {
            return [];
        }

        const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
                if (!node.parentElement) {
                    return NodeFilter.FILTER_REJECT;
                }

                if (!node.nodeValue || !node.nodeValue.trim()) {
                    return NodeFilter.FILTER_REJECT;
                }

                if (isInsideOverlay(node.parentElement)) {
                    return NodeFilter.FILTER_REJECT;
                }

                if (isInsideSkippedElement(node.parentElement)) {
                    return NodeFilter.FILTER_REJECT;
                }

                if (!isElementVisible(node.parentElement)) {
                    return NodeFilter.FILTER_REJECT;
                }

                return NodeFilter.FILTER_ACCEPT;
            }
        });

        const nodes = [];
        while (walker.nextNode()) {
            nodes.push(walker.currentNode);
        }
        return nodes;
    }

    function isInsideOverlay(element) {
        return Boolean(element.closest(`#${OVERLAY_ID}`));
    }

    function isInsideSkippedElement(element) {
        let current = element;
        while (current && current !== document.body) {
            if (SKIP_TAGS.has(current.tagName)) {
                return true;
            }

            if (current.getAttribute("aria-hidden") === "true") {
                return true;
            }

            if (current.isContentEditable) {
                return true;
            }

            if (LAYOUT_SKIP_TAGS.has(current.tagName) && !current.closest("main, article")) {
                return true;
            }

            current = current.parentElement;
        }

        return false;
    }

    function isElementVisible(element) {
        let current = element;
        while (current && current !== document.body) {
            const styles = window.getComputedStyle(current);
            if (styles.display === "none" || styles.visibility === "hidden") {
                return false;
            }
            current = current.parentElement;
        }
        return true;
    }

    function determineSeparator(previousNode, currentNode, blockCache) {
        if (!previousNode) {
            return "";
        }

        const previousBlock = findLogicalBlock(previousNode.parentElement, blockCache);
        const currentBlock = findLogicalBlock(currentNode.parentElement, blockCache);
        const between = getTextBetween(previousNode, currentNode);

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

    function findLogicalBlock(element, cache) {
        if (!element) {
            return document.body;
        }

        if (cache.has(element)) {
            return cache.get(element);
        }

        let current = element;
        while (current && current !== document.body) {
            if (BLOCK_TAGS.has(current.tagName)) {
                cache.set(element, current);
                return current;
            }

            const display = window.getComputedStyle(current).display;
            if (display === "block" || display === "list-item" || display === "table-cell" || display === "table-row") {
                cache.set(element, current);
                return current;
            }

            current = current.parentElement;
        }

        cache.set(element, document.body);
        return document.body;
    }

    function getTextBetween(previousNode, currentNode) {
        try {
            const range = document.createRange();
            range.setStartAfter(previousNode);
            range.setEndBefore(currentNode);
            return range.toString();
        } catch (error) {
            return "";
        }
    }

    function getOffsetFromPoint(clientX, clientY, target, readingMap) {
        if (document.caretPositionFromPoint) {
            const caret = document.caretPositionFromPoint(clientX, clientY);
            if (caret) {
                const offset = convertNodeOffsetToGlobal(caret.offsetNode, caret.offset, readingMap);
                if (offset != null) {
                    return offset;
                }
            }
        }

        if (document.caretRangeFromPoint) {
            const range = document.caretRangeFromPoint(clientX, clientY);
            if (range) {
                const offset = convertNodeOffsetToGlobal(range.startContainer, range.startOffset, readingMap);
                if (offset != null) {
                    return offset;
                }
            }
        }

        return findOffsetFromTarget(target, readingMap);
    }

    function convertNodeOffsetToGlobal(node, localOffset, readingMap) {
        if (!node) {
            return null;
        }

        const directRun = readingMap.runLookup.get(node);
        if (directRun) {
            return clamp(directRun.start + localOffset, directRun.start, directRun.end);
        }

        if (node.nodeType === Node.ELEMENT_NODE) {
            const childTextNode = resolveClosestTextNode(node, localOffset);
            if (!childTextNode) {
                return null;
            }
            const run = readingMap.runLookup.get(childTextNode);
            if (!run) {
                return null;
            }
            return clamp(run.start + localOffset, run.start, run.end);
        }

        return null;
    }

    function resolveClosestTextNode(node, localOffset) {
        if (node.nodeType === Node.TEXT_NODE) {
            return node;
        }

        const children = node.childNodes;
        if (!children.length) {
            return null;
        }

        const clampedIndex = clamp(localOffset, 0, children.length - 1);
        const directChild = children[clampedIndex] || children[clampedIndex - 1];
        if (!directChild) {
            return null;
        }

        if (directChild.nodeType === Node.TEXT_NODE) {
            return directChild;
        }

        const walker = document.createTreeWalker(directChild, NodeFilter.SHOW_TEXT);
        return walker.nextNode();
    }

    function findOffsetFromTarget(target, readingMap) {
        if (!(target instanceof Node)) {
            return null;
        }

        const run = readingMap.runs.find((candidate) => candidate.element && candidate.element.contains(target));
        return run ? run.start : null;
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

    function findSentenceForOffset(offset, sentenceRanges) {
        for (let index = 0; index < sentenceRanges.length; index += 1) {
            const range = sentenceRanges[index];
            if (offset >= range.start && offset < range.end) {
                return range;
            }
        }

        if (sentenceRanges.length && offset >= sentenceRanges[sentenceRanges.length - 1].end) {
            return sentenceRanges[sentenceRanges.length - 1];
        }

        return sentenceRanges[0] || null;
    }

    function findWordRangeAtOffset(text, offset) {
        const safeLength = text.length;
        if (!safeLength) {
            return null;
        }

        let cursor = clamp(offset, 0, safeLength - 1);
        while (cursor < safeLength && /\s/.test(text[cursor])) {
            cursor += 1;
        }
        if (cursor >= safeLength) {
            cursor = safeLength - 1;
        }

        let start = cursor;
        while (start > 0 && isWordCharacter(text[start - 1])) {
            start -= 1;
        }

        let end = cursor;
        while (end < safeLength && isWordCharacter(text[end])) {
            end += 1;
        }

        if (start === end) {
            start = cursor;
            while (start > 0 && !/\s/.test(text[start - 1]) && !isBoundaryPunctuation(text[start - 1])) {
                start -= 1;
            }
            end = cursor;
            while (end < safeLength && !/\s/.test(text[end]) && !isBoundaryPunctuation(text[end])) {
                end += 1;
            }
        }

        if (end <= start) {
            return null;
        }

        return { start, end };
    }

    function isWordCharacter(character) {
        return /[\p{L}\p{N}'-]/u.test(character);
    }

    function isBoundaryPunctuation(character) {
        return /[.,;:!?()[\]{}]/.test(character);
    }

    function highlightOffset(offset) {
        const readingMap = buildOrReuseReadingMap();
        const wordRange = findWordRangeAtOffset(readingMap.text, offset);
        const sentenceRange = findSentenceForOffset(offset, readingMap.sentenceRanges);

        state.activeWordRange = wordRange;
        state.activeSentenceRange = sentenceRange;
        redrawHighlights();
        scrollSentenceIntoView(sentenceRange, readingMap);
    }

    function redrawHighlights() {
        clearOverlayBlocks();

        if (!state.activeSentenceRange && !state.activeWordRange) {
            return;
        }

        positionOverlay();
        const readingMap = buildOrReuseReadingMap();

        if (state.activeSentenceRange) {
            drawRangeRects(readingMap, state.activeSentenceRange, "twelve-reader-highlight sentence");
        }
        if (state.activeWordRange) {
            drawRangeRects(readingMap, state.activeWordRange, "twelve-reader-highlight word");
        }
    }

    function drawRangeRects(readingMap, rangeLike, className) {
        const range = createDomRange(readingMap.runs, rangeLike.start, rangeLike.end);
        if (!range) {
            return;
        }

        const overlay = ensureOverlay();
        const fragment = document.createDocumentFragment();
        Array.from(range.getClientRects()).forEach((rect) => {
            if (rect.width < 1 || rect.height < 1) {
                return;
            }

            const block = document.createElement("div");
            block.className = className;
            block.style.left = `${rect.left + window.scrollX}px`;
            block.style.top = `${rect.top + window.scrollY}px`;
            block.style.width = `${rect.width}px`;
            block.style.height = `${rect.height}px`;
            fragment.appendChild(block);
        });

        overlay.appendChild(fragment);
    }

    function createDomRange(runs, start, end) {
        if (!runs.length) {
            return null;
        }

        const maxOffset = runs[runs.length - 1].end;
        const safeStart = clamp(start, 0, maxOffset);
        const safeEnd = clamp(end, safeStart, maxOffset);
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
            return range.collapsed ? null : range;
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
                    node: run.node,
                    offset: offset - run.start
                };
            }
        }

        if (bias === "forward") {
            const run = runs[Math.min(low, runs.length - 1)];
            return { node: run.node, offset: 0 };
        }

        const run = runs[Math.max(high, 0)];
        return { node: run.node, offset: run.text.length };
    }

    function clearHighlights() {
        state.activeSentenceRange = null;
        state.activeWordRange = null;
        clearOverlayBlocks();
    }

    function clearOverlayBlocks() {
        const overlay = ensureOverlay();
        overlay.innerHTML = "";
    }

    function ensureOverlay() {
        let overlay = document.getElementById(OVERLAY_ID);
        if (!overlay) {
            overlay = document.createElement("div");
            overlay.id = OVERLAY_ID;
            overlay.setAttribute("aria-hidden", "true");
            document.documentElement.appendChild(overlay);
        }
        positionOverlay();
        return overlay;
    }

    function positionOverlay() {
        const overlay = document.getElementById(OVERLAY_ID);
        if (!overlay) {
            return;
        }

        overlay.style.width = `${Math.max(document.documentElement.scrollWidth, document.body.scrollWidth)}px`;
        overlay.style.height = `${Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)}px`;
    }

    function scrollSentenceIntoView(sentenceRange, readingMap) {
        if (!sentenceRange) {
            return;
        }

        const range = createDomRange(readingMap.runs, sentenceRange.start, sentenceRange.end);
        if (!range) {
            return;
        }

        const rect = range.getBoundingClientRect();
        const viewportPadding = 120;
        if (rect.top < viewportPadding || rect.bottom > window.innerHeight - viewportPadding) {
            const top = rect.top + window.scrollY - viewportPadding;
            window.scrollTo({ top, behavior: "smooth" });
        }
    }

    function scheduleHighlightRedraw() {
        if (state.resizeScheduled) {
            return;
        }

        state.resizeScheduled = true;
        window.requestAnimationFrame(() => {
            state.resizeScheduled = false;
            if (state.activeSentenceRange || state.activeWordRange) {
                redrawHighlights();
            }
        });
    }

    function installMutationObserver() {
        if (!document.body) {
            return;
        }

        state.mutationObserver = new MutationObserver(() => {
            state.dirty = true;
        });

        state.mutationObserver.observe(document.body, {
            childList: true,
            subtree: true,
            characterData: true
        });
    }

    function updateClickModeMarker() {
        document.documentElement.toggleAttribute("data-twelve-reader-click-mode", state.clickMode);
    }

    function injectStyles() {
        if (document.getElementById(STYLE_ID)) {
            return;
        }

        const style = document.createElement("style");
        style.id = STYLE_ID;
        style.textContent = `
            #${OVERLAY_ID} {
                position: absolute;
                inset: 0 auto auto 0;
                pointer-events: none;
                z-index: 2147483646;
            }

            .twelve-reader-highlight {
                position: absolute;
                border-radius: 5px;
                pointer-events: none;
            }

            .twelve-reader-highlight.sentence {
                background: rgba(249, 203, 61, 0.28);
            }

            .twelve-reader-highlight.word {
                background: rgba(234, 94, 42, 0.38);
            }

            #${TOAST_ID} {
                position: fixed;
                right: 20px;
                bottom: 20px;
                max-width: 320px;
                padding: 10px 14px;
                border-radius: 999px;
                background: rgba(17, 24, 39, 0.92);
                color: #ffffff;
                font: 500 13px/1.4 Arial, sans-serif;
                box-shadow: 0 18px 45px rgba(15, 23, 42, 0.28);
                z-index: 2147483647;
                opacity: 0;
                transform: translateY(10px);
                transition: opacity 180ms ease, transform 180ms ease;
                pointer-events: none;
            }

            #${TOAST_ID}[data-visible="true"] {
                opacity: 1;
                transform: translateY(0);
            }

            html[data-twelve-reader-click-mode] {
                cursor: crosshair;
            }
        `;

        document.documentElement.appendChild(style);
    }

    let toastTimeoutId = null;
    function showToast(message) {
        let toast = document.getElementById(TOAST_ID);
        if (!toast) {
            toast = document.createElement("div");
            toast.id = TOAST_ID;
            toast.setAttribute("aria-live", "polite");
            document.documentElement.appendChild(toast);
        }

        toast.textContent = message;
        toast.dataset.visible = "true";
        if (toastTimeoutId) {
            window.clearTimeout(toastTimeoutId);
        }
        toastTimeoutId = window.setTimeout(() => {
            toast.dataset.visible = "false";
        }, 1800);
    }

    function clamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
    }
})();
