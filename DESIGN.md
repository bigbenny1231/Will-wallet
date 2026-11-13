# Lastword — Design Direction (binding for site, dashboard, NFT art, video)

Goal: the most beautiful thing the judges see that week. Not "a dark dashboard". An object with a point of view.

## Concept

An estate document that is alive. Editorial, solemn, precise. The product is about continuity after
absence, so the aesthetic is memento mori without goth: paper-and-ink restraint, one warm metallic
accent, and a single living motif — the heartbeat trace.

Signature motif: **the pulse line** (ECG trace).
- Alive: a slow rhythmic trace, breathing glow, beats every few seconds in sync with real heartbeats.
- Warning: the trace thins and stutters, amber.
- Triggered: the trace flatlines; the flat line extends and *becomes* the settlement timeline (steps appear as ticks on it).
- Settled: the line is grey and still; the heir's name sits under it.

The Will NFT is a **seal**: a circular medallion, thin double ring, the pulse trace inside, the vault number in small caps around the rim like a coin inscription. Green/amber/red/grey by state. This is also the on-chain SVG the contract renders.

## Tokens (use exactly)

```css
--ink:        #0B0C0F;   /* background */
--ink-2:      #121419;   /* panels */
--ink-3:      #1A1D24;   /* borders, hairlines at 1px, 40% alpha */
--bone:       #EDE7DC;   /* primary text */
--bone-2:     #A9A399;   /* secondary text */
--brass:      #C8A96A;   /* accent: links, small caps labels, seal rim */
--brass-2:    #8C7446;   /* accent muted */
--life:       #3DDC84;   /* Alive */
--warn:       #F5B942;   /* Warning */
--dead:       #FF4D4D;   /* Triggered */
--still:      #7A7F87;   /* Settled */
--grain:      url(data:image/svg+xml;...) /* 3% noise overlay on ink, fixed, pointer-events none */
```

Typography (self-hosted via npm `@fontsource` so it renders in the sandbox too):
- Display: **Instrument Serif** (regular + italic). Headlines, the product name, pull quotes. Italic for emphasis words.
- Text/UI: **Inter Tight** (400/500/600). Body, labels, numbers.
- Mono: **JetBrains Mono** (400). Hashes, account ids, log lines.
- Sizes: display 72/64/48, h2 32, body 17, label 12 small caps (letter-spacing 0.12em, brass), mono 14.

Layout: generous whitespace, 12-col grid, max-width 1200, hairline rules instead of card borders where possible, no drop shadows, no gradients except the seal's glow, corner radius 4 (not 12), buttons are text + hairline underline or a solid bone pill for the single primary CTA.

Motion: slow (600–900 ms, ease-out-quint), nothing bounces. The pulse animates with CSS `stroke-dashoffset` on a path; beats are triggered from real heartbeat events when live data exists. Respect prefers-reduced-motion.

## Voice (copy)

Calm, declarative, short. No exclamation marks, no emoji, no hype adjectives.
Sentences like a will reads: "While you are alive, nothing happens." "When you are not, this executes."
Legal framing rules (never claim legal effect, certainty of outcome, or that it is or replaces a will; never say it detects death).

## Site (landing)

Sections in order: nav · hero (headline "Your crypto shouldn't die with you." in Instrument Serif 56–68, sub in Inter Tight 20, the seal animating on the right with a live-looking pulse) · a full-width pulse strip that flatlines on scroll into the three steps · "For heirs" band on bone background (inverted) · security model as a typeset table · "For attorneys" with the sample clause in a document-styled block · FAQ · footer. The demo video embedded under the hero on a hairline-framed player.

## Dashboard

Vault page = "the estate console": left column the seal (large, 360px) with state word under it in Instrument Serif; a horizontal pulse strip across the top of the content column that reflects state; panels are hairline-ruled sections, not cards; the settlement timeline is drawn ON the flatline (ticks with step labels, explorer links as brass small caps); the agent log is a typeset ledger (mono, allowed in life green, denied in dead red with the reason in small caps). Buttons: one primary (bone pill), others as text links. Keep every existing function and test.

## Video

A produced piece, not a screen capture of terminals. Title in Instrument Serif on ink with the seal breathing. The dashboard footage is the real thing, but framed inside a designed stage: the two log panes are typeset like the dashboard ledger (not generic terminals), captions in Instrument Serif italic 48 on a hairline-ruled lower third, section cards between acts ("I. Alive", "II. Silence", "III. Settlement"), and a final card with the heir's name under a still grey seal. Music: none unless a licence-free track is available offline; silence with captions is acceptable.
