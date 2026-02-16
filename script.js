// Mock data for locations
const locations = [
    { name: 'home', color: '#6B9BD1', label: 'Home' },
    { name: 'paris', color: '#E88D8D', label: 'Paris' },
    { name: 'tokyo', color: '#A78DD8', label: 'Tokyo' },
    { name: 'beach', color: '#7DD8C0', label: 'Beach House' },
    { name: 'mountains', color: '#D8A87D', label: 'Mountains' }
];

// Calendar configuration - show full year with data in the middle
const calendarStart = new Date(2024, 9, 1); // Oct 1, 2024 (3 months before data)
const numWeeks = 52;
const numDays = numWeeks * 7;
const calendarEnd = new Date(calendarStart);
calendarEnd.setDate(calendarEnd.getDate() + numDays);

// Data range (where we have actual location data)
const dataStart = new Date(2025, 0, 1).getTime(); // Jan 1, 2025

// Helper: Create a timestamp from date and time
function makeTimestamp(year, month, day, hours = 0, minutes = 0) {
    return new Date(year, month, day, hours, minutes).getTime();
}

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

// Define trips as continuous time periods with transportation legs
const trips = [
    {
        depart: makeTimestamp(2025, 0, 17, 14, 30),  // Jan 17 (Friday), 2:30 PM
        arrive: makeTimestamp(2025, 0, 18, 10, 6),   // Jan 18 (Saturday), 10:06 AM
        from: 'home',
        to: 'paris',
        legs: [
            { mode: 'uber', duration: 45, note: 'To JFK Airport' },
            { mode: 'plane', duration: 450, note: 'JFK → CDG (7h 30min)' },
            { mode: 'train', duration: 60, note: 'RER B to city center' },
            { mode: 'taxi', duration: 20, note: 'To apartment' }
        ]
    },
    {
        depart: makeTimestamp(2025, 1, 1, 8, 0),     // Feb 1 (Saturday), 8:00 AM
        arrive: makeTimestamp(2025, 1, 2, 2, 10),    // Feb 2 (Sunday), 2:10 AM
        from: 'paris',
        to: 'tokyo',
        legs: [
            { mode: 'taxi', duration: 50, note: 'To CDG Airport' },
            { mode: 'plane', duration: 720, note: 'CDG → HND (12h direct)' },
            { mode: 'train', duration: 35, note: 'Monorail to city' },
            { mode: 'taxi', duration: 25, note: 'To hotel' }
        ]
    },
    {
        depart: makeTimestamp(2025, 1, 11, 16, 0),   // Feb 11 (Tuesday), 4:00 PM
        arrive: makeTimestamp(2025, 1, 12, 23, 0),   // Feb 12 (Wednesday), 11:00 PM
        from: 'tokyo',
        to: 'beach',
        legs: [
            { mode: 'train', duration: 90, note: 'To Narita Airport' },
            { mode: 'plane', duration: 540, note: 'NRT → HNL (9h)' },
            { mode: 'uber', duration: 35, note: 'To harbor' },
            { mode: 'boat', duration: 180, note: 'Ferry to island' },
            { mode: 'car', duration: 15, note: 'To beach house' }
        ]
    },
    {
        depart: makeTimestamp(2025, 1, 27, 11, 0),   // Feb 27 (Thursday), 11:00 AM
        arrive: makeTimestamp(2025, 1, 27, 11, 30),  // Feb 27 (Thursday), 11:30 AM (30 min)
        from: 'beach',
        to: 'mountains',
        legs: [
            { mode: 'car', duration: 30, note: 'Short drive up the coast' }
        ]
    }
];

// Define location periods (where you're staying)
// First stay starts 48 hours before first trip (fade-in period)
const firstStayStart = trips[0].depart - (48 * 60 * 60 * 1000); // 48 hours before first trip

