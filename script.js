// ============================================================
// Constants
// ============================================================
const CELL_SIZE = 375 / 7;           // ~53.57px, square cells
const CHUNK_WEEKS = 4;               // Weeks per chunk
const CHUNK_DAYS = CHUNK_WEEKS * 7;  // Days per chunk
const BUFFER_PX = 600;               // Extend when this close to edge
const MAX_CHUNKS = 40;               // Max chunks in DOM before pruning

// Fixed epoch: a known Sunday used as absolute row=0 reference
// This never changes — all positioning is relative to this
const EPOCH = new Date(2024, 11, 29); // Sun Dec 29, 2024
EPOCH.setHours(0, 0, 0, 0);

// Transportation modes
const transportModes = {
    car: { icon: '🚗', label: 'Car' },
    plane: { icon: '✈️', label: 'Flight' },
    helicopter: { icon: '🚁', label: 'Helicopter' },
    boat: { icon: '⛵', label: 'Boat' },
    ferry: { icon: '⛴️', label: 'Ferry' },
    train: { icon: '🚆', label: 'Train' },
    taxi: { icon: '🚕', label: 'Taxi' },
    uber: { icon: '🚙', label: 'Uber' }
};

// ============================================================
// Parse helpers
// ============================================================
function parseTimestamp(isoString) {
    const [datePart, timePart] = isoString.split('T');
    const [year, month, day] = datePart.split('-').map(Number);
    if (timePart) {
        const [hours, minutes] = timePart.split(':').map(Number);
        return new Date(year, month - 1, day, hours, minutes).getTime();
    }
    return new Date(year, month - 1, day).getTime();
}

// ============================================================
// Calendar State
// ============================================================
const CalendarState = {
    // Rendered range in absolute week offsets from EPOCH
    renderedStartWeek: 0,
    renderedEndWeek: 0,

    // The pixel offset: absolute week 0 maps to this y-pixel in the canvas
    // When we prepend, we increase this and shift scrollTop
    originY: 0,

    // Chunks in DOM, keyed by chunkIndex (chunkIndex = Math.floor(weekOffset / CHUNK_WEEKS))
    chunks: new Map(),

    // Parsed data
    events: [],      // sorted parsed events
    stays: [],       // derived stay segments
    travel: [],      // derived travel segments
    gaps: [],        // derived gap periods (undefined)
    locations: [],
    locationMap: {},
    fadeHours: 48,

    // DOM refs (set during init)
    canvas: null,
    viewport: null,
};

