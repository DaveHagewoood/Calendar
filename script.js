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

    // Interaction state
    wasDrag: false,

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
            estimated: e.estimated || [],
        })).sort((a, b) => a.arrive - b.arrive);

        // Validate
        for (let i = 0; i < events.length; i++) {
            const e = events[i];
            if (e.depart !== null && e.depart < e.arrive) {
                console.warn(`Event ${e.id}: depart before arrive`);
            }
            if (i > 0) {
                const prev = events[i - 1];
                // Use end-of-day if no depart set
                let prevEnd;
                if (prev.depart !== null) {
                    prevEnd = prev.depart;
                } else {
                    const pd = new Date(prev.arrive);
                    prevEnd = new Date(pd.getFullYear(), pd.getMonth(), pd.getDate(), 23, 59, 59).getTime();
                }
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
            const estimated = [...e.estimated];

            if (e.depart !== null) {
                stayEnd = e.depart;
            } else {
                // No departure set — default to end of arrival day
                const arriveDate = new Date(e.arrive);
                stayEnd = new Date(arriveDate.getFullYear(), arriveDate.getMonth(), arriveDate.getDate(), 23, 59, 59).getTime();
                if (!estimated.includes('depart')) {
                    estimated.push('depart');
                }
            }

            if (stayEnd > e.arrive) {
                stays.push({
                    location: e.location,
                    start: e.arrive,
                    end: stayEnd,
                    estimated: estimated,
                });
            }
        }

        // Build gaps: undefined periods between events
        const gaps = [];
        for (let i = 0; i < events.length - 1; i++) {
            const e = events[i];
            const next = events[i + 1];
            // Use derived stay end for gap start
            const stay = stays.find(s => s.start === e.arrive);
            const gapStart = stay ? stay.end : e.arrive;
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

        // Click handler for undefined days
        const dayTime = date.getTime();
        cell.addEventListener('click', () => {
            if (CalendarState.wasDrag) return;
            if (isUndefinedTime(dayTime)) {
                openEventPanel(date);
            }
        });

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
        const classes = [`location-${stay.location}`];
        if (stay.estimated && stay.estimated.length > 0) {
            classes.push('estimated-segment');
        }
        renderSegment(container, stay.start, stay.end,
            'continuous-fill', classes, clipStart, clipEnd);
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

    // After last event
    const lastEvent = events[events.length - 1];
    const lastStay = CalendarState.stays.find(s => s.start === lastEvent.arrive);
    const lastEnd = lastStay ? lastStay.end : lastEvent.arrive;
    const hasConfirmedDepart = lastEvent.depart !== null && !lastEvent.estimated.includes('depart');
    const undefinedStart = hasConfirmedDepart ? lastEnd + fadeDuration : lastEnd;

    if (clipEnd > undefinedStart) {
        renderSegment(container, undefinedStart, clipEnd,
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

// Render fade-out gradient after last event (only if depart is confirmed)
function renderFadeOut(container, clipStart, clipEnd) {
    const { events, fadeHours } = CalendarState;
    if (events.length === 0) return;

    const lastEvent = events[events.length - 1];
    // Don't fade out from estimated/missing depart — the stay just ends
    if (lastEvent.depart === null || lastEvent.estimated.includes('depart')) return;
    const fadeOutStart = lastEvent.depart;
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
    let totalDragDistance = 0;

    viewport.addEventListener('mousedown', (e) => {
        isDragging = true;
        lastY = e.clientY;
        totalDragDistance = 0;
        viewport.style.cursor = 'grabbing';
    });

    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        const deltaY = lastY - e.clientY;
        lastY = e.clientY;
        totalDragDistance += Math.abs(deltaY);
        viewport.scrollTop += deltaY;
    });

    document.addEventListener('mouseup', () => {
        CalendarState.wasDrag = totalDragDistance > 5;
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

// Check if a timestamp falls in an undefined period (not in any stay, travel, or fade)
function isUndefinedTime(timestamp) {
    const { events, stays, travel } = CalendarState;
    // In a stay?
    for (const s of stays) {
        if (timestamp >= s.start && timestamp < s.end) return false;
    }
    // In travel?
    for (const t of travel) {
        if (timestamp >= t.start && timestamp < t.end) return false;
    }
    // In fade-in zone?
    if (events.length > 0) {
        const firstTravel = travel.find(t => t.eventId === events[0].id);
        const fadeInEnd = firstTravel ? firstTravel.start : events[0].arrive;
        const fadeInStart = fadeInEnd - (CalendarState.fadeHours * 60 * 60 * 1000);
        if (timestamp >= fadeInStart && timestamp < fadeInEnd) return false;

        // In fade-out zone? (only if last event has confirmed depart)
        const lastEvent = events[events.length - 1];
        if (lastEvent.depart !== null && !lastEvent.estimated.includes('depart')) {
            const fadeOutStart = lastEvent.depart;
            const fadeOutEnd = fadeOutStart + (CalendarState.fadeHours * 60 * 60 * 1000);
            if (timestamp >= fadeOutStart && timestamp < fadeOutEnd) return false;
        }
    }
    return true;
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
// Event Entry Panel
// ============================================================

// Pending event being created
let pendingEvent = null;

function createEventPanel() {
    const container = document.querySelector('.mobile-container');

    const backdrop = document.createElement('div');
    backdrop.className = 'event-backdrop';
    backdrop.addEventListener('click', closeEventPanel);

    const panel = document.createElement('div');
    panel.className = 'event-panel';
    panel.innerHTML = `
        <div class="trip-panel-handle"></div>
        <div class="event-panel-header">
            <div class="event-panel-title"><span id="eventTripName">New Trip</span><svg class="event-title-edit" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg></div>
            <button class="trip-panel-close" id="eventPanelClose">&times;</button>
        </div>
        <div class="event-panel-body">
            <div class="event-field" id="eventTransportSection">
                <div class="event-field-label">Transportation</div>
                <div id="eventLegsDisplay"></div>
                <div class="event-field-add" id="openChainBuilder">
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 12h8"/><path d="M12 8v8"/></svg>
                    <span>Tap to set transportation</span>
                </div>
                <div class="chain-builder" id="chainBuilder">
                    <div class="chain-preview" id="chainPreview"></div>
                    <div class="chain-modes" id="chainModes"></div>
                    <div class="chain-actions">
                        <button class="leg-cancel-btn" id="chainCancelBtn">Cancel</button>
                        <button class="leg-confirm-btn" id="chainDoneBtn">Done</button>
                    </div>
                </div>
            </div>
            <div class="event-field">
                <div class="event-field-label">Arrival</div>
                <div class="event-field-datetime">
                    <span class="event-field-date event-field-tappable" id="eventArriveDate"></span>
                    <span class="event-field-time event-field-tappable" id="eventArriveTime"></span>
                </div>
                <input type="date" id="eventArriveDateInput" class="hidden-input">
                <div class="time-picker" id="arriveTimePicker"></div>
            </div>
            <div class="event-field" id="eventLocationField">
                <div class="event-field-label">Location</div>
                <div class="event-field-value event-field-empty" id="eventLocationValue">Tap to set destination</div>
                <div class="location-picker" id="locationPicker"></div>
            </div>
            <div class="event-field">
                <div class="event-field-label">Departure</div>
                <div class="event-field-datetime">
                    <span class="event-field-date event-field-tappable" id="eventDepartDate"></span>
                    <span class="event-field-time event-field-tappable" id="eventDepartTime"></span>
                </div>
                <input type="date" id="eventDepartDateInput" class="hidden-input">
                <div class="time-picker" id="departTimePicker"></div>
            </div>
        </div>
        <div class="event-panel-footer">
            <button class="event-save-btn" id="eventSaveBtn" disabled>Save Trip</button>
        </div>
    `;

    container.appendChild(backdrop);
    container.appendChild(panel);

    panel.querySelector('#eventPanelClose').addEventListener('click', closeEventPanel);
    panel.querySelector('#eventLocationField').addEventListener('click', toggleLocationPicker);
    panel.querySelector('#eventSaveBtn').addEventListener('click', saveEvent);

    // Arrival date — native picker; time — custom inline picker
    panel.querySelector('#eventArriveDate').addEventListener('click', () => {
        panel.querySelector('#eventArriveDateInput').showPicker();
    });
    panel.querySelector('#eventArriveTime').addEventListener('click', () => {
        openTimePicker('arriveTimePicker', pendingEvent.arrive, (h, min) => {
            pendingEvent.arrive.setHours(h, min, 0, 0);
            pendingEvent.estimated = pendingEvent.estimated.filter(f => f !== 'arrive');
            updateArriveDisplay();
        });
    });
    panel.querySelector('#eventArriveDateInput').addEventListener('change', (e) => {
        if (!e.target.value || !pendingEvent) return;
        const [y, m, d] = e.target.value.split('-').map(Number);
        pendingEvent.arrive.setFullYear(y, m - 1, d);
        if (pendingEvent.estimated.includes('depart')) {
            pendingEvent.depart = new Date(y, m - 1, d, 23, 0, 0, 0);
        }
        updateArriveDisplay();
        updateDepartDisplay();
    });

    // Departure date — native picker; time — custom inline picker
    panel.querySelector('#eventDepartDate').addEventListener('click', () => {
        panel.querySelector('#eventDepartDateInput').showPicker();
    });
    panel.querySelector('#eventDepartTime').addEventListener('click', () => {
        openTimePicker('departTimePicker', pendingEvent.depart, (h, min) => {
            pendingEvent.depart.setHours(h, min, 0, 0);
            pendingEvent.estimated = pendingEvent.estimated.filter(f => f !== 'depart');
            updateDepartDisplay();
        });
    });
    panel.querySelector('#eventDepartDateInput').addEventListener('change', (e) => {
        if (!e.target.value || !pendingEvent) return;
        const [y, m, d] = e.target.value.split('-').map(Number);
        pendingEvent.depart.setFullYear(y, m - 1, d);
        pendingEvent.estimated = pendingEvent.estimated.filter(f => f !== 'depart');
        updateDepartDisplay();
    });

    // Transportation chain builder
    panel.querySelector('#openChainBuilder').addEventListener('click', () => {
        openChainBuilder();
    });
    panel.querySelector('#chainCancelBtn').addEventListener('click', () => {
        closeChainBuilder();
    });
    panel.querySelector('#chainDoneBtn').addEventListener('click', () => {
        confirmChain();
    });

    CalendarState.eventPanel = panel;
    CalendarState.eventBackdrop = backdrop;
}

// Chain builder state
let chainModes = []; // modes being built in the chain builder

function openChainBuilder() {
    const panel = CalendarState.eventPanel;
    // Initialize chain from existing legs if any
    if (pendingEvent.travel && pendingEvent.travel.legs.length > 0) {
        chainModes = pendingEvent.travel.legs.map(l => l.mode);
    } else {
        chainModes = [];
    }
    buildChainModeButtons();
    updateChainPreview();
    panel.querySelector('#chainBuilder').classList.add('open');
    panel.querySelector('#openChainBuilder').style.display = 'none';
}

function closeChainBuilder() {
    const panel = CalendarState.eventPanel;
    panel.querySelector('#chainBuilder').classList.remove('open');
    panel.querySelector('#openChainBuilder').style.display = '';
    chainModes = [];
}

function buildChainModeButtons() {
    const container = CalendarState.eventPanel.querySelector('#chainModes');
    container.innerHTML = '';
    Object.entries(transportModes).forEach(([key, mode]) => {
        const btn = document.createElement('div');
        btn.className = 'mode-btn';
        btn.innerHTML = `<span class="mode-icon">${mode.icon}</span><span class="mode-label">${mode.label}</span>`;
        btn.addEventListener('click', () => {
            chainModes.push(key);
            updateChainPreview();
        });
        container.appendChild(btn);
    });
}

function updateChainPreview() {
    const preview = CalendarState.eventPanel.querySelector('#chainPreview');
    if (chainModes.length === 0) {
        preview.innerHTML = '<span class="chain-empty">Tap modes below to build your route</span>';
        return;
    }
    preview.innerHTML = chainModes.map((mode, i) => {
        const m = transportModes[mode] || { icon: '📍' };
        const arrow = i < chainModes.length - 1 ? '<span class="chain-arrow">→</span>' : '';
        return `<span class="chain-item" data-index="${i}"><span class="chain-icon">${m.icon}</span><span class="chain-remove" data-index="${i}">×</span></span>${arrow}`;
    }).join('');

    // Wire up remove buttons
    preview.querySelectorAll('.chain-remove').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const idx = parseInt(btn.dataset.index, 10);
            chainModes.splice(idx, 1);
            updateChainPreview();
        });
    });
}

function confirmChain() {
    if (chainModes.length === 0) {
        // Clear travel
        pendingEvent.travel = null;
    } else {
        // Build legs from chain — preserve existing leg details if mode matches
        const oldLegs = (pendingEvent.travel && pendingEvent.travel.legs) || [];
        const newLegs = chainModes.map((mode, i) => {
            // Try to reuse existing leg at same position with same mode
            if (i < oldLegs.length && oldLegs[i].mode === mode) {
                return { ...oldLegs[i] };
            }
            return { mode, duration: 0, note: '' };
        });
        pendingEvent.travel = { legs: newLegs };
    }
    renderLegsDisplay();
    closeChainBuilder();
}

function renderLegsDisplay() {
    const container = CalendarState.eventPanel.querySelector('#eventLegsDisplay');
    container.innerHTML = '';

    if (!pendingEvent.travel || pendingEvent.travel.legs.length === 0) {
        // Update the "tap to set" text
        const addBtn = CalendarState.eventPanel.querySelector('#openChainBuilder span');
        addBtn.textContent = 'Tap to set transportation';
        return;
    }

    // Update button text to "Edit"
    const addBtn = CalendarState.eventPanel.querySelector('#openChainBuilder span');
    addBtn.textContent = 'Edit transportation';

    pendingEvent.travel.legs.forEach((leg, i) => {
        const mode = transportModes[leg.mode] || { icon: '📍', label: leg.mode };
        const hasDuration = leg.duration > 0;
        const hasNote = leg.note && leg.note.length > 0;

        const el = document.createElement('div');
        el.className = 'leg-item leg-item-tappable';
        el.innerHTML = `
            <span class="leg-item-icon">${mode.icon}</span>
            <span class="leg-item-info">
                <span class="leg-item-note ${hasNote ? '' : 'event-field-empty'}">${hasNote ? leg.note : mode.label}</span>
                <span class="leg-item-duration ${hasDuration ? '' : 'event-field-estimated'}">${hasDuration ? formatDuration(leg.duration) : '~duration not set'}</span>
            </span>
        `;
        el.addEventListener('click', () => openLegDetail(i));
        container.appendChild(el);
    });
}

function openLegDetail(index) {
    const leg = pendingEvent.travel.legs[index];
    const mode = transportModes[leg.mode] || { icon: '📍', label: leg.mode };

    // Simple prompt-style inline edit using the chain builder area
    const panel = CalendarState.eventPanel;
    const builder = panel.querySelector('#chainBuilder');

    builder.innerHTML = `
        <div class="leg-detail-header">${mode.icon} ${mode.label}</div>
        <div class="leg-builder-fields">
            <input type="number" class="leg-input leg-duration-input" id="legDetailDuration" placeholder="Minutes" min="1" value="${leg.duration || ''}">
            <input type="text" class="leg-input leg-note-input" id="legDetailNote" placeholder="Note (e.g. SFO → JFK)" value="${leg.note || ''}">
        </div>
        <div class="chain-actions">
            <button class="leg-cancel-btn" id="legDetailCancel">Cancel</button>
            <button class="leg-confirm-btn" id="legDetailSave">Save</button>
        </div>
    `;

    panel.querySelector('#legDetailCancel').addEventListener('click', () => {
        closeLegDetail();
    });
    panel.querySelector('#legDetailSave').addEventListener('click', () => {
        const duration = parseInt(panel.querySelector('#legDetailDuration').value, 10);
        const note = panel.querySelector('#legDetailNote').value.trim();
        if (duration > 0) leg.duration = duration;
        if (note) leg.note = note;
        closeLegDetail();
        renderLegsDisplay();
    });

    builder.classList.add('open');
    panel.querySelector('#openChainBuilder').style.display = 'none';
}

function closeLegDetail() {
    const panel = CalendarState.eventPanel;
    const builder = panel.querySelector('#chainBuilder');
    builder.classList.remove('open');
    panel.querySelector('#openChainBuilder').style.display = '';

    // Restore chain builder HTML for next use
    builder.innerHTML = `
        <div class="chain-preview" id="chainPreview"></div>
        <div class="chain-modes" id="chainModes"></div>
        <div class="chain-actions">
            <button class="leg-cancel-btn" id="chainCancelBtn">Cancel</button>
            <button class="leg-confirm-btn" id="chainDoneBtn">Done</button>
        </div>
    `;
    // Re-wire buttons
    panel.querySelector('#chainCancelBtn').addEventListener('click', () => closeChainBuilder());
    panel.querySelector('#chainDoneBtn').addEventListener('click', () => confirmChain());
}

function buildLocationPicker() {
    const picker = CalendarState.eventPanel.querySelector('#locationPicker');
    picker.innerHTML = '';
    CalendarState.locations.forEach(loc => {
        const opt = document.createElement('div');
        opt.className = 'location-option';
        opt.innerHTML = `<span class="location-dot" style="background:${loc.color}"></span><span>${loc.label}</span>`;
        opt.addEventListener('click', (e) => {
            e.stopPropagation();
            selectLocation(loc);
        });
        picker.appendChild(opt);
    });
}

function closeAllTimePickers() {
    CalendarState.eventPanel.querySelectorAll('.time-picker.open').forEach(p => p.classList.remove('open'));
}

function toggleLocationPicker() {
    closeAllTimePickers();
    const picker = CalendarState.eventPanel.querySelector('#locationPicker');
    picker.classList.toggle('open');
}

function selectLocation(loc) {
    pendingEvent.location = loc.name;

    const valueEl = CalendarState.eventPanel.querySelector('#eventLocationValue');
    valueEl.innerHTML = `<span class="location-dot" style="background:${loc.color}"></span>${loc.label}`;
    valueEl.classList.remove('event-field-empty');

    // Update title to location name (default behavior)
    CalendarState.eventPanel.querySelector('#eventTripName').textContent = loc.label;

    // Close picker and enable save
    CalendarState.eventPanel.querySelector('#locationPicker').classList.remove('open');
    CalendarState.eventPanel.querySelector('#eventSaveBtn').disabled = false;
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function formatDateStr(d) {
    return `${DAY_NAMES[d.getDay()]}, ${MONTH_NAMES[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

function formatTimeStr(d) {
    let h = d.getHours();
    const min = d.getMinutes();
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return `${h}:${String(min).padStart(2, '0')} ${ampm}`;
}

// Custom inline time picker
function openTimePicker(pickerId, currentDate, onSelect) {
    const panel = CalendarState.eventPanel;
    const picker = panel.querySelector(`#${pickerId}`);

    // Close any other open time pickers
    panel.querySelectorAll('.time-picker.open').forEach(p => {
        if (p.id !== pickerId) p.classList.remove('open');
    });

    // Toggle if already open
    if (picker.classList.contains('open')) {
        picker.classList.remove('open');
        return;
    }

    const currentH = currentDate.getHours();
    const currentMin = currentDate.getMinutes();
    const currentAmPm = currentH >= 12 ? 'pm' : 'am';
    const current12 = currentH % 12 || 12;

    // State for selection
    let selectedHour = current12;
    let selectedMinute = currentMin;
    let selectedAmPm = currentAmPm;

    // Build picker content
    picker.innerHTML = `
        <div class="tp-section">
            <div class="tp-label">Hour</div>
            <div class="tp-grid tp-hours">
                ${[12,1,2,3,4,5,6,7,8,9,10,11].map(h =>
                    `<div class="tp-btn${h === current12 ? ' tp-selected' : ''}" data-hour="${h}">${h}</div>`
                ).join('')}
            </div>
        </div>
        <div class="tp-section">
            <div class="tp-label">Minute</div>
            <div class="tp-grid tp-minutes">
                ${[0,5,10,15,20,25,30,35,40,45,50,55].map(m =>
                    `<div class="tp-btn${m === currentMin ? ' tp-selected' : ''}" data-minute="${m}">${String(m).padStart(2,'0')}</div>`
                ).join('')}
            </div>
        </div>
        <div class="tp-section">
            <div class="tp-ampm">
                <div class="tp-btn tp-ampm-btn${currentAmPm === 'am' ? ' tp-selected' : ''}" data-ampm="am">AM</div>
                <div class="tp-btn tp-ampm-btn${currentAmPm === 'pm' ? ' tp-selected' : ''}" data-ampm="pm">PM</div>
            </div>
        </div>
        <div class="tp-done-row">
            <button class="tp-done-btn">Done</button>
        </div>
    `;

    // Hour buttons
    picker.querySelectorAll('[data-hour]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            selectedHour = parseInt(btn.dataset.hour, 10);
            picker.querySelectorAll('.tp-hours .tp-btn').forEach(b => b.classList.remove('tp-selected'));
            btn.classList.add('tp-selected');
        });
    });

    // Minute buttons
    picker.querySelectorAll('[data-minute]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            selectedMinute = parseInt(btn.dataset.minute, 10);
            picker.querySelectorAll('.tp-minutes .tp-btn').forEach(b => b.classList.remove('tp-selected'));
            btn.classList.add('tp-selected');
        });
    });

    // AM/PM buttons
    picker.querySelectorAll('[data-ampm]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            selectedAmPm = btn.dataset.ampm;
            picker.querySelectorAll('.tp-ampm-btn').forEach(b => b.classList.remove('tp-selected'));
            btn.classList.add('tp-selected');
        });
    });

    // Done button
    picker.querySelector('.tp-done-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        let h24 = selectedHour % 12;
        if (selectedAmPm === 'pm') h24 += 12;
        onSelect(h24, selectedMinute);
        picker.classList.remove('open');
    });

    picker.classList.add('open');
}