const stays = [
    { location: 'home', start: firstStayStart, end: trips[0].depart },
    { location: 'paris', start: trips[0].arrive, end: trips[1].depart },
    { location: 'tokyo', start: trips[1].arrive, end: trips[2].depart },
    { location: 'beach', start: trips[2].arrive, end: trips[3].depart },
    { location: 'mountains', start: trips[3].arrive, end: makeTimestamp(2025, 1, 28, 12, 0) } // Feb 28, noon - after this, we don't know
];

// Helper: Convert timestamp to grid position
function getGridPosition(timestamp) {
    const msFromStart = timestamp - calendarStart.getTime();
    const totalMs = calendarEnd.getTime() - calendarStart.getTime();

    // Calculate actual day boundaries to handle DST
    let dayIndex = 0;
    let currentTime = calendarStart.getTime();

    while (currentTime < timestamp && dayIndex < numDays) {
        const dayStart = new Date(calendarStart);
        dayStart.setDate(dayStart.getDate() + dayIndex);
        dayStart.setHours(0, 0, 0, 0);

        const dayEnd = new Date(dayStart);
        dayEnd.setDate(dayEnd.getDate() + 1);
        dayEnd.setHours(0, 0, 0, 0);

        if (timestamp >= dayStart.getTime() && timestamp < dayEnd.getTime()) {
            const msInDay = dayEnd.getTime() - dayStart.getTime();
            const msSinceDayStart = timestamp - dayStart.getTime();
            const dayFraction = msSinceDayStart / msInDay;

            const row = Math.floor(dayIndex / 7);
            const col = dayIndex % 7;

            return { row, col, dayIndex, dayFraction };
        }

        dayIndex++;
        currentTime = dayEnd.getTime();
    }

    // Fallback for timestamps outside range
    const daysFromStart = msFromStart / (1000 * 60 * 60 * 24);
    dayIndex = Math.floor(daysFromStart);
    const dayFraction = daysFromStart - dayIndex;
    const row = Math.floor(dayIndex / 7);
    const col = dayIndex % 7;

    return { row, col, dayIndex, dayFraction };
}

// Helper: Render a continuous segment across the grid (Step 2: with time precision)
function renderContinuousSegment(start, end, className, additionalClasses = []) {
    const segments = [];
    const startPos = getGridPosition(start);
    const endPos = getGridPosition(end);

    const numRows = Math.ceil(numDays / 7);
    const cellWidth = 100 / 7; // Each column is 1/7 of width
    const cellHeight = 100 / numRows; // Each row is 1/numRows of height

    // Render one segment per row
    for (let row = startPos.row; row <= endPos.row; row++) {
        const segment = document.createElement('div');
        segment.className = [className, ...additionalClasses].join(' ');

        const isFirstRow = (row === startPos.row);
        const isLastRow = (row === endPos.row);

        // Calculate start position (with fractional day precision on first row)
        const startCol = isFirstRow ? startPos.col + startPos.dayFraction : 0;

        // Calculate end position (with fractional day precision on last row)
        const endCol = isLastRow ? endPos.col + endPos.dayFraction : 7;

        const left = startCol * cellWidth;
        const width = (endCol - startCol) * cellWidth;
        const top = row * cellHeight;

        segment.style.position = 'absolute';
        segment.style.left = `${left}%`;
        segment.style.width = `${width}%`;
        segment.style.top = `${top}%`;
        segment.style.height = `${cellHeight}%`;

        segments.push(segment);
    }

    return segments;
}

// Render calendar grid (day cells with numbers only)
const calendarGrid = document.getElementById('calendarGrid');

for (let i = 0; i < numDays; i++) {
    const date = new Date(calendarStart);
    date.setDate(date.getDate() + i);

    const dayCell = document.createElement('div');
    dayCell.className = 'day-cell';

    // Render day number
    const dayOfMonth = date.getDate();
    const monthAbbr = date.toLocaleString('default', { month: 'short' });
    const dayNumber = document.createElement('div');
    dayNumber.className = 'day-number';
    dayNumber.textContent = dayOfMonth === 1 ? `${dayOfMonth} ${monthAbbr}` : dayOfMonth;

    dayCell.appendChild(dayNumber);
    calendarGrid.appendChild(dayCell);
}

