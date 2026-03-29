# 09 - Visual Architecture Diagrams

This notebook shows the repo as pictures made from text.

These are not exact UML diagrams. They are beginner diagrams designed to help you think clearly.

## 1. Whole monorepo view

```text
Cadence monorepo
|
|- apps/web
|  |- Flask backend
|  |- web templates
|  |- web frontend JS/CSS
|
|- apps/extension
|  |- popup
|  |- background service worker
|  |- offscreen audio document
|  |- content script
|
|- packages/reader-core
   |- future shared reading logic
```

## 2. Web app high-level architecture

```text
User
-> Browser UI (/reader)
-> Web frontend JS
-> Flask API
-> edge-tts

Then back:

edge-tts
-> Flask streaming session
-> audio stream + SSE events
-> browser audio + highlight UI
```

## 3. Web app detailed reading flow

```text
Upload file
-> /api/upload
-> Flask stores original file
-> frontend chooses renderer by file type
-> frontend renders visible content
-> frontend builds canonical text map
-> frontend sends manifest to /api/documents/<id>/manifest
-> user clicks or presses play
-> frontend requests /api/read-sessions
-> Flask creates ReadSession
-> /audio streams MP3
-> /events streams word timing
-> frontend maps timing to DOM ranges
-> frontend paints sentence + word highlight
```

## 4. Web app source of truth map

```text
Frontend owns:
- rendered document
- text mapping
- click position
- highlight drawing

Backend owns:
- files
- voices
- sessions
- streaming audio
- streaming timing events
```

## 5. Extension architecture

```text
Popup <-> Background service worker <-> Offscreen document
                     |
                     v
                Content script <-> Webpage DOM
                     |
                     v
                Flask backend -> edge-tts
```

## 6. Why the extension is split

```text
Popup
- controls
- settings UI

Background
- orchestration
- persistence
- backend calls

Offscreen
- audio playback
- timing progress loop

Content script
- webpage text extraction
- click-to-read
- highlights
- floating controls
```

## 7. Extension playback flow

```text
User presses shortcut or popup button
-> background gets readable page text from content script
-> background POSTs /api/page-read-sessions
-> backend creates session
-> background tells offscreen to start session
-> offscreen loads audio stream + event stream
-> offscreen computes current spoken offset
-> background receives progress
-> background forwards READING_PROGRESS to content script
-> content script highlights page text
```

## 8. Extension persistence flow

```text
Playback starts
-> background stores runtime state in chrome.storage.session

Service worker goes idle and is unloaded
-> in-memory globals disappear

User presses pause or reopens popup
-> background wakes up again
-> background reloads state from chrome.storage.session
-> background asks offscreen for live playback state
-> control works again
```

## 9. Highlighting model

```text
Visible text nodes
-> canonical reading string
-> run boundaries (start/end offsets)
-> speech timing event arrives
-> character range determined
-> DOM range reconstructed
-> rectangles measured
-> overlay blocks drawn on screen
```

## 10. Failure map

```text
Possible failure
-> likely area to inspect

Upload fails
-> Flask upload route

Audio plays but no highlight
-> timing flow, offset mapping, content script overlay

Pause/resume fails in extension
-> background persistence + offscreen state sync

Wrong word highlighted
-> canonical text mismatch or sentence/word mapping
```

## Practice exercise

Take one of the diagrams above and redraw it by hand.

Then explain it out loud in your own words.

If you can teach one diagram back to yourself, you understand that part much more deeply.
