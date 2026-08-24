# Graphical floor view — visual design

**Date:** 2026-08-24
**Surface:** `apps/web/src/routes/dashboard/floorplan-view.tsx` (renderer) and
`apps/web/src/routes/config/floorplans.tsx` (grade assignment).

## The thesis

**Hue encodes cleanroom grade. Saturation encodes status.**

The existing view is deliberately white, and its reasoning is sound and must
survive: a floor of tinted tiles cannot show two readings disagreeing, and
status colour must never be confusable with theme colour. So colour is not
added as decoration — it is given a second job it can hold honestly.

GMP floor plans are already colour-coded by classification. Adopting that is
borrowing the subject's own vernacular rather than inventing a palette: the
drawing becomes a zoning plan that a QA operator already knows how to read,
and the alarm state rides on top of it in saturated chips that nothing else on
the page competes with.

The rule that keeps the two from fighting: **zone colour is low-chroma and
lives in the room FILL; status colour is saturated and lives only in CHIPS and
the alarm halo.** No other element on the drawing is allowed to be saturated.

## Tokens

### Zone fills (low chroma, room interiors)

| Grade | Fill | Ink (code text + grade tab) |
|---|---|---|
| `A` — sterile core | `#EEF0FF` | `#4338CA` |
| `B` — aseptic | `#E8F1FE` | `#1D4ED8` |
| `C` — clean production | `#E9F7F1` | `#047857` |
| `D` — support / stores | `#FEF5E7` | `#B45309` |
| `CIRCULATION` — corridors | `#EFF2F7` | `#475569` |
| `UTILITY` — plant, offices | `#F4F4F5` | `#52525B` |
| unset (`null`) | `#FFFFFF` | `#1F2937` |

### Fixed, never themed

Walls stay one graphite (`#1F2937`) across every room, whatever its grade.
Colouring walls per zone was considered and rejected — it makes a dense floor
noisy and weakens the one line that carries the building's structure. The zone
speaks through fill, code colour and the grade tab; the walls stay quiet.

Doors keep `#0EA5E9` for leaf and swing arc — it reads as an opening, and it
matches the operator's reference drawing.

Status chips are unchanged and remain semantic: `OUT_OF_SPEC #DC2626`,
`STALE`/`PARTIAL #D97706`, `NO_DATA #64748B`, `OK #15803D`, each keeping its
glyph so status is never colour alone.

### Ground

The building sits on `#F8FAFC` rather than on the card's white, so the plan
reads as a drawing on a plate instead of floating. Building outline `#1F2937`
at 3px.

## Elements

**Grade tab.** A 14×11 rounded rect in the room's top-left inside corner,
filled with the zone ink, carrying the grade letter in white at 8px bold.
Omitted entirely when the room has no grade — an absent tab is honest, a
guessed grade is not.

**Room code.** Uppercase, `700`, letter-spacing `0.08em`, in the zone ink.
The tracking is what gives it the drafting-label character; it is the one
typographic move on the drawing and it is not repeated elsewhere.

**Room label.** `#475569`, regular weight, no tracking — subordinate to the
code by both size and colour.

**Corridor centre-line — the signature.** Every room graded `CIRCULATION` gets
a dashed centre-line (`#94A3B8`, 1px, `6 5`) running its long axis. It costs
almost nothing and it makes the corridors read as one connected circulation
system rather than as leftover space between rooms. This is the element the
drawing is remembered by; nothing else on the page gets a flourish.

**Alarm halo.** A room whose worst status is `OUT_OF_SPEC` gets a 2px inset
stroke in `#DC2626` at 0.9 opacity, 4 units inside its walls. It pulses
between 0.35 and 0.9 opacity over 2s — the one aesthetic risk here, taken
because this drawing's job is to be read from across a room, and a breach
should find the eye rather than wait to be found. **It must be wrapped in
`@media (prefers-reduced-motion: reduce)` and fall back to a static 0.9
stroke.** The fill never changes: an alarm must not repaint the zone, or
grade and status start arguing.

**Instrument tiles.** White `#FFFFFF`, hairline `#CBD5E1`, 3px radius. Code in
`#111827` at `600` with `0.04em` tracking. Values keep tabular figures so
columns of readings align.

**Legends.** Two, in one bar, separated by a rule: status (existing, unchanged)
and grade. The grade legend is a swatch, the letter, and the plain-language
name — "A — Sterile core", not "Grade A".

## Data

Grade is stored per room: `floorplan_rooms.grade`, nullable text, one of
`A` `B` `C` `D` `CIRCULATION` `UTILITY`. **Text with zod validation, not a
Postgres enum** — the enum count stays at 13, and a classification vocabulary
that may need extending should not require a migration to do it.

`NULL` means nobody has classified this room, and it renders white exactly as
today. Every existing room is `NULL` on migration, so nothing changes
appearance until someone assigns a grade.

Assignment lives in the Floorplans editor beside the room's code and limits.

## What this deliberately does not do

- **No dark mode.** Out of scope, unchanged from the doors work.
- **No new dependency.** No chart, icon or font library; the drawing stays
  hand-rolled SVG on system font stacks.
- **No colour on walls, doors, or the building outline.** One accessory
  removed: the zone already speaks three times (fill, code colour, tab), and a
  fourth would be the thing that tips the drawing into noise.