// ============================================================
// Data Provider
// ============================================================
const DataProvider = {
    _data: null,
    _derived: null,

    init() {
        this._data = CALENDAR_DATA;
        this._derived = null;
    },

    getLocations() {
        return this._data.locations;
    },

    getConfig() {
        return this._data.config;
    },

    _derive() {
        if (this._derived) return this._derived;

        // Parse and sort events by arrive time
        const events = this._data.events.map(e => ({
            id: e.id,
            location: e.location,
            arrive: parseTimestamp(e.arrive),
            depart: e.depart ? parseTimestamp(e.depart) : null,
            travel: e.travel || null,
        })).sort((a, b) => a.arrive - b.arrive);

        // Validate
        for (let i = 0; i < events.length; i++) {
            const e = events[i];
            if (e.depart !== null && e.depart < e.arrive) {
                console.warn(`Event ${e.id}: depart before arrive`);
            }
            if (i > 0) {
                const prev = events[i - 1];
                const prevEnd = prev.depart || prev.arrive;
                // Check travel doesn't overlap previous event
                let thisStart = e.arrive;
                if (e.travel && e.travel.legs && e.travel.legs.length > 0) {
                    const travelDuration = e.travel.legs.reduce((s, l) => s + l.duration, 0) * 60 * 1000;
                    thisStart = e.arrive - travelDuration;
                }
                if (thisStart < prevEnd) {
                    console.warn(`Event ${e.id}: overlaps with ${prev.id}`);
                }
            }
        }

        // Build travel segments
        const travel = [];
        events.forEach(e => {
            if (e.travel && e.travel.legs && e.travel.legs.length > 0) {
                const totalMin = e.travel.legs.reduce((s, l) => s + l.duration, 0);
                const travelStart = e.arrive - totalMin * 60 * 1000;
                travel.push({
                    eventId: e.id,
                    start: travelStart,
                    end: e.arrive,
                    location: e.location,
                    legs: e.travel.legs,
                });
            }
        });

        // Build stays: each event → a stay from arrive to effective end
        const stays = [];
        for (let i = 0; i < events.length; i++) {
            const e = events[i];
            let stayEnd;

            if (e.depart !== null) {
                stayEnd = e.depart;
            } else if (i < events.length - 1) {
                // Extend to next event's travel start or arrive
                const next = events[i + 1];
                const nextTravel = travel.find(t => t.eventId === next.id);
                stayEnd = nextTravel ? nextTravel.start : next.arrive;
            } else {
                // Last event with no depart: zero-length (fade-out starts from arrive)
                stayEnd = e.arrive;
            }

            if (stayEnd > e.arrive) {
                stays.push({
                    location: e.location,
                    start: e.arrive,
                    end: stayEnd,
                });
            }
        }

        // Build gaps: undefined periods between events
        const gaps = [];
        for (let i = 0; i < events.length - 1; i++) {
            const e = events[i];
            const next = events[i + 1];
            const gapStart = e.depart || e.arrive;
            const nextTravel = travel.find(t => t.eventId === next.id);
            const gapEnd = nextTravel ? nextTravel.start : next.arrive;
            if (gapEnd > gapStart) {
                gaps.push({ start: gapStart, end: gapEnd });
            }
        }

        this._derived = { events, stays, travel, gaps };
        return this._derived;
    },

    loadAll() {
        return this._derive();
    }
};

// ============================================================
// Grid Position (absolute, relative to EPOCH)
// ============================================================
function getGridPosition(timestamp) {
    const msPerDay = 24 * 60 * 60 * 1000;
    const daysFromEpoch = Math.floor((timestamp - EPOCH.getTime()) / msPerDay);

    const dayDate = new Date(EPOCH);
    dayDate.setDate(dayDate.getDate() + daysFromEpoch);
    dayDate.setHours(0, 0, 0, 0);

    const nextDay = new Date(dayDate);
    nextDay.setDate(nextDay.getDate() + 1);
    nextDay.setHours(0, 0, 0, 0);

    const dayFraction = Math.max(0, Math.min(1,
        (timestamp - dayDate.getTime()) / (nextDay.getTime() - dayDate.getTime())
    ));

    const row = Math.floor(daysFromEpoch / 7);
    const col = ((daysFromEpoch % 7) + 7) % 7; // always 0-6

    return { row, col, dayIndex: daysFromEpoch, dayFraction };
}

// Convert absolute row to pixel Y in the canvas
function rowToY(absoluteRow) {
    return CalendarState.originY + absoluteRow * CELL_SIZE;
}

// Convert absolute col to pixel X
function colToX(col) {
    return col * CELL_SIZE;
}

// Get the date for a given dayIndex from epoch
function dateFromDayIndex(dayIndex) {
    const d = new Date(EPOCH);
    d.setDate(d.getDate() + dayIndex);
    d.setHours(0, 0, 0, 0);
    return d;
}

// Get timestamp for start of a week offset
function weekToTimestamp(weekOffset) {
    const d = new Date(EPOCH);
    d.setDate(d.getDate() + weekOffset * 7);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
}

// ============================================================
// Rendering helpers
// ============================================================

// Create an absolutely positioned element
function createPositionedDiv(className, left, top, width, height) {
    const el = document.createElement('div');
    el.className = className;
    el.style.position = 'absolute';
    el.style.left = left + 'px';
    el.style.top = top + 'px';
    el.style.width = width + 'px';
    el.style.height = height + 'px';
    return el;
}

