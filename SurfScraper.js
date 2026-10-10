async function fetchNDBCData(url) {
    try {
        console.log(`Fetching data from: ${url}`);
        const response = await fetch(url);

        if (!response.ok) {
            throw new Error(`HTTP error! Status: ${response.status}`);
        }

        const data = await response.text();
        console.log("Successfully fetched data.");
        console.log("\n--- Raw Data Retrieved ---");
        console.log(data); // Print the actual data
        return data;

    } catch (error) {
        console.error("Error during data fetching:", error.message);
        return null;
    }
}

const targetUrl = "https://www.ndbc.noaa.gov/data/realtime2/46267.txt";

fetchNDBCData(targetUrl)
    .catch(error => console.error("Unhandled error:", error));