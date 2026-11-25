<p align="center">
  <img src="logo.webp" width="140" alt="Curio logo">
</p>

<h1 align="center">Curio</h1>

<p align="center"><em>A personal encyclopedia, built one curiosity at a time.</em></p>

## The idea

You're reading a book and a line stops you. You're looking at a painting, a
coin, a flower, and you want to know what it is and why it matters. You ask,
you understand — and then, weeks later, it's gone. Not because it didn't
matter, but because there was nowhere for it to live.

Notes apps keep your words. Chatbots give you an answer and let it scroll
away. Curio is built for the space between them: capture the thing that
caught your attention, understand it in the moment, and keep it somewhere
you can actually find it again — even when you've forgotten the title, the
terminology, and which book it came from.

## What it does

Curio has two destinations, and nothing else.

**Capture.** The app opens here. Take a photo, choose one from your photos,
or type a question in your own words. Photograph a passage and ask about the
specific line that confused you. If you switch apps, back out of the camera,
or lose your connection, your draft is still there when you return.

**Understand.** You get an explanation that leads with the answer, in plain
language, with a quiet way to ask a follow-up and go deeper. For a
photographed passage, the original stays within reach, and the author's
words are always kept distinct from the interpretation. Quotations and
sources are never invented — if a line is unreadable, Curio says which part
needs a clearer photo instead of guessing.

**Save.** Saving is one deliberate action, with a short title suggested for
you to edit. Your question, the explanation, and the source photo stay
together as a single entry, and follow-ups deepen that same entry — one
idea, one record, no matter how many questions it took to understand it.

**Library.** Your saved entries live on a visual map, not in a list of
rows. Each entry is a recognisable object: your actual photograph, a tall
miniature of the page you marked, a small note carrying your own words.
Objects you connected sit near each other, joined by a fine line. A clean
A–Z index and search are always one tap away when you know exactly what
you're looking for.

## The interesting part

Most collections make you remember in order to find. Curio tries the
opposite:

- **Recognition by sight.** You should be able to spot your coin, your page,
  and your book on the map with the labels covered — a round coin, a tall
  book, and a wide photograph are easier to tell apart than three identical
  tiles.
- **Connections you chose.** Link two entries by dragging one onto the
  other, and write the thought that joins them, in your words. Suggestions
  appear as faint dotted lines you can accept or dismiss — the permanent
  map only ever shows connections you made.
- **Following a thread.** Tap a connected object and the map glides to it,
  so you can start with a page from one book, follow it to another, and end
  up at a thought you wrote weeks ago — then retrace your steps with Back.
- **Recovery from a half-remembered phrase.** Search looks across titles,
  your questions, and the explanations, and forgives near-misses: search
  "spirit of the age" and the entry you saved as "spirit of the times"
  still finds its way back to you.

The map remembers where you left everything, too. If the coin was near the
lower left yesterday, it's near the lower left tomorrow.

## Status

Curio is in development and **not yet runnable**. This repository holds the
idea, the design, and the source written so far — it doesn't yet include
everything needed to build and run the app on your own, and there's no
download or beta yet. It's shared to show what Curio is and where it's
going.

No quizzes, no streaks, no XP, no social feed. "Curio" is a working title.

## Under the hood

TypeScript and React on the front, a small server layer with a SQLite
schema and migrations (`drizzle/`) behind it. No user data lives in this
repository — saved entries and their photos are deliberately excluded, so a
fresh checkout starts with an empty Library.
