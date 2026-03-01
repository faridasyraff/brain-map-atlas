import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';

function CoronalView() {
  const navigate = useNavigate();
  const [slice, setSlice] = useState(660);
  const [maxSlice] = useState(1319);
  const [regionInfo, setRegionInfo] = useState('Click a brain region');
  const [isPanelOpen, setIsPanelOpen] = useState(false);
  const [selectedRegion, setSelectedRegion] = useState(null);
  const [regionMap, setRegionMap] = useState({});

  const canvasRef = useRef(null);
  const brainImgRef = useRef(new Image());
  const labelImgRef = useRef(new Image());
  const labelDataRef = useRef(null);
  const dimensionsRef = useRef({ width: 0, height: 0 });

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
              else if (c === ',' && !inQuotes) { result.push(current.trim()); current = ''; }
              else current += c;
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

  useEffect(() => {
    const brainImg = brainImgRef.current;
    const labelImg = labelImgRef.current;

    brainImg.src = `/slices/coronal/brain_${String(slice).padStart(4, '0')}.png`;
    labelImg.src = `/slices/coronal/labels_${String(slice).padStart(4, '0')}.png`;

    let brainLoaded = false;
    let labelLoaded = false;

    const checkBothLoaded = () => { if (brainLoaded && labelLoaded) redraw(); };

    brainImg.onload = () => { brainLoaded = true; checkBothLoaded(); };
    labelImg.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = labelImg.width;
      canvas.height = labelImg.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(labelImg, 0, 0);
      labelDataRef.current = ctx.getImageData(0, 0, labelImg.width, labelImg.height);
      dimensionsRef.current = { width: labelImg.width, height: labelImg.height };
      labelLoaded = true;
      checkBothLoaded();
    };
  }, [slice]);

  const pixelToAnnotationId = (r, g, b) => b + (g << 8) + (r << 16);
  const rgbToKey = (r, g, b) => (r << 16) | (g << 8) | b;

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

  const redraw = () => {
    const canvas = canvasRef.current;
    const brainImg = brainImgRef.current;
    const labelData = labelDataRef.current;
    if (!canvas || !brainImg.complete || !labelData) return;
    const ctx = canvas.getContext('2d');
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
    drawRegionOutlines(ctx);
  };

  const drawRegionOutlines = (ctx) => {
    const labelData = labelDataRef.current;
    if (!labelData) return;
    const { width, height } = dimensionsRef.current;
    const processedLabelData = rotateImageData90CW(labelData, width, height);
    const processedWidth = height;
    const processedHeight = width;
    ctx.save();
    ctx.fillStyle = 'black';
    ctx.globalAlpha = 0.8;
    for (let y = 1; y < processedHeight - 1; y++) {
      for (let x = 1; x < processedWidth - 1; x++) {
        const i = (y * processedWidth + x) * 4;
        const key = rgbToKey(processedLabelData.data[i], processedLabelData.data[i + 1], processedLabelData.data[i + 2]);
        const neighbors = [i - processedWidth * 4, i + processedWidth * 4, i - 4, i + 4];
        for (const n of neighbors) {
          const nk = rgbToKey(processedLabelData.data[n], processedLabelData.data[n + 1], processedLabelData.data[n + 2]);
          if (nk !== key) { ctx.fillRect(x, y, 1, 1); break; }
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
    const processedLabelData = rotateImageData90CW(labelData, width, height);
    const processedWidth = height;
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
    drawRegionOutlines(ctx);
  };

  const handleCanvasClick = (e) => {
    const labelData = labelDataRef.current;
    if (!labelData) return;
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const { width, height } = dimensionsRef.current;
    const canvasX = Math.floor((e.clientX - rect.left) * canvas.width / rect.width);
    const canvasY = Math.floor((e.clientY - rect.top) * canvas.height / rect.height);
    const x = canvasY;
    const y = height - 1 - canvasX;
    const i = (y * width + x) * 4;
    const r = labelData.data[i];
    const g = labelData.data[i + 1];
    const b = labelData.data[i + 2];
    const annotationId = pixelToAnnotationId(r, g, b);
    const name = regionMap[annotationId] || 'Unknown region';
    setRegionInfo(name);
    setSelectedRegion({ name, id: annotationId, slice });
    setIsPanelOpen(true);
    setTimeout(() => { if (labelDataRef.current) highlightRegion(annotationId); }, 100);
  };

  return (
      <div className="flex h-screen bg-gray-950 text-white overflow-hidden">

        {/* Main Content */}
        <div className="flex flex-col flex-1 overflow-hidden">

          {/* Header */}
          <div className="bg-gray-900 border-b border-gray-800 px-6 py-4 flex items-center gap-4">
            <button
                onClick={() => navigate('/2D-brain')}
                className="text-gray-400 hover:text-white text-sm border border-gray-700 hover:border-gray-500 px-3 py-2 rounded-md transition-colors"
            >
              ← Back to 3-Plane View
            </button>
            <h1 className="text-xl font-bold text-white">Coronal View</h1>
          </div>

          {/* Region Info Bar */}
          <div className="bg-gray-900/50 border-b border-gray-800 px-6 py-2">
            <span className="text-sm text-blue-400 font-medium">{regionInfo}</span>
          </div>

          {/* Slider */}
          <div className="bg-gray-900 border-b border-gray-800 px-6 py-3 flex items-center gap-4">
            <span className="text-xs text-gray-400 w-8">0</span>
            <input
                type="range"
                min="0"
                max={maxSlice}
                value={slice}
                step="1"
                onChange={(e) => setSlice(parseInt(e.target.value))}
                className="flex-1 accent-blue-500"
            />
            <span className="text-xs text-gray-400 w-8 text-right">{maxSlice}</span>
            <span className="text-sm text-white font-medium w-20 text-right">
            Slice: {slice}
          </span>
          </div>

          {/* Canvas */}
          <div className="relative flex-1 flex items-center justify-center bg-black overflow-hidden">
            <canvas
                ref={canvasRef}
                className="max-w-full max-h-full object-contain cursor-crosshair"
                onClick={handleCanvasClick}
            />
            <div className="absolute inset-0 pointer-events-none flex items-center justify-between px-4">
              <span className="text-sm text-gray-500 font-bold">P</span>
              <span className="text-sm text-gray-500 font-bold">A</span>
            </div>
          </div>
        </div>

        {/* Side Panel */}
        <div className={`bg-gray-900 border-l border-gray-800 w-80 flex flex-col transition-all duration-300 ${isPanelOpen ? 'translate-x-0' : 'translate-x-full absolute right-0 h-full'}`}>
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
            <div>
              <h2 className="font-semibold text-white text-sm">{selectedRegion?.name || 'Select a region'}</h2>
              {selectedRegion && <span className="text-xs text-gray-500">ID: {selectedRegion.id}</span>}
            </div>
            <button
                onClick={() => setIsPanelOpen(false)}
                className="text-gray-500 hover:text-white text-xl leading-none transition-colors"
            >
              ×
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {selectedRegion ? (
                <>
                <div>
                  <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Basic Information</h3>
                  <div className="bg-gray-800 rounded-lg p-3 space-y-1 text-sm">
                    <p><span className="text-gray-400">Region:</span> <span className="text-white">{selectedRegion.name}</span></p>
                    <p><span className="text-gray-400">ID:</span> <span className="text-white">{selectedRegion.id}</span></p>
                    <p><span className="text-gray-400">View:</span> <span className="text-white">Coronal</span></p>
                    <p><span className="text-gray-400">Slice:</span> <span className="text-white">{selectedRegion.slice}</span></p>
                  </div>
                </div>

                <div>
                  <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">External Resources</h3>

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
      </div>
  );
}

export default CoronalView;