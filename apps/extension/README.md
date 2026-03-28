# 12reader Chrome extension

This extension reads webpages aloud with `chrome.tts`.

## What it does

- reads the current webpage from the top
- supports click-to-read when click mode is enabled
- highlights the current sentence and word on the page
- supports pause, resume, stop, voice changes, and speed changes

## Load it in Chrome

1. Open `chrome://extensions`
2. Turn on Developer mode
3. Click Load unpacked
4. Select `apps/extension`

## Notes

- this is the webpage-reading side of the 12reader monorepo
- it uses `chrome.tts`, not the Flask `edge-tts` backend
