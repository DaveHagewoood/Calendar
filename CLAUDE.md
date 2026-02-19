# Travel Calendar Prototype

Mobile-first continuous timeline (375x812px) showing location stays as color-coded bars with infinite bidirectional scroll. Vanilla HTML/CSS/JS, no build tools.

## Files

- **index.html** — Minimal shell, Lucide CDN
- **script.js** — Rendering engine (chunk system, pixel positioning, scroll handling)
- **styles.css** — Absolute positioning, z-index layers, animations
- **data.js** — `CALENDAR_DATA` constant (locations, events, config)
- **data.json** — Mirror of data.js for reference

## Architecture

**Think time-based, not day-based.** Everything is positioned by timestamps, not discrete days.

- **EPOCH** = Sun Dec 29, 2024 — col 0 = Sunday, fixed row=0 reference
- **CELL_SIZE** = `375 / 7` (~53.57px square cells)
- **Chunks** = 4-week blocks rendered on demand, pruned when distant (max 40)
- **Positioning**: `rowToY(row)` / `colToX(col)` — absolute pixels, never percentages
- **Prepend**: uses `transform: translateY()` on chunk containers (preserves CSS animations), compensates `scrollTop`
- **Z-index**: bg(0) → fills(1) → grid(2) → labels(5) → icons(10)

## Data Model — Event-Based

Each destination visit is a standalone **event** with optional fields. Events are independent — they don't need to chain together.

### Event fields
- `id` (string, required) — unique identifier
- `location` (string, required) — references a location name
- `arrive` (ISO datetime, required) — when you arrive (minimum data to create an event)
- `depart` (ISO datetime, nullable) — when you leave (null = unknown)
- `travel` (object, optional) — how you got there, with `legs[]` array
  - Each leg: `{ mode, duration (minutes), note }`
  - Travel renders backward from arrive: start = arrive - sum(leg durations)

### Derivation (DataProvider._derive)
From events, the engine derives:
- **stays** — color bars from arrive to depart (or next event boundary)
- **travel** — animated segments before arrive (only if legs defined)
- **gaps** — undefined periods between events

### Validation rules
- No overlapping events (arrive/depart ranges + travel can't conflict)
- `depart >= arrive` when both defined
- Events auto-sorted by arrive time

## Critical Rules

1. **Pixel positioning only** — use `rowToY()` / `colToX()`, never percentages or CSS grid
2. **Transparent day cells** — grid is an overlay, color bars go underneath
3. **EPOCH must be a Sunday** — anchors col 0 = Sunday
4. **Timestamps, not days** — segments use fractional day positioning for hour-level precision
5. **Missing data is OK** — events can lack depart, travel, or both
