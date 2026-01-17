import { useState } from "react";

function App() {
    const [brainID, setBrainID] = useState("");
    const [regionData, setRegionData] = useState(null);
    const [error, setError] = useState(null);

    const callAllenApi = async () => {
        const numericValue = Number(brainID);


        if (Number.isNaN(numericValue)) {
            setError("Please enter a valid brainID");
            return;
        }

        // Construct the Allen Brain Atlas query URL for a Structure by ID
        const url = `https://api.brain-map.org/api/v2/data/Structure/${numericValue}.json`;

        try {
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`API request failed: ${response.status}`);
            }

            const data = await response.json();
            setRegionData(data);
            setError(null);

        } catch (err) {
            setError(err.message);
            setRegionData(null);
        }
    };

    return (
        <div className="App">
            <label htmlFor="fname">number:</label>
            <input
                type="number"
                id="fname"
                value={brainID}
                onChange={(e) => setBrainID(e.target.value)}
            />

            <button onClick={callAllenApi}>Submit</button>

            {error && <div style={{ color: "red" }}>{error}</div>}

            {regionData && (
                <div>
                    <h3>Region Info</h3>
                    <pre>{JSON.stringify(regionData, null, 2)}</pre>
                </div>
            )}
        </div>
    );
}

export default App;
