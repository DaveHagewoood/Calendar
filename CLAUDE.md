# Travel Calendar Prototype

Mobile-first continuous timeline (375x812px) showing location stays as color-coded bars with infinite bidirectional scroll. Vanilla HTML/CSS/JS, no build tools. Deployed to Netlify.

## Files

- **index.html** — Minimal shell, Lucide CDN
- **script.js** — Rendering engine, data provider, event panel, transportation chain builder
- **styles.css** — Absolute positioning, z-index layers, animations, panel styles
- **data.js** — `JSONBIN_CONFIG` with API credentials (gitignored, not committed)

## Hosting & Data

- **App**: Netlify static deploy at `travel-calendar-app.netlify.app`
- **Data**: jsonbin.io — fetched on init, saved on event creation
- **Deploy**: `netlify deploy --dir=. --prod --skip-functions-cache`
- **data.js** is gitignored (contains API key). Must exist locally with `JSONBIN_CONFIG` (binId, masterKey, baseUrl)

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
- `depart` (ISO datetime, nullable) — when you leave (null = defaults to end of arrive day, marked estimated)
- `travel` (object, optional) — how you got there, with `legs[]` array
  - Each leg: `{ mode, duration (minutes), note }`
  - Travel renders backward from arrive: start = arrive - sum(leg durations)
- `estimated` (string array, optional) — field names with uncertain values (e.g. `["arrive", "depart"]`)

### Three data states
- **Confirmed** — field has a value and is NOT in `estimated` array
- **Estimated** — field has a value but IS in `estimated` array (rendered with diagonal stripes/reduced opacity on calendar, amber dashed style in panel)
- **Not set** — field is null/missing

### Derivation (DataProvider._derive)
From events, the engine derives:
- **stays** — color bars from arrive to depart (or next event boundary)
- **travel** — animated segments before arrive (only if legs defined)
- **gaps** — undefined periods between events (rendered as gray with ?)

### Validation rules
- No overlapping events (arrive/depart ranges + travel can't conflict)
- `depart >= arrive` when both defined
- Events auto-sorted by arrive time

## UI Panels

### Event Panel (New Trip)
- Opens when clicking undefined (gray) days on the calendar
- Fields: location picker (dropdown with colored dots), arrival date/time, departure date/time, transportation
- Custom inline time picker with hour grid, minute grid, AM/PM toggle, Done button
- Arrival defaults to noon (estimated), departure defaults to end of day (estimated)
- Save creates event, re-derives calendar, persists to jsonbin.io

### Transportation Chain Builder
- Chain-first workflow: tap transport mode buttons to build sequence (e.g. Car → Plane → Car)
- Visual preview with emoji pills and arrows, remove individual modes with ×
- After chain is set, legs display as tappable items with inline editors for duration and note
- "Edit transportation" re-opens builder, preserves existing leg details when modes match

### Trip Detail Panel
- Opens via expand icons on travel segments
- Shows travel legs with mode icons, durations, notes

## Critical Rules

1. **Pixel positioning only** — use `rowToY()` / `colToX()`, never percentages or CSS grid
2. **Transparent day cells** — grid is an overlay, color bars go underneath
3. **EPOCH must be a Sunday** — anchors col 0 = Sunday
4. **Timestamps, not days** — segments use fractional day positioning for hour-level precision
5. **Missing data is OK** — events can lack depart, travel, or both
6. **Panels need pointer-events management** — `pointer-events: none` when closed, `auto` when `.open`
