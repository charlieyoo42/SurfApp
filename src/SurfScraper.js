const path = require("path");
const Database = require("better-sqlite3");

const DB_PATH = path.join(__dirname, "surf_data.db");
const targetUrl = "https://www.ndbc.noaa.gov/data/realtime2/46267.txt";
const STATION = targetUrl.match(/(\d{5})\.txt/)?.[1] ?? "unknown";

// NDBC realtime2 columns after year/month/day/hour/minute
const FIELDS = [
    "wind_direction",   // degT
    "wind_speed",       // m/s
    "gust",             // m/s
    "wave_height",      // m
    "wave_period_dpd",  // s (dominant)
    "wave_period_apd",  // s (auxiliary)
    "mean_wind_direction", // degT
    "pressure",         // hPa
    "air_temp",         // C
    "water_temp",       // C
    "dew_point",        // C
    "visibility",       // nmi
    "pressure_tendency",// hPa
    "tide"              // ft
];

function initDb() {
    const db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");

    const columns = FIELDS.map(f => `${f} REAL`).join(", ");
    db.exec(`
        CREATE TABLE IF NOT EXISTS ndbc_readings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            station TEXT NOT NULL,
            reading_time TEXT NOT NULL,
            ${columns},
            fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE (station, reading_time)
        );
    `);

    return db;
}

// Parse the raw NDBC text into row objects.
// Format: YYYY MM DD HH MM <14 measurement columns>, "MM" = missing.
function parseNdbcData(raw) {
    const rows = [];
    for (const line of raw.split("\n")) {
        if (line.trimStart().startsWith("#") || !line.trim()) continue;

        const parts = line.trim().split(/\s+/);
        if (parts.length < 5) continue;

        const [year, month, day, hour, minute] = parts;
        // Skip malformed rows (all five must be numeric)
        if (!parts.slice(0, 5).every(p => /^\d+$/.test(p))) continue;

        const row = {
            station: STATION,
            reading_time: `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")} ${hour.padStart(2, "0")}:${minute.padStart(2, "0")}:00`
        };

        parts.slice(5).forEach((value, i) => {
            row[FIELDS[i]] = value === "MM" ? null : parseFloat(value); // MM = missing
        });
        rows.push(row);
    }
    return rows;
}

// Insert only rows that don't already exist (INSERT OR IGNORE + UNIQUE key)
function saveNewRows(db, rows) {
    if (rows.length === 0) return 0;

    const columns = ["station", "reading_time", ...FIELDS];
    const placeholders = columns.map(() => "?").join(", ");
    const insert = db.prepare(`
        INSERT OR IGNORE INTO ndbc_readings (${columns.join(", ")}) VALUES (${placeholders});
    `);

    const insertMany = db.transaction((items) => {
        let inserted = 0;
        for (const row of items) {
            inserted += insert.run(...columns.map(c => row[c])).changes;
        }
        return inserted; // number of newly inserted rows
    });

    return insertMany(rows);
}

async function fetchNDBCData(url) {
    try {
        console.log(`Fetching data from: ${url}`);
        const response = await fetch(url);

        if (!response.ok) {
            throw new Error(`HTTP error! Status: ${response.status}`);
        }

        const data = await response.text();
        console.log("Successfully fetched data.");
        return data;

    } catch (error) {
        console.error("Error during data fetching:", error.message);
        return null;
    }
}

async function main() {
    const db = initDb();
    try {
        const raw = await fetchNDBCData(targetUrl);
        if (!raw) return;

        const rows = parseNdbcData(raw);
        console.log(`Parsed ${rows.length} readings.`);

        const inserted = saveNewRows(db, rows);
        console.log(`Inserted ${inserted} new readings into ${DB_PATH}.`);

        const total = db.prepare("SELECT COUNT(*) AS n FROM ndbc_readings").get().n;
        console.log(`Total readings in database: ${total}`);
    } finally {
        db.close();
    }
}

main().catch(error => console.error("Unhandled error:", error));