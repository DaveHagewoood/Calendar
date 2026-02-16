# Travel Calendar Prototype

A mobile-first calendar visualization that displays location-based timelines as continuous color-coded bars rather than traditional day-based events.

## Core Concept

This is **not** a traditional calendar. It's a continuous timeline that wraps horizontally across weeks, showing where you are (or will be) at any given time with smooth color transitions and travel indicators.

### Key Architectural Decision

**Think time-based, not day-based.** The fundamental architecture uses:
- Continuous color bars positioned by absolute pixel coordinates
- Transparent grid cells overlaid to show day boundaries
- Z-index layering to separate timeline from grid structure
- Chunk-based rendering for infinite bidirectional scroll

## File Structure

```
Calendar/
├── index.html          # Basic structure, Lucide icon CDN
├── styles.css          # Absolute positioning styles, z-index hierarchy
├── script.js           # Chunk-based infinite scroll rendering engine
├── data.js             # Local datastore (CALENDAR_DATA constant)
├── data.json           # Mirror of data.js for reference/migration
├── .gitignore          # Project exclusions
└── CLAUDE.md           # This file
```

## Technical Architecture

### Infinite Scroll & Chunk System

The calendar uses a chunk-based rendering system for infinite bidirectional scroll:

- **CELL_SIZE** = `375 / 7` (~53.57px) — fixed square cell size
- **EPOCH** = Mon Dec 30, 2024 — absolute row=0 reference that never changes
- **Chunks** = 4-week (28-day) blocks, rendered on demand
- Initial load: ~13 weeks back + ~52 weeks forward from today
- Scroll listener (RAF-throttled, passive) extends range when within 600px of edge
- Prepend handling: shifts `originY` and `scrollTop` in sync to prevent jumps
- Distant chunks pruned when count exceeds MAX_CHUNKS (40)

### Key State: CalendarState

```javascript
CalendarState = {
    renderedStartWeek,  // Absolute week offset from EPOCH
    renderedEndWeek,
    originY,            // Pixel offset: absolute week 0 maps to this Y
    chunks: Map,        // chunkIndex → DOM element
    trips, stays,       // Parsed data arrays
    locationMap,        // name → location object
    canvas, viewport    // DOM refs
}
```

### Pixel Positioning (not percentages)

All elements use absolute pixel positioning via `createPositionedDiv()`:

```javascript
function rowToY(absoluteRow) {
    return CalendarState.originY + absoluteRow * CELL_SIZE;
}
function colToX(col) {
    return col * CELL_SIZE;
}
```

### Z-Index Layering

```
Layer 0: chunk-bg          - Dark gray background rows
Layer 1: continuous-fill   - Color bars (stays, trips, fades, undefined)
Layer 2: day-cell          - Transparent grid overlay with borders
Layer 5: location-label    - Location name text
Layer 10: travel-icon      - Interactive travel icons
```

### Grid Position (absolute from EPOCH)

```javascript
function getGridPosition(timestamp) {
    const daysFromEpoch = Math.floor((timestamp - EPOCH) / msPerDay);
    const row = Math.floor(daysFromEpoch / 7);       // = week offset
    const col = ((daysFromEpoch % 7) + 7) % 7;       // always 0-6
    const dayFraction = /* time within the day, 0-1 */;
    return { row, col, dayIndex: daysFromEpoch, dayFraction };
}
```

### Chunk Rendering Pipeline

Each chunk renders layers in z-order:
1. `chunk-bg` — dark gray row backgrounds
2. `renderUndefined()` — gray fill for unknown periods
3. `renderFadeIn()` / `renderFadeOut()` — 48h gradient transitions
4. `renderStays()` — location color bars
5. `renderTrips()` — animated travel segments
6. `renderLabels()` — location name text
7. `renderDayCells()` — transparent grid with day numbers
8. `renderTripIcons()` — plane icons on trips

### DataProvider

Wraps `CALENDAR_DATA` from `data.js`. Designed to swap to `fetch()` later:
- `loadAll()` — returns all trips/stays as parsed timestamps
- `loadRange(start, end)` — returns trips/stays overlapping a time range
- `getLocations()` / `getConfig()` — static data access

## Features

### Location Stays
- Color-coded background fills for each location
- Smooth transitions between locations
- Time-of-day precision (can start/end at specific hours)
- Labels on each row: centered for wide stays, left-aligned for narrow

