# Cadence Chrome extension

This extension reads webpages aloud by calling the local Cadence Flask app, which streams `edge-tts` audio and timing data.

## What it does

- reads the current webpage from the top
- supports click-to-read when click mode is enabled
- highlights the current sentence and word on the page
- supports pause, resume, stop, voice changes, and speed changes
- uses the same Edge voice list exposed by the local web app backend

## Load it in Chrome

1. Open `chrome://extensions`
2. Turn on Developer mode
3. Click Load unpacked
4. Select `apps/extension`

## Run the local backend first

Before using the extension, start the Flask app from the repo root:

```bash
python app.py
```

The extension expects the backend at `http://127.0.0.1:5000`.

## Notes

- this is the webpage-reading side of the Cadence monorepo
- it uses the Flask `edge-tts` backend, not `chrome.tts`
