import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import './2Dbrain.css';

function TwoDBrain() {
  const navigate = useNavigate();
  const [question, setQuestion] = useState("");
  const [aiResults, setAiResults] = useState(null);
  const [isLoadingAI, setIsLoadingAI] = useState(false);
  const [regionSearch, setRegionSearch] = useState("");



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
    setIsPanelOpen(true);

    setTimeout(() => {
      Object.keys(updatedSlices).forEach(view => {
        highlightRegion(regionId, view);
      });
    }, 300);
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
      const response = await fetch("http://localhost:5001/api/ask-ai", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ question })
      });

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
        setIsPanelOpen(true);

        setTimeout(() => {
          Object.keys(updatedSlices).forEach(view => {
            highlightRegion(topRegion, view);
          });
        }, 300);
      }


    } catch (err) {
      console.error("AI request failed:", err);
    }

    setIsLoadingAI(false);
  };


  return (
    <div className="brain-2d-container">
      <div className="brain-main-content">
        <div className="brain-header">
          <h1>3-Plane Brain Atlas Viewer</h1>
          <div className="brain-ai-search">
            <div className="brain-region-search">
              <input
                  type="text"
                  placeholder="Search region by name..."
                  value={regionSearch}
                  onChange={(e) => setRegionSearch(e.target.value)}
                  className="ai-input"
              />
              <button onClick={handleRegionSearch}>
                Search
              </button>
            </div>

            <input
                type="text"
                placeholder="Ask a neuroscience question..."
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                className="ai-input"
            />
            <button onClick={handleAskAI} disabled={isLoadingAI}>
              {isLoadingAI ? "Thinking..." : "Ask AI"}
            </button>
          </div>

          <div className="brain-view-buttons">
            <button
                className="view-nav-btn"
                onClick={() => navigate('/sagittal')}
            >
              Sagittal View
            </button>
            <button
                className="view-nav-btn"
                onClick={() => navigate('/coronal')}
            >
              Coronal View
            </button>
            <button
                className="view-nav-btn"
                onClick={() => navigate('/transverse')}
            >
              Transverse View
            </button>
          </div>
        </div>

        <div className="brain-views-grid">
          {/* Sagittal View (was Axial) - Rotated 180 degrees */}
          <div className="brain-view-panel">
            <div className="brain-view-header">
              <h2>Sagittal</h2>
              <div className="brain-controls">
                <input
                    type="range"
                  className="slice-slider"
                  min="0"
                  max={maxSlices.sagittal}
                  value={slices.sagittal}
                  step="1"
                  onChange={(e) => handleSliceChange('sagittal', e.target.value)}
                />
                <span className="slice-label">{slices.sagittal}</span>
              </div>
            </div>
            <canvas
              ref={canvasRefs.sagittal}
              className="brain-canvas"
              onClick={(e) => handleCanvasClick(e, 'sagittal')}
            />
            <div className="brain-view-labels">
              <span className="label-left">L</span>
              <span className="label-right">R</span>
            </div>
          </div>

          {/* Coronal View (was Sagittal) - Rotated 90 degrees clockwise */}
          <div className="brain-view-panel">
            <div className="brain-view-header">
              <h2>Coronal</h2>
              <div className="brain-controls">
                <input
                  type="range"
                  className="slice-slider"
                  min="0"
                  max={maxSlices.coronal}
                  value={slices.coronal}
                  step="1"
                  onChange={(e) => handleSliceChange('coronal', e.target.value)}
                />
                <span className="slice-label">{slices.coronal}</span>
              </div>
            </div>
            <canvas
              ref={canvasRefs.coronal}
              className="brain-canvas"
              onClick={(e) => handleCanvasClick(e, 'coronal')}
            />
            <div className="brain-view-labels">
              <span className="label-left">P</span>
              <span className="label-right">A</span>
            </div>
          </div>

          {/* Transverse View (was Coronal) - Rotated 90 degrees clockwise */}
          <div className="brain-view-panel">
            <div className="brain-view-header">
              <h2>Transverse</h2>
              <div className="brain-controls">
                <input
                  type="range"
                  className="slice-slider"
                  min="0"
                  max={maxSlices.transverse}
                  value={slices.transverse}
                  step="1"
                  onChange={(e) => handleSliceChange('transverse', e.target.value)}
                />
                <span className="slice-label">{slices.transverse}</span>
              </div>
            </div>
            <canvas
              ref={canvasRefs.transverse}
              className="brain-canvas"
              onClick={(e) => handleCanvasClick(e, 'transverse')}
            />
            <div className="brain-view-labels">
              <span className="label-left">R</span>
              <span className="label-right">L</span>
            </div>
          </div>
        </div>

        <h2 className="region-info-main">{regionInfo}</h2>
      </div>

      {/* Description Panel */}
      <div className={`brain-description-panel ${isPanelOpen ? 'open' : ''}`}>
        <div className="brain-panel-header">
          <button className="brain-close-btn" onClick={() => setIsPanelOpen(false)}>×</button>
          <h2>{selectedRegion?.name || 'Select a region'}</h2>
          <div className="brain-region-id">
            {selectedRegion ? `ID: ${selectedRegion.id}` : ''}
          </div>
        </div>
        <div className="brain-panel-content">
          {selectedRegion ? (
            <>
              {ancestors.length > 0 && (
                <div className="brain-info-section">
                  <h3>Hierarchy</h3>
                  <div className="brain-breadcrumb">
                    {ancestors.map((ancestor, idx) => (
                      <React.Fragment key={ancestor.mba_id}>
                        <span className={idx === ancestors.length - 1 ? 'breadcrumb-active' : ''}>
                          {ancestor.acronym || ancestor.name}
                        </span>
                        {idx < ancestors.length - 1 && <span className="breadcrumb-sep"> > </span>}
                      </React.Fragment>
                    ))}
                  </div>
                </div>
              )}

              <div className="brain-info-section">
                <h3>Basic Information</h3>
                <p><strong>Region:</strong> {selectedRegion.name}</p>
                <p><strong>Annotation ID:</strong> {selectedRegion.id}</p>
                <p><strong>View:</strong> {selectedRegion.view}</p>
                <p><strong>Slice:</strong> {selectedRegion.slice}</p>
              </div>
              
              <div className="brain-info-section">
                <h3>Description</h3>
                <p>This is the <strong>{selectedRegion.name}</strong> region of the mouse brain.</p>
                {aiResults && (
                    <div className="brain-info-section">
                      <h3>AI Results</h3>
                      {aiResults.matched_regions.map((r, i) => (
                          <div key={i}>
                            <p>
                              <strong>ID:</strong> {r.region_id}<br />
                              <strong>Confidence:</strong> {(r.confidence * 100).toFixed(1)}%<br />
                              <strong>Reason:</strong> {r.reason}
                            </p>
                          </div>
                      ))}
                      <p><em>{aiResults.uncertainty_note}</em></p>
                    </div>
                )}

              </div>
              
              <div className="brain-info-section">
                <h3>External Resources</h3>
                <p>
                  <a
                    href={`https://atlas.brain-map.org/atlas?atlas=602630314#atlas=${selectedRegion.id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    View in Allen Brain Atlas →
                  </a>
                </p>
              </div>
            </>
          ) : (
            <div className="brain-loading">Click on a brain region to see details</div>
          )}
        </div>
      </div>
    </div>
  );
}

export default TwoDBrain;