### Travel Periods
- Cyan gradient background with animated right-facing arrows
- White circular icons with plane symbol
- Hover effect with scale animation

### Undefined Periods
- Gray background (#3a3a3a) for unknown periods
- 48-hour fade-in gradient before first known stay
- 48-hour fade-out gradient after last known stay

### Scroll Behavior
- Infinite bidirectional scroll via chunk system
- Auto-centers on today's date at startup
- Mobile-style drag interaction
- Hidden scrollbar for native app feel
- 375×812px mobile container

### Today Highlight
- Translucent white circle behind today's day number
- Calendar auto-scrolls to center on today

## Data Structure

All trip and stay data lives in `data.js` (and mirrored in `data.json`). Dates use ISO 8601 local-time strings (no timezone suffix).

```json
{
    "locations": [
        { "name": "paris", "color": "#E88D8D", "label": "Paris" }
    ],
    "trips": [
        {
            "depart": "2026-01-17T14:30",
            "arrive": "2026-01-18T10:06",
            "from": "home",
            "to": "paris",
            "legs": [
                { "mode": "uber", "duration": 45, "note": "To JFK Airport" }
            ]
        }
    ],
    "stays": [
        {
            "location": "paris",
            "start": "2026-01-18T10:06",
            "end": "2026-02-01T08:00"
        }
    ],
    "config": {
        "calendarStartDate": "2025-10-01",
        "weeksToShow": 52,
        "dataStartDate": "2026-01-01",
        "fadeHours": 48,
        "homeLocation": "home"
    }
}
```

**Important:** The initial "home" stay is derived at runtime from `dataStartDate` to first trip departure.

**Date format:** Use `YYYY-MM-DDTHH:MM` (no timezone). Parsed via `parseTimestamp()` into local-time millisecond timestamps.

## Location Colors

Defined as CSS custom properties:

```css
.location-home { --fill-color: #4A7BA7; }       /* Blue */
.location-paris { --fill-color: #C66B6B; }      /* Red */
.location-tokyo { --fill-color: #8B6FB8; }      /* Purple */
.location-beach { --fill-color: #5AB89E; }      /* Teal */
.location-mountains { --fill-color: #B8895B; }  /* Brown */
.location-lake { --fill-color: #6BC6E8; }       /* Cyan */
.location-undefined { --fill-color: #3a3a3a; }  /* Gray */
```

## Dependencies

- **Lucide Icons** (CDN): Professional SVG icon library
- **No build tools required**: Vanilla HTML/CSS/JS

## Code Conventions

### Timestamps
In `data.js`/`data.json`, use ISO 8601 local-time strings:
```
"2026-01-17T14:30"   // Jan 17, 2026 at 2:30 PM
"2025-10-01"         // Oct 1, 2025 (date-only, for config)
```
At runtime, `parseTimestamp()` converts these to millisecond timestamps.

### Class Naming
- `.location-{name}` - Location-specific color variables
- `.travel-segment` - Animated travel background
- `.travel-icon` - Interactive icon wrapper
- `.location-label` / `.location-label-narrow` - Stay name labels
- `.chunk` / `.chunk-bg` - Chunk containers and backgrounds

### DOM Structure
```html
<div class="calendar-viewport" id="calendarViewport">
    <div class="calendar-canvas" id="calendarCanvas">
        <div class="chunk" data-chunk-index="5">
            <!-- chunk-bg rows, continuous-fill segments,
                 day-cells, location-labels, travel-icons -->
        </div>
    </div>
</div>
```

## Future Considerations

- Remote data loading (swap DataProvider.loadAll → fetch)
- Click handlers for travel icons (expand trip details)
- Responsive sizing for different screen sizes
- Month labels positioned absolutely

## Critical Reminders

1. **Never think in discrete days** - Everything is timestamp-based
2. **Pixel positioning only** - No percentages, no CSS grid — use `rowToY()` and `colToX()`
3. **Transparent cells are essential** - Grid is just an overlay
4. **Data lives in data.js** - Edit data.js (and sync data.json), not hardcoded values
5. **Z-index matters** - Background at 0, fills at 1, grid at 2, labels at 5, icons at 10
6. **EPOCH never changes** - All positioning is absolute from Dec 30, 2024
7. **originY shifts on prepend** - Existing elements get repositioned, scrollTop compensated
