/**
 * Region Info Panel Component
 * Displays selected region details in a right sidebar
 */
import React, { useState, useEffect } from 'react';
import { brainApi } from '../api/brainApi.js';

const RegionInfoPanel = ({ region, pixelRGB, pixelCoords, sliceIndex, isVisible, onClose }) => {
  const [ancestors, setAncestors] = useState([]);

  // Fetch ancestors when region changes
  useEffect(() => {
    if (region && region.mba_id) {
      brainApi.getAncestors(region.mba_id).then(setAncestors);
    } else {
      setAncestors([]);
    }
  }, [region?.mba_id]);

  if (!isVisible) return null;

  // Handle background
  if (!region && pixelRGB && pixelRGB.r === 0 && pixelRGB.g === 0 && pixelRGB.b === 0) {
    return (
      <div style={styles.panel}>
        <div style={styles.header}>
          <button onClick={onClose} style={styles.closeBtn}>×</button>
          <h2 style={styles.title}>Background</h2>
        </div>
        <div style={styles.content}>
          <p style={styles.subtitle}>No region data</p>
          <p style={styles.debugText}>
            <strong>Slice:</strong> {sliceIndex}
          </p>
          <p style={styles.debugText}>
            <strong>Pixel Coords:</strong> {pixelCoords?.x ?? '?'}, {pixelCoords?.y ?? '?'}
          </p>
          <p style={styles.debugText}>
            <strong>RGB:</strong> {pixelRGB?.r ?? 0}, {pixelRGB?.g ?? 0}, {pixelRGB?.b ?? 0}
          </p>
        </div>
      </div>
    );
  }

  // Handle region not found
  if (!region) {
    return (
      <div style={styles.panel}>
        <div style={styles.header}>
          <button onClick={onClose} style={styles.closeBtn}>×</button>
          <h2 style={styles.title}>Unknown Region</h2>
        </div>
        <div style={styles.content}>
          <p style={styles.debugText}>
            <strong>Slice:</strong> {sliceIndex}
          </p>
          <p style={styles.debugText}>
            <strong>Pixel Coords:</strong> {pixelCoords?.x ?? '?'}, {pixelCoords?.y ?? '?'}
          </p>
          <p style={styles.debugText}>
            <strong>RGB:</strong> {pixelRGB?.r ?? 0}, {pixelRGB?.g ?? 0}, {pixelRGB?.b ?? 0}
          </p>
          <p style={styles.note}>Region not found in database.</p>
        </div>
      </div>
    );
  }

  // Display region info
  return (
    <div style={styles.panel}>
      <div style={styles.header}>
        <button onClick={onClose} style={styles.closeBtn}>×</button>
        <h2 style={styles.title}>{region.acronym}</h2>
        <p style={styles.subtitle}>{region.name}</p>
      </div>

      <div style={styles.content}>
        <section style={styles.section}>
          <h3 style={styles.sectionTitle}>Hierarchy</h3>
          {ancestors.length > 0 && (
            <div style={styles.breadcrumb}>
              {ancestors.map((ancestor, idx) => (
                <React.Fragment key={ancestor.mba_id}>
                  <span style={idx === ancestors.length - 1 ? styles.breadcrumbActive : styles.breadcrumbItem}>
                    {ancestor.acronym || ancestor.name}
                  </span>
                  {idx < ancestors.length - 1 && <span style={styles.breadcrumbSeparator}> > </span>}
                </React.Fragment>
              ))}
            </div>
          )}
        </section>

        <section style={styles.section}>
          <h3 style={styles.sectionTitle}>Basic Info</h3>
          <p style={styles.infoLine}>
            <strong>MBA ID:</strong> {region.mba_id}
          </p>
          <p style={styles.infoLine}>
            <strong>Identifier:</strong> {region.identifier}
          </p>
          <p style={styles.infoLine}>
            <strong>Slice:</strong> {sliceIndex}
          </p>
        </section>

        <section style={styles.section}>
          <h3 style={styles.sectionTitle}>Debug Info</h3>
          <p style={styles.debugText}>
            <strong>Pixel Coords:</strong> {pixelCoords?.x ?? '?'}, {pixelCoords?.y ?? '?'}
          </p>
          <p style={styles.debugText}>
            <strong>RGB Color:</strong> ({pixelRGB?.r ?? 0}, {pixelRGB?.g ?? 0}, {pixelRGB?.b ?? 0})
          </p>
          <p style={styles.debugText}>
            <strong>Region RGB:</strong> ({region.color_r}, {region.color_g}, {region.color_b})
          </p>
          <div
            style={{
              ...styles.colorSwatch,
              backgroundColor: `rgb(${region.color_r}, ${region.color_g}, ${region.color_b})`
            }}
          />
        </section>

        <section style={styles.section}>
          <a
            href={`https://atlas.brain-map.org/atlas?atlas=602630314#atlas=${region.mba_id}`}
            target="_blank"
            rel="noopener noreferrer"
            style={styles.link}
          >
            View in Allen Brain Atlas →
          </a>
        </section>
      </div>
    </div>
  );
};