// Render day cells for a range of day indices
function renderDayCells(container, startDayIndex, numDays) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayTime = today.getTime();

    for (let i = 0; i < numDays; i++) {
        const dayIndex = startDayIndex + i;
        const row = Math.floor(dayIndex / 7);
        const col = ((dayIndex % 7) + 7) % 7;
        const date = dateFromDayIndex(dayIndex);

        const cell = createPositionedDiv('day-cell',
            colToX(col), rowToY(row), CELL_SIZE, CELL_SIZE);

        const dayOfMonth = date.getDate();
        const monthAbbr = date.toLocaleString('default', { month: 'short' });
        const dayNumber = document.createElement('div');
        dayNumber.className = 'day-number';

        if (date.getTime() === todayTime) {
            dayNumber.classList.add('today');
        }

        dayNumber.textContent = dayOfMonth === 1 ? `${dayOfMonth} ${monthAbbr}` : dayOfMonth;
        cell.appendChild(dayNumber);
        container.appendChild(cell);
    }
}

// Render a continuous segment (stay/trip/undefined) across rows, clipped to a time range
function renderSegment(container, start, end, className, additionalClasses, clipStart, clipEnd) {
    const clippedStart = Math.max(start, clipStart);
    const clippedEnd = Math.min(end, clipEnd);
    if (clippedStart >= clippedEnd) return [];

    const startPos = getGridPosition(clippedStart);
    const endPos = getGridPosition(clippedEnd);
    const segments = [];

    for (let row = startPos.row; row <= endPos.row; row++) {
        const isFirstRow = (row === startPos.row);
        const isLastRow = (row === endPos.row);

        const startCol = isFirstRow ? startPos.col + startPos.dayFraction : 0;
        const endCol = isLastRow ? endPos.col + endPos.dayFraction : 7;

        const left = colToX(startCol);
        const width = (endCol - startCol) * CELL_SIZE;
        const top = rowToY(row);

        const seg = createPositionedDiv(
            [className, ...additionalClasses].join(' '),
            left, top, width, CELL_SIZE
        );
        segments.push(seg);
        container.appendChild(seg);
    }
    return segments;
}

// Render stay segments for a time range
function renderStays(container, stays, clipStart, clipEnd) {
    stays.forEach(stay => {
        if (stay.end <= clipStart || stay.start >= clipEnd) return;
        renderSegment(container, stay.start, stay.end,
            'continuous-fill', [`location-${stay.location}`], clipStart, clipEnd);
    });
}

// Render travel segments for a time range
function renderTravel(container, travel, clipStart, clipEnd) {
    travel.forEach(t => {
        if (t.end <= clipStart || t.start >= clipEnd) return;
        renderSegment(container, t.start, t.end,
            'continuous-fill', ['travel-segment'], clipStart, clipEnd);
    });
}

// Render undefined periods (before first event, after last event, and gaps between events)
function renderUndefined(container, clipStart, clipEnd) {
    const { events, gaps, fadeHours } = CalendarState;
    const fadeDuration = fadeHours * 60 * 60 * 1000;

    if (events.length === 0) {
        renderSegment(container, clipStart, clipEnd,
            'continuous-fill', ['location-undefined'], clipStart, clipEnd);
        return;
    }

    // Before first event (minus fade-in zone)
    const firstEvent = events[0];
    const firstTravelStart = CalendarState.travel.length > 0 && CalendarState.travel[0].eventId === firstEvent.id
        ? CalendarState.travel[0].start : firstEvent.arrive;
    const fadeInStart = firstTravelStart - fadeDuration;

    if (clipStart < fadeInStart) {
        renderSegment(container, clipStart, fadeInStart,
            'continuous-fill', ['location-undefined'], clipStart, clipEnd);
    }

    // After last event (plus fade-out zone)
    const lastEvent = events[events.length - 1];
    const lastEnd = lastEvent.depart || lastEvent.arrive;
    const fadeOutEnd = lastEnd + fadeDuration;

    if (clipEnd > fadeOutEnd) {
        renderSegment(container, fadeOutEnd, clipEnd,
            'continuous-fill', ['location-undefined'], clipStart, clipEnd);
    }

    // Gaps between events
    gaps.forEach(gap => {
        if (gap.end <= clipStart || gap.start >= clipEnd) return;
        renderSegment(container, gap.start, gap.end,
            'continuous-fill', ['location-undefined'], clipStart, clipEnd);
    });
}

