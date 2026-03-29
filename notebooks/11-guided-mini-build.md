# 11 - Guided Mini Build

This notebook gives you a practical learning path for building a smaller version yourself.

Do not try to rebuild all of Cadence immediately.

Build a mini-reader first.

## Goal of the mini build

Build a small app that:

- accepts plain text input
- reads the text aloud
- highlights the current sentence
- later highlights the current word

That alone will teach you a lot.

## Stage 1: Single-page text reader

### Build

- one Flask route that serves one HTML page
- one textarea
- one play button

### Learn

- how frontend sends data to backend
- how backend returns a response

### Question

Where should the current text live while the user is editing it?

## Stage 2: Basic TTS endpoint

### Build

- backend accepts plain text
- backend uses `edge-tts`
- return playable audio

### Learn

- what it means to call a backend service for speech
- why long text is different from short text

### Question

What happens if the user clicks play twice?

## Stage 3: Add sessions

### Build

- create a read session object
- give it an id
- allow starting and stopping

### Learn

- why explicit session objects make the system cleaner

### Question

Why is a session object better than a pile of unrelated globals?

## Stage 4: Add sentence segmentation

### Build

- split the text into sentence ranges
- highlight the active sentence during playback

### Learn

- how to turn one long string into useful chunks

### Question

What should happen if the segmentation is wrong?

## Stage 5: Add word timing metadata

### Build

- stream audio
- stream timing metadata
- highlight the current word

### Learn

- why media and metadata often need separate flows

### Question

Why is time alone not enough without text offsets?

## Stage 6: Add click-to-read

### Build

- when the user clicks a sentence, start from there

### Learn

- click mapping
- offset calculation

### Question

Do you want to start from exact click position or sentence start? Why?

## Stage 7: Add one real format

### Build

- choose PDF or Markdown first
- render it properly
- build text mapping from rendered output

### Learn

- why real rendering and visible reading order matter

### Question

What gets harder when a format has complex layout?

## Stage 8: Add browser extension later

Only after the mini web app feels understandable.

### Build later

- popup
- content script
- background
- offscreen audio

### Learn

- how platform rules change architecture

## Suggested weekly plan

### Week 1

- Stage 1 and Stage 2

### Week 2

- Stage 3 and Stage 4

### Week 3

- Stage 5 and Stage 6

### Week 4

- Stage 7

### Week 5+

- extension work

## Personal learning rule

At the end of each stage, write down:

- what I built
- what confused me
- what state I had to manage
- what broke first
- what I would do differently next time

This turns coding into real engineering growth.

## Mini-project challenge

After finishing the mini build, try one of these:

1. add speed control
2. add stop and resume
3. add a small floating playback bar
4. add markdown support

If you can do any two of those, you are progressing very well.
