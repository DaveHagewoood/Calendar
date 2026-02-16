# Travel Calendar Prototype

A mobile-first calendar visualization that displays location-based timelines as continuous color-coded bars rather than traditional day-based events.

## Core Concept

This is **not** a traditional calendar. It's a continuous timeline that wraps horizontally across weeks, showing where you are (or will be) at any given time with smooth color transitions and travel indicators.

### Key Architectural Decision

**Think time-based, not day-based.** The fundamental architecture uses:
- Continuous color bars positioned by absolute timestamps
- Transparent grid cells overlaid to show day boundaries
- Z-index layering to separate timeline from grid structure

## File Structure

```
Calendar/
├── index.html          # Basic structure, Lucide icon CDN
├── styles.css          # Layered architecture with z-index hierarchy
├── script.js           # Continuous timeline rendering engine
├── .gitignore          # Project exclusions
└── CLAUDE.md           # This file
```

## Technical Architecture

### Z-Index Layering

```
Layer 0: segment-container   - Continuous color bars
Layer 1: day-cell            - Transparent grid overlay
Layer 2: day-number          - Date labels
Layer 10: icon-container     - Interactive travel icons
```

### Time-Based Positioning

All positioning is calculated from timestamps, not discrete days:

```javascript
function getGridPosition(timestamp) {
    const daysFromStart = (timestamp - calendarStart) / (24 * 60 * 60 * 1000);
    const dayIndex = Math.floor(daysFromStart);
    const dayFraction = daysFromStart - dayIndex;  // Time within day
    const row = Math.floor(dayIndex / 7);
    const col = dayIndex % 7;
    return { row, col, dayIndex, dayFraction };
}
```

### Continuous Segment Rendering

Segments wrap across multiple rows with percentage-based positioning:

```javascript
function renderContinuousSegment(start, end, className, additionalClasses) {
    // Splits segment into row-based pieces
    // Calculates left/width percentages for each row
    // Applies gradients across multiple segments for smooth transitions
}
```

## Features

### Location Stays
- Color-coded background fills for each location
- Smooth transitions between locations
- Time-of-day precision (can start/end at specific hours)

### Travel Periods
- Cyan gradient background with animated right-facing arrows
- White circular icons with plane symbol
- Hover effect with scale animation

### Undefined Periods
- Gray background with question mark icons
- 48-hour fade-in gradient before first known trip
- 48-hour fade-out gradient after last known stay

### Scroll Behavior
- Vertical scroll only (52 weeks loaded)
- Mobile-style drag interaction
- Hidden scrollbar for native app feel
- 375×812px mobile container

## Data Structure

```javascript
const trips = [
    {
        depart: makeTimestamp(2025, 0, 17, 14, 30),  // Jan 17, 2:30 PM
        arrive: makeTimestamp(2025, 0, 18, 9, 0),
        destination: 'paris'
    },
    // ... more trips
];

const stays = [
    {
        start: makeTimestamp(2025, 0, 18, 9, 0),
        end: makeTimestamp(2025, 0, 24, 16, 0),
        location: 'paris'
    },
    // ... more stays
];
```

**Important:** JavaScript months are 0-indexed (0=Jan, 1=Feb, 2=March)

## Location Colors

Defined as CSS custom properties:

```css
.location-home { --fill-color: #4A7BA7; }       /* Blue */
.location-paris { --fill-color: #C66B6B; }      /* Red */
.location-tokyo { --fill-color: #8B6FB8; }      /* Purple */
.location-beach { --fill-color: #5AB89E; }      /* Teal */
.location-mountains { --fill-color: #B8895B; }  /* Brown */
.location-undefined { --fill-color: #3a3a3a; }  /* Gray */
```

## Development History

### Initial Approach (Wrong)
Started with day-based thinking: each day cell contained its own background color. This broke the continuous timeline concept.

### Architectural Pivot
Shifted to continuous timeline with transparent overlay:
1. **Step 1:** Basic color fills with absolute positioning
2. **Step 2:** Time-of-day precision with fractional days
3. **Step 3:** Multi-row wrapping with gradient calculations

### Key Learnings
- Grid cells must be transparent (background: transparent)
- Segments use absolute positioning with percentage-based coordinates
- Gradients must be calculated across row boundaries for smooth fades
- Z-index separation is critical for independent layering

## Visual Effects

### Travel Animation
```css
.travel-segment {
    background-image:
        url("data:image/svg+xml,..."),  /* Animated arrows */
        linear-gradient(135deg, #06b6d4 0%, #0891b2 100%);
    animation: travel-animation 1.5s linear infinite;
}
```

### Fade Gradients
48-hour transitions calculated with:
```javascript
const gradientStart = Math.max(0, (segmentStartTime - fadeInStart) / fadeInDuration);
const gradientEnd = Math.min(1, (segmentEndTime - fadeInStart) / fadeInDuration);
```

## Dependencies

- **Lucide Icons** (CDN): Professional SVG icon library
- **No build tools required**: Vanilla HTML/CSS/JS

## Configuration

```javascript
const weeksToShow = 52;
const calendarStart = new Date(2024, 9, 1);  // Oct 1, 2024
const cellSize = 375 / 7;  // Based on mobile width
```

## Code Conventions

### Timestamps
Use `makeTimestamp(year, month, day, hour, minute)` for consistency:
```javascript
makeTimestamp(2025, 0, 17, 14, 30)  // Jan 17, 2025 at 2:30 PM
```

### Class Naming
- `.location-{name}` - Location-specific color variables
- `.travel-segment` - Animated travel background
- `.fading-segment` - Gradient transition
- `.travel-icon` - Interactive icon wrapper

### DOM Structure
```html
<div class="calendar-grid">
    <div class="day-cell">
        <span class="day-number">1</span>
    </div>
    <!-- More cells... -->
</div>
<div class="segment-container">
    <div class="continuous-fill location-paris"></div>
</div>
<div class="icon-container">
    <div class="travel-icon"></div>
</div>
```

## Future Considerations

- Hot-loading weeks on scroll (currently loads all 52 at once)
- Data persistence (currently hardcoded sample data)
- Click handlers for travel icons (expand trip details)
- Responsive sizing for different screen sizes
- Month labels positioned absolutely

## Critical Reminders

1. **Never think in discrete days** - Everything is timestamp-based
2. **Gradients span multiple segments** - Calculate per-segment percentages
3. **Transparent cells are essential** - Grid is just an overlay
4. **Month indexing starts at 0** - January = 0, not 1
5. **Z-index matters** - Timeline at 0, grid at 1, icons at 10