// Render fade-in gradient before first event
function renderFadeIn(container, clipStart, clipEnd) {
    const { events, fadeHours } = CalendarState;
    if (events.length === 0) return;

    const firstEvent = events[0];
    // Fade into the first event's travel start or arrive
    const firstTravel = CalendarState.travel.find(t => t.eventId === firstEvent.id);
    const fadeInEnd = firstTravel ? firstTravel.start : firstEvent.arrive;
    const fadeInStart = fadeInEnd - (fadeHours * 60 * 60 * 1000);
    const fadeInDuration = fadeInEnd - fadeInStart;

    if (fadeInEnd <= clipStart || fadeInStart >= clipEnd) return;

    const clippedStart = Math.max(fadeInStart, clipStart);
    const clippedEnd = Math.min(fadeInEnd, clipEnd);
    const startPos = getGridPosition(clippedStart);
    const endPos = getGridPosition(clippedEnd);
    const locColor = getLocationColor(firstEvent.location);
    const grayColor = '#3a3a3a';

    for (let row = startPos.row; row <= endPos.row; row++) {
        const isFirstRow = (row === startPos.row);
        const isLastRow = (row === endPos.row);

        const startCol = isFirstRow ? startPos.col + startPos.dayFraction : 0;
        const endCol = isLastRow ? endPos.col + endPos.dayFraction : 7;

        const left = colToX(startCol);
        const width = (endCol - startCol) * CELL_SIZE;
        const top = rowToY(row);

        const seg = createPositionedDiv('continuous-fill',
            left, top, width, CELL_SIZE);

        const segStartTime = isFirstRow ? clippedStart : weekToTimestamp(row);
        const segEndTime = isLastRow ? clippedEnd : weekToTimestamp(row + 1);

        // t=0 is gray, t=1 is full location color
        const tStart = Math.max(0, (segStartTime - fadeInStart) / fadeInDuration);
        const tEnd = Math.min(1, (segEndTime - fadeInStart) / fadeInDuration);

        const colorStart = lerpColor(grayColor, locColor, tStart);
        const colorEnd = lerpColor(grayColor, locColor, tEnd);

        seg.style.background = `linear-gradient(to right, ${colorStart}, ${colorEnd})`;
        seg.style.opacity = '0.85';
        container.appendChild(seg);
    }
}

// Render fade-out gradient after last event
function renderFadeOut(container, clipStart, clipEnd) {
    const { events, fadeHours } = CalendarState;
    if (events.length === 0) return;

    const lastEvent = events[events.length - 1];
    const fadeOutStart = lastEvent.depart || lastEvent.arrive;
    const fadeOutEnd = fadeOutStart + (fadeHours * 60 * 60 * 1000);
    const fadeOutDuration = fadeOutEnd - fadeOutStart;

    if (fadeOutDuration <= 0 || fadeOutEnd <= clipStart || fadeOutStart >= clipEnd) return;

    const clippedStart = Math.max(fadeOutStart, clipStart);
    const clippedEnd = Math.min(fadeOutEnd, clipEnd);
    const startPos = getGridPosition(clippedStart);
    const endPos = getGridPosition(clippedEnd);
    const locColor = getLocationColor(lastEvent.location);
    const grayColor = '#3a3a3a';

    for (let row = startPos.row; row <= endPos.row; row++) {
        const isFirstRow = (row === startPos.row);
        const isLastRow = (row === endPos.row);

        const startCol = isFirstRow ? startPos.col + startPos.dayFraction : 0;
        const endCol = isLastRow ? endPos.col + endPos.dayFraction : 7;

        const left = colToX(startCol);
        const width = (endCol - startCol) * CELL_SIZE;
        const top = rowToY(row);

        const seg = createPositionedDiv('continuous-fill',
            left, top, width, CELL_SIZE);

        const segStartTime = isFirstRow ? clippedStart : weekToTimestamp(row);
        const segEndTime = isLastRow ? clippedEnd : weekToTimestamp(row + 1);

        // t=0 is full location color, t=1 is gray
        const tStart = Math.max(0, (segStartTime - fadeOutStart) / fadeOutDuration);
        const tEnd = Math.min(1, (segEndTime - fadeOutStart) / fadeOutDuration);

        const colorStart = lerpColor(locColor, grayColor, tStart);
        const colorEnd = lerpColor(locColor, grayColor, tEnd);

        seg.style.background = `linear-gradient(to right, ${colorStart}, ${colorEnd})`;
        seg.style.opacity = '0.85';
        container.appendChild(seg);
    }
}

