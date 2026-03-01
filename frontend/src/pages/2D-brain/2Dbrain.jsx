import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import WordCloud from "react-d3-cloud";
import './2Dbrain.css';

function TwoDBrain() {
  const navigate = useNavigate();
  const [question, setQuestion] = useState("");
  const [aiResults, setAiResults] = useState(null);
  const [isLoadingAI, setIsLoadingAI] = useState(false);
  const [regionSearch, setRegionSearch] = useState("");
  const [aiEndpoint, setAiEndpoint] = useState("/api/ask-ai");
  const [errorMessage, setErrorMessage] = useState(null);
  const AI_ENDPOINTS = [
    { label: "OpenAI", value: "/api/ask-ai" },
    { label: "Group A - api list", value: "https://capstone.ssdd.dev/brainatlas-be/api/list" },
    { label: "Group A - health", value: "https://capstone.ssdd.dev/brainatlas-be/health" }
  ];

  const dragStateRef = useRef({ isDragging: false, view: null, startY: null, startSlice: null });
  const [suggestions, setSuggestions] = useState([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [wordCloudData, setWordCloudData] = useState(null);
  const [isLoadingCloud, setIsLoadingCloud] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem("aiEndpoint");
    if (saved) setAiEndpoint(saved);
  }, []);

  useEffect(() => {
    localStorage.setItem("aiEndpoint", aiEndpoint);
  }, [aiEndpoint]);



  const [slices, setSlices] = useState({
    sagittal: 570,   // Middle of Z-axis (1140/2) - was axial
    coronal: 660,    // Middle of X-axis (1320/2) - was sagittal
    transverse: 400  // Middle of Y-axis (800/2) - was coronal
  });
  
  const [maxSlices, setMaxSlices] = useState({
    sagittal: 1139,   // Z-axis: 1140 slices (0-1139) - was axial
    coronal: 1319,    // X-axis: 1320 slices (0-1319) - was sagittal
    transverse: 799   // Y-axis: 800 slices (0-799) - was coronal
  });

  const [regionInfo, setRegionInfo] = useState('Click a brain region');
  const [isPanelOpen, setIsPanelOpen] = useState(false);
  const [selectedRegion, setSelectedRegion] = useState(null);
  const [ancestors, setAncestors] = useState([]);
  const [regionMap, setRegionMap] = useState({});
  
  // Separate refs for each view
  const canvasRefs = {
    sagittal: useRef(null),
    coronal: useRef(null),
    transverse: useRef(null)
  };
  
  const brainImgRefs = {
    sagittal: useRef(new Image()),
    coronal: useRef(new Image()),
    transverse: useRef(new Image())
  };
  
  const labelImgRefs = {
    sagittal: useRef(new Image()),
    coronal: useRef(new Image()),
    transverse: useRef(new Image())
  };
  
  const labelDataRefs = {
    sagittal: useRef(null),
    coronal: useRef(null),
    transverse: useRef(null)
  };
  
  const dimensionsRefs = {
    sagittal: useRef({ width: 0, height: 0 }),
    coronal: useRef({ width: 0, height: 0 }),
    transverse: useRef({ width: 0, height: 0 })
  };

  // Load region metadata
  useEffect(() => {
    fetch('/data/parcellation_term.csv')
      .then(r => r.text())
      .then(text => {
        const lines = text.trim().split('\n');

        function parseCSVLine(line) {
          const result = [];
          let current = '';
          let inQuotes = false;

          for (let c of line) {
            if (c === '"') inQuotes = !inQuotes;
            else if (c === ',' && !inQuotes) {
              result.push(current.trim());
              current = '';
            } else {
              current += c;
            }
          }
          result.push(current.trim());
          return result;
        }

        const headers = parseCSVLine(lines[0]);
        const idCol = headers.indexOf('identifier');
        const nameCol = headers.indexOf('name');

        const map = {};
        for (let i = 1; i < lines.length; i++) {
          const row = parseCSVLine(lines[i]);
          const identifier = row[idCol];
          const name = row[nameCol];

          if (!identifier) continue;
          const numericId = parseInt(identifier.split(':')[1]);
          map[numericId] = name;
        }

        setRegionMap(map);
        console.log('Loaded', Object.keys(map).length, 'regions');
      })
      .catch(err => console.error('Error loading CSV:', err));
  }, []);

  // Load slice images for a specific view
  const loadSliceImages = (view, sliceIndex) => {
    const brainImg = brainImgRefs[view].current;
    const labelImg = labelImgRefs[view].current;

    brainImg.src = `/slices/${view}/brain_${String(sliceIndex).padStart(4, '0')}.png`;
    labelImg.src = `/slices/${view}/labels_${String(sliceIndex).padStart(4, '0')}.png`;

    brainImg.onload = () => {
      const canvas = canvasRefs[view].current;
      if (canvas) {
        canvas.width = brainImg.width;
        canvas.height = brainImg.height;
        redraw(view);
      }
    };

    labelImg.onload = () => {
      const width = labelImg.width;
      const height = labelImg.height;
      dimensionsRefs[view].current = { width, height };

      const offCanvas = document.createElement('canvas');
      offCanvas.width = width;
      offCanvas.height = height;
      const offCtx = offCanvas.getContext('2d');
      offCtx.drawImage(labelImg, 0, 0);

      labelDataRefs[view].current = offCtx.getImageData(0, 0, width, height);
      redraw(view);
    };
  };

  // Load images whenever slice position changes
  useEffect(() => {
    loadSliceImages('sagittal', slices.sagittal);
  }, [slices.sagittal]);

  useEffect(() => {
    loadSliceImages('coronal', slices.coronal);
  }, [slices.coronal]);

  useEffect(() => {
    loadSliceImages('transverse', slices.transverse);
  }, [slices.transverse]);

  // Fetch ancestors when region is selected
  useEffect(() => {
    if (selectedRegion && selectedRegion.id) {
      fetch(`http://127.0.0.1:8000/regions/${selectedRegion.id}/ancestors`)
        .then(r => r.ok ? r.json() : [])
        .then(setAncestors)
        .catch(err => {
          console.error('Error fetching ancestors:', err);
          setAncestors([]);
        });
    } else {
      setAncestors([]);
    }
  }, [selectedRegion?.id]);

  // Helper functions
  const pixelToAnnotationId = (r, g, b) => {
    return b + (g << 8) + (r << 16);
  };

  const rgbToKey = (r, g, b) => {
    return (r << 16) | (g << 8) | b;
  };

  // Rotate image data 90 degrees clockwise
  const rotateImageData90CW = (imageData, width, height) => {
    const rotated = new ImageData(height, width);
    
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const srcIdx = (y * width + x) * 4;
        const destX = height - 1 - y;
        const destY = x;
        const destIdx = (destY * height + destX) * 4;
        
        rotated.data[destIdx] = imageData.data[srcIdx];
        rotated.data[destIdx + 1] = imageData.data[srcIdx + 1];
        rotated.data[destIdx + 2] = imageData.data[srcIdx + 2];
        rotated.data[destIdx + 3] = imageData.data[srcIdx + 3];
      }
    }
    
    return rotated;
  };

  // Rotate image data 180 degrees
  const rotateImageData180 = (imageData, width, height) => {
    const rotated = new ImageData(width, height);
    
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const srcIdx = (y * width + x) * 4;
        const destX = width - 1 - x;
        const destY = height - 1 - y;
        const destIdx = (destY * width + destX) * 4;
        
        rotated.data[destIdx] = imageData.data[srcIdx];
        rotated.data[destIdx + 1] = imageData.data[srcIdx + 1];
        rotated.data[destIdx + 2] = imageData.data[srcIdx + 2];
        rotated.data[destIdx + 3] = imageData.data[srcIdx + 3];
      }
    }
    return rotated;
  };
  // wordcloud imple
  const generateWordCloud = async (regionName) => {
    setIsLoadingCloud(true);
    setWordCloudData(null);
    try {
      const response = await fetch("http://localhost:5001/api/region-keywords", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ regionName })
      });

      const data = await response.json();

      if (!data.keywords || data.keywords.length === 0) {
        throw new Error("No keywords returned.");
      }

      const cleaned = data.keywords
          .filter(k => k && typeof k.text === "string" && typeof k.value === "number")
          .map(k => ({ text: k.text, value: Number(k.value) }));

      setWordCloudData(cleaned);
    } catch (err) {
      console.error("Word cloud failed:", err);
      setWordCloudData(null);
    }
    setIsLoadingCloud(false);
  };
  const findRegionIdByName = (query) => {
    const lower = query.toLowerCase();

    for (const [id, name] of Object.entries(regionMap)) {
      if (name.toLowerCase().includes(lower)) {
        return parseInt(id);
      }
    }

    return null;
  };
  const handleRegionSearch = async () => {
    if (!regionSearch.trim()) return;

    const regionId = findRegionIdByName(regionSearch);

    if (!regionId) {
      setRegionInfo("Region not found.");
      return;
    }

    const updatedSlices = {};

    for (const view of ["sagittal", "coronal", "transverse"]) {
      const sliceIndex = await findRegionInView(regionId, view);
      if (sliceIndex !== null) {
        updatedSlices[view] = sliceIndex;
      }
    }

    setSlices(prev => ({
      ...prev,
      ...updatedSlices
    }));

    const regionName = regionMap[regionId];

    setSelectedRegion({
      name: regionName,
      id: regionId,
      view: "Search",
      slice: "-"
    });

    setRegionInfo(`Search result: ${regionName}`);
    generateWordCloud(regionName);
    setIsPanelOpen(true);

    setTimeout(() => {
      Object.keys(updatedSlices).forEach(view => {
        highlightRegion(regionId, view);
      });
    }, 300);
  };
  const getSuggestions = (query) => {
    if (!query.trim()) {
      setSuggestions([]);
      return;
    }
    const lower = query.toLowerCase();
    const matches = Object.entries(regionMap)
        .filter(([, name]) => name.toLowerCase().includes(lower))
        .slice(0, 8) // limit to 8 suggestions
        .map(([id, name]) => ({ id: parseInt(id), name }));
    setSuggestions(matches);
  };


  const redraw = (view) => {
    const canvas = canvasRefs[view].current;
    const brainImg = brainImgRefs[view].current;
    const labelData = labelDataRefs[view].current;
    
    if (!canvas || !brainImg.complete || !labelData) return;

    const ctx = canvas.getContext('2d');
    
    // Apply rotation based on view
    if (view === 'sagittal') {
      // Rotate 180 degrees
      ctx.save();
      ctx.translate(canvas.width, canvas.height);
      ctx.rotate(Math.PI);
      ctx.drawImage(brainImg, 0, 0);
      ctx.restore();
    } else if (view === 'coronal' || view === 'transverse') {
      // Rotate 90 degrees clockwise
      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = brainImg.height;
      tempCanvas.height = brainImg.width;
      const tempCtx = tempCanvas.getContext('2d');
      
      tempCtx.translate(tempCanvas.width, 0);
      tempCtx.rotate(Math.PI / 2);
      tempCtx.drawImage(brainImg, 0, 0);
      
      canvas.width = tempCanvas.width;
      canvas.height = tempCanvas.height;
      ctx.drawImage(tempCanvas, 0, 0);
    } else {
      ctx.drawImage(brainImg, 0, 0);
    }
    
    drawRegionOutlines(ctx, view);
  };

  const drawRegionOutlines = (ctx, view) => {
    const labelData = labelDataRefs[view].current;
    if (!labelData) return;

    const { width, height } = dimensionsRefs[view].current;
    
    // Get rotated label data for outline detection
    let processedLabelData = labelData;
    let processedWidth = width;
    let processedHeight = height;
    
    if (view === 'sagittal') {
      processedLabelData = rotateImageData180(labelData, width, height);
    } else if (view === 'coronal' || view === 'transverse') {
      processedLabelData = rotateImageData90CW(labelData, width, height);
      processedWidth = height;
      processedHeight = width;
    }

    ctx.save();
    ctx.fillStyle = 'black';
    ctx.globalAlpha = 0.8;

    for (let y = 1; y < processedHeight - 1; y++) {
      for (let x = 1; x < processedWidth - 1; x++) {
        const i = (y * processedWidth + x) * 4;

        const key = rgbToKey(
          processedLabelData.data[i],
          processedLabelData.data[i + 1],
          processedLabelData.data[i + 2]
        );

        const neighbors = [
          i - processedWidth * 4,
          i + processedWidth * 4,
          i - 4,
          i + 4
        ];

        for (const n of neighbors) {
          const nk = rgbToKey(
            processedLabelData.data[n],
            processedLabelData.data[n + 1],
            processedLabelData.data[n + 2]
          );

          if (nk !== key) {
            ctx.fillRect(x, y, 1, 1);
            break;
          }
        }
      }
    }

    ctx.restore();
  };

  const highlightRegion = (targetId, view) => {
    const canvas = canvasRefs[view].current;
    const brainImg = brainImgRefs[view].current;
    const labelData = labelDataRefs[view].current;
    const ctx = canvas.getContext('2d');
    const { width, height } = dimensionsRefs[view].current;

    // Redraw the brain image with rotation
    if (view === 'sagittal') {
      ctx.save();
      ctx.translate(canvas.width, canvas.height);
      ctx.rotate(Math.PI);
      ctx.drawImage(brainImg, 0, 0);
      ctx.restore();
    } else if (view === 'coronal' || view === 'transverse') {
      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = brainImg.height;
      tempCanvas.height = brainImg.width;
      const tempCtx = tempCanvas.getContext('2d');
      
      tempCtx.translate(tempCanvas.width, 0);
      tempCtx.rotate(Math.PI / 2);
      tempCtx.drawImage(brainImg, 0, 0);
      
      canvas.width = tempCanvas.width;
      canvas.height = tempCanvas.height;
      ctx.drawImage(tempCanvas, 0, 0);
    } else {
      ctx.drawImage(brainImg, 0, 0);
    }

    // Get rotated label data for highlighting
    let processedLabelData = labelData;
    let processedWidth = width;
    let processedHeight = height;
    
    if (view === 'sagittal') {
      processedLabelData = rotateImageData180(labelData, width, height);
    } else if (view === 'coronal' || view === 'transverse') {
      processedLabelData = rotateImageData90CW(labelData, width, height);
      processedWidth = height;
      processedHeight = width;
    }

    ctx.globalAlpha = 0.4;
    ctx.fillStyle = 'red';

    for (let i = 0; i < processedLabelData.data.length; i += 4) {
      const r = processedLabelData.data[i];
      const g = processedLabelData.data[i + 1];
      const b = processedLabelData.data[i + 2];

      if (pixelToAnnotationId(r, g, b) === targetId) {
        const p = i / 4;
        ctx.fillRect(p % processedWidth, Math.floor(p / processedWidth), 1, 1);
      }
    }

    ctx.globalAlpha = 1.0;
    drawRegionOutlines(ctx, view);
  };

  const handleCanvasClick = (e, view) => {
    const labelData = labelDataRefs[view].current;
    if (!labelData) return;

    const canvas = canvasRefs[view].current;
    const rect = canvas.getBoundingClientRect();
    const { width, height } = dimensionsRefs[view].current;

    // Get click position on canvas
    let canvasX = Math.floor((e.clientX - rect.left) * canvas.width / rect.width);
    let canvasY = Math.floor((e.clientY - rect.top) * canvas.height / rect.height);

    // Convert rotated canvas coordinates back to original image coordinates
    let x, y;
    
    if (view === 'sagittal') {
      // 180 degree rotation
      x = width - 1 - canvasX;
      y = height - 1 - canvasY;
    } else if (view === 'coronal' || view === 'transverse') {
      // 90 degree clockwise rotation - reverse it
      x = canvasY;
      y = height - 1 - canvasX;
    } else {
      x = canvasX;
      y = canvasY;
    }

    // Clamp to image bounds
    x = Math.max(0, Math.min(x, width - 1));
    y = Math.max(0, Math.min(y, height - 1));

    const i = (y * width + x) * 4;
    const r = labelData.data[i];
    const g = labelData.data[i + 1];
    const b = labelData.data[i + 2];

    const annotationId = pixelToAnnotationId(r, g, b);
    const name = regionMap[annotationId] || 'Unknown region';

    setRegionInfo(name);
    setSelectedRegion({ name, id: annotationId, view, slice: slices[view] });
    generateWordCloud(name);
    setIsPanelOpen(true);

    console.log('Clicked:', name, annotationId, `in ${view} view at (${x}, ${y})`);

    // Calculate new slice positions based on the 3D coordinate system
    const newSlices = { ...slices };
    
    // Note: The coordinate mapping is based on the ORIGINAL (unrotated) image coordinates
    if (view === 'sagittal') {
      // Sagittal (was axial) shows XY plane at position Z
      // x position in image → X coordinate → coronal slice
      // y position in image → Y coordinate → transverse slice
      newSlices.coronal = Math.floor((x / width) * maxSlices.coronal);
      newSlices.transverse = Math.floor((y / height) * maxSlices.transverse);
      
    } else if (view === 'coronal') {
      // Coronal (was sagittal) shows YZ plane at position X
      // x position in image → Y coordinate → transverse slice
      // y position in image → Z coordinate → sagittal slice
      newSlices.transverse = Math.floor((x / width) * maxSlices.transverse);
      newSlices.sagittal = Math.floor(((height - y) / height) * maxSlices.sagittal);
      
    } else if (view === 'transverse') {
      // Transverse (was coronal) shows XZ plane at position Y
      // x position in image → X coordinate → coronal slice
      // y position in image → Z coordinate → sagittal slice
      newSlices.coronal = Math.floor((x / width) * maxSlices.coronal);
      newSlices.sagittal = Math.floor(((height - y) / height) * maxSlices.sagittal);
    }

    // Clamp values to valid ranges
    newSlices.sagittal = Math.min(Math.max(newSlices.sagittal, 0), maxSlices.sagittal);
    newSlices.coronal = Math.min(Math.max(newSlices.coronal, 0), maxSlices.coronal);
    newSlices.transverse = Math.min(Math.max(newSlices.transverse, 0), maxSlices.transverse);

    setSlices(newSlices);

    // Highlight after images load - increase timeout for safety
    setTimeout(() => {
      Object.keys(canvasRefs).forEach(v => {
        if (labelDataRefs[v].current) {
          highlightRegion(annotationId, v);
        }
      });
    }, 200);
  };
  const handleTouchStart = (e, view) => {
    console.log("handle touch start")
    e.preventDefault();
    const touch = e.touches[0];
    dragStateRef.current = {
      isDragging: true,
      view,
      startY: touch.clientY,
      startX: touch.clientX,
      startSlice: slices[view],
    };
  };

  const handleTouchMove = (e, view) => {
    console.log("handle touch move")
    e.preventDefault();
    const drag = dragStateRef.current;
    if (!drag.isDragging || drag.view !== view) return;

    const touch = e.touches[0];
    const deltaY = touch.clientY - drag.startY;

    // Sensitivity: how many pixels of drag = 1 slice change
    const sensitivity = 0.5;
    const sliceDelta = Math.round(deltaY * sensitivity);

    const newSlice = Math.min(
        Math.max(drag.startSlice - sliceDelta, 0),
        maxSlices[view]
    );

    setSlices(prev => ({ ...prev, [view]: newSlice }));
  };

  const handleTouchEnd = (e, view) => {
    console.log("handle touch end")
    const drag = dragStateRef.current;
    const touch = e.changedTouches[0];
    const deltaX = Math.abs(touch.clientX - drag.startX);
    const deltaY = Math.abs(touch.clientY - drag.startY);

    // If barely moved, treat as a tap (click to identify region)
    if (deltaX < 5 && deltaY < 5) {
      handleCanvasClick(
          { clientX: touch.clientX, clientY: touch.clientY },
          view
      );
    }

    dragStateRef.current.isDragging = false;
  };

  const handleSliceChange = (view, value) => {
    setSlices(prev => ({
      ...prev,
      [view]: parseInt(value)
    }));
  };
  const findRegionInView = async (regionId, view) => {
    for (let i = 0; i <= maxSlices[view]; i += 10) {
      loadSliceImages(view, i);

      await new Promise(r => setTimeout(r, 50));

      const labelData = labelDataRefs[view].current;
      if (!labelData) continue;

      for (let j = 0; j < labelData.data.length; j += 4) {
        const id = pixelToAnnotationId(
            labelData.data[j],
            labelData.data[j + 1],
            labelData.data[j + 2]
        );

        if (id === regionId) {
          return i;
        }
      }
    }
    return null;
  };

  const handleAskAI = async () => {
    if (!question.trim()) return;

    setIsLoadingAI(true);
    setAiResults(null);

    try {
      const url = aiEndpoint.startsWith("http") ? aiEndpoint : `http://localhost:5001${aiEndpoint}`;
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ question })
      });
      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Server error: ${response.status} - ${errText}`);
      }

      const data = await response.json();
      setAiResults(data);

      if (data.matched_regions?.length > 0) {

        const topRegion = data.matched_regions[0].region_id;
        const updatedSlices = {};

        for (const view of ["sagittal", "coronal", "transverse"]) {
          const sliceIndex = await findRegionInView(topRegion, view);
          if (sliceIndex !== null) {
            updatedSlices[view] = sliceIndex;
          }
        }

        setSlices(prev => ({
          ...prev,
          ...updatedSlices
        }));

        const regionName = regionMap[topRegion] || "Unknown region";

        setSelectedRegion({
          name: regionName,
          id: topRegion,
          view: "AI",
          slice: "-"
        });

        setRegionInfo(`AI suggests: ${regionName}`);
        generateWordCloud(regionName);
        setIsPanelOpen(true);

        setTimeout(() => {
          Object.keys(updatedSlices).forEach(view => {
            highlightRegion(topRegion, view);
          });
        }, 300);
      }


    } catch (err) {
      console.error("AI request failed:", err);
      setErrorMessage(err.message || "Unknown error occurred.");
    }

    setIsLoadingAI(false);
  };


  return (
      <div className="flex h-screen bg-gray-950 text-white overflow-hidden">

        {/* Main Content */}
        <div className="flex flex-col flex-1 overflow-hidden">

          {/* Header */}
          <div className="bg-gray-900 border-b border-gray-800 px-6 py-4">
            <h1 className="text-xl font-bold text-white mb-3">3-Plane Brain Atlas Viewer</h1>

            <div className="flex flex-wrap items-center gap-3">

              {/* Region Search */}
              <div className="relative">
                <div className="flex gap-2">
                  <input
                      type="text"
                      placeholder="Search brain region..."
                      value={regionSearch}
                      onChange={(e) => {
                        setRegionSearch(e.target.value);
                        getSuggestions(e.target.value);
                      }}
                      onFocus={() => setShowSuggestions(true)}
                      onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
                      className="bg-gray-800 border border-gray-700 text-white placeholder-gray-500 rounded-md px-3 py-2 text-sm w-56 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  <button
                      onClick={handleRegionSearch}
                      className="bg-blue-600 hover:bg-blue-500 text-white text-sm px-4 py-2 rounded-md transition-colors"
                  >
                    Search
                  </button>
                </div>

                {showSuggestions && suggestions.length > 0 && (
                    <ul className="absolute top-full left-0 mt-1 w-56 bg-gray-800 border border-gray-700 rounded-md shadow-xl z-50 max-h-52 overflow-y-auto">
                      {suggestions.map((s) => (
                          <li
                              key={s.id}
                              onMouseDown={() => {
                                setRegionSearch(s.name);
                                setSuggestions([]);
                                setShowSuggestions(false);
                                setTimeout(() => handleRegionSearch(), 0);
                              }}
                              className="px-3 py-2 text-sm text-gray-300 cursor-pointer hover:bg-gray-700 transition-colors"
                          >
                            {s.name}
                          </li>
                      ))}
                    </ul>
                )}
              </div>

              {/* AI Question */}
              <input
                  type="text"
                  placeholder="Ask a neuroscience question..."
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  className="bg-gray-800 border border-gray-700 text-white placeholder-gray-500 rounded-md px-3 py-2 text-sm w-72 focus:outline-none focus:ring-2 focus:ring-purple-500"
              />
              <button
                  onClick={handleAskAI}
                  disabled={isLoadingAI}
                  className="bg-purple-600 hover:bg-purple-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm px-4 py-2 rounded-md transition-colors"
              >
                {isLoadingAI ? "Thinking..." : "Ask AI"}
              </button>

              {/* AI Mode Selector */}
              <div className="flex items-center gap-2">
                <label className="text-gray-400 text-sm">AI Mode:</label>
                <select
                    value={aiEndpoint}
                    onChange={(e) => setAiEndpoint(e.target.value)}
                    className="bg-gray-800 border border-gray-700 text-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-500"
                >
                  {AI_ENDPOINTS.map((ep) => (
                      <option key={ep.value} value={ep.value}>{ep.label}</option>
                  ))}
                </select>
              </div>

              {/* View Nav Buttons */}
              <div className="flex gap-2 ml-auto">
                {['sagittal', 'coronal', 'transverse'].map((v) => (
                    <button
                        key={v}
                        onClick={() => navigate(`/${v}`)}
                        className="border border-gray-600 hover:border-blue-500 hover:text-blue-400 text-gray-300 text-sm px-3 py-2 rounded-md transition-colors capitalize"
                    >
                      {v}
                    </button>
                ))}
              </div>
            </div>
          </div>

          {/* Region Info Bar */}
          <div className="bg-gray-900/50 border-b border-gray-800 px-6 py-2">
            <span className="text-sm text-blue-400 font-medium">{regionInfo}</span>
          </div>

          {/* Brain Views Grid */}
          <div className="flex-1 grid grid-cols-3 gap-4 p-4 overflow-hidden">
            {['sagittal', 'coronal', 'transverse'].map((view) => (
                <div key={view} className="bg-gray-900 border border-gray-800 rounded-xl flex flex-col overflow-hidden">

                  {/* View Header */}
                  <div className="flex items-center justify-between px-4 py-2 border-b border-gray-800">
                    <h2 className="text-sm font-semibold text-gray-200 capitalize">{view}</h2>
                    <div className="flex items-center gap-2">
                      <input
                          type="range"
                          min="0"
                          max={maxSlices[view]}
                          value={slices[view]}
                          step="1"
                          onChange={(e) => handleSliceChange(view, e.target.value)}
                          className="w-28 accent-blue-500"
                      />
                      <span className="text-xs text-gray-400 w-10 text-right">{slices[view]}</span>
                    </div>
                  </div>

                  {/* Canvas */}
                  <div className="relative flex-1 flex items-center justify-center bg-black overflow-hidden">
                    <canvas
                        ref={canvasRefs[view]}
                        className="max-w-full max-h-full object-contain cursor-crosshair"
                        onClick={(e) => handleCanvasClick(e, view)}
                        onTouchStart={(e) => handleTouchStart(e, view)}
                        onTouchMove={(e) => handleTouchMove(e, view)}
                        onTouchEnd={(e) => handleTouchEnd(e, view)}
                    />
                    {/* Orientation Labels */}
                    <div className="absolute inset-0 pointer-events-none flex items-center justify-between px-2">
                <span className="text-xs text-gray-500 font-bold">
                  {view === 'sagittal' ? 'L' : view === 'coronal' ? 'P' : 'R'}
                </span>
                      <span className="text-xs text-gray-500 font-bold">
                  {view === 'sagittal' ? 'R' : view === 'coronal' ? 'A' : 'L'}
                </span>
                    </div>
                  </div>
                </div>
            ))}
          </div>
        </div>

        {/* Side Panel */}
        <div className={`bg-gray-900 border-l border-gray-800 w-80 flex flex-col transition-all duration-300 ${isPanelOpen ? 'translate-x-0' : 'translate-x-full absolute right-0 h-full'}`}>
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
            <div>
              <h2 className="font-semibold text-white text-sm">{selectedRegion?.name || 'Select a region'}</h2>
              {selectedRegion && (
                  <span className="text-xs text-gray-500">ID: {selectedRegion.id}</span>
              )}
            </div>
            <button
                onClick={() => { setIsPanelOpen(false); setWordCloudData(null); }}
                className="text-gray-500 hover:text-white text-xl leading-none transition-colors"
            >
              ×
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {selectedRegion ? (
                <>
                  {ancestors.length > 0 && (
                      <div>
                        <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Hierarchy</h3>
                        <div className="flex flex-wrap gap-1 text-xs text-gray-300">
                          {ancestors.map((ancestor, idx) => (
                              <React.Fragment key={ancestor.mba_id}>
                      <span className={idx === ancestors.length - 1 ? 'text-blue-400 font-medium' : ''}>
                        {ancestor.acronym || ancestor.name}
                      </span>
                                {idx < ancestors.length - 1 && <span className="text-gray-600">›</span>}
                              </React.Fragment>
                          ))}
                        </div>
                      </div>
                  )}

                  <div>
                    <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Basic
                      Information</h3>
                    <div className="bg-gray-800 rounded-lg p-3 space-y-1 text-sm">
                      <p><span className="text-gray-400">Region:</span> <span
                          className="text-white">{selectedRegion.name}</span></p>
                      <p><span className="text-gray-400">ID:</span> <span
                          className="text-white">{selectedRegion.id}</span></p>
                      <p><span className="text-gray-400">View:</span> <span
                          className="text-white">{selectedRegion.view}</span></p>
                      <p><span className="text-gray-400">Slice:</span> <span
                          className="text-white">{selectedRegion.slice}</span></p>
                    </div>
                  </div>

                  {aiResults && (
                      <div>
                        <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
                          AI Matched Regions
                        </h3>
                        <div className="space-y-2">
                          {aiResults.matched_regions.map((r, i) => {
                            const name = regionMap[r.region_id] || "Unknown region";
                            const isActive = selectedRegion?.id === r.region_id;
                            return (
                                <button
                                    key={i}
                                    onClick={async () => {
                                      setSelectedRegion({ name, id: r.region_id, view: "AI", slice: "-" });
                                      setRegionInfo(`AI suggests: ${name}`);
                                      generateWordCloud(name);

                                      const updatedSlices = {};
                                      for (const view of ["sagittal", "coronal", "transverse"]) {
                                        const sliceIndex = await findRegionInView(r.region_id, view);
                                        if (sliceIndex !== null) {
                                          updatedSlices[view] = sliceIndex;
                                        }
                                      }

                                      setSlices(prev => ({ ...prev, ...updatedSlices }));

                                      setTimeout(() => {
                                        Object.keys(canvasRefs).forEach(v => {
                                          if (labelDataRefs[v].current) {
                                            highlightRegion(r.region_id, v);
                                          }
                                        });
                                      }, 300);
                                    }}
                                    className={`w-full text-left rounded-lg p-3 text-sm transition-colors border ${
                                        isActive
                                            ? 'bg-blue-900/40 border-blue-600'
                                            : 'bg-gray-800 border-gray-700 hover:border-gray-500'
                                    }`}
                                >
                                  <div className="flex items-center justify-between mb-1">
                                    <span className="text-white font-medium">{name}</span>
                                    <span className={`text-xs font-semibold px-1.5 py-0.5 rounded ${
                                        r.confidence > 0.75 ? 'bg-green-900 text-green-400' :
                                            r.confidence > 0.4  ? 'bg-yellow-900 text-yellow-400' :
                                                'bg-red-900 text-red-400'
                                    }`}>
                {(r.confidence * 100).toFixed(0)}%
              </span>
                                  </div>
                                  <p className="text-gray-400 text-xs leading-relaxed">{r.reason}</p>
                                </button>
                            );
                          })}
                        </div>
                        {aiResults.uncertainty_note && (
                            <p className="text-xs text-gray-500 italic mt-2">{aiResults.uncertainty_note}</p>
                        )}
                      </div>
                  )}
                  <div>
                    <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
                      Word Cloud
                    </h3>
                    {isLoadingCloud && (
                        <p className="text-gray-500 text-sm">Generating...</p>
                    )}
                    {wordCloudData && wordCloudData.length > 0 && (
                        <div className="bg-gray-800 rounded-lg overflow-hidden">
                          <WordCloud
                              data={wordCloudData}
                              width={280}
                              height={180}
                              fontSize={(word) => Math.log2(word.value) * 10}
                              rotate={(word) => (word.value % 2 === 0 ? 0 : -90)}
                              padding={2}
                          />
                        </div>
                    )}
                  </div>

                  <div>
                    <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">External
                      Resources</h3>

                    href={`https://atlas.brain-map.org/atlas?atlas=602630314#atlas=${selectedRegion.id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-400 hover:text-blue-300 text-sm underline underline-offset-2 transition-colors"
                    <a>
                      View in Allen Brain Atlas →
                    </a>
                  </div>
                </>
            ) : (
                <div className="text-gray-500 text-sm text-center mt-8">Click on a brain region to see details</div>
            )}
          </div>
        </div>

        {/* Error Popup */}
        {errorMessage && (
            <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
              <div className="bg-gray-900 border border-red-800 rounded-xl p-6 max-w-sm w-full mx-4 shadow-2xl">
                <h3 className="text-red-400 font-semibold mb-2">⚠ API Error</h3>
                <p className="text-gray-300 text-sm mb-4">{errorMessage}</p>
                <button
                    onClick={() => setErrorMessage(null)}
                    className="bg-red-600 hover:bg-red-500 text-white text-sm px-4 py-2 rounded-md transition-colors"
                >
                  Close
                </button>
              </div>
            </div>
        )}
      </div>
  );
}

export default TwoDBrain;