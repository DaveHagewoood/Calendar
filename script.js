// ============================================================
// Constants
// ============================================================
let CELL_SIZE = 375 / 7;             // recalculated from container width on init
let CONTAINER_WIDTH = 375;           // recalculated on init
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

// Color palette for dynamically created locations
const COLOR_PALETTE = [
    '#E8B84D', '#C66B6B', '#8B6FB8', '#5AB89E', '#B8895B', '#6BC6E8',
    '#E87D5A', '#7DB86B', '#B85B8F', '#5B8FB8', '#D4A053', '#6BE8C4',
    '#A06BE8', '#E8CB5A', '#5AE8A0', '#E85A7D'
];

// Accommodation types
const STAY_TYPES = {
    hotel:   { icon: '🏨', label: 'Hotel' },
    house:   { icon: '🏠', label: 'House' },
    airbnb:  { icon: '🏡', label: 'Airbnb' },
    yacht:   { icon: '🛥️', label: 'Yacht' },
    hostel:  { icon: '🛏️', label: 'Hostel' },
    camping: { icon: '⛺', label: 'Camping' },
    other:   { icon: '📍', label: 'Other' },
};

function slugify(label) {
    return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function getNextPaletteColor(existingLocations) {
    const usedColors = new Set(existingLocations.map(l => l.color));
    for (const color of COLOR_PALETTE) {
        if (!usedColors.has(color)) return color;
    }
    return COLOR_PALETTE[existingLocations.length % COLOR_PALETTE.length];
}

function ensureLocation(nameOrLabel) {
    const name = slugify(nameOrLabel);
    if (CalendarState.locationMap[name]) {
        return CalendarState.locationMap[name];
    }
    // Capitalize first letter of each word for label
    const label = nameOrLabel.replace(/\b\w/g, c => c.toUpperCase());
    const color = getNextPaletteColor(DataProvider._data.locations);
    const newLoc = { name, label, color };
    DataProvider._data.locations.push(newLoc);
    CalendarState.locations = DataProvider._data.locations;
    CalendarState.locationMap[name] = newLoc;
    return newLoc;
}

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
// Toast Notification System
// ============================================================
const ToastManager = {
    container: null,

    init(parentEl) {
        this.container = document.createElement('div');
        this.container.className = 'toast-container';
        parentEl.appendChild(this.container);
    },

    show(message, type = 'error', durationMs = 4000) {
        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        const icons = { error: '\u26D4', warning: '\u26A0\uFE0F', success: '\u2705', info: '\u2139\uFE0F' };
        toast.innerHTML = `<span class="toast-icon">${icons[type] || ''}</span><span class="toast-msg">${message}</span>`;
        toast.addEventListener('click', () => dismiss());
        this.container.appendChild(toast);
        // Trigger enter animation
        requestAnimationFrame(() => toast.classList.add('toast-visible'));
        const dismiss = () => {
            toast.classList.remove('toast-visible');
            toast.addEventListener('transitionend', () => toast.remove(), { once: true });
            // Fallback removal if transition doesn't fire
            setTimeout(() => { if (toast.parentNode) toast.remove(); }, 400);
        };
        const timer = setTimeout(dismiss, durationMs);
        return () => { clearTimeout(timer); dismiss(); };
    }
};

// ============================================================
// Validation Engine — extensible rule-based validation
// ============================================================
const ValidationEngine = {
    // Each rule: { id, check(event, existingEvents, mode) → { level: 'error'|'warning', message } | null }
    // mode is 'create' or 'edit'
    rules: [
        {
            id: 'depart-before-arrive',
            check(event, _existing, _mode) {
                if (event.depart && event.arrive && event.depart <= event.arrive) {
                    return { level: 'error', message: 'Departure must be after arrival' };
                }
                return null;
            }
        },
        {
            id: 'overlap',
            check(event, existingEvents, mode) {
                const arriveMs = event.arrive instanceof Date ? event.arrive.getTime() : event.arrive;
                const departMs = event.depart instanceof Date ? event.depart.getTime() : (event.depart || arriveMs);
                // Compute travel start
                let travelStart = arriveMs;
                if (event.travel && event.travel.legs && event.travel.legs.length > 0) {
                    const totalMin = event.travel.legs.reduce((sum, l) => sum + (l.duration || EstimationEngine.estimateLegDuration(l)), 0);
                    travelStart = arriveMs - totalMin * 60000;
                }
                const eventStart = Math.min(travelStart, arriveMs);
                const eventEnd = departMs;

                for (const other of existingEvents) {
                    // Skip self when editing
                    if (mode === 'edit' && other.id === event._editingId) continue;
                    const otherArrive = parseTimestamp(other.arrive);
                    const otherDepart = other.depart ? parseTimestamp(other.depart) : null;
                    // Compute other's effective end (depart or EOD)
                    let otherEnd = otherDepart;
                    if (!otherEnd) {
                        const d = new Date(otherArrive);
                        d.setHours(23, 59, 59, 0);
                        otherEnd = d.getTime();
                    }
                    // Compute other's travel start
                    let otherStart = otherArrive;
                    if (other.travel && other.travel.legs) {
                        const totalMin = other.travel.legs.reduce((sum, l) => sum + (l.duration || 0), 0);
                        otherStart = otherArrive - totalMin * 60000;
                    }
                    const oStart = Math.min(otherStart, otherArrive);
                    const oEnd = otherEnd;

                    // Check overlap
                    if (eventStart < oEnd && eventEnd > oStart) {
                        const loc = CalendarState.locationMap[other.location];
                        const name = loc ? loc.label : other.location;
                        const fmtRange = (s, e) => {
                            const fd = (ms) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
                                + ' ' + new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
                            return `${fd(s)} → ${fd(e)}`;
                        };
                        return {
                            level: 'error',
                            message: `Overlaps with ${name} (${other.id}). `
                                + `Your event occupies ${fmtRange(eventStart, eventEnd)}. `
                                + `${name} occupies ${fmtRange(oStart, oEnd)}${!otherDepart ? ' (no depart set — defaults to end of day)' : ''}. `
                                + `Conflict: ${fmtRange(Math.max(eventStart, oStart), Math.min(eventEnd, oEnd))}.`
                        };
                    }
                }
                return null;
            }
        }
    ],

    validate(event, existingEvents, mode = 'create') {
        const errors = [];
        const warnings = [];
        for (const rule of this.rules) {
            const result = rule.check(event, existingEvents, mode);
            if (result) {
                if (result.level === 'error') errors.push(result.message);
                else warnings.push(result.message);
            }
        }
        return { valid: errors.length === 0, errors, warnings };
    }
};

// ============================================================
// Estimation Engine — extensible auto-estimation for missing data
// ============================================================
const EstimationEngine = {
    // Default duration estimates by transport mode (minutes)
    modeDurations: {
        plane: 300,
        car: 60,
        taxi: 30,
        uber: 30,
        train: 90,
        boat: 120,
        ferry: 90,
        helicopter: 60,
    },

    estimateLegDuration(leg) {
        return this.modeDurations[leg.mode] || 60;
    },

    // Format an estimated duration for display
    formatEstimatedDuration(leg) {
        if (leg.duration > 0) return null; // has real duration, no estimate needed
        const est = this.estimateLegDuration(leg);
        return `~${formatDuration(est)}`;
    }
};

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

    async init() {
        const { binId, masterKey, baseUrl } = JSONBIN_CONFIG;
        const res = await fetch(`${baseUrl}/${binId}/latest`, {
            headers: { 'X-Master-Key': masterKey }
        });
        if (!res.ok) throw new Error(`Failed to load data: ${res.status}`);
        const json = await res.json();
        this._data = json.record;
        this._derived = null;
    },

    _saving: false,
    _pendingSave: false,

    async save() {
        // Coalesce rapid saves — if already saving, queue one retry
        if (this._saving) {
            this._pendingSave = true;
            return;
        }
        this._saving = true;

        const maxRetries = 3;
        let lastErr;
        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                const { binId, masterKey, baseUrl } = JSONBIN_CONFIG;
                const res = await fetch(`${baseUrl}/${binId}`, {
                    method: 'PUT',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Master-Key': masterKey
                    },
                    body: JSON.stringify(this._data)
                });
                if (res.ok) {
                    this._saving = false;
                    // Flush queued save if data changed while we were saving
                    if (this._pendingSave) {
                        this._pendingSave = false;
                        this.save();
                    }
                    return;
                }
                lastErr = new Error(`HTTP ${res.status}`);
            } catch (err) {
                lastErr = err;
            }
            // Exponential backoff: 500ms, 1s, 2s
            if (attempt < maxRetries - 1) {
                await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt)));
            }
        }

        this._saving = false;
        if (this._pendingSave) {
            this._pendingSave = false;
        }
        throw lastErr;
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
                    eventId: e.id,
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

        // Click handler: analyze all segments on this day
        cell.addEventListener('click', () => {
            if (CalendarState.wasDrag) return;
            const segments = getSegmentsForDay(date);
            const totalItems = segments.stays.length + segments.travel.length + segments.gaps.length;

            if (totalItems === 0) {
                openEventPanel(date);
            } else if (totalItems === 1) {
                if (segments.stays.length === 1) {
                    const evt = DataProvider._data.events.find(e => e.id === segments.stays[0].eventId);
                    if (evt) openEventPanelForEdit(evt);
                } else if (segments.gaps.length === 1) {
                    openEventPanel(date);
                } else if (segments.travel.length === 1) {
                    openTravelPanel(segments.travel[0]);
                }
            } else {
                showDayZoomView(date, segments);
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
function computeEventCompleteness(rawEvent) {
    const missing = [];
    if (!rawEvent.depart) missing.push('departure');
    if (!rawEvent.travel || !rawEvent.travel.legs || rawEvent.travel.legs.length === 0) missing.push('transportation');
    if (rawEvent.estimated && rawEvent.estimated.length > 0) {
        rawEvent.estimated.forEach(f => {
            if (f === 'arrive') missing.push('arrival time');
            if (f === 'depart') missing.push('departure time');
        });
    }
    return { complete: missing.length === 0, missing };
}

function renderStays(container, stays, clipStart, clipEnd) {
    stays.forEach(stay => {
        if (stay.end <= clipStart || stay.start >= clipEnd) return;
        const loc = CalendarState.locationMap[stay.location];
        const fillColor = loc ? loc.color : '#3a3a3a';
        const classes = [];
        if (stay.estimated && stay.estimated.length > 0) {
            classes.push('estimated-segment');
        }
        const segs = renderSegment(container, stay.start, stay.end,
            'continuous-fill', classes, clipStart, clipEnd);
        segs.forEach(seg => seg.style.setProperty('--fill-color', fillColor));

        // Completeness badge at the start of the stay (if visible in this chunk)
        if (stay.eventId && stay.start >= clipStart && stay.start < clipEnd) {
            const rawEvent = DataProvider._data.events.find(e => e.id === stay.eventId);
            if (rawEvent) {
                const { complete } = computeEventCompleteness(rawEvent);
                if (!complete) {
                    const pos = getGridPosition(stay.start);
                    const badge = createPositionedDiv('completeness-badge',
                        colToX(pos.col + pos.dayFraction) - 3,
                        rowToY(pos.row) + 2,
                        8, 8);
                    container.appendChild(badge);
                }
            }
        }
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
    const { events, gaps } = CalendarState;

    if (events.length === 0) {
        renderSegment(container, clipStart, clipEnd,
            'continuous-fill', ['location-undefined'], clipStart, clipEnd);
        return;
    }

    // Before first event
    const firstEvent = events[0];
    const firstTravelStart = CalendarState.travel.length > 0 && CalendarState.travel[0].eventId === firstEvent.id
        ? CalendarState.travel[0].start : firstEvent.arrive;

    if (clipStart < firstTravelStart) {
        renderSegment(container, clipStart, firstTravelStart,
            'continuous-fill', ['location-undefined'], clipStart, clipEnd);
    }

    // After last event
    const lastEvent = events[events.length - 1];
    const lastStay = CalendarState.stays.find(s => s.start === lastEvent.arrive);
    const lastEnd = lastStay ? lastStay.end : lastEvent.arrive;

    if (clipEnd > lastEnd) {
        renderSegment(container, lastEnd, clipEnd,
            'continuous-fill', ['location-undefined'], clipStart, clipEnd);
    }

    // Gaps between events
    gaps.forEach(gap => {
        if (gap.end <= clipStart || gap.start >= clipEnd) return;
        renderSegment(container, gap.start, gap.end,
            'continuous-fill', ['location-undefined'], clipStart, clipEnd);
    });
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
            // Show "City · Accommodation" when stay.name exists
            let labelText = loc.label;
            if (stay.eventId) {
                const rawEvt = DataProvider._data.events.find(e => e.id === stay.eventId);
                if (rawEvt && rawEvt.stay && rawEvt.stay.name) {
                    labelText += ` \u00B7 ${rawEvt.stay.name}`;
                }
            }
            label.textContent = labelText;
            container.appendChild(label);
        }
    });
}

// Render travel icons for a time range

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
        const bg = createPositionedDiv('chunk-bg', 0, rowToY(row), CONTAINER_WIDTH, CELL_SIZE);
        fragment.appendChild(bg);
    }

    // Render layers in z-order: undefined → stays → travel → labels → day cells → icons
    renderUndefined(fragment, chunkStartTime, chunkEndTime);
    renderStays(fragment, CalendarState.stays, chunkStartTime, chunkEndTime);
    renderTravel(fragment, CalendarState.travel, chunkStartTime, chunkEndTime);
    renderLabels(fragment, CalendarState.stays, chunkStartTime, chunkEndTime);
    renderDayCells(fragment, startDayIndex, CHUNK_DAYS);
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

    // Show/hide Today button based on whether today's row is visible
    updateTodayButtonVisibility();
}