// Render location labels for a time range
function renderLabels(container, stays, clipStart, clipEnd) {
    const { locationMap } = CalendarState;
    const minColsForCentered = 1.5;

    stays.forEach(stay => {
        if (stay.end <= clipStart || stay.start >= clipEnd) return;
        const loc = locationMap[stay.location];
        if (!loc) return;

        const clippedStart = Math.max(stay.start, clipStart);
        const clippedEnd = Math.min(stay.end, clipEnd);
        const startPos = getGridPosition(clippedStart);
        const endPos = getGridPosition(clippedEnd);

        for (let row = startPos.row; row <= endPos.row; row++) {
            const isFirstRow = (row === startPos.row);
            const isLastRow = (row === endPos.row);

            const startCol = isFirstRow ? startPos.col + startPos.dayFraction : 0;
            const endCol = isLastRow ? endPos.col + endPos.dayFraction : 7;
            const colSpan = endCol - startCol;

            const isNarrow = colSpan < minColsForCentered;

            const label = createPositionedDiv(
                'location-label' + (isNarrow ? ' location-label-narrow' : ''),
                colToX(startCol), rowToY(row), colSpan * CELL_SIZE, CELL_SIZE
            );
            label.textContent = loc.label;
            container.appendChild(label);
        }
    });
}

// Render travel icons for a time range
function renderTravelIcons(container, travel, clipStart, clipEnd) {
    travel.forEach(t => {
        if (t.end <= clipStart || t.start >= clipEnd) return;

        const center = (t.start + t.end) / 2;
        if (center < clipStart || center >= clipEnd) return;

        const centerPos = getGridPosition(center);

        const icon = document.createElement('div');
        icon.className = 'travel-icon';
        icon.innerHTML = '<i data-lucide="plus"></i>';
        icon.style.position = 'absolute';
        icon.style.left = colToX(centerPos.col + centerPos.dayFraction) + 'px';
        icon.style.top = (rowToY(centerPos.row) + CELL_SIZE / 2) + 'px';
        icon.addEventListener('click', (e) => {
            e.stopPropagation();
            openTravelPanel(t);
        });

        container.appendChild(icon);
    });
}

// ============================================================
// Chunk rendering
// ============================================================
function getChunkIndex(weekOffset) {
    return Math.floor(weekOffset / CHUNK_WEEKS);
}

function renderChunk(chunkIndex) {
    if (CalendarState.chunks.has(chunkIndex)) return; // Already rendered

    const startWeek = chunkIndex * CHUNK_WEEKS;
    const startDayIndex = startWeek * 7;
    const chunkStartTime = weekToTimestamp(startWeek);
    const chunkEndTime = weekToTimestamp(startWeek + CHUNK_WEEKS);

    const fragment = document.createDocumentFragment();

    // Background fill for the chunk area (dark gray base)
    const bgStartRow = startWeek;
    for (let w = 0; w < CHUNK_WEEKS; w++) {
        const row = startWeek + w;
        const bg = createPositionedDiv('chunk-bg', 0, rowToY(row), 375, CELL_SIZE);
        fragment.appendChild(bg);
    }

    // Render layers in z-order: undefined → fades → stays → travel → labels → day cells → icons
    renderUndefined(fragment, chunkStartTime, chunkEndTime);
    renderFadeIn(fragment, chunkStartTime, chunkEndTime);
    renderFadeOut(fragment, chunkStartTime, chunkEndTime);
    renderStays(fragment, CalendarState.stays, chunkStartTime, chunkEndTime);
    renderTravel(fragment, CalendarState.travel, chunkStartTime, chunkEndTime);
    renderLabels(fragment, CalendarState.stays, chunkStartTime, chunkEndTime);
    renderDayCells(fragment, startDayIndex, CHUNK_DAYS);
    renderTravelIcons(fragment, CalendarState.travel, chunkStartTime, chunkEndTime);

    // Wrap in a container div for easy removal
    const chunkEl = document.createElement('div');
    chunkEl.className = 'chunk';
    chunkEl.dataset.chunkIndex = chunkIndex;
    chunkEl.appendChild(fragment);

    CalendarState.canvas.appendChild(chunkEl);
    CalendarState.chunks.set(chunkIndex, chunkEl);

    // Initialize lucide icons for this chunk only
    lucide.createIcons({ nameAttr: 'data-lucide', nodes: chunkEl.querySelectorAll('[data-lucide]') });
}