// Create a container for continuous segments
const segmentContainer = document.createElement('div');
segmentContainer.className = 'segment-container';
calendarGrid.appendChild(segmentContainer);

// Create a separate container for icons (needs to be on top)
const iconContainer = document.createElement('div');
iconContainer.className = 'icon-container';
calendarGrid.appendChild(iconContainer);

// Render undefined period before data starts (before fade-in)
if (calendarStart.getTime() < firstStayStart) {
    const segments = renderContinuousSegment(
        calendarStart.getTime(),
        firstStayStart,
        'continuous-fill',
        ['location-undefined']
    );
    segments.forEach(seg => segmentContainer.appendChild(seg));

    // Add question mark icons for pre-data undefined period
    const preStartPos = getGridPosition(calendarStart.getTime());
    const preEndPos = getGridPosition(firstStayStart);

    const numRows = Math.ceil(numDays / 7);
    const cellWidth = 100 / 7;
    const cellHeight = 100 / numRows;

    for (let dayIdx = preStartPos.dayIndex; dayIdx < preEndPos.dayIndex; dayIdx++) {
        const row = Math.floor(dayIdx / 7);
        const col = dayIdx % 7;

        const questionMark = document.createElement('div');
        questionMark.className = 'undefined-icon';
        questionMark.innerHTML = '<i data-lucide="help-circle"></i>';
        questionMark.style.position = 'absolute';
        questionMark.style.left = `${(col + 0.5) * cellWidth}%`;
        questionMark.style.top = `${(row + 0.5) * cellHeight}%`;
        questionMark.style.transform = 'translate(-50%, -50%)';

        iconContainer.appendChild(questionMark);
    }
}

// Render fade-in period before first stay (48 hours before first trip)
const fadeInStart = firstStayStart;
const fadeInEnd = trips[0].depart;
const fadeInDuration = fadeInEnd - fadeInStart;

if (fadeInDuration > 0) {
    const startPos = getGridPosition(fadeInStart);
    const endPos = getGridPosition(fadeInEnd);

    const numRows = Math.ceil(numDays / 7);
    const cellWidth = 100 / 7;
    const cellHeight = 100 / numRows;

    const firstLocation = stays[0].location;
    const locationClass = `location-${firstLocation}`;

    // Render one segment per row with calculated gradient (gray to home color)
    for (let row = startPos.row; row <= endPos.row; row++) {
        const segment = document.createElement('div');
        segment.className = `continuous-fill ${locationClass}`;

        const isFirstRow = (row === startPos.row);
        const isLastRow = (row === endPos.row);

        const startCol = isFirstRow ? startPos.col + startPos.dayFraction : 0;
        const endCol = isLastRow ? endPos.col + endPos.dayFraction : 7;

        const left = startCol * cellWidth;
        const width = (endCol - startCol) * cellWidth;
        const top = row * cellHeight;

        segment.style.position = 'absolute';
        segment.style.left = `${left}%`;
        segment.style.width = `${width}%`;
        segment.style.top = `${top}%`;
        segment.style.height = `${cellHeight}%`;

        // Calculate the time range this segment covers
        const segmentStartTime = isFirstRow ? fadeInStart : (() => {
            const rowStart = new Date(calendarStart);
            rowStart.setDate(rowStart.getDate() + row * 7);
            rowStart.setHours(0, 0, 0, 0);
            return rowStart.getTime();
        })();

        const segmentEndTime = isLastRow ? fadeInEnd : (() => {
            const rowEnd = new Date(calendarStart);
            rowEnd.setDate(rowEnd.getDate() + (row + 1) * 7);
            rowEnd.setHours(0, 0, 0, 0);
            return rowEnd.getTime();
        })();

        // Calculate gradient positions (0 = start of fade, 1 = end of fade)
        const gradientStart = Math.max(0, (segmentStartTime - fadeInStart) / fadeInDuration);
        const gradientEnd = Math.min(1, (segmentEndTime - fadeInStart) / fadeInDuration);

        // Create gradient with correct start/end positions (gray to home color)
        const gradientStartPercent = gradientStart * 100;
        const gradientEndPercent = gradientEnd * 100;

        segment.style.background = `linear-gradient(to right,
            #3a3a3a ${gradientStartPercent}%,
            var(--fill-color) ${gradientEndPercent}%)`;
        segment.style.opacity = '0.85';

        segmentContainer.appendChild(segment);
    }
}

