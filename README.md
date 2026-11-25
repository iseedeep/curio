# Curio — a personal encyclopedia

Curio is a curiosity-capture app: photograph or type anything that catches
your attention, get a clear jargon-free explanation, and save it as an entry
in your own searchable encyclopedia.

Two destinations, and nothing else:

- **Capture** — opens directly to Capture. Take a photo, choose one from
  Photos, or type a question. Photograph a passage and ask about the specific
  line that confused you. Drafts survive switching apps, backing out of the
  camera, or losing connection.
- **Library** — a visual map of the things you've collected. Each entry is a
  recognisable object: your actual photo, a tall miniature of a marked page,
  a small note carrying your own words. Fine lines join connected entries.
  Tap an object for a preview with Open / Connect; tap a line to see both
  objects and the thought you saved about them. Long-press and drag to link,
  or use Connect. Pan and pinch to explore; follow a thread and retrace it
  with Back. Search flies to the object on the map; the clean A–Z index is
  one tap away.

Answers lead with a clear explanation, keep the original passage within
reach, distinguish the author's words from Curio's interpretation, and never
invent quotations or sources. Saving is one deliberate action with an
editable suggested title; follow-ups deepen the same entry instead of
creating near-identical records.

## Tech

- TypeScript, React 19, Tailwind CSS 4, Drizzle ORM, Bun
- Client in `client/`, server actions in `server/src/actions.ts`, schema in
  `server/src/schema.ts`, migrations in `drizzle/`
- `bun run typecheck`, `bun run build`

## Running it

This code was built to run as a Muse web artifact, and it depends on the
Muse platform runtime: `@hatch/space-sdk` is a `file:` dependency pointing
at the platform's SDK, and the server actions run against the platform's
SQLite-backed data layer. It will **not** run standalone as-is outside that
runtime — porting it to a standalone server (for example, swapping the SDK
calls for a plain HTTP API and the Drizzle/SQLite layer for a database of
your choice) is a real piece of work, not a one-line change.

## Privacy

No user data ships in this repo. The app database (`app.db`), which holds
saved entries and their photos, is deliberately excluded, as are build
output and `node_modules`. A fresh checkout starts with an empty Library.

## Status

Personal project, iPhone-first. No quizzes, streaks, XP, or social features.
The name "Curio" is already taken on the App Store by other apps, so treat
it as a working title.