function removeChunk(chunkIndex) {
    const el = CalendarState.chunks.get(chunkIndex);
    if (el) {
        el.remove();
        CalendarState.chunks.delete(chunkIndex);
    }
}

// ============================================================
// Canvas size management
// ============================================================
function updateCanvasSize() {
    const totalRows = CalendarState.renderedEndWeek - CalendarState.renderedStartWeek;
    const height = rowToY(CalendarState.renderedEndWeek) - rowToY(CalendarState.renderedStartWeek);
    // The canvas top corresponds to renderedStartWeek
    // We use originY to map absolute rows to canvas pixels
    CalendarState.canvas.style.height = (rowToY(CalendarState.renderedEndWeek)) + 'px';
}

// ============================================================
// Scroll extension
// ============================================================
function extendForward(numWeeks) {
    const newEndWeek = CalendarState.renderedEndWeek + numWeeks;
    const startChunk = getChunkIndex(CalendarState.renderedEndWeek);
    const endChunk = getChunkIndex(newEndWeek - 1);

    for (let ci = startChunk; ci <= endChunk; ci++) {
        renderChunk(ci);
    }

    CalendarState.renderedEndWeek = newEndWeek;
    updateCanvasSize();
}

function extendBackward(numWeeks) {
    const newStartWeek = CalendarState.renderedStartWeek - numWeeks;
    const addedHeight = numWeeks * CELL_SIZE;

    // Shift origin so existing elements stay in place visually
    CalendarState.originY += addedHeight;

    // Shift existing chunks via transform (avoids restarting CSS animations)
    CalendarState.chunks.forEach((chunkEl) => {
        const current = parseFloat(chunkEl.dataset.shiftY || '0');
        const newShift = current + addedHeight;
        chunkEl.style.transform = `translateY(${newShift}px)`;
        chunkEl.dataset.shiftY = newShift;
    });

    // Render new chunks
    const startChunk = getChunkIndex(newStartWeek);
    const endChunk = getChunkIndex(CalendarState.renderedStartWeek - 1);

    for (let ci = startChunk; ci <= endChunk; ci++) {
        renderChunk(ci);
    }

    CalendarState.renderedStartWeek = newStartWeek;
    updateCanvasSize();

    // Compensate scroll position
    CalendarState.viewport.scrollTop += addedHeight;
}

// Prune chunks that are far from viewport
function pruneDistantChunks() {
    if (CalendarState.chunks.size <= MAX_CHUNKS) return;

    const scrollTop = CalendarState.viewport.scrollTop;
    const viewportHeight = CalendarState.viewport.clientHeight;
    const viewCenter = scrollTop + viewportHeight / 2;

    // Find which row is at center
    const centerRow = Math.floor(viewCenter / CELL_SIZE);

    // Sort chunks by distance from center
    const sorted = [...CalendarState.chunks.entries()].sort((a, b) => {
        const aCenterRow = a[0] * CHUNK_WEEKS + CHUNK_WEEKS / 2;
        const bCenterRow = b[0] * CHUNK_WEEKS + CHUNK_WEEKS / 2;
        return Math.abs(bCenterRow - centerRow) - Math.abs(aCenterRow - centerRow);
    });

    // Remove the most distant chunks
    while (sorted.length > MAX_CHUNKS) {
        const [chunkIndex] = sorted.shift();
        removeChunk(chunkIndex);
    }

    // Update rendered range
    const remaining = [...CalendarState.chunks.keys()].sort((a, b) => a - b);
    if (remaining.length > 0) {
        CalendarState.renderedStartWeek = remaining[0] * CHUNK_WEEKS;
        CalendarState.renderedEndWeek = (remaining[remaining.length - 1] + 1) * CHUNK_WEEKS;
    }
}

