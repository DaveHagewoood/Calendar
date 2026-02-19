// Local datastore - event-based format
// When migrating to a remote database, replace this with a fetch() call
const CALENDAR_DATA = {
    "locations": [
        { "name": "san-diego", "color": "#E8B84D", "label": "San Diego" },
        { "name": "paris", "color": "#E88D8D", "label": "Paris" },
        { "name": "tokyo", "color": "#A78DD8", "label": "Tokyo" },
        { "name": "beach", "color": "#7DD8C0", "label": "Beach House" },
        { "name": "mountains", "color": "#D8A87D", "label": "Mountains" },
        { "name": "lake", "color": "#6BC6E8", "label": "Lake House" }
    ],
    "events": [
        {
            "id": "evt-1",
            "location": "san-diego",
            "arrive": "2026-01-15T14:30",
            "depart": "2026-01-17T14:30"
        },
        {
            "id": "evt-2",
            "location": "paris",
            "arrive": "2026-01-18T00:05",
            "depart": "2026-02-01T08:00",
            "travel": {
                "legs": [
                    { "mode": "uber", "duration": 45, "note": "To SAN Airport" },
                    { "mode": "plane", "duration": 450, "note": "JFK → CDG (7h 30min)" },
                    { "mode": "train", "duration": 60, "note": "RER B to city center" },
                    { "mode": "taxi", "duration": 20, "note": "To apartment" }
                ]
            }
        },
        {
            "id": "evt-3",
            "location": "tokyo",
            "arrive": "2026-02-01T21:50",
            "depart": "2026-02-11T16:00",
            "travel": {
                "legs": [
                    { "mode": "taxi", "duration": 50, "note": "To CDG Airport" },
                    { "mode": "plane", "duration": 720, "note": "CDG → HND (12h direct)" },
                    { "mode": "train", "duration": 35, "note": "Monorail to city" },
                    { "mode": "taxi", "duration": 25, "note": "To hotel" }
                ]
            }
        },
        {
            "id": "evt-4",
            "location": "beach",
            "arrive": "2026-02-12T06:20",
            "depart": "2026-02-27T11:00",
            "travel": {
                "legs": [
                    { "mode": "train", "duration": 90, "note": "To Narita Airport" },
                    { "mode": "plane", "duration": 540, "note": "NRT → HNL (9h)" },
                    { "mode": "uber", "duration": 35, "note": "To harbor" },
                    { "mode": "boat", "duration": 180, "note": "Ferry to island" },
                    { "mode": "car", "duration": 15, "note": "To beach house" }
                ]
            }
        },
        {
            "id": "evt-5",
            "location": "mountains",
            "arrive": "2026-02-27T11:30",
            "depart": "2026-02-28T10:00",
            "travel": {
                "legs": [
                    { "mode": "car", "duration": 30, "note": "Short drive up the coast" }
                ]
            }
        },
        {
            "id": "evt-6",
            "location": "lake",
            "arrive": "2026-02-28T11:00",
            "depart": null,
            "travel": {
                "legs": [
                    { "mode": "car", "duration": 60, "note": "Drive to lake house" }
                ]
            }
        }
    ],
    "config": {
        "fadeHours": 48
    }
};
