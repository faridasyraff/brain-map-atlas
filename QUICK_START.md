# 🧠 2D Brain Atlas MVP - Quick Start (5 minutes)

## What You Get
✅ Complete 2D brain viewer with 800 slices  
✅ Click to identify brain regions  
✅ Region information in sidebar  
✅ Slice navigation slider  
✅ Backend API integration  

## Prerequisites
- Backend: Running on http://127.0.0.1:8000
- Node.js installed in frontend/

## Start in 4 Commands

### Terminal 1: Start Backend
```powershell
cd C:\Users\cokeisbetter\Desktop\Brain Map\brain-map-atlas
& '.\.venv\Scripts\Activate.ps1'
python -m uvicorn backend.app.main:app --reload --port 8000
```

### Terminal 2: Start Frontend
```bash
cd C:\Users\cokeisbetter\Desktop\Brain Map\brain-map-atlas\frontend
npm run dev
```

### Open Browser
```
http://localhost:5173
```

### Click Navbar
**"2D Atlas (MVP)"** button

---

## Usage (30 seconds)

1. **Navigate slices**: Drag slider (0-799) at top-left
2. **Click brain**: Click anywhere on the anatomy image
3. **View info**: Right sidebar shows region details
4. **Check debug**: See pixel coords & RGB values
5. **Learn more**: Click "View in Allen Brain Atlas" link

---

## What Happens on Click

```
Click on brain image
    ↓
Your mouse position → image pixel coordinate
    ↓
Read RGB color from label image
    ↓
Backend: GET /regions/by_rgb/lookup?r=R&g=G&b=B
    ↓
Response: Region name, acronym, ID, hierarchy, etc.
    ↓
Right sidebar displays all region info
```

---

## Files Created

```
✅ frontend/src/api/brainApi.js
✅ frontend/src/pages/Atlas2D.jsx
✅ frontend/src/components/SliceViewerCanvas.jsx
✅ frontend/src/components/RegionInfoPanel.jsx
✅ frontend/SETUP_2D_ATLAS.md (full docs)
✅ FRONTEND_INTEGRATION_COMPLETE.md (dev guide)
```

---

## Troubleshooting

**"Backend API unavailable"**
→ Start FastAPI server first (Terminal 1)

**No slices showing**
→ Check `/slices/` folder exists in `frontend/public/`

**Clicking doesn't work**
→ Check browser console for errors
→ Verify backend is responding at http://127.0.0.1:8000/health

**Wrong region shown**
→ Label PNGs are mostly placeholder - this is expected in MVP

---

## Next Steps

- ✅ Test clicking different slices
- ✅ Verify region names are correct
- ✅ Check Allen Atlas links work
- ✅ Test API error handling
- → Add region highlighting
- → Add hierarchy browser
- → Add search functionality

---

**Status**: ✅ **READY TO USE!**

Enjoy your brain atlas! 🧠