// ============================================================
// Scroll handler
// ============================================================
let scrollRAF = null;

function handleScroll() {
    const { viewport } = CalendarState;
    const scrollTop = viewport.scrollTop;
    const viewportHeight = viewport.clientHeight;
    const canvasHeight = parseFloat(CalendarState.canvas.style.height) || 0;

    // Extend forward
    if (scrollTop + viewportHeight > canvasHeight - BUFFER_PX) {
        extendForward(CHUNK_WEEKS);
    }

    // Extend backward
    if (scrollTop < BUFFER_PX) {
        extendBackward(CHUNK_WEEKS);
    }

    // Prune if too many chunks
    pruneDistantChunks();
}

// ============================================================
// Drag scroll (mobile-style)
// ============================================================
function setupDragScroll(viewport) {
    let isDragging = false;
    let lastY = 0;

    viewport.addEventListener('mousedown', (e) => {
        isDragging = true;
        lastY = e.clientY;
        viewport.style.cursor = 'grabbing';
    });

    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        const deltaY = lastY - e.clientY;
        lastY = e.clientY;
        viewport.scrollTop += deltaY;
    });

    document.addEventListener('mouseup', () => {
        isDragging = false;
        viewport.style.cursor = 'default';
    });

    viewport.addEventListener('selectstart', (e) => {
        if (isDragging) e.preventDefault();
    });
}

// ============================================================
// Trip Detail Panel
// ============================================================
function createTripPanel() {
    const container = document.querySelector('.mobile-container');

    const backdrop = document.createElement('div');
    backdrop.className = 'trip-backdrop';
    backdrop.addEventListener('click', closeTripPanel);

    const panel = document.createElement('div');
    panel.className = 'trip-panel';
    panel.innerHTML = `
        <div class="trip-panel-handle"></div>
        <div class="trip-panel-header">
            <div class="trip-panel-route" id="tripPanelRoute"></div>
            <button class="trip-panel-close" id="tripPanelClose">&times;</button>
        </div>
        <div class="trip-panel-time" id="tripPanelTime"></div>
        <div class="trip-panel-legs" id="tripPanelLegs"></div>
    `;

    container.appendChild(backdrop);
    container.appendChild(panel);

    panel.querySelector('#tripPanelClose').addEventListener('click', closeTripPanel);

    CalendarState.tripPanel = panel;
    CalendarState.tripBackdrop = backdrop;
}

function formatDuration(minutes) {
    if (minutes < 60) return `${minutes}min`;
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m > 0 ? `${h}h ${m}min` : `${h}h`;
}

function formatTime(timestamp) {
    const d = new Date(timestamp);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const hours = d.getHours();
    const mins = d.getMinutes().toString().padStart(2, '0');
    const ampm = hours >= 12 ? 'PM' : 'AM';
    const h = hours % 12 || 12;
    return `${months[d.getMonth()]} ${d.getDate()}, ${h}:${mins} ${ampm}`;
}

function lerpColor(hex1, hex2, t) {
    const r1 = parseInt(hex1.slice(1, 3), 16), g1 = parseInt(hex1.slice(3, 5), 16), b1 = parseInt(hex1.slice(5, 7), 16);
    const r2 = parseInt(hex2.slice(1, 3), 16), g2 = parseInt(hex2.slice(3, 5), 16), b2 = parseInt(hex2.slice(5, 7), 16);
    const r = Math.round(r1 + (r2 - r1) * t), g = Math.round(g1 + (g2 - g1) * t), b = Math.round(b1 + (b2 - b1) * t);
    return `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`;
}

function getLocationColor(name) {
    const loc = CalendarState.locationMap[name];
    if (loc) return loc.color;
    // Fall back to CSS variable values
    const colors = {
        paris: '#C66B6B', tokyo: '#8B6FB8',
        beach: '#5AB89E', mountains: '#B8895B', lake: '#6BC6E8'
    };
    return colors[name] || '#666';
}

function getLocationLabel(name) {
    const loc = CalendarState.locationMap[name];
    return loc ? loc.label : name.charAt(0).toUpperCase() + name.slice(1);
}