function createTodayButton(container) {
    const btn = document.createElement('button');
    btn.className = 'today-btn';
    btn.textContent = 'Today';
    btn.style.display = 'none';
    btn.addEventListener('click', () => {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const todayPos = getGridPosition(today.getTime());
        const todayY = rowToY(todayPos.row);
        const viewportHeight = CalendarState.viewport.clientHeight;
        CalendarState.viewport.scrollTo({
            top: todayY - viewportHeight / 2 + CELL_SIZE / 2,
            behavior: 'smooth'
        });
    });
    container.appendChild(btn);
    CalendarState.todayButton = btn;
}

function updateTodayButtonVisibility() {
    const btn = CalendarState.todayButton;
    if (!btn) return;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayPos = getGridPosition(today.getTime());
    const todayY = rowToY(todayPos.row);
    const scrollTop = CalendarState.viewport.scrollTop;
    const viewportHeight = CalendarState.viewport.clientHeight;
    const visible = todayY >= scrollTop && todayY + CELL_SIZE <= scrollTop + viewportHeight;
    btn.style.display = visible ? 'none' : '';
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

// Check if a timestamp falls in an undefined period (not in any stay or travel)
function isUndefinedTime(timestamp) {
    const { stays, travel } = CalendarState;
    for (const s of stays) {
        if (timestamp >= s.start && timestamp < s.end) return false;
    }
    for (const t of travel) {
        if (timestamp >= t.start && timestamp < t.end) return false;
    }
    return true;
}

function findEventAtTime(timestamp) {
    for (const evt of DataProvider._data.events) {
        const arrive = parseTimestamp(evt.arrive);
        let depart = evt.depart ? parseTimestamp(evt.depart) : null;
        if (!depart) {
            const d = new Date(arrive);
            d.setHours(23, 59, 59, 0);
            depart = d.getTime();
        }
        let start = arrive;
        if (evt.travel && evt.travel.legs) {
            const totalMin = evt.travel.legs.reduce((sum, l) => sum + (l.duration || 0), 0);
            start = arrive - totalMin * 60000;
        }
        if (timestamp >= start && timestamp < depart) {
            return evt;
        }
    }
    return null;
}

// Collect all segments (stays, travel, gaps) that touch a given day
function getSegmentsForDay(date) {
    const dayStart = new Date(date);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(date);
    dayEnd.setHours(23, 59, 59, 999);
    const ds = dayStart.getTime();
    const de = dayEnd.getTime();

    const { stays, travel } = CalendarState;

    const dayStays = stays
        .filter(s => s.start < de && s.end > ds)
        .map(s => ({ ...s, clipStart: Math.max(s.start, ds), clipEnd: Math.min(s.end, de) }));

    const dayTravel = travel
        .filter(t => t.start < de && t.end > ds)
        .map(t => ({ ...t, clipStart: Math.max(t.start, ds), clipEnd: Math.min(t.end, de) }));

    // Compute gaps: time within the day not covered by any stay or travel
    const covered = [];
    dayStays.forEach(s => covered.push({ start: s.clipStart, end: s.clipEnd }));
    dayTravel.forEach(t => covered.push({ start: t.clipStart, end: t.clipEnd }));
    covered.sort((a, b) => a.start - b.start);

    const gaps = [];
    let cursor = ds;
    const MIN_GAP = 60000; // ignore gaps shorter than 1 minute
    for (const seg of covered) {
        if (seg.start - cursor >= MIN_GAP) {
            gaps.push({ start: cursor, end: seg.start });
        }
        cursor = Math.max(cursor, seg.end);
    }
    if (de - cursor >= MIN_GAP) {
        gaps.push({ start: cursor, end: de });
    }

    return { stays: dayStays, travel: dayTravel, gaps };
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
// Day Zoom View (disambiguation when clicking a day with multiple segments)
// ============================================================
function createDayZoomView() {
    const container = document.querySelector('.mobile-container');

    const backdrop = document.createElement('div');
    backdrop.className = 'day-zoom-backdrop';
    backdrop.addEventListener('click', closeDayZoomView);

    const panel = document.createElement('div');
    panel.className = 'day-zoom';
    panel.innerHTML = `
        <div class="day-zoom-header">
            <span class="day-zoom-title" id="dayZoomTitle"></span>
            <button class="day-zoom-close-btn" id="dayZoomCloseBtn">&times;</button>
        </div>
        <div class="day-zoom-segments" id="dayZoomSegments"></div>
        <button class="day-zoom-close" id="dayZoomClose">Close</button>
    `;

    container.appendChild(backdrop);
    container.appendChild(panel);

    panel.querySelector('#dayZoomCloseBtn').addEventListener('click', closeDayZoomView);
    panel.querySelector('#dayZoomClose').addEventListener('click', closeDayZoomView);

    CalendarState.dayZoom = panel;
    CalendarState.dayZoomBackdrop = backdrop;
}

function showDayZoomView(date, segments) {
    const { dayZoom, dayZoomBackdrop } = CalendarState;
    const titleEl = dayZoom.querySelector('#dayZoomTitle');
    const segmentsEl = dayZoom.querySelector('#dayZoomSegments');

    titleEl.textContent = date.toLocaleDateString('en-US', {
        weekday: 'long', month: 'short', day: 'numeric'
    });
    segmentsEl.innerHTML = '';

    const fmtTime = (ms) => {
        const d = new Date(ms);
        return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
    };

    // Collect all items and sort by start time
    const items = [];

    segments.stays.forEach(s => {
        const loc = CalendarState.locationMap[s.location];
        const label = loc ? loc.label : s.location;
        const color = loc ? loc.color : '#666';
        const evt = DataProvider._data.events.find(e => e.id === s.eventId);
        let name = label;
        if (evt && evt.stay && evt.stay.name) name += ` \u00b7 ${evt.stay.name}`;
        const estimated = s.estimated && s.estimated.length > 0;
        items.push({
            start: s.clipStart,
            duration: s.clipEnd - s.clipStart,
            type: 'stay',
            color, estimated,
            label: name,
            time: `${fmtTime(s.clipStart)} – ${fmtTime(s.clipEnd)}`,
            action: () => { closeDayZoomView(); if (evt) openEventPanelForEdit(evt); }
        });
    });

    segments.travel.forEach(t => {
        const loc = CalendarState.locationMap[t.location];
        const label = loc ? loc.label : t.location;
        items.push({
            start: t.clipStart,
            duration: t.clipEnd - t.clipStart,
            type: 'travel',
            label: `\u2192 ${label}`,
            time: `${fmtTime(t.clipStart)} – ${fmtTime(t.clipEnd)}`,
            action: () => { closeDayZoomView(); openTravelPanel(t); }
        });
    });

    segments.gaps.forEach(g => {
        items.push({
            start: g.start,
            duration: g.end - g.start,
            type: 'gap',
            label: '',
            time: `${fmtTime(g.start)} – ${fmtTime(g.end)}`,
            action: () => { closeDayZoomView(); openEventPanel(date, new Date(g.start)); }
        });
    });

    items.sort((a, b) => a.start - b.start);

    // Calculate proportional heights
    const totalDuration = items.reduce((sum, it) => sum + it.duration, 0);

    items.forEach(item => {
        const pct = totalDuration > 0 ? (item.duration / totalDuration) * 100 : 100 / items.length;
        const bar = document.createElement('div');
        bar.className = 'day-zoom-segment';
        bar.style.flex = `${pct} 0 0`;

        if (item.type === 'stay') {
            bar.classList.add('is-stay');
            if (item.estimated) bar.classList.add('is-estimated');
            bar.style.setProperty('--fill-color', item.color);
        } else if (item.type === 'travel') {
            bar.classList.add('is-travel');
        } else {
            bar.classList.add('is-gap');
        }

        // Overlay label (like calendar location-label)
        const labelEl = document.createElement('div');
        labelEl.className = 'day-zoom-label';
        labelEl.textContent = item.label;
        bar.appendChild(labelEl);

        // Time range
        const timeEl = document.createElement('div');
        timeEl.className = 'day-zoom-time';
        timeEl.textContent = item.time;
        bar.appendChild(timeEl);

        // Edit icon (centered)
        const icon = document.createElement('div');
        icon.className = 'day-zoom-edit-icon';
        icon.textContent = item.type === 'gap' ? '+' : '\u270E';
        bar.appendChild(icon);

        bar.addEventListener('click', item.action);
        segmentsEl.appendChild(bar);
    });

    dayZoomBackdrop.classList.add('open');
    dayZoom.classList.add('open');
}

function closeDayZoomView() {
    CalendarState.dayZoomBackdrop.classList.remove('open');
    CalendarState.dayZoom.classList.remove('open');
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
            <div class="event-field" id="eventArriveField">
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
            <div class="event-field" id="eventStayField" style="display:none">
                <div class="event-field-label">Accommodation</div>
                <div class="event-field-value event-field-empty event-field-tappable" id="eventStayTypeDisplay">Tap to set type</div>
                <div class="location-picker" id="stayTypePicker"></div>
                <div id="eventStayNameField" style="margin-top:8px;display:none">
                    <div class="event-field-label">Name</div>
                    <input type="text" class="leg-input" id="eventStayName" placeholder="e.g. Hotel Le Marais">
                </div>
                <div id="eventStayAddressField" style="margin-top:8px;display:none">
                    <div class="event-field-label">Address</div>
                    <input type="text" class="leg-input" id="eventStayAddress" placeholder="Full address">
                </div>
            </div>
            <div class="event-field" id="eventDepartField">
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
            <button class="event-delete-btn" id="eventDeleteBtn" style="display:none">Delete Trip</button>
            <button class="event-save-btn" id="eventSaveBtn" disabled>Save Trip</button>
        </div>
    `;

    container.appendChild(backdrop);
    container.appendChild(panel);

    panel.querySelector('#eventPanelClose').addEventListener('click', closeEventPanel);
    panel.querySelector('#eventLocationField').addEventListener('click', toggleLocationPicker);
    panel.querySelector('#eventSaveBtn').addEventListener('click', saveEvent);

    // Delete button with inline confirmation
    let deleteConfirmTimer = null;
    panel.querySelector('#eventDeleteBtn').addEventListener('click', async function() {
        if (!pendingEvent || !pendingEvent._editingId) return;

        if (this.classList.contains('confirming')) {
            // Second tap — delete
            clearTimeout(deleteConfirmTimer);
            this.classList.remove('confirming');
            const id = pendingEvent._editingId;
            const deletedEvt = DataProvider._data.events.find(e => e.id === id);
            DataProvider._data.events = DataProvider._data.events.filter(e => e.id !== id);
            if (deletedEvt) notifyChat('deleted', deletedEvt);
            refreshCalendar();
            closeEventPanel();
            try {
                await DataProvider.save();
                ToastManager.show('Trip deleted', 'success', 2000);
            } catch (err) {
                console.error('Failed to save after delete:', err);
                ToastManager.show('Deleted locally. Remote sync failed.', 'warning');
            }
        } else {
            // First tap — confirm
            this.classList.add('confirming');
            this.textContent = 'Tap again to confirm';
            deleteConfirmTimer = setTimeout(() => {
                this.classList.remove('confirming');
                this.textContent = 'Delete Trip';
            }, 3000);
        }
    });

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
        const estimatedDur = EstimationEngine.formatEstimatedDuration(leg);

        const el = document.createElement('div');
        el.className = 'leg-item leg-item-tappable';
        el.innerHTML = `
            <span class="leg-item-icon">${mode.icon}</span>
            <span class="leg-item-info">
                <span class="leg-item-note ${hasNote ? '' : 'event-field-empty'}">${hasNote ? leg.note : mode.label}</span>
                <span class="leg-item-duration ${hasDuration ? '' : 'event-field-estimated'}">${hasDuration ? formatDuration(leg.duration) : estimatedDur}</span>
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

    // "Add new city" option
    const addOpt = document.createElement('div');
    addOpt.className = 'location-option';
    addOpt.innerHTML = `<span class="location-dot" style="background:#666;border:1px dashed #aaa"></span><span style="color:#aaa">+ Add new city...</span>`;
    addOpt.addEventListener('click', (e) => {
        e.stopPropagation();
        showNewCityInput(picker);
    });
    picker.appendChild(addOpt);
}

function showNewCityInput(picker) {
    picker.innerHTML = `
        <div style="padding: 8px 4px;">
            <input type="text" class="leg-input" id="newCityInput" placeholder="City name (e.g. Barcelona)">
            <div style="display:flex;gap:8px;margin-top:8px">
                <button class="leg-cancel-btn" id="newCityCancel">Cancel</button>
                <button class="leg-confirm-btn" id="newCityConfirm">Add</button>
            </div>
        </div>
    `;
    const input = picker.querySelector('#newCityInput');
    setTimeout(() => input.focus(), 50);
    picker.querySelector('#newCityCancel').addEventListener('click', () => buildLocationPicker());
    const confirmCity = () => {
        const label = input.value.trim();
        if (!label) return;
        const loc = ensureLocation(label);
        selectLocation(loc);
    };
    picker.querySelector('#newCityConfirm').addEventListener('click', confirmCity);
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') confirmCity();
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

    // Show accommodation section
    showStaySection();
}

function showStaySection() {
    const panel = CalendarState.eventPanel;
    const stayField = panel.querySelector('#eventStayField');
    stayField.style.display = '';

    // Build stay type picker
    const typePicker = stayField.querySelector('#stayTypePicker');
    typePicker.innerHTML = '';
    Object.entries(STAY_TYPES).forEach(([key, st]) => {
        const opt = document.createElement('div');
        opt.className = 'location-option';
        opt.innerHTML = `<span style="font-size:16px">${st.icon}</span><span>${st.label}</span>`;
        opt.addEventListener('click', (e) => {
            e.stopPropagation();
            selectStayType(key);
        });
        typePicker.appendChild(opt);
    });

    // Wire up type display tap
    const typeDisplay = stayField.querySelector('#eventStayTypeDisplay');
    typeDisplay.onclick = () => typePicker.classList.toggle('open');

    // Pre-fill if editing
    if (pendingEvent.stay) {
        if (pendingEvent.stay.type) {
            const st = STAY_TYPES[pendingEvent.stay.type];
            typeDisplay.innerHTML = `${st ? st.icon : ''} ${st ? st.label : pendingEvent.stay.type}`;
            typeDisplay.classList.remove('event-field-empty');
            stayField.querySelector('#eventStayNameField').style.display = '';
            stayField.querySelector('#eventStayAddressField').style.display = '';
        }
        if (pendingEvent.stay.name) {
            stayField.querySelector('#eventStayNameField').style.display = '';
            stayField.querySelector('#eventStayName').value = pendingEvent.stay.name;
        }
        if (pendingEvent.stay.address) {
            stayField.querySelector('#eventStayAddressField').style.display = '';
            stayField.querySelector('#eventStayAddress').value = pendingEvent.stay.address;
        }
    }
}

function selectStayType(type) {
    if (!pendingEvent.stay) pendingEvent.stay = {};
    pendingEvent.stay.type = type;

    const stayField = CalendarState.eventPanel.querySelector('#eventStayField');
    const st = STAY_TYPES[type];
    const typeDisplay = stayField.querySelector('#eventStayTypeDisplay');
    typeDisplay.innerHTML = `${st.icon} ${st.label}`;
    typeDisplay.classList.remove('event-field-empty');
    stayField.querySelector('#stayTypePicker').classList.remove('open');

    // Show name and address fields
    stayField.querySelector('#eventStayNameField').style.display = '';
    stayField.querySelector('#eventStayAddressField').style.display = '';
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

function validateFieldsInline() {
    if (!pendingEvent) return;
    const panel = CalendarState.eventPanel;
    const arriveField = panel.querySelector('#eventArriveField');
    const departField = panel.querySelector('#eventDepartField');

    // Clear previous inline errors
    [arriveField, departField].forEach(field => {
        field.classList.remove('event-field-error');
        const existing = field.querySelector('.event-field-error-text');
        if (existing) existing.remove();
    });

    // Build a lightweight event object for validation rules
    const checkEvent = {
        arrive: pendingEvent.arrive,
        depart: pendingEvent.depart,
        travel: pendingEvent.travel,
        _editingId: pendingEvent._editingId
    };

    // Run only inline-relevant rules (depart-before-arrive)
    for (const rule of ValidationEngine.rules) {
        if (rule.id === 'depart-before-arrive') {
            const result = rule.check(checkEvent, [], 'create');
            if (result && result.level === 'error') {
                departField.classList.add('event-field-error');
                const errEl = document.createElement('div');
                errEl.className = 'event-field-error-text';
                errEl.textContent = result.message;
                departField.appendChild(errEl);
            }
        }
    }
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
    validateFieldsInline();
}

function updateDepartDisplay() {
    if (!pendingEvent) return;
    const panel = CalendarState.eventPanel;
    const dateEl = panel.querySelector('#eventDepartDate');
    const timeEl = panel.querySelector('#eventDepartTime');
    const isEstimated = pendingEvent.estimated.includes('depart');

    if (!pendingEvent.depart) {
        dateEl.innerHTML = '<span class="event-field-estimated">~End of day</span>';
        dateEl.classList.remove('event-field-empty');
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
    validateFieldsInline();
}

function openEventPanel(date, arriveOverride) {
    const { eventPanel, eventBackdrop } = CalendarState;

    // Initialize pending event — use arriveOverride if provided, otherwise noon
    const arriveDate = arriveOverride ? new Date(arriveOverride) : new Date(date);
    if (!arriveOverride) arriveDate.setHours(12, 0, 0, 0);
    const departDate = new Date(date);
    departDate.setHours(23, 0, 0, 0);
    pendingEvent = {
        arrive: arriveDate,
        location: null,
        depart: departDate,
        estimated: ['arrive', 'depart'],
        travel: null,
        stay: null,
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

    // Reset accommodation
    const stayField = eventPanel.querySelector('#eventStayField');
    stayField.style.display = 'none';
    stayField.querySelector('#stayTypePicker').classList.remove('open');
    stayField.querySelector('#eventStayTypeDisplay').textContent = 'Tap to set type';
    stayField.querySelector('#eventStayTypeDisplay').classList.add('event-field-empty');
    stayField.querySelector('#eventStayNameField').style.display = 'none';
    stayField.querySelector('#eventStayAddressField').style.display = 'none';
    stayField.querySelector('#eventStayName').value = '';
    stayField.querySelector('#eventStayAddress').value = '';

    // Reset save button
    const saveBtn = eventPanel.querySelector('#eventSaveBtn');
    saveBtn.textContent = 'Save Trip';
    saveBtn.disabled = true;
    saveBtn.dataset.saving = 'false';

    // Hide delete button in create mode
    const deleteBtn = eventPanel.querySelector('#eventDeleteBtn');
    deleteBtn.style.display = 'none';
    deleteBtn.classList.remove('confirming');
    deleteBtn.textContent = 'Delete Trip';

    // Build location options
    buildLocationPicker();

    eventBackdrop.classList.add('open');
    eventPanel.classList.add('open');
}

function openEventPanelForEdit(evt) {
    const { eventPanel, eventBackdrop } = CalendarState;

    // Build pendingEvent from raw event data
    const arrive = new Date(parseTimestamp(evt.arrive));
    const depart = evt.depart ? new Date(parseTimestamp(evt.depart)) : null;

    pendingEvent = {
        arrive: arrive,
        location: evt.location,
        depart: depart,
        estimated: evt.estimated ? [...evt.estimated] : [],
        travel: evt.travel ? { legs: evt.travel.legs.map(l => ({ ...l })) } : null,
        stay: evt.stay ? { ...evt.stay } : null,
        _editingId: evt.id,
    };

    // Update date/time displays
    updateArriveDisplay();
    updateDepartDisplay();

    // Set location
    const loc = CalendarState.locationMap[evt.location];
    const locValue = eventPanel.querySelector('#eventLocationValue');
    let displayName = loc ? loc.label : evt.location;
    if (evt.stay && evt.stay.name) {
        displayName += ` \u00B7 ${evt.stay.name}`;
    }
    if (loc) {
        locValue.innerHTML = `<span class="location-dot" style="background:${loc.color}"></span>${displayName}`;
    } else {
        locValue.textContent = displayName;
    }
    locValue.classList.remove('event-field-empty');
    eventPanel.querySelector('#locationPicker').classList.remove('open');

    // Set title
    eventPanel.querySelector('#eventTripName').textContent = displayName;

    // Transportation
    renderLegsDisplay();
    closeChainBuilder();

    // Accommodation section
    if (evt.location) {
        showStaySection();
    }

    // Save button → "Update Trip", enabled
    const saveBtn = eventPanel.querySelector('#eventSaveBtn');
    saveBtn.textContent = 'Update Trip';
    saveBtn.disabled = false;
    saveBtn.dataset.saving = 'false';

    // Show delete button in edit mode
    const deleteBtn = eventPanel.querySelector('#eventDeleteBtn');
    deleteBtn.style.display = '';
    deleteBtn.classList.remove('confirming');
    deleteBtn.textContent = 'Delete Trip';

    // Build location picker for potential location change
    buildLocationPicker();

    eventBackdrop.classList.add('open');
    eventPanel.classList.add('open');
}

function toISO(d) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function buildEventObject(pending) {
    const obj = {
        location: pending.location,
        arrive: toISO(pending.arrive),
        depart: pending.depart ? toISO(pending.depart) : null,
        estimated: pending.estimated || [],
    };
    if (pending.travel && pending.travel.legs.length > 0) {
        obj.travel = pending.travel;
    }
    if (pending.stay && (pending.stay.type || pending.stay.name || pending.stay.address)) {
        obj.stay = {};
        if (pending.stay.type) obj.stay.type = pending.stay.type;
        if (pending.stay.name) obj.stay.name = pending.stay.name;
        if (pending.stay.address) obj.stay.address = pending.stay.address;
    }
    return obj;
}

async function saveEvent() {
    if (!pendingEvent || !pendingEvent.location) return;

    // Prevent double-tap
    const saveBtn = CalendarState.eventPanel.querySelector('#eventSaveBtn');
    if (saveBtn.dataset.saving === 'true') return;

    // Validate
    const mode = pendingEvent._editingId ? 'edit' : 'create';
    const validation = ValidationEngine.validate(pendingEvent, DataProvider._data.events, mode);
    validation.warnings.forEach(w => ToastManager.show(w, 'warning'));
    if (!validation.valid) {
        validation.errors.forEach(e => ToastManager.show(e, 'error'));
        return;
    }

    saveBtn.dataset.saving = 'true';
    saveBtn.textContent = 'Saving...';
    saveBtn.disabled = true;

    // Collect stay fields from UI before building event
    const stayField = CalendarState.eventPanel.querySelector('#eventStayField');
    if (stayField && stayField.style.display !== 'none') {
        if (!pendingEvent.stay) pendingEvent.stay = {};
        const nameVal = stayField.querySelector('#eventStayName').value.trim();
        const addrVal = stayField.querySelector('#eventStayAddress').value.trim();
        if (nameVal) pendingEvent.stay.name = nameVal;
        if (addrVal) pendingEvent.stay.address = addrVal;
    }

    const eventObj = buildEventObject(pendingEvent);

    if (pendingEvent._editingId) {
        // Edit mode: replace existing
        eventObj.id = pendingEvent._editingId;
        const idx = DataProvider._data.events.findIndex(e => e.id === pendingEvent._editingId);
        if (idx !== -1) DataProvider._data.events[idx] = eventObj;
        notifyChat('edited', eventObj);
    } else {
        // Create mode: generate new id and push
        const maxId = DataProvider._data.events.reduce((max, e) => {
            const num = parseInt(e.id.replace('evt-', ''), 10);
            return num > max ? num : max;
        }, 0);
        eventObj.id = `evt-${maxId + 1}`;
        DataProvider._data.events.push(eventObj);
        notifyChat('created', eventObj);
    }

    // Re-derive and re-render locally
    refreshCalendar();
    closeEventPanel();

    // Persist to remote
    try {
        await DataProvider.save();
        ToastManager.show('Trip saved', 'success', 2000);
    } catch (err) {
        console.error('Failed to save to remote:', err);
        ToastManager.show('Saved locally. Remote sync failed.', 'warning');
    }

    saveBtn.dataset.saving = 'false';
    saveBtn.textContent = pendingEvent && pendingEvent._editingId ? 'Update Trip' : 'Save Trip';
    saveBtn.disabled = false;
}

function refreshCalendar() {
    // Clear derived cache and re-derive
    DataProvider._derived = null;
    const { events, stays, travel, gaps } = DataProvider.loadAll();

    CalendarState.events = events;
    CalendarState.stays = stays;
    CalendarState.travel = travel;
    CalendarState.gaps = gaps;

    // Refresh locations in case new ones were added dynamically
    CalendarState.locations = DataProvider._data.locations;
    CalendarState.locationMap = Object.fromEntries(
        DataProvider._data.locations.map(l => [l.name, l])
    );

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
// Manual Change Context Injection
// ============================================================
function notifyChat(action, eventObj) {
    if (!ChatUI.messages || ChatUI.messages.length === 0) return;
    const loc = CalendarState.locationMap[eventObj.location];
    const label = loc ? loc.label : eventObj.location;
    let stayInfo = '';
    if (eventObj.stay && eventObj.stay.name) stayInfo = ` — ${eventObj.stay.name}`;
    let msg;
    if (action === 'created') {
        msg = `[System: The user manually created ${eventObj.id} (${label}${stayInfo}), arriving ${eventObj.arrive || '?'}${eventObj.depart ? ', departing ' + eventObj.depart : ''}]`;
    } else if (action === 'edited') {
        msg = `[System: The user manually edited ${eventObj.id} (${label}${stayInfo}), now arriving ${eventObj.arrive || '?'}${eventObj.depart ? ', departing ' + eventObj.depart : ''}]`;
    } else if (action === 'deleted') {
        msg = `[System: The user manually deleted ${eventObj.id} (${label}${stayInfo})]`;
    }
    if (msg) ChatUI.messages.push({ role: 'user', content: msg });
}

// ============================================================
// Chat AI Assistant
// ============================================================

const AnthropicClient = {
    async sendMessageStream(messages, tools, systemPrompt, onDelta, onToolUse, onDone) {
        const res = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'x-api-key': ANTHROPIC_CONFIG.apiKey,
                'anthropic-version': '2023-06-01',
                'anthropic-dangerous-direct-browser-access': 'true',
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                model: ANTHROPIC_CONFIG.model,
                max_tokens: 1024,
                system: systemPrompt,
                messages,
                tools,
                stream: true,
            }),
        });

        if (!res.ok) {
            const err = await res.text();
            throw new Error(`API error ${res.status}: ${err}`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        const contentBlocks = [];
        let currentBlock = null;

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            const lines = buffer.split('\n');
            buffer = lines.pop(); // keep incomplete line

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const data = line.slice(6).trim();
                if (data === '[DONE]') continue;
                let evt;
                try { evt = JSON.parse(data); } catch { continue; }

                switch (evt.type) {
                    case 'content_block_start':
                        currentBlock = { ...evt.content_block, text: '' };
                        break;
                    case 'content_block_delta':
                        if (evt.delta.type === 'text_delta' && currentBlock) {
                            currentBlock.text += evt.delta.text;
                            onDelta(evt.delta.text);
                        } else if (evt.delta.type === 'input_json_delta' && currentBlock) {
                            currentBlock.text += evt.delta.partial_json;
                        }
                        break;
                    case 'content_block_stop':
                        if (currentBlock) {
                            if (currentBlock.type === 'tool_use') {
                                try { currentBlock.input = JSON.parse(currentBlock.text); } catch { currentBlock.input = {}; }
                                delete currentBlock.text;
                            }
                            contentBlocks.push(currentBlock);
                            currentBlock = null;
                        }
                        break;
                    case 'message_stop':
                        break;
                }
            }
        }

        // Process tool uses
        const toolUses = contentBlocks.filter(b => b.type === 'tool_use');
        if (toolUses.length > 0) {
            onToolUse(toolUses, contentBlocks);
        }

        onDone(contentBlocks);
        return contentBlocks;
    }
};

function buildScheduleTimeline() {
    const events = DataProvider._data.events;
    if (events.length === 0) return 'No trips scheduled.';

    // Sort events by arrive time
    const sorted = [...events].sort((a, b) => new Date(a.arrive) - new Date(b.arrive));
    const fmt = (iso) => {
        if (!iso) return '?';
        const d = new Date(iso);
        return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
            + ' ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
    };

    const lines = sorted.map(e => {
        const loc = CalendarState.locationMap[e.location];
        const label = loc ? loc.label : e.location;

        // Compute effective occupied range
        let rangeStart = new Date(e.arrive).getTime();
        if (e.travel && e.travel.legs && e.travel.legs.length > 0) {
            const totalMin = e.travel.legs.reduce((s, l) => s + (l.duration || EstimationEngine.estimateLegDuration(l)), 0);
            rangeStart = rangeStart - totalMin * 60000;
        }
        let rangeEnd;
        if (e.depart) {
            rangeEnd = new Date(e.depart).getTime();
        } else {
            const d = new Date(e.arrive);
            d.setHours(23, 59, 59, 0);
            rangeEnd = d.getTime();
        }

        let line = `  ${e.id}: ${label}`;
        if (e.stay && e.stay.name) line += ` (${e.stay.name})`;
        line += `\n    arrive: ${fmt(e.arrive)}`;
        line += `\n    depart: ${e.depart ? fmt(e.depart) : 'not set (defaults to end of arrival day)'}`;
        if (e.travel && e.travel.legs && e.travel.legs.length > 0) {
            const totalMin = e.travel.legs.reduce((s, l) => s + (l.duration || EstimationEngine.estimateLegDuration(l)), 0);
            const modes = e.travel.legs.map(l => l.mode).join(' → ');
            line += `\n    travel: ${modes}, ${totalMin} min before arrive`;
        }
        line += `\n    occupied range: ${fmt(new Date(rangeStart).toISOString())} → ${fmt(new Date(rangeEnd).toISOString())}`;
        if (e.estimated && e.estimated.length > 0) line += `\n    estimated: [${e.estimated.join(', ')}]`;
        return line;
    });

    return lines.join('\n\n');
}

function buildSystemPrompt() {
    const locations = DataProvider._data.locations;
    const today = new Date().toISOString().split('T')[0];

    return `You are a travel planning assistant embedded in a visual calendar app. Today is ${today}.

## Your Role
Help the user manage their travel schedule. You can view, create, edit, and delete trips. Be concise and helpful. When the user asks to add or change a trip, use the appropriate tool. When they ask questions, answer from the schedule data.

## CRITICAL: How Time Works in This System

**"arrive" = when you physically arrive AT the destination, NOT when you leave the previous place.**

Travel legs render BACKWARD from the arrive time. If you arrive in NYC at 11:30am after a 5-hour flight, the travel segment occupies 6:30am–11:30am. The "occupied range" of the event includes this travel window.

**If an event has no depart time, the system treats it as ending at 23:59 on the arrival day.** This means it blocks the entire rest of that day.

### Worked Example
User says: "I left San Diego at 6:30am on a jet for New York"
- The user LEFT at 6:30am — that is the travel departure, not the arrival.
- Estimate flight time: ~5 hours (300 minutes).
- So arrive in New York = 6:30am + 5h = 11:30am.
- Create event: arrive="2026-01-29T11:30", travel_legs=[{mode:"plane", duration:300}]
- The system will render travel from 6:30am to 11:30am (backward from arrive).

### Default Travel Duration Estimates (used when duration is omitted)
${Object.entries(EstimationEngine.modeDurations).map(([k, v]) => `- ${k}: ${v} min`).join('\n')}
- other/unknown: 60 min

**IMPORTANT: Always provide a duration on travel legs.** If the user doesn't specify, estimate based on the route. Omitting duration causes the system to use the defaults above, which may not match the actual route and can cause unexpected overlaps.

## Workflow: Inserting Trips Between Existing Events
When the user describes a trip that falls within an existing event's time range:
1. FIRST use edit_event to adjust the existing event's depart time (to make room)
2. THEN create_event for the new trip(s)
3. If the user returns to the original city afterward, create another event for the return

Always check the "occupied range" in the schedule below to see where events actually sit before making changes.

## Known Locations
${locations.map(l => `- "${l.name}" (${l.label})`).join('\n')}

You can also use ANY city in the world. If you specify a location name that doesn't exist yet, it will be automatically created. Use a slug format like "barcelona", "new-york", "cape-town".

## Accommodation Types
${Object.entries(STAY_TYPES).map(([k, v]) => `- "${k}" (${v.label} ${v.icon})`).join('\n')}

Events can optionally include accommodation details: stay_type, stay_name (hotel/property name), and stay_address. These are optional — the minimum required is just a city.

## Available Transport Modes
${Object.entries(transportModes).map(([k, v]) => `- "${k}" (${v.label} ${v.icon})`).join('\n')}

## Current Schedule (LIVE — trust this over conversation history)
The schedule below is the real-time state. The user may have added, edited, or deleted trips manually since your last message. Always trust this data over what you remember from earlier in the conversation.

${buildScheduleTimeline()}

## Rules
- Dates use ISO format: "YYYY-MM-DDTHH:mm" (e.g. "2025-03-15T14:00")
- Each event must have a location (existing or new city slug) and arrive datetime
- Departure must be after arrival
- Events cannot overlap — check the "occupied range" fields above to avoid conflicts
- The "estimated" array lists fields that are approximate (e.g. ["arrive", "depart"])
- Travel legs have: mode, duration (minutes, ALWAYS provide this), note (optional)
- Stay info is optional: stay_type, stay_name, stay_address
- Multiple stays in the same city are fine (e.g. different hotels)
- When creating events, always call the create_event tool
- When asked about the schedule, use get_schedule to get the latest data before answering
- Be concise in responses — ask clarifying questions if you need arrival times or travel durations`;
}

const chatTools = [
    {
        name: 'get_schedule',
        description: 'Get all scheduled trips/events with full details',
        input_schema: { type: 'object', properties: {}, required: [] }
    },
    {
        name: 'get_event_details',
        description: 'Get details of a specific event by ID',
        input_schema: {
            type: 'object',
            properties: { event_id: { type: 'string', description: 'Event ID (e.g. "evt-1")' } },
            required: ['event_id']
        }
    },
    {
        name: 'list_locations',
        description: 'Get all available locations that can be used for trips',
        input_schema: { type: 'object', properties: {}, required: [] }
    },
    {
        name: 'create_event',
        description: 'Create a new trip. Location can be any existing city or a new city slug. New cities are auto-created. Returns validation errors if the trip conflicts.',
        input_schema: {
            type: 'object',
            properties: {
                location: { type: 'string', description: 'City slug (e.g. "san-diego", "barcelona", "new-york")' },
                arrive: { type: 'string', description: 'Arrival datetime in ISO format (e.g. "2025-03-15T14:00")' },
                depart: { type: 'string', description: 'Departure datetime in ISO format, or null if unknown' },
                travel_legs: {
                    type: 'array',
                    description: 'Transportation legs to get there',
                    items: {
                        type: 'object',
                        properties: {
                            mode: { type: 'string', description: 'Transport mode (car, plane, train, etc.)' },
                            duration: { type: 'number', description: 'Duration in minutes' },
                            note: { type: 'string', description: 'Optional note (e.g. "SFO → LAX")' }
                        },
                        required: ['mode']
                    }
                },
                estimated: {
                    type: 'array',
                    description: 'Fields that are estimated/approximate (e.g. ["arrive", "depart"])',
                    items: { type: 'string' }
                },
                stay_type: { type: 'string', description: 'Accommodation type: hotel, house, airbnb, yacht, hostel, camping, other' },
                stay_name: { type: 'string', description: 'Name of the accommodation (e.g. "Hotel Le Marais")' },
                stay_address: { type: 'string', description: 'Full address of the accommodation' }
            },
            required: ['location', 'arrive']
        }
    },
    {
        name: 'edit_event',
        description: 'Edit an existing trip. Only include fields you want to change. Returns validation errors if the changes conflict.',
        input_schema: {
            type: 'object',
            properties: {
                event_id: { type: 'string', description: 'Event ID to edit (e.g. "evt-1")' },
                location: { type: 'string', description: 'New city slug' },
                arrive: { type: 'string', description: 'New arrival datetime' },
                depart: { type: 'string', description: 'New departure datetime, or null to clear' },
                travel_legs: {
                    type: 'array',
                    description: 'New transportation legs (replaces existing)',
                    items: {
                        type: 'object',
                        properties: {
                            mode: { type: 'string' },
                            duration: { type: 'number' },
                            note: { type: 'string' }
                        },
                        required: ['mode']
                    }
                },
                estimated: {
                    type: 'array',
                    description: 'Updated estimated fields',
                    items: { type: 'string' }
                },
                stay_type: { type: 'string', description: 'Accommodation type: hotel, house, airbnb, yacht, hostel, camping, other' },
                stay_name: { type: 'string', description: 'Name of the accommodation' },
                stay_address: { type: 'string', description: 'Full address of the accommodation' }
            },
            required: ['event_id']
        }
    },
    {
        name: 'delete_event',
        description: 'Delete a trip by its event ID',
        input_schema: {
            type: 'object',
            properties: { event_id: { type: 'string', description: 'Event ID to delete' } },
            required: ['event_id']
        }
    },
    {
        name: 'create_location',
        description: 'Create a new city/location. Returns the created location with auto-assigned color. Note: create_event auto-creates locations too, so this is only needed if you want to set a custom color.',
        input_schema: {
            type: 'object',
            properties: {
                label: { type: 'string', description: 'Display name (e.g. "Barcelona", "New York")' },
                color: { type: 'string', description: 'Optional hex color (e.g. "#E87D5A"). Auto-assigned if omitted.' }
            },
            required: ['label']
        }
    }
];

async function executeToolCall(name, input) {
    switch (name) {
        case 'get_schedule':
            return { success: true, result: DataProvider._data.events, timeline: buildScheduleTimeline() };

        case 'get_event_details': {
            const evt = DataProvider._data.events.find(e => e.id === input.event_id);
            if (!evt) return { success: false, error: `Event "${input.event_id}" not found` };
            return { success: true, result: evt };
        }

        case 'list_locations':
            return { success: true, result: DataProvider._data.locations };

        case 'create_event': {
            // Auto-create location if it doesn't exist
            ensureLocation(input.location);

            // Build event for validation
            const arrive = new Date(input.arrive);
            const depart = input.depart ? new Date(input.depart) : null;
            const checkEvent = {
                arrive: arrive.getTime(),
                depart: depart ? depart.getTime() : null,
                travel: input.travel_legs ? { legs: input.travel_legs.map(l => ({ mode: l.mode, duration: l.duration || 0, note: l.note || '' })) } : null,
                estimated: input.estimated || [],
            };

            // Validate
            const validation = ValidationEngine.validate(checkEvent, DataProvider._data.events, 'create');
            if (!validation.valid) {
                return { success: false, error: `Validation failed: ${validation.errors.join('; ')}` };
            }

            // Build and save
            const maxId = DataProvider._data.events.reduce((max, e) => {
                const num = parseInt(e.id.replace('evt-', ''), 10);
                return num > max ? num : max;
            }, 0);
            const newEvent = {
                id: `evt-${maxId + 1}`,
                location: slugify(input.location),
                arrive: input.arrive,
                depart: input.depart || null,
                estimated: input.estimated || [],
            };
            if (input.travel_legs && input.travel_legs.length > 0) {
                newEvent.travel = { legs: input.travel_legs.map(l => ({ mode: l.mode, duration: l.duration || 0, note: l.note || '' })) };
            }
            if (input.stay_type || input.stay_name || input.stay_address) {
                newEvent.stay = {};
                if (input.stay_type) newEvent.stay.type = input.stay_type;
                if (input.stay_name) newEvent.stay.name = input.stay_name;
                if (input.stay_address) newEvent.stay.address = input.stay_address;
            }
            DataProvider._data.events.push(newEvent);
            refreshCalendar();
            ToastManager.show('Trip created by assistant', 'success', 2000);
            DataProvider.save().catch(err => {
                console.error('Remote save failed:', err);
                ToastManager.show('Saved locally. Remote sync failed.', 'warning');
            });
            if (validation.warnings.length > 0) {
                return { success: true, result: newEvent, warnings: validation.warnings };
            }
            return { success: true, result: newEvent };
        }

        case 'edit_event': {
            const idx = DataProvider._data.events.findIndex(e => e.id === input.event_id);
            if (idx === -1) return { success: false, error: `Event "${input.event_id}" not found` };

            const existing = { ...DataProvider._data.events[idx] };
            // Merge fields
            if (input.location !== undefined) {
                ensureLocation(input.location);
                existing.location = slugify(input.location);
            }
            if (input.arrive !== undefined) existing.arrive = input.arrive;
            if (input.depart !== undefined) existing.depart = input.depart;
            if (input.estimated !== undefined) existing.estimated = input.estimated;
            if (input.travel_legs !== undefined) {
                existing.travel = input.travel_legs.length > 0
                    ? { legs: input.travel_legs.map(l => ({ mode: l.mode, duration: l.duration || 0, note: l.note || '' })) }
                    : undefined;
            }
            // Merge stay fields
            if (input.stay_type !== undefined || input.stay_name !== undefined || input.stay_address !== undefined) {
                if (!existing.stay) existing.stay = {};
                if (input.stay_type !== undefined) existing.stay.type = input.stay_type;
                if (input.stay_name !== undefined) existing.stay.name = input.stay_name;
                if (input.stay_address !== undefined) existing.stay.address = input.stay_address;
            }

            // Validate
            const arrive = new Date(existing.arrive);
            const depart = existing.depart ? new Date(existing.depart) : null;
            const checkEvent = {
                arrive: arrive.getTime(),
                depart: depart ? depart.getTime() : null,
                travel: existing.travel || null,
                estimated: existing.estimated || [],
                _editingId: input.event_id,
            };
            const validation = ValidationEngine.validate(checkEvent, DataProvider._data.events, 'edit');
            if (!validation.valid) {
                return { success: false, error: `Validation failed: ${validation.errors.join('; ')}` };
            }

            DataProvider._data.events[idx] = existing;
            refreshCalendar();
            ToastManager.show('Trip updated by assistant', 'success', 2000);
            DataProvider.save().catch(err => {
                console.error('Remote save failed:', err);
                ToastManager.show('Saved locally. Remote sync failed.', 'warning');
            });
            if (validation.warnings.length > 0) {
                return { success: true, result: existing, warnings: validation.warnings };
            }
            return { success: true, result: existing };
        }

        case 'delete_event': {
            const idx = DataProvider._data.events.findIndex(e => e.id === input.event_id);
            if (idx === -1) return { success: false, error: `Event "${input.event_id}" not found` };
            const removed = DataProvider._data.events.splice(idx, 1)[0];
            refreshCalendar();
            ToastManager.show('Trip deleted by assistant', 'success', 2000);
            DataProvider.save().catch(err => {
                console.error('Remote save failed:', err);
                ToastManager.show('Saved locally. Remote sync failed.', 'warning');
            });
            return { success: true, result: { deleted: removed.id, location: removed.location } };
        }

        case 'create_location': {
            const name = slugify(input.label);
            if (CalendarState.locationMap[name]) {
                return { success: true, result: CalendarState.locationMap[name], note: 'Already exists' };
            }
            const color = input.color || getNextPaletteColor(DataProvider._data.locations);
            const newLoc = { name, label: input.label, color };
            DataProvider._data.locations.push(newLoc);
            CalendarState.locations = DataProvider._data.locations;
            CalendarState.locationMap[name] = newLoc;
            DataProvider.save().catch(err => console.error('Remote save failed:', err));
            return { success: true, result: newLoc };
        }

        default:
            return { success: false, error: `Unknown tool: ${name}` };
    }
}

// ============================================================
// Split Divider Drag
// ============================================================
function setupSplitDivider() {
    const divider = document.getElementById('splitDivider');
    const chatContainer = document.getElementById('chatContainer');
    const mobileContainer = document.querySelector('.mobile-container');
    if (!divider || !chatContainer) return;

    let isDragging = false;

    divider.addEventListener('pointerdown', (e) => {
        isDragging = true;
        divider.setPointerCapture(e.pointerId);
        e.preventDefault();
    });

    document.addEventListener('pointermove', (e) => {
        if (!isDragging) return;
        const containerRect = mobileContainer.getBoundingClientRect();
        const containerHeight = containerRect.height;
        const chatHeight = containerRect.bottom - e.clientY - 4; // 4 = half divider height
        const minChat = 120;
        const minCalendar = containerHeight * 0.3;
        const maxChat = containerHeight - minCalendar - 8; // 8 = divider height
        const clamped = Math.max(minChat, Math.min(maxChat, chatHeight));
        chatContainer.style.flexBasis = clamped + 'px';
        // Keep today button above the divider
        if (CalendarState.todayButton) {
            CalendarState.todayButton.style.bottom = (clamped + 8 + 16) + 'px';
        }
    });

    document.addEventListener('pointerup', () => {
        if (!isDragging) return;
        isDragging = false;
        // Trigger scroll handler to load any newly-visible chunks
        handleScroll();
    });
}

const ChatUI = {
    container: null,
    messagesEl: null,
    inputEl: null,
    messages: [], // conversation history: { role, content }
    isSending: false,

    init() {
        this.container = document.getElementById('chatContainer');

        // Build chat HTML directly into the container
        this.container.innerHTML = `
            <div class="chat-header">
                <span class="chat-header-title">Travel Assistant</span>
            </div>
            <div class="chat-messages" id="chatMessages"></div>
            <div class="chat-input-area">
                <input type="text" class="chat-input" id="chatInput" placeholder="Ask about your schedule...">
                <button class="chat-send-btn" id="chatSendBtn">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
                </button>
            </div>
        `;

        this.messagesEl = this.container.querySelector('#chatMessages');
        this.inputEl = this.container.querySelector('#chatInput');

        this.container.querySelector('#chatSendBtn').addEventListener('click', () => this.handleSend());
        this.inputEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.handleSend();
            }
        });

        // Welcome message
        this.addMessage('assistant', 'Hi! I can help manage your travel schedule. Ask me to add a trip, check your schedule, or edit events.');

        // Set up split divider drag
        setupSplitDivider();
    },

    addMessage(role, content) {
        const bubble = document.createElement('div');
        bubble.className = `chat-bubble chat-bubble-${role}`;
        bubble.textContent = content;
        this.messagesEl.appendChild(bubble);
        this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
        return bubble;
    },

    addTypingIndicator() {
        const bubble = document.createElement('div');
        bubble.className = 'chat-bubble chat-bubble-assistant chat-typing';
        bubble.innerHTML = '<span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>';
        bubble.id = 'chatTyping';
        this.messagesEl.appendChild(bubble);
        this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
        return bubble;
    },

    removeTypingIndicator() {
        const el = this.messagesEl.querySelector('#chatTyping');
        if (el) el.remove();
    },

    addToolBubble(title, body, success) {
        const bubble = document.createElement('div');
        bubble.className = 'chat-tool-bubble' + (success === false ? ' tool-error' : success === true ? ' tool-ok' : '');
        const header = document.createElement('div');
        header.className = 'chat-tool-header';
        header.textContent = title;
        bubble.appendChild(header);
        if (body) {
            const pre = document.createElement('pre');
            pre.className = 'chat-tool-body';
            pre.textContent = body;
            bubble.appendChild(pre);
        }
        this.messagesEl.appendChild(bubble);
        this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    },

    async handleSend() {
        const text = this.inputEl.value.trim();
        if (!text || this.isSending) return;

        this.inputEl.value = '';
        this.addMessage('user', text);
        this.messages.push({ role: 'user', content: text });

        this.isSending = true;
        this.inputEl.disabled = true;

        try {
            await this.sendToAssistant();
        } catch (err) {
            console.error('Chat error:', err);
            this.removeTypingIndicator();
            const errMsg = err.message || String(err);
            this.addMessage('assistant', `Error: ${errMsg}`);
        }

        this.isSending = false;
        this.inputEl.disabled = false;
        this.inputEl.focus();
    },

    async sendToAssistant() {
        this.addTypingIndicator();
        const systemPrompt = buildSystemPrompt();
        const MAX_TOOL_ROUNDS = 10;

        for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
            let streamBubble = null;
            let streamText = '';
            const toolUses = [];

            try {
                await AnthropicClient.sendMessageStream(
                    this.messages.map(m => ({ role: m.role, content: m.content })),
                    chatTools,
                    systemPrompt,
                    (delta) => {
                        if (!streamBubble) {
                            this.removeTypingIndicator();
                            streamBubble = document.createElement('div');
                            streamBubble.className = 'chat-bubble chat-bubble-assistant';
                            this.messagesEl.appendChild(streamBubble);
                        }
                        streamText += delta;
                        streamBubble.textContent = streamText;
                        this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
                    },
                    (tus) => { toolUses.push(...tus); },
                    () => {}
                );
            } catch (err) {
                console.error(`Chat API error (round ${round + 1}):`, err);
                this.removeTypingIndicator();
                this.addMessage('assistant', `Error (round ${round + 1}): ${err.message || err}`);
                return;
            }

            if (toolUses.length === 0) {
                if (streamText) {
                    this.messages.push({ role: 'assistant', content: streamText });
                } else if (round === 0) {
                    // No text and no tools on first round — empty response
                    this.removeTypingIndicator();
                    this.addMessage('assistant', '[Empty response from API — try again]');
                }
                break;
            }

            // Has tool calls — add assistant message, execute tools, loop again
            const assistantContent = [];
            if (streamText) assistantContent.push({ type: 'text', text: streamText });
            toolUses.forEach(tu => assistantContent.push({ type: 'tool_use', id: tu.id, name: tu.name, input: tu.input }));
            this.messages.push({ role: 'assistant', content: assistantContent });

            const toolResults = [];
            for (const tu of toolUses) {
                // Show debug bubble for tool call
                const inputSummary = JSON.stringify(tu.input, null, 2);
                this.addToolBubble(`\u2192 ${tu.name}`, inputSummary);

                try {
                    const result = await executeToolCall(tu.name, tu.input);
                    const resultJson = JSON.stringify(result);
                    toolResults.push({
                        type: 'tool_result',
                        tool_use_id: tu.id,
                        content: resultJson,
                    });
                    // Show debug bubble for tool result
                    const short = resultJson.length > 300 ? resultJson.slice(0, 300) + '...' : resultJson;
                    this.addToolBubble(`\u2190 ${tu.name}`, short, result.success);
                } catch (toolErr) {
                    console.error(`Tool error (${tu.name}):`, toolErr);
                    this.addToolBubble(`\u2190 ${tu.name}`, `CRASH: ${toolErr.message}`, false);
                    toolResults.push({
                        type: 'tool_result',
                        tool_use_id: tu.id,
                        content: JSON.stringify({ success: false, error: `Tool crashed: ${toolErr.message}` }),
                        is_error: true,
                    });
                }
            }
            this.messages.push({ role: 'user', content: toolResults });

            // Show typing indicator for next round
            if (!this.messagesEl.querySelector('#chatTyping')) {
                this.addTypingIndicator();
            }
        }

        // If we exhausted all rounds
        if (this.messagesEl.querySelector('#chatTyping')) {
            this.removeTypingIndicator();
            this.addMessage('assistant', '[Stopped — too many tool calls in a row. Try a simpler request.]');
        }

        this.removeTypingIndicator();
    }
};

// ============================================================
// Initialize
// ============================================================
async function initCalendar() {
    // Compute cell size from actual container width
    const container = document.querySelector('.mobile-container');
    CONTAINER_WIDTH = container.clientWidth;
    CELL_SIZE = CONTAINER_WIDTH / 7;

    await DataProvider.init();

    const locations = DataProvider.getLocations();
    const { events, stays, travel, gaps } = DataProvider.loadAll();

    // Populate state
    CalendarState.events = events;
    CalendarState.stays = stays;
    CalendarState.travel = travel;
    CalendarState.gaps = gaps;
    CalendarState.locations = locations;
    CalendarState.locationMap = Object.fromEntries(locations.map(l => [l.name, l]));
    CalendarState.canvas = document.getElementById('calendarCanvas');
    CalendarState.viewport = document.getElementById('calendarViewport');

    // Create panels and UI systems
    createTripPanel();
    createEventPanel();
    createDayZoomView();
    ToastManager.init(document.querySelector('.mobile-container'));

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

    // Create Today floating button
    createTodayButton(document.querySelector('.mobile-container'));

    // Initialize chat UI (split layout — always visible)
    ChatUI.init();

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
