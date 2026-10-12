const path = require("path");
const Database = require("better-sqlite3");
const cron = require("node-cron");

const DB_PATH = path.join(__dirname, "surf_data.db");

const TARGET_URLS = [
    "https://www.ndbc.noaa.gov/data/realtime2/46211.txt",
    // add more realtime2 station URLs here
];

// Optional human-readable names, keyed by station id. Falls back to the id.
const STATION_NAMES = {
    "46211": "Grays Harbor, WA",
};

function parseStationId(url) {
    return url.match(/([A-Za-z0-9]{5})\.txt/)?.[1] ?? "unknown";
}

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
    const createSql = (name) => `
        CREATE TABLE ${name} (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            station_id TEXT NOT NULL,
            station TEXT NOT NULL,
            reading_time TEXT NOT NULL,
            ${columns},
            fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE (station_id, reading_time)
        );
    `;

    const existing = db.prepare("PRAGMA table_info(ndbc_readings)").all();
    if (existing.length === 0) {
        db.exec(createSql("ndbc_readings"));
    } else if (!existing.some(c => c.name === "station_id")) {
        // Migrate old schema, where `station` held the station id
        const cols = ["station_id", "station", "reading_time", ...FIELDS, "fetched_at"].join(", ");
        db.transaction(() => {
            db.exec(createSql("ndbc_readings_new"));
            db.exec(`
                INSERT INTO ndbc_readings_new (${cols})
                SELECT station, station, reading_time, ${FIELDS.join(", ")}, fetched_at
                FROM ndbc_readings;
            `);
            db.exec("DROP TABLE ndbc_readings");
            db.exec("ALTER TABLE ndbc_readings_new RENAME TO ndbc_readings");
        })();
        const setName = db.prepare("UPDATE ndbc_readings SET station = ? WHERE station_id = ?");
        for (const [id, name] of Object.entries(STATION_NAMES)) setName.run(name, id);
    }

    return db;
}

// Parse the raw NDBC text into row objects.
// Format: YYYY MM DD HH MM <14 measurement columns>, "MM" = missing.
function parseNdbcData(raw, stationId) {
    const rows = [];
    for (const line of raw.split("\n")) {
        if (line.trimStart().startsWith("#") || !line.trim()) continue;

        const parts = line.trim().split(/\s+/);
        if (parts.length < 5) continue;

        const [year, month, day, hour, minute] = parts;
        // Skip malformed rows (all five must be numeric)
        if (!parts.slice(0, 5).every(p => /^\d+$/.test(p))) continue;

        const row = {
            station_id: stationId,
            station: STATION_NAMES[stationId] ?? stationId,
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

    const columns = ["station_id", "station", "reading_time", ...FIELDS];
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
        for (const url of TARGET_URLS) {
            const stationId = parseStationId(url);
            const raw = await fetchNDBCData(url);
            if (!raw) continue; // already logged; carry on with the other stations

            const rows = parseNdbcData(raw, stationId);
            console.log(`[${stationId}] Parsed ${rows.length} readings.`);

            const inserted = saveNewRows(db, rows);
            console.log(`[${stationId}] Inserted ${inserted} new readings into ${DB_PATH}.`);
        }

        const total = db.prepare("SELECT COUNT(*) AS n FROM ndbc_readings").get().n;
        console.log(`Total readings in database: ${total}`);
    } finally {
        db.close();
    }
}

// Run every 15 minutes, on the quarter hour (1:00, 1:15, 1:30, 1:45, ...)
const CRON_SCHEDULE = "*/15 * * * *";

let running = false;
async function runScrape() {
    if (running) return; // skip if the previous run hasn't finished
    running = true;
    try {
        await main();
    } catch (error) {
        console.error("Unhandled error:", error);
    } finally {
        running = false;
    }
}

cron.schedule(CRON_SCHEDULE, runScrape);
console.log(`Scraper scheduled (${CRON_SCHEDULE}). Waiting for next run...`);