function openTravelPanel(travelSeg) {
    const { tripPanel, tripBackdrop } = CalendarState;

    // Header: → destination with color dot
    const routeEl = tripPanel.querySelector('#tripPanelRoute');
    routeEl.innerHTML = `
        <span class="route-arrow">→</span>
        <span class="route-dot" style="background: ${getLocationColor(travelSeg.location)}"></span>
        ${getLocationLabel(travelSeg.location)}
    `;

    // Time subtitle
    const timeEl = tripPanel.querySelector('#tripPanelTime');
    timeEl.textContent = `${formatTime(travelSeg.start)}  →  ${formatTime(travelSeg.end)}`;

    // Build leg timeline
    const legsEl = tripPanel.querySelector('#tripPanelLegs');
    legsEl.innerHTML = '';

    travelSeg.legs.forEach(leg => {
        const mode = transportModes[leg.mode] || { icon: '📍', label: leg.mode };
        const legEl = document.createElement('div');
        legEl.className = 'trip-leg';
        legEl.innerHTML = `
            <div class="trip-leg-icon">${mode.icon}</div>
            <div class="trip-leg-info">
                <div class="trip-leg-note">${leg.note}</div>
                <div class="trip-leg-duration">${formatDuration(leg.duration)}</div>
            </div>
        `;
        legsEl.appendChild(legEl);
    });

    // Open
    tripBackdrop.classList.add('open');
    tripPanel.classList.add('open');
}

function closeTripPanel() {
    CalendarState.tripBackdrop.classList.remove('open');
    CalendarState.tripPanel.classList.remove('open');
}

// ============================================================
// Initialize
// ============================================================
function initCalendar() {
    DataProvider.init();

    const config = DataProvider.getConfig();
    const locations = DataProvider.getLocations();
    const { events, stays, travel, gaps } = DataProvider.loadAll();

    // Populate state
    CalendarState.events = events;
    CalendarState.stays = stays;
    CalendarState.travel = travel;
    CalendarState.gaps = gaps;
    CalendarState.locations = locations;
    CalendarState.locationMap = Object.fromEntries(locations.map(l => [l.name, l]));
    CalendarState.fadeHours = config.fadeHours;
    CalendarState.canvas = document.getElementById('calendarCanvas');
    CalendarState.viewport = document.getElementById('calendarViewport');

    // Create trip detail panel
    createTripPanel();

    // Calculate initial range: 13 weeks back from today + 52 weeks forward
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayPos = getGridPosition(today.getTime());
    const todayWeek = todayPos.row; // absolute week from epoch

    const initialStartWeek = todayWeek - 13;
    const initialEndWeek = todayWeek + 52;

    // Set origin so renderedStartWeek maps to top=0 in canvas
    CalendarState.originY = -initialStartWeek * CELL_SIZE;
    CalendarState.renderedStartWeek = initialStartWeek;
    CalendarState.renderedEndWeek = initialStartWeek; // will be extended

    // Render initial chunks
    const startChunk = getChunkIndex(initialStartWeek);
    const endChunk = getChunkIndex(initialEndWeek - 1);
    for (let ci = startChunk; ci <= endChunk; ci++) {
        renderChunk(ci);
    }
    CalendarState.renderedEndWeek = (endChunk + 1) * CHUNK_WEEKS;
    updateCanvasSize();

    // Scroll to today
    const todayY = rowToY(todayWeek);
    const viewportHeight = CalendarState.viewport.clientHeight;
    CalendarState.viewport.scrollTop = todayY - viewportHeight / 2 + CELL_SIZE / 2;

    // Set up scroll handler
    CalendarState.viewport.addEventListener('scroll', () => {
        if (scrollRAF) return;
        scrollRAF = requestAnimationFrame(() => {
            handleScroll();
            scrollRAF = null;
        });
    }, { passive: true });

    // Set up drag scroll
    setupDragScroll(CalendarState.viewport);

    console.log('Calendar initialized: weeks', initialStartWeek, 'to', initialEndWeek,
        `(${CalendarState.chunks.size} chunks)`);
}

initCalendar();
