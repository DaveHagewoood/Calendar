# Travel Calendar Prototype

Mobile-first continuous timeline (375x812px) showing location stays as color-coded bars with infinite bidirectional scroll. Vanilla HTML/CSS/JS, no build tools.

## Files

- **index.html** — Minimal shell, Lucide CDN
- **script.js** — Rendering engine (chunk system, pixel positioning, scroll handling)
- **styles.css** — Absolute positioning, z-index layers, animations
- **data.js** — `CALENDAR_DATA` constant (locations, trips, stays, config)
- **data.json** — Mirror of data.js for reference

## Architecture

**Think time-based, not day-based.** Everything is positioned by timestamps, not discrete days.

- **EPOCH** = Sun Dec 29, 2024 — col 0 = Sunday, fixed row=0 reference
- **CELL_SIZE** = `375 / 7` (~53.57px square cells)
- **Chunks** = 4-week blocks rendered on demand, pruned when distant (max 40)
- **Positioning**: `rowToY(row)` / `colToX(col)` — absolute pixels, never percentages
- **Prepend**: uses `transform: translateY()` on chunk containers (preserves CSS animations), compensates `scrollTop`
- **Z-index**: bg(0) → fills(1) → grid(2) → labels(5) → icons(10)
- **No "home" concept**: periods without stays/trips are simply undefined (gray with ?)

## Data Format

Dates: `YYYY-MM-DDTHH:MM` (no timezone), parsed by `parseTimestamp()`. Edit `data.js` and sync `data.json`.

Location colors: CSS classes `.location-{name}` with `--fill-color` custom properties.

## Critical Rules

1. **Pixel positioning only** — use `rowToY()` / `colToX()`, never percentages or CSS grid
2. **Transparent day cells** — grid is an overlay, color bars go underneath
3. **EPOCH must be a Sunday** — anchors col 0 = Sunday; can be any Sunday, but don't change at runtime
4. **Timestamps, not days** — segments use fractional day positioning for hour-level precision
