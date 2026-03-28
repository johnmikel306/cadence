# 12reader

12reader is now a monorepo for two related reading products:

- a Flask web app for uploaded documents
- a Chrome extension for live webpage read-aloud

Both products focus on the same core experience: start reading quickly, follow along visually, and let the user jump to a specific place in the content.

## Apps in this repo

### `apps/web`

The document reader web app.

- uploads and reads `pdf`, `docx`, `md`, and `txt`
- renders documents in a format-appropriate viewer
- streams audio with `edge-tts`
- highlights the current word and sentence
- lets the user click a visible passage to start reading there
- supports voice and speed hot-swaps during playback

### `apps/extension`

The Chrome extension for webpage reading.

- reads regular webpages with `chrome.tts`
- supports click-to-read when click mode is enabled
- highlights the active sentence and word directly on the page
- includes popup controls for voice, speed, pause, resume, and stop

## Monorepo layout

```text
12reader/
|- app.py
|- requirements.txt
|- package.json
|- apps/
|  |- web/
|  |  |- app.py
|  |  |- requirements.txt
|  |  |- templates/
|  |  |- static/
|  |  |- uploads/
|  |- extension/
|     |- manifest.json
|     |- background.js
|     |- content.js
|     |- popup.html
|     |- popup.css
|     |- popup.js
|- packages/
|  |- reader-core/
```

## What is shared conceptually

The two apps are separate runtimes, but they are built around the same reader ideas:

- canonical reading offsets
- click-to-read behavior
- sentence segmentation
- word and sentence highlighting
- voice and speed control

`packages/reader-core` is the shared home for consolidating that logic over time.

## Running the web app

You can still start the web app from the repo root.

### 1. Create and activate a virtual environment

Git Bash on Windows:

```bash
python -m venv .venv
source .venv/Scripts/activate
```

PowerShell:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
```

### 2. Install Python dependencies

```bash
python -m pip install -r requirements.txt
```

### 3. Start the server

```bash
python app.py
```

Open:

- `http://127.0.0.1:5000/` for the landing page
- `http://127.0.0.1:5000/reader` for the document reader

## Loading the Chrome extension

1. Open `chrome://extensions`
2. Turn on Developer mode
3. Click `Load unpacked`
4. Select `apps/extension`

Then open any normal webpage and use the popup to:

- read from the top
- enable click-to-read
- pause, resume, or stop
- change voice and speed

## Root scripts

```bash
npm run check:extension
npm run check:web
```

## Web app API overview

- `GET /` - landing page
- `GET /reader` - reader UI
- `POST /api/upload` - upload a supported document
- `GET /api/voices` - fetch available Edge TTS voices
- `GET /api/documents/<document_id>/file` - serve the uploaded original file
- `POST /api/documents/<document_id>/manifest` - save the frontend-built canonical text manifest
- `POST /api/read-sessions` - create a streamed read session from an offset
- `GET /api/read-sessions/<session_id>/audio` - stream MP3 audio
- `GET /api/read-sessions/<session_id>/events` - stream word timing events via SSE
- `DELETE /api/read-sessions/<session_id>` - stop a session

## Current limitations

### Web app

- scanned or image-only PDFs still need OCR for reliable click-to-read
- very complex PDFs and DOCX files can still drift slightly in text timing alignment
- uploaded files and sessions are local/in-memory only

### Chrome extension

- works best on standard article/content pages
- very dynamic apps, editors, or virtualized pages may need more extraction rules
- `chrome://` pages and some protected pages do not allow content script behavior
- webpage voice quality depends on the Chrome/OS voice stack available on the machine

## Recommended next steps

1. extract shared reader utilities into `packages/reader-core`
2. add tests around sentence segmentation and offset mapping
3. add better webpage content filtering for article-heavy pages
4. add an optional cloud-voice mode for the extension later if you want backend voice parity