// Render stay segments (skip first one since it's rendered as fade-in)
stays.forEach((stay, index) => {
    if (index === 0) return; // Skip first stay, it's the fade-in period

    const segments = renderContinuousSegment(
        stay.start,
        stay.end,
        'continuous-fill',
        [`location-${stay.location}`]
    );
    segments.forEach(seg => segmentContainer.appendChild(seg));
});

// Render travel segments
trips.forEach((trip, tripIndex) => {
    const segments = renderContinuousSegment(
        trip.depart,
        trip.arrive,
        'continuous-fill',
        ['travel-segment']
    );
    segments.forEach(seg => segmentContainer.appendChild(seg));
});

// Render fade period after last stay with continuous gradient
const lastStay = stays[stays.length - 1];
const fadeEnd = new Date(lastStay.end);
fadeEnd.setTime(fadeEnd.getTime() + 48 * 60 * 60 * 1000); // 48 hours
const fadeEndTimestamp = Math.min(fadeEnd.getTime(), calendarEnd.getTime());

if (fadeEndTimestamp > lastStay.end) {
    const fadeDuration = fadeEndTimestamp - lastStay.end;
    const startPos = getGridPosition(lastStay.end);
    const endPos = getGridPosition(fadeEndTimestamp);

    const numRows = Math.ceil(numDays / 7);
    const cellWidth = 100 / 7;
    const cellHeight = 100 / numRows;

    const locationClass = `location-${lastStay.location}`;

    // Render one segment per row with calculated gradient
    for (let row = startPos.row; row <= endPos.row; row++) {
        const segment = document.createElement('div');
        segment.className = `continuous-fill ${locationClass}`;

        const isFirstRow = (row === startPos.row);
        const isLastRow = (row === endPos.row);

        const startCol = isFirstRow ? startPos.col + startPos.dayFraction : 0;
        const endCol = isLastRow ? endPos.col + endPos.dayFraction : 7;

        const left = startCol * cellWidth;
        const width = (endCol - startCol) * cellWidth;
        const top = row * cellHeight;

        segment.style.position = 'absolute';
        segment.style.left = `${left}%`;
        segment.style.width = `${width}%`;
        segment.style.top = `${top}%`;
        segment.style.height = `${cellHeight}%`;

        // Calculate the time range this segment covers
        const segmentStartTime = isFirstRow ? lastStay.end : (() => {
            const rowStart = new Date(calendarStart);
            rowStart.setDate(rowStart.getDate() + row * 7);
            rowStart.setHours(0, 0, 0, 0);
            return rowStart.getTime();
        })();

        const segmentEndTime = isLastRow ? fadeEndTimestamp : (() => {
            const rowEnd = new Date(calendarStart);
            rowEnd.setDate(rowEnd.getDate() + (row + 1) * 7);
            rowEnd.setHours(0, 0, 0, 0);
            return rowEnd.getTime();
        })();

        // Calculate gradient positions (0 = start of fade, 1 = end of fade)
        const gradientStart = Math.max(0, (segmentStartTime - lastStay.end) / fadeDuration);
        const gradientEnd = Math.min(1, (segmentEndTime - lastStay.end) / fadeDuration);

        // Create gradient with correct start/end positions
        const gradientStartPercent = gradientStart * 100;
        const gradientEndPercent = gradientEnd * 100;

        segment.style.background = `linear-gradient(to right,
            var(--fill-color) ${gradientStartPercent}%,
            #3a3a3a ${gradientEndPercent}%)`;
        segment.style.opacity = '0.85';

        segmentContainer.appendChild(segment);
    }
}

