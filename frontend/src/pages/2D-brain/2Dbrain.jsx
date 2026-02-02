import React, { useState, useEffect, useRef } from 'react';
import './2Dbrain.css';

function TwoDBrain() {
  const [currentSlice, setCurrentSlice] = useState(400);
  const [regionInfo, setRegionInfo] = useState('Click a brain region');
  const [isPanelOpen, setIsPanelOpen] = useState(false);
  const [selectedRegion, setSelectedRegion] = useState(null);
  const [regionMap, setRegionMap] = useState({});
  const [labelData, setLabelData] = useState(null);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });

  const canvasRef = useRef(null);
  const brainImgRef = useRef(new Image());
  const labelImgRef = useRef(new Image());

  const MAX_SLICES = 799;

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

  // Load slice images
  useEffect(() => {
    const brainImg = brainImgRef.current;
    const labelImg = labelImgRef.current;

    brainImg.src = `/slices/brain_${String(currentSlice).padStart(3, '0')}.png`;
    labelImg.src = `/slices/labels_${String(currentSlice).padStart(3, '0')}.png`;

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
      setDimensions({ width, height });

      const offCanvas = document.createElement('canvas');
      offCanvas.width = width;
      offCanvas.height = height;
      const offCtx = offCanvas.getContext('2d');
      offCtx.drawImage(labelImg, 0, 0);

      setLabelData(offCtx.getImageData(0, 0, width, height));
      redraw();
    };
  }, [currentSlice]);

  // Helper functions
  const pixelToAnnotationId = (r, g, b) => {
    return b + (g << 8) + (r << 16);
  };

  const rgbToKey = (r, g, b) => {
    return (r << 16) | (g << 8) | b;
  };

  const redraw = () => {
    const canvas = canvasRef.current;
    const brainImg = brainImgRef.current;
    
    if (!canvas || !brainImg.complete || !labelData) return;

    const ctx = canvas.getContext('2d');
    ctx.drawImage(brainImg, 0, 0);
    drawRegionOutlines(ctx);
  };

  const drawRegionOutlines = (ctx) => {
    if (!labelData) return;

    const { width, height } = dimensions;

    ctx.save();
    ctx.fillStyle = 'black';
    ctx.globalAlpha = 0.8;

    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const i = (y * width + x) * 4;

        const key = rgbToKey(
          labelData.data[i],
          labelData.data[i + 1],
          labelData.data[i + 2]
        );

        const neighbors = [
          i - width * 4,
          i + width * 4,
          i - 4,
          i + 4
        ];

        for (const n of neighbors) {
          const nk = rgbToKey(
            labelData.data[n],
            labelData.data[n + 1],
            labelData.data[n + 2]
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
    const ctx = canvas.getContext('2d');
    const { width, height } = dimensions;

    ctx.drawImage(brainImg, 0, 0);

    ctx.globalAlpha = 0.4;
    ctx.fillStyle = 'red';

    for (let i = 0; i < labelData.data.length; i += 4) {
      const r = labelData.data[i];
      const g = labelData.data[i + 1];
      const b = labelData.data[i + 2];

      if (pixelToAnnotationId(r, g, b) === targetId) {
        const p = i / 4;
        ctx.fillRect(p % width, Math.floor(p / width), 1, 1);
      }
    }

    ctx.globalAlpha = 1.0;
    drawRegionOutlines(ctx);
  };

  const handleCanvasClick = (e) => {
    if (!labelData) return;

    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const { width, height } = dimensions;

    const x = Math.floor((e.clientX - rect.left) * width / rect.width);
    const y = Math.floor((e.clientY - rect.top) * height / rect.height);

    const i = (y * width + x) * 4;
    const r = labelData.data[i];
    const g = labelData.data[i + 1];
    const b = labelData.data[i + 2];

    const annotationId = pixelToAnnotationId(r, g, b);
    const name = regionMap[annotationId] || 'Unknown region';

    setRegionInfo(name);
    setSelectedRegion({ name, id: annotationId });
    setIsPanelOpen(true);

    console.log('Clicked:', name, annotationId);

    highlightRegion(annotationId);
  };

  return (
    <div className="brain-2d-container">
      <div className="brain-main-content">
        <h1>2D Brain Atlas Viewer</h1>
        
        <div className="brain-controls">
          <input
            type="range"
            className="slice-slider"
            min="0"
            max={MAX_SLICES}
            value={currentSlice}
            step="1"
            onChange={(e) => setCurrentSlice(parseInt(e.target.value))}
          />
          <span className="slice-label">Slice: {currentSlice}</span>
        </div>

        <h2 className="region-info">{regionInfo}</h2>
        
        <canvas
          ref={canvasRef}
          className="brain-canvas"
          onClick={handleCanvasClick}
        />
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
              <div className="brain-info-section">
                <h3>Basic Information</h3>
                <p><strong>Region:</strong> {selectedRegion.name}</p>
                <p><strong>Annotation ID:</strong> {selectedRegion.id}</p>
                <p><strong>Slice:</strong> {currentSlice}</p>
              </div>
              
              <div className="brain-info-section">
                <h3>Description</h3>
                <p>This is the <strong>{selectedRegion.name}</strong> region of the mouse brain.</p>
              </div>
              
              <div className="brain-info-section">
                <h3>External Resources</h3>
                <p>
                  
                    href={`https://atlas.brain-map.org/atlas?atlas=602630314#atlas=${selectedRegion.id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  <a>
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