import {useEffect, useState} from "react";
import WordCloud from "react-d3-cloud";


function Data() {
  const [brainID, setBrainID] = useState("");
  const [regionData, setRegionData] = useState(null);
  const [error, setError] = useState(null);
  const [ready, setReady] = useState(false);
  const options = {
    rotations: 2,
    rotationAngles: [-90, 0],
    fontSizes: [20, 60],
  };
  useEffect(() => {
    console.log("Updated regionData:", regionData);
  }, [regionData]);


  const callAllenApi = async () => {
    const numericValue = Number(brainID);

    if (Number.isNaN(numericValue)) {
      setError("Please enter a valid brainID");
      return;
    }

    try {
      const allenUrl = `https://api.brain-map.org/api/v2/data/Structure/${numericValue}.json`;
      const allenResponse = await fetch(allenUrl);

      if (!allenResponse.ok) {
        throw new Error(`Allen API failed: ${allenResponse.status}`);
      }

      const allenData = await allenResponse.json();
      console.log(allenData);
      const region = allenData.msg?.[0];

      if (!region) {
        throw new Error("No region data found.");
      }

      const aiResponse = await fetch("http://localhost:5001/api/region-keywords", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          regionName: region.name
        })
      });

      if (!aiResponse.ok) {
        throw new Error(`AI keyword API failed: ${aiResponse.status}`);
      }

      const aiData = await aiResponse.json();
      console.log(aiData);

      if (!aiData.keywords || aiData.keywords.length === 0) {
        throw new Error("No keywords returned from AI.");
      }

      const cleaned = aiData.keywords
          .filter(k => k && typeof k.text === "string" && typeof k.value === "number")
          .map(k => ({
            text: k.text,
            value: Number(k.value)
          }));

      if (cleaned.length === 0) {
        throw new Error("AI returned invalid keyword format.");
      }
      setRegionData(cleaned);

      setError(null);
      setReady(true);

    } catch (err) {
      console.error(err);
      setError(err.message);
      setRegionData(null);
    }
  };

  const generateWordCloudFromAI = async (regionName) => {
    try {
      const response = await fetch("http://localhost:5001/api/region-keywords", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ regionName })
      });

      const data = await response.json();

      if (!data.keywords || data.keywords.length === 0) {
        throw new Error("No keywords returned.");
      }

      setRegionData(data.keywords);
      setError(null);

    } catch (err) {
      setError("AI keyword generation failed.");
    }
  };



  return (
    <div className="Data">
      <h1>Wordcloud</h1>
      <label htmlFor="fname">Brain Region ID:</label>
      <input
        type="number"
        id="fname"
        value={brainID}
        onChange={(e) => setBrainID(e.target.value)}
      />

      <button onClick={callAllenApi}>Submit</button>

      {error && <div style={{ color: "red" }}>{error}</div>}

      {ready && Array.isArray(regionData) && regionData.length > 0 && (
          <div style={{ width: 800, height: 400 }}>
            <WordCloud
                data={regionData}           // prop is `data`, not `words`
                fontSize={(word) => Math.log2(word.value) * 10}
                rotate={(word) => (word.value % 2 === 0 ? 0 : -90)}
            />
          </div>
      )}


    </div>
  );
}

export default Data;