function formatInputDate(d) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function formatInputTime(d) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function updateArriveDisplay() {
    if (!pendingEvent) return;
    const panel = CalendarState.eventPanel;
    const dateEl = panel.querySelector('#eventArriveDate');
    const timeEl = panel.querySelector('#eventArriveTime');
    const isEstimated = pendingEvent.estimated.includes('arrive');

    dateEl.textContent = formatDateStr(pendingEvent.arrive);
    if (isEstimated) {
        timeEl.innerHTML = `<span class="event-field-estimated">~${formatTimeStr(pendingEvent.arrive)}</span>`;
    } else {
        timeEl.textContent = formatTimeStr(pendingEvent.arrive);
    }

    // Sync hidden date input
    panel.querySelector('#eventArriveDateInput').value = formatInputDate(pendingEvent.arrive);
}

function updateDepartDisplay() {
    if (!pendingEvent) return;
    const panel = CalendarState.eventPanel;
    const dateEl = panel.querySelector('#eventDepartDate');
    const timeEl = panel.querySelector('#eventDepartTime');
    const isEstimated = pendingEvent.estimated.includes('depart');

    if (!pendingEvent.depart) {
        dateEl.textContent = 'Not set';
        dateEl.classList.add('event-field-empty');
        timeEl.textContent = '';
    } else {
        dateEl.classList.remove('event-field-empty');
        if (isEstimated) {
            dateEl.innerHTML = `<span class="event-field-estimated">~${formatDateStr(pendingEvent.depart)}</span>`;
            timeEl.innerHTML = `<span class="event-field-estimated">~${formatTimeStr(pendingEvent.depart)}</span>`;
        } else {
            dateEl.textContent = formatDateStr(pendingEvent.depart);
            timeEl.textContent = formatTimeStr(pendingEvent.depart);
        }
        // Sync hidden date input
        panel.querySelector('#eventDepartDateInput').value = formatInputDate(pendingEvent.depart);
    }
}

