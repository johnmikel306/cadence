# 12 - Brand And UI Refresh Notes

This notebook captures naming ideas, font ideas, and a cleaner design direction for the product.

It is based on product references and web design inspiration from sources like:

- `speechify.com`
- `linear.app`
- `webflow.com/blog/web-design-trends-2025`

## 1. Current decision

The product is now named `Cadence`.

That choice fits the product well because it suggests:

- rhythm
- pacing
- reading flow
- listening with structure

It is more premium and more memorable than the earlier internal-style name.

## 2. Better name directions

These are not trademark-checked. They are brainstorming options.

### Clear names

- `ReadAlong`
- `ReadStream`
- `PageFlow`
- `WebReader`
- `ListenReader`

These are easiest for users to understand quickly.

### Premium names

- `Cadence`
- `Sonnet`
- `Lumen`
- `Margin`
- `Relay`

These feel more like a polished product brand.

### Technical / product-like names

- `SyncRead`
- `DocFlow`
- `StreamText`
- `Signal Reader`

These feel more software-like and functional.

### Friendly names

- `PagePal`
- `FollowAlong`
- `ReadBuddy`
- `ListenPal`

These feel more approachable but slightly less premium.

## 3. Final name shortlist

Before the decision, these were the strongest options:

1. `ReadAlong`
2. `Cadence`
3. `PageFlow`
4. `SyncRead`
5. `Lumen`

### Best all-rounder

`ReadAlong`

Why:

- instantly communicates the follow-along reading behavior
- works for both documents and webpages
- feels friendly without sounding childish

### Best premium brand name

`Cadence`

Why:

- connects naturally to rhythm, voice, and reading pace
- feels more unique and product-brand-like

This is now the chosen direction for the repo UI.

## 4. Typography recommendations

The current product already leans toward a good reading direction, but it can become more intentional.

### Option A - Best overall

`Newsreader` + `Manrope`

- `Newsreader` for large headlines and reading surfaces
- `Manrope` for controls, labels, nav, and UI chrome

Why:

- warm and editorial for reading
- modern and clean for controls
- feels more premium than a generic sans-only product

### Option B - Best for technical clarity

`Source Serif 4` + `IBM Plex Sans`

Why:

- strong readability
- more serious and structured
- good for a product that wants to feel credible and utility-focused

### Option C - Best for more personality

`Fraunces` + `Instrument Sans`

Why:

- stronger brand presence on landing pages
- still readable if used carefully

### Option D - Best for accessibility positioning

`Atkinson Hyperlegible Next` + `Newsreader`

Why:

- clearer accessibility story
- strong fit if comprehension and reduced strain become central brand messages

## 5. Recommended font choice

For this repo, I recommend:

- headline / editorial voice: `Newsreader`
- interface / controls: `Manrope`

That combination fits the product very well.

## 6. What the best competitors and references suggest

### From `speechify.com`

Useful product ideas:

- clear feature framing: text highlighting, speed control, read anything
- simple benefit-led messaging
- strong accessibility and productivity framing

### From `linear.app`

Useful design ideas:

- tight spacing discipline
- crisp hierarchy
- polished control surfaces
- minimal but confident motion

### From Webflow 2025 design trend coverage

Useful inspiration to borrow lightly:

- soft light and shadow overlays
- subtle glow used as emphasis, not decoration overload
- layered depth and polished visual focus

Important warning:

The main reading surface should stay calm and readable. Trendy visual effects should live more in marketing areas than in the reading canvas itself.

## 7. Best UI direction for this product

Recommended direction:

`calm editorial workspace + precision SaaS chrome`

That means:

- reading surface feels warm, quiet, and book-like
- controls feel clean, modern, compact, and reliable
- highlighting is the main visual accent
- motion is subtle and purposeful

## 8. Concrete UI recipe

### Color direction

- paper background: warm off-white
- text: deep ink brown or charcoal
- accent: teal, copper, or amber
- active word highlight: richer accent color
- active sentence highlight: softer accent wash

### Layout direction

- sticky top or bottom playback rail
- left sidebar or floating side rail for source/actions
- generous center reading column
- clear visual separation between control chrome and reading canvas

### Motion direction

- fade in uploaded content
- smooth auto-scroll while reading
- small state changes for pause/resume
- no excessive bounce or novelty transitions

### Surface direction

- use soft panels and subtle shadows
- avoid flat generic white-on-white boxes everywhere
- keep the actual document surface calmer than the surrounding UI

## 9. Design directions you could choose from

### Direction A - Editorial Reader

Feel:

- calm
- scholarly
- premium

Good for:

- readers
- students
- professionals

### Direction B - Productive Listener

Feel:

- efficient
- modern
- software-polished

Good for:

- people who want a utility tool first

### Direction C - Ambient Reading Lab

Feel:

- futuristic
- luminous
- immersive

Good for:

- landing pages and marketing moments

Risk:

- easier to overdesign and hurt readability

## 10. My recommendation for you

If you want the strongest next move, I would do this:

- rename toward `ReadAlong` or `Cadence`
- adopt `Newsreader` + `Manrope`
- redesign the frontend as a calm editorial workspace with stronger, cleaner playback chrome

That would make the product feel:

- more intentional
- more memorable
- more readable
- less like a prototype

## 11. Good next design tasks

1. redesign the landing page around one strong message and one product screenshot
2. simplify the `/reader` control area into a more compact command bar
3. create a consistent floating playback rail style shared by the web app and extension
4. define a small design token system for color, spacing, type, and highlight states