const styles = {
  panel: {
    position: 'fixed',
    right: 0,
    top: 0,
    width: '350px',
    height: '100vh',
    backgroundColor: '#f5f5f5',
    borderLeft: '2px solid #ccc',
    boxShadow: '-2px 0 8px rgba(0,0,0,0.1)',
    overflowY: 'auto',
    zIndex: 1000,
    fontFamily: 'system-ui, -apple-system, sans-serif'
  },
  header: {
    backgroundColor: '#2c3e50',
    color: 'white',
    padding: '16px',
    borderBottom: '1px solid #ccc',
    position: 'sticky',
    top: 0
  },
  closeBtn: {
    position: 'absolute',
    right: '12px',
    top: '12px',
    background: 'none',
    border: 'none',
    color: 'white',
    fontSize: '24px',
    cursor: 'pointer',
    padding: '0',
    width: '24px',
    height: '24px',
    lineHeight: '1'
  },
  title: {
    margin: '0 0 4px 0',
    fontSize: '20px',
    fontWeight: 'bold'
  },
  subtitle: {
    margin: '0',
    fontSize: '13px',
    opacity: 0.9,
    fontStyle: 'italic'
  },
  content: {
    padding: '16px'
  },
  section: {
    marginBottom: '20px',
    paddingBottom: '16px',
    borderBottom: '1px solid #ddd'
  },
  sectionTitle: {
    margin: '0 0 12px 0',
    fontSize: '14px',
    fontWeight: 'bold',
    color: '#2c3e50',
    textTransform: 'uppercase',
    letterSpacing: '0.5px'
  },
  infoLine: {
    margin: '6px 0',
    fontSize: '13px',
    color: '#333'
  },
  debugText: {
    margin: '4px 0',
    fontSize: '12px',
    color: '#666',
    fontFamily: 'monospace',
    backgroundColor: '#eee',
    padding: '4px 6px',
    borderRadius: '3px'
  },
  colorSwatch: {
    width: '100%',
    height: '40px',
    borderRadius: '4px',
    border: '1px solid #ccc',
    marginTop: '8px'
  },
  link: {
    display: 'inline-block',
    marginTop: '8px',
    padding: '8px 12px',
    backgroundColor: '#3498db',
    color: 'white',
    textDecoration: 'none',
    borderRadius: '4px',
    fontSize: '13px',
    fontWeight: 'bold',
    transition: 'background-color 0.2s'
  },
  note: {
    fontSize: '12px',
    color: '#999',
    fontStyle: 'italic',
    marginTop: '8px'
  },
  breadcrumb: {
    fontSize: '12px',
    color: '#333',
    lineHeight: '1.6',
    padding: '8px',
    backgroundColor: '#f0f0f0',
    borderRadius: '4px',
    wordBreak: 'break-word'
  },
  breadcrumbItem: {
    color: '#666'
  },
  breadcrumbActive: {
    color: '#2c3e50',
    fontWeight: 'bold'
  },
  breadcrumbSeparator: {
    color: '#999',
    margin: '0 4px'
  }
};

export default RegionInfoPanel;