function openEventPanel(date) {
    const { eventPanel, eventBackdrop } = CalendarState;

    // Initialize pending event with noon arrival, end-of-day departure (both estimated)
    const arriveDate = new Date(date);
    arriveDate.setHours(12, 0, 0, 0);
    const departDate = new Date(date);
    departDate.setHours(23, 0, 0, 0);
    pendingEvent = {
        arrive: arriveDate,
        location: null,
        depart: departDate,
        estimated: ['arrive', 'depart'],
        travel: null,
    };

    // Update displays
    updateArriveDisplay();
    updateDepartDisplay();

    // Reset location
    const locValue = eventPanel.querySelector('#eventLocationValue');
    locValue.textContent = 'Tap to set destination';
    locValue.classList.add('event-field-empty');
    eventPanel.querySelector('#locationPicker').classList.remove('open');

    // Reset title
    eventPanel.querySelector('#eventTripName').textContent = 'New Trip';

    // Reset transportation
    renderLegsDisplay();
    closeChainBuilder();

    // Reset save button
    eventPanel.querySelector('#eventSaveBtn').disabled = true;

    // Build location options
    buildLocationPicker();

    eventBackdrop.classList.add('open');
    eventPanel.classList.add('open');
}

function toISO(d) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function saveEvent() {
    if (!pendingEvent || !pendingEvent.location) return;

    // Generate unique id
    const maxId = CALENDAR_DATA.events.reduce((max, e) => {
        const num = parseInt(e.id.replace('evt-', ''), 10);
        return num > max ? num : max;
    }, 0);
    const newId = `evt-${maxId + 1}`;

    // Add to source data
    const newEvent = {
        id: newId,
        location: pendingEvent.location,
        arrive: toISO(pendingEvent.arrive),
        depart: pendingEvent.depart ? toISO(pendingEvent.depart) : null,
        estimated: pendingEvent.estimated,
    };
    if (pendingEvent.travel && pendingEvent.travel.legs.length > 0) {
        newEvent.travel = pendingEvent.travel;
    }
    CALENDAR_DATA.events.push(newEvent);

    // Re-derive and re-render
    refreshCalendar();
    closeEventPanel();
}

function refreshCalendar() {
    // Clear derived cache and re-derive
    DataProvider._derived = null;
    const { events, stays, travel, gaps } = DataProvider.loadAll();

    CalendarState.events = events;
    CalendarState.stays = stays;
    CalendarState.travel = travel;
    CalendarState.gaps = gaps;

    // Re-render all visible chunks
    const chunkIndices = [...CalendarState.chunks.keys()];
    chunkIndices.forEach(ci => removeChunk(ci));
    chunkIndices.forEach(ci => renderChunk(ci));
}

function closeEventPanel() {
    closeAllTimePickers();
    CalendarState.eventBackdrop.classList.remove('open');
    CalendarState.eventPanel.classList.remove('open');
    pendingEvent = null;
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

    // Create panels
    createTripPanel();
    createEventPanel();

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
