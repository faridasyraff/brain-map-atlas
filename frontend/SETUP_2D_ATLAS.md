# 2D Brain Atlas MVP - Frontend Integration Guide

## Setup

### Prerequisites
- Backend FastAPI server running on `http://127.0.0.1:8000`
- Frontend dev server on `http://localhost:5173`

### Backend Setup
```bash
cd brain-map-atlas
& '.venv\Scripts\Activate.ps1'  # Windows
# or: source .venv/bin/activate  # Mac/Linux

python -m uvicorn backend.app.main:app --reload --port 8000
```

### Frontend Setup
```bash
cd brain-map-atlas/frontend
npm install
npm run dev
```

Open browser to: **http://localhost:5173**

---

## Testing the 2D Brain Viewer

### 1. Navigate to the MVP Page
- Click **"2D Atlas (MVP)"** in the navbar
- URL: `http://localhost:5173/atlas-2d`

### 2. Explore Brain Slices
- Use the **slice slider** (0-799) to navigate through brain slices
- Canvas shows the anatomy image at the selected slice
- Info panel below shows current slice number

### 3. Click to Identify Regions
1. **Click anywhere on the brain image**
2. The app will:
   - Map your mouse position to image pixel coordinates
   - Read the RGB color from the label slice at that pixel
   - Call the backend API: `GET /regions/by_rgb/lookup?r=R&g=G&b=B`
   - Display region information in the right sidebar
3. **Right panel shows**:
   - Region acronym and full name
   - MBA structure ID
   - Pixel coordinates you clicked
   - RGB color values (pixel and region colors)
   - Hierarchy info (parent region)
   - Link to Allen Brain Atlas

### 4. Background Handling
- If you click on **background** (RGB 0,0,0):
  - Panel shows "Background / No region data"
  - Debug info still displays pixel coords and RGB

### 5. Debug Information
- **Debug Info section** shows:
  - Pixel coordinates clicked
  - RGB value read from label slice
  - Region RGB for comparison
  - Color swatch visualization

---

## Feature Overview

### Components

**`Atlas2D.jsx`** (Main page)
- Slice slider (0-799)
- Canvas viewer
- Region selection state management
- API health check

**`SliceViewerCanvas.jsx`** (Canvas component)
- Loads anatomy PNG (visible)
- Loads label PNG (offscreen)
- Click detection and pixel mapping
- Calls backend API on click
- Loading state

**`RegionInfoPanel.jsx`** (Right sidebar)
- Displays selected region details
- Shows debug information
- Handles background/unknown regions
- Links to Allen Brain Atlas

**`brainApi.js`** (API client)
- `getRegionByRGB(r, g, b)` - Main lookup endpoint
- `getRegionById(mbaId)` - Alternative lookup
- `searchRegions(query)` - Text search
- `health()` - API health check

---

## Pixel Mapping Logic

```javascript
// Map canvas mouse coordinates to image pixel coordinates:
const rect = canvas.getBoundingClientRect();
const pixelX = (e.clientX - rect.left) * (imageWidth / canvasDisplayWidth);
const pixelY = (e.clientY - rect.top) * (imageHeight / canvasDisplayHeight);

// Read RGB from offscreen label canvas:
const pixelIndex = (y * width + x) * 4;  // RGBA: 4 bytes per pixel
const r = labelData.data[pixelIndex];
const g = labelData.data[pixelIndex + 1];
const b = labelData.data[pixelIndex + 2];
```

---

## Troubleshooting

### "Backend API is not responding"
- ✅ Start FastAPI server on port 8000
- ✅ Check CORS settings (should allow localhost:5173)
- ✅ Verify no firewall blocking localhost connections

### Slices not loading
- ✅ Verify PNG files exist: `frontend/public/slices/brain_000.png`
- ✅ Check browser console for 404 errors
- ✅ Try slice 400 (middle of brain)

### Clicking doesn't show regions
- ✅ Check browser DevTools → Network tab for API calls
- ✅ Ensure label PNGs are properly populated (currently mostly background)
- ✅ Try clicking on different slices

### Region colors don't match
- This is expected during MVP! Label PNGs are mostly placeholder black.
- You'll see region data for any non-black pixels where the CSV has RGB matches.

---

## API Integration Details

### Request
```bash
GET http://127.0.0.1:8000/regions/by_rgb/lookup?r=112&g=255&b=113
```

### Success Response (200)
```json
{
  "id": 6,
  "mba_id": 315,
  "identifier": "MBA:315",
  "acronym": "Isocortex",
  "name": "Isocortex",
  "parent_mba_id": 695,
  "parent_identifier": "MBA:695",
  "depth": null,
  "color_r": 112,
  "color_g": 255,
  "color_b": 113,
  "color_hex": "#70FF71",
  "graph_order": 5.0,
  "created_at": "2026-02-09 21:41:24"
}
```

### Error Responses
- **404**: RGB not found (background or unmapped region)
- **500**: Server error (check backend logs)

---

## Next Steps / Enhancements

- [ ] Highlight clicked region on the anatomy slice
- [ ] Show region hierarchy tree
- [ ] Add search-by-name functionality
- [ ] Implement 3D viewer integration
- [ ] Add region statistics (volume, surface area)
- [ ] Cache frequently accessed regions locally
- [ ] Add measurements/annotations tool

---

## File Structure

```
frontend/
├── src/
│   ├── api/
│   │   └── brainApi.js              [NEW] API client
│   ├── pages/
│   │   └── Atlas2D.jsx              [NEW] Main 2D page
│   ├── components/
│   │   ├── SliceViewerCanvas.jsx    [NEW] Canvas component
│   │   ├── RegionInfoPanel.jsx      [NEW] Info sidebar
│   │   └── common/
│   │       └── Navbar.jsx           [UPDATED] Added route
│   ├── app/
│   │   └── App.jsx                  [UPDATED] Added route
│   ├── main.jsx                     [NO CHANGES]
│   └── styles/
│       └── index.css                [NO CHANGES]
└── public/
    └── slices/
        ├── brain_000.png ... brain_799.png    [EXISTING]
        └── labels_000.png ... labels_799.png  [EXISTING]
```

---

## Summary

✅ **Complete end-to-end 2D brain viewer**  
✅ **Click-to-identify with RGB lookup**  
✅ **Right sidebar with region details**  
✅ **Slice navigation slider**  
✅ **Debug information display**  
✅ **Backend integration with error handling**  
✅ **Graceful background/unknown region handling**  

**Status**: Ready for MVP testing and iteration!
