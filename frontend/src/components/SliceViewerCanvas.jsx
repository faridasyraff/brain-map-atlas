/**
 * Slice Viewer Canvas Component
 * Renders anatomy slice with click detection using label slice
 */
import React, { useEffect, useRef, useState } from 'react';
import { brainApi } from '../api/brainApi.js';

const SliceViewerCanvas = ({ sliceIndex, onRegionSelected, onLoadingChange }) => {
  const canvasRef = useRef(null);
  const offscreenCanvasRef = useRef(null);
  const anatomyImgRef = useRef(new Image());
  const labelImgRef = useRef(new Image());
  const [isLoading, setIsLoading] = useState(true);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  const [labelData, setLabelData] = useState(null);

  const MAX_SLICES = 799;

  /**
   * Load slices whenever sliceIndex changes
   */
  useEffect(() => {
    const loadSlices = async () => {
      setIsLoading(true);
      onLoadingChange?.(true);

      const sliceStr = String(sliceIndex).padStart(3, '0');
      
      // Load anatomy image
      anatomyImgRef.current.src = `/slices/brain_${sliceStr}.png`;
      
      // Load label image
      labelImgRef.current.src = `/slices/labels_${sliceStr}.png`;
    };

    loadSlices();
  }, [sliceIndex, onLoadingChange]);

  /**
   * Setup canvas and image load handlers
   */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const anatomy = anatomyImgRef.current;
    const label = labelImgRef.current;

    // Anatomy image loaded
    anatomy.onload = () => {
      canvas.width = anatomy.width;
      canvas.height = anatomy.height;
      setDimensions({ width: anatomy.width, height: anatomy.height });
      redraw();
    };

    // Label image loaded
    label.onload = () => {
      const width = label.width;
      const height = label.height;

      // Create offscreen canvas for label data
      if (!offscreenCanvasRef.current) {
        offscreenCanvasRef.current = document.createElement('canvas');
      }
      const offscreen = offscreenCanvasRef.current;
      offscreen.width = width;
      offscreen.height = height;

      const ctx = offscreen.getContext('2d');
      ctx.drawImage(label, 0, 0);

      const imageData = ctx.getImageData(0, 0, width, height);
      setLabelData(imageData);
      setIsLoading(false);
      onLoadingChange?.(false);

      redraw();
    };

    // Error handlers
    anatomy.onerror = () => {
      console.error(`Failed to load anatomy slice: brain_${String(sliceIndex).padStart(3, '0')}.png`);
      setIsLoading(false);
      onLoadingChange?.(false);
    };

    label.onerror = () => {
      console.error(`Failed to load label slice: labels_${String(sliceIndex).padStart(3, '0')}.png`);
      setIsLoading(false);
      onLoadingChange?.(false);
    };
  }, [onLoadingChange, sliceIndex]);

  /**
   * Redraw canvas with anatomy image
   */
  const redraw = () => {
    const canvas = canvasRef.current;
    const anatomy = anatomyImgRef.current;

    if (!canvas || !anatomy.complete) return;

    const ctx = canvas.getContext('2d');
    ctx.drawImage(anatomy, 0, 0);
  };

  // Encode pixel RGB into combined annotation id (matches original pipeline)
  const pixelToAnnotationId = (r, g, b) => {
    return (b) + (g << 8) + (r << 16);
  };

  // Highlight an annotation by drawing semi-transparent overlay on matching pixels
  const highlightRegion = (targetAnnotationId) => {
    if (!labelData) return;
    const canvas = canvasRef.current;
    const anatomy = anatomyImgRef.current;
    if (!canvas || !anatomy.complete) return;

    const ctx = canvas.getContext('2d');
    const { width, height } = dimensions;

    // Draw base anatomy first
    ctx.drawImage(anatomy, 0, 0);

    ctx.globalAlpha = 0.4;
    ctx.fillStyle = 'red';

    for (let i = 0; i < labelData.data.length; i += 4) {
      const r = labelData.data[i];
      const g = labelData.data[i + 1];
      const b = labelData.data[i + 2];

      if (pixelToAnnotationId(r, g, b) === targetAnnotationId) {
        const p = i / 4;
        ctx.fillRect(p % width, Math.floor(p / width), 1, 1);
      }
    }

    ctx.globalAlpha = 1.0;
  };

  /**
   * Handle canvas click - map to pixel and lookup region
   */
  const handleCanvasClick = async (e) => {
    if (!labelData) return;

    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const { width, height } = dimensions;

    // Map mouse position to image coordinates
    const pixelX = Math.floor((e.clientX - rect.left) * (width / rect.width));
    const pixelY = Math.floor((e.clientY - rect.top) * (height / rect.height));

    // Clamp to bounds
    const x = Math.max(0, Math.min(pixelX, width - 1));
    const y = Math.max(0, Math.min(pixelY, height - 1));

    // Read RGB from label image data
    const i = (y * width + x) * 4;
    const r = labelData.data[i];
    const g = labelData.data[i + 1];
    const b = labelData.data[i + 2];

    console.log(`Clicked at pixel (${x}, ${y}) → RGB(${r}, ${g}, ${b})`);

    // Compute annotation id encoded in label PNGs
    const annotationId = pixelToAnnotationId(r, g, b);

    // Call API to get region info by annotation id, fallback to RGB lookup
    setIsLoading(true);
    try {
      let region = null;

      // Prefer annotation lookup (matches label encoding)
      if (annotationId && annotationId !== 0) {
        region = await brainApi.getRegionByAnnotation(annotationId);
      }

      // Fallback: try direct RGB lookup (backwards compatibility)
      if (!region && !(r === 0 && g === 0 && b === 0)) {
        region = await brainApi.getRegionByRGB(r, g, b);
      }

      // If region found and annotationId is available, highlight using annotation id
      if (region) {
        // If region includes annotation_id use it, otherwise use computed annotationId
        const targetId = region.annotation_id || annotationId;
        if (targetId) highlightRegion(targetId);
      }

      onRegionSelected({
        region,
        pixelRGB: { r, g, b },
        pixelCoords: { x, y }
      });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div style={styles.container}>
      <div style={styles.canvasWrapper}>
        {isLoading && <div style={styles.loadingOverlay}>Loading...</div>}
        <canvas
          ref={canvasRef}
          onClick={handleCanvasClick}
          style={styles.canvas}
          title="Click to identify brain regions"
        />
      </div>
      <div style={styles.info}>
        <p style={styles.infoText}>Slice: {sliceIndex} / {MAX_SLICES}</p>
        <p style={styles.infoText}>Click on the brain to identify regions</p>
      </div>
    </div>
  );
};

const styles = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    backgroundColor: '#f9f9f9',
    borderRadius: '4px',
    overflow: 'hidden'
  },
  canvasWrapper: {
    position: 'relative',
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fff',
    minHeight: '500px'
  },
  canvas: {
    maxWidth: '100%',
    maxHeight: '100%',
    cursor: 'crosshair',
    border: '1px solid #ddd'
  },
  loadingOverlay: {
    position: 'absolute',
    top: '50%',
    left: '50%',
    transform: 'translate(-50%, -50%)',
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    color: 'white',
    padding: '16px 24px',
    borderRadius: '4px',
    fontSize: '14px',
    fontWeight: 'bold',
    zIndex: 100
  },
  info: {
    padding: '12px 16px',
    borderTop: '1px solid #ddd',
    backgroundColor: '#fafafa',
    fontSize: '13px',
    color: '#666'
  },
  infoText: {
    margin: '4px 0',
    lineHeight: '1.4'
  }
};

export default SliceViewerCanvas;
