/**
 * 2D Brain Atlas Page
 * Main container for the 2D brain viewer MVP
 */
import React, { useState, useEffect } from 'react';
import SliceViewerCanvas from '../components/SliceViewerCanvas.jsx';
import RegionInfoPanel from '../components/RegionInfoPanel.jsx';
import { brainApi } from '../api/brainApi.js';

const Atlas2D = () => {
  const [sliceIndex, setSliceIndex] = useState(400);
  const [selectedRegion, setSelectedRegion] = useState(null);
  const [pixelRGB, setPixelRGB] = useState(null);
  const [pixelCoords, setPixelCoords] = useState(null);
  const [isPanelVisible, setIsPanelVisible] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [apiHealth, setApiHealth] = useState(false);

  const MAX_SLICES = 799;

  /**
   * Check API health on mount
   */
  useEffect(() => {
    const checkHealth = async () => {
      const healthy = await brainApi.health();
      setApiHealth(healthy);
      if (!healthy) {
        console.warn('Backend API is not responding. Make sure FastAPI server is running on http://127.0.0.1:8000');
      }
    };
    checkHealth();
  }, []);

  /**
   * Handle region selection from canvas click
   */
  const handleRegionSelected = ({ region, pixelRGB, pixelCoords }) => {
    setSelectedRegion(region);
    setPixelRGB(pixelRGB);
    setPixelCoords(pixelCoords);
    setIsPanelVisible(true);
  };

  /**
   * Handle slice slider change
   */
  const handleSliceChange = (e) => {
    setSliceIndex(parseInt(e.target.value, 10));
  };

  return (
    <div style={styles.page}>
      {/* Header */}
      <div style={styles.header}>
        <h1 style={styles.title}>2D Brain Atlas Viewer</h1>
        {!apiHealth && (
          <div style={styles.warning}>
            ⚠️ Backend API unavailable. Start the server:
            <br />
            <code>python -m uvicorn backend.app.main:app --reload --port 8000</code>
          </div>
        )}
      </div>

      {/* Main content */}
      <div style={styles.mainContent}>
        {/* Left: Canvas viewer */}
        <div style={styles.leftPanel}>
          {/* Slice slider */}
          <div style={styles.controlPanel}>
            <label style={styles.label}>Slice Index:</label>
            <input
              type="range"
              min="0"
              max={MAX_SLICES}
              value={sliceIndex}
              onChange={handleSliceChange}
              style={styles.slider}
            />
            <span style={styles.sliceValue}>{sliceIndex}</span>
          </div>

          {/* Canvas */}
          <SliceViewerCanvas
            sliceIndex={sliceIndex}
            onRegionSelected={handleRegionSelected}
            onLoadingChange={setIsLoading}
          />
        </div>

        {/* Right: Region info panel */}
        <RegionInfoPanel
          region={selectedRegion}
          pixelRGB={pixelRGB}
          pixelCoords={pixelCoords}
          sliceIndex={sliceIndex}
          isVisible={isPanelVisible}
          onClose={() => setIsPanelVisible(false)}
        />
      </div>
    </div>
  );
};

const styles = {
  page: {
    display: 'flex',
    flexDirection: 'column',
    height: '100vh',
    backgroundColor: '#f0f0f0',
    fontFamily: 'system-ui, -apple-system, sans-serif'
  },
  header: {
    backgroundColor: '#2c3e50',
    color: 'white',
    padding: '16px 24px',
    borderBottom: '2px solid #34495e',
    boxShadow: '0 2px 4px rgba(0,0,0,0.1)'
  },
  title: {
    margin: '0',
    fontSize: '24px',
    fontWeight: 'bold'
  },
  warning: {
    marginTop: '12px',
    padding: '12px',
    backgroundColor: 'rgba(255, 193, 7, 0.2)',
    border: '1px solid #ffc107',
    borderRadius: '4px',
    fontSize: '12px',
    color: '#fff',
    fontFamily: 'monospace'
  },
  mainContent: {
    display: 'flex',
    flex: 1,
    overflow: 'hidden'
  },
  leftPanel: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    padding: '16px',
    gap: '12px',
    overflow: 'auto'
  },
  controlPanel: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    padding: '12px 16px',
    backgroundColor: 'white',
    borderRadius: '4px',
    boxShadow: '0 1px 3px rgba(0,0,0,0.1)'
  },
  label: {
    fontSize: '14px',
    fontWeight: '600',
    color: '#333',
    minWidth: '90px'
  },
  slider: {
    flex: 1,
    height: '6px',
    borderRadius: '3px',
    background: 'linear-gradient(to right, #3498db, #2980b9)',
    outline: 'none',
    cursor: 'pointer'
  },
  sliceValue: {
    fontSize: '14px',
    fontWeight: 'bold',
    color: '#2c3e50',
    minWidth: '50px',
    textAlign: 'right'
  }
};

export default Atlas2D;
