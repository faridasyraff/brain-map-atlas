import React, { useState, useEffect, useRef } from 'react';
import '../styles/SingleView.css';

function SagittalView() {
  const [slice, setSlice] = useState(570); // Middle of Z-axis
  const [maxSlice] = useState(1139); // Z-axis: 1140 slices (0-1139)
  const [regionInfo, setRegionInfo] = useState('Click a brain region');
  const [isPanelOpen, setIsPanelOpen] = useState(false);
  const [selectedRegion, setSelectedRegion] = useState(null);
  const [regionMap, setRegionMap] = useState({});
  
  const canvasRef = useRef(null);
  const brainImgRef = useRef(new Image());
  const labelImgRef = useRef(new Image());
  const labelDataRef = useRef(null);
  const dimensionsRef = useRef({ width: 0, height: 0 });

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
      })
      .catch(err => console.error('Error loading CSV:', err));
  }, []);

  // Load slice images
  const loadSliceImages = (sliceIndex) => {
    const brainImg = brainImgRef.current;
    const labelImg = labelImgRef.current;

    brainImg.src = `/slices/sagittal/brain_${String(sliceIndex).padStart(4, '0')}.png`;
    labelImg.src = `/slices/sagittal/labels_${String(sliceIndex).padStart(4, '0')}.png`;

    brainImg.onload = () => {
      const canvas = canvasRef.current;
      if (canvas) {
        canvas.width = brainImg.width;
        canvas.height = brainImg.height;
        redraw();
      }
    };

    labelImg.onload = () => {
      const width = labelImg.width;
      const height = labelImg.height;
      dimensionsRef.current = { width, height };

      const offCanvas = document.createElement('canvas');
      offCanvas.width = width;
      offCanvas.height = height;
      const offCtx = offCanvas.getContext('2d');
      offCtx.drawImage(labelImg, 0, 0);

      labelDataRef.current = offCtx.getImageData(0, 0, width, height);
      redraw();
    };
  };

  useEffect(() => {
    loadSliceImages(slice);
  }, [slice]);

  const pixelToAnnotationId = (r, g, b) => {
    return b + (g << 8) + (r << 16);
  };

  const rgbToKey = (r, g, b) => {
    return (r << 16) | (g << 8) | b;
  };

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

  const redraw = () => {
    const canvas = canvasRef.current;
    const brainImg = brainImgRef.current;
    const labelData = labelDataRef.current;
    
    if (!canvas || !brainImg.complete || !labelData) return;

    const ctx = canvas.getContext('2d');
    
    // Rotate 180 degrees
    ctx.save();
    ctx.translate(canvas.width, canvas.height);
    ctx.rotate(Math.PI);
    ctx.drawImage(brainImg, 0, 0);
    ctx.restore();
    
    drawRegionOutlines(ctx);
  };

  const drawRegionOutlines = (ctx) => {
    const labelData = labelDataRef.current;
    if (!labelData) return;

    const { width, height } = dimensionsRef.current;
    const processedLabelData = rotateImageData180(labelData, width, height);

    ctx.save();
    ctx.fillStyle = 'black';
    ctx.globalAlpha = 0.8;

    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const i = (y * width + x) * 4;

        const key = rgbToKey(
          processedLabelData.data[i],
          processedLabelData.data[i + 1],
          processedLabelData.data[i + 2]
        );

        const neighbors = [
          i - width * 4,
          i + width * 4,
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

  const highlightRegion = (targetId) => {
    const canvas = canvasRef.current;
    const brainImg = brainImgRef.current;
    const labelData = labelDataRef.current;
    const ctx = canvas.getContext('2d');
    const { width, height } = dimensionsRef.current;

    // Redraw the brain image with rotation
    ctx.save();
    ctx.translate(canvas.width, canvas.height);
    ctx.rotate(Math.PI);
    ctx.drawImage(brainImg, 0, 0);
    ctx.restore();

    const processedLabelData = rotateImageData180(labelData, width, height);

    ctx.globalAlpha = 0.4;
    ctx.fillStyle = 'red';

    for (let i = 0; i < processedLabelData.data.length; i += 4) {
      const r = processedLabelData.data[i];
      const g = processedLabelData.data[i + 1];
      const b = processedLabelData.data[i + 2];

      if (pixelToAnnotationId(r, g, b) === targetId) {
        const p = i / 4;
        ctx.fillRect(p % width, Math.floor(p / width), 1, 1);
      }
    }

    ctx.globalAlpha = 1.0;
    drawRegionOutlines(ctx);
  };

  const handleCanvasClick = (e) => {
    const labelData = labelDataRef.current;
    if (!labelData) return;

    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const { width, height } = dimensionsRef.current;

    let canvasX = Math.floor((e.clientX - rect.left) * canvas.width / rect.width);
    let canvasY = Math.floor((e.clientY - rect.top) * canvas.height / rect.height);

    // Convert back from 180 degree rotation
    const x = width - 1 - canvasX;
    const y = height - 1 - canvasY;

    const i = (y * width + x) * 4;
    const r = labelData.data[i];
    const g = labelData.data[i + 1];
    const b = labelData.data[i + 2];

    const annotationId = pixelToAnnotationId(r, g, b);
    const name = regionMap[annotationId] || 'Unknown region';

    setRegionInfo(name);
    setSelectedRegion({ name, id: annotationId, slice });
    setIsPanelOpen(true);

    setTimeout(() => {
      if (labelDataRef.current) {
        highlightRegion(annotationId);
      }
    }, 100);
  };

  return (
    <div className="single-view-container">
      <div className="single-view-content">
        <div className="single-view-header">
          <button 
            className="back-btn"
            onClick={() => window.location.href = '/2D-brain'}
          >
            ← Back to 3-Plane View
          </button>
          <h1>Sagittal View</h1>
        </div>
        
        <div className="single-view-panel">
          <div className="view-controls">
            <input
              type="range"
              className="slice-slider-large"
              min="0"
              max={maxSlice}
              value={slice}
              step="1"
              onChange={(e) => setSlice(parseInt(e.target.value))}
            />
            <div className="brain-icon-container">
              <div className="brain-icon-wrapper">
                <img src="/images/brain-icon2.png" alt="brain" className="brain-slice-icon" />
                <div
                  className="brain-slice-indicator-sagittal"
                  style={{ left: `${((slice / maxSlice) * 70) + 15}%` }}
                />
              </div>
              <span className="slice-label-large">{slice} / {maxSlice}</span>
            </div>
          </div>
          
          <div className="canvas-wrapper">
            <canvas
              ref={canvasRef}
              className="brain-canvas-large"
              onClick={handleCanvasClick}
            />
            <div className="canvas-labels">
              <span className="label-left">L</span>
              <span className="label-right">R</span>
            </div>
          </div>
        </div>

        <h2 className="region-info-display">{regionInfo}</h2>
      </div>

      {/* Description Panel */}
      <div className={`info-panel ${isPanelOpen ? 'open' : ''}`}>
        <div className="panel-header">
          <button className="close-btn" onClick={() => setIsPanelOpen(false)}>×</button>
          <h2>{selectedRegion?.name || 'Select a region'}</h2>
          <div className="region-id">
            {selectedRegion ? `ID: ${selectedRegion.id}` : ''}
          </div>
        </div>
        <div className="panel-content">
          {selectedRegion ? (
            <>
              <div className="info-section">
                <h3>Basic Information</h3>
                <p><strong>Region:</strong> {selectedRegion.name}</p>
                <p><strong>Annotation ID:</strong> {selectedRegion.id}</p>
                <p><strong>View:</strong> Sagittal</p>
                <p><strong>Slice:</strong> {selectedRegion.slice}</p>
              </div>
              
              <div className="info-section">
                <h3>Description</h3>
                <p>This is the <strong>{selectedRegion.name}</strong> region of the mouse brain.</p>
              </div>
              
              <div className="info-section">
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
            <div className="loading">Click on a brain region to see details</div>
          )}
        </div>
      </div>
    </div>
  );
}

export default SagittalView;