// Render undefined period after fade
if (fadeEndTimestamp < calendarEnd.getTime()) {
    const segments = renderContinuousSegment(
        fadeEndTimestamp,
        calendarEnd.getTime(),
        'continuous-fill',
        ['location-undefined']
    );
    segments.forEach(seg => {
        segmentContainer.appendChild(seg);
    });

    // Add question mark icons for undefined period (one per day)
    const undefStartPos = getGridPosition(fadeEndTimestamp);
    const undefEndPos = getGridPosition(calendarEnd.getTime());

    const numRows = Math.ceil(numDays / 7);
    const cellWidth = 100 / 7;
    const cellHeight = 100 / numRows;

    for (let dayIdx = undefStartPos.dayIndex; dayIdx <= undefEndPos.dayIndex; dayIdx++) {
        const row = Math.floor(dayIdx / 7);
        const col = dayIdx % 7;

        const questionMark = document.createElement('div');
        questionMark.className = 'undefined-icon';
        questionMark.innerHTML = '<i data-lucide="help-circle"></i>';
        questionMark.style.position = 'absolute';
        questionMark.style.left = `${(col + 0.5) * cellWidth}%`;
        questionMark.style.top = `${(row + 0.5) * cellHeight}%`;
        questionMark.style.transform = 'translate(-50%, -50%)';

        iconContainer.appendChild(questionMark);
    }
}

// Render trip icons
trips.forEach((trip, tripIndex) => {
    const tripCenter = (trip.depart + trip.arrive) / 2;
    const centerPos = getGridPosition(tripCenter);

    const icon = document.createElement('div');
    icon.className = 'travel-icon';
    icon.innerHTML = '<i data-lucide="plus"></i>';

    const numRows = Math.ceil(numDays / 7);
    const cellWidth = 100 / 7;
    const cellHeight = 100 / numRows;

    // Position at exact time within the day
    const left = (centerPos.col + centerPos.dayFraction) * cellWidth;
    const top = centerPos.row * cellHeight + cellHeight / 2;

    icon.style.position = 'absolute';
    icon.style.left = `${left}%`;
    icon.style.top = `${top}%`;

    iconContainer.appendChild(icon);
});

// Initialize Lucide icons
lucide.createIcons();

// Vertical drag scroll functionality (mobile-style)
const viewport = document.querySelector('.calendar-viewport');

let isDragging = false;
let startY = 0;
let startScrollTop = 0;

viewport.addEventListener('mousedown', (e) => {
    isDragging = true;
    startY = e.clientY;
    startScrollTop = viewport.scrollTop;
    viewport.style.cursor = 'grabbing';
});

document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;

    const deltaY = startY - e.clientY; // Inverted for natural scroll direction
    viewport.scrollTop = startScrollTop + deltaY;
});

document.addEventListener('mouseup', () => {
    isDragging = false;
    viewport.style.cursor = 'default';
});

// Prevent text selection while dragging
viewport.addEventListener('selectstart', (e) => {
    if (isDragging) e.preventDefault();
});

// Scroll to the data start (Jan 1, 2025) on load
setTimeout(() => {
    const dataStartPos = getGridPosition(dataStart);
    const numRows = Math.ceil(numDays / 7);
    const scrollToRow = Math.max(0, dataStartPos.row - 2); // Show 2 weeks before data
    const scrollPercentage = scrollToRow / numRows;
    viewport.scrollTop = viewport.scrollHeight * scrollPercentage;
}, 100);

console.log('Calendar prototype loaded with', numDays, 'days from', calendarStart.toDateString(), 'to', calendarEnd.toDateString());
