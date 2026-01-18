# Brain Map Atlas

An interactive 3D brain visualization tool using React, Three.js, and the Allen Brain Atlas API.

## Project Structure

```
brain-map-atlas/
├── frontend/          # Vite + React frontend
│   ├── src/           # React components, pages
│   ├── public/        # Static assets & 3D models
│   ├── package.json   # Frontend dependencies
│   └── vite.config.js # Vite configuration
├── backend/           # Python backend API
└── README.md          # This file
```

## Frontend Setup

### Prerequisites
- Node.js 16+ 
- npm or yarn

### Installation

```bash
cd frontend
npm install
```

### Development

```bash
npm run dev
```

Runs the Vite dev server at `http://localhost:5174` with hot module reload (HMR).

### Production Build

```bash
npm run build
```

Builds the app for production to the `dist/` folder.

### Preview Production Build

```bash
npm run preview
```

Serves the production build locally for testing.

## Dependencies

### Frontend Dependencies

#### Core React
- **react** (^19.2.3) - UI library
- **react-dom** (^19.2.3) - React DOM rendering
- **react-router-dom** (^7.12.0) - Client-side routing

#### 3D Graphics
- **three** (^0.182.0) - 3D graphics library
- **@react-three/fiber** (^9.5.0) - React renderer for Three.js
- **@react-three/drei** (^10.7.7) - Utilities for Three.js (OrbitControls, useGLTF, etc.)

#### Utilities
- **web-vitals** (^2.1.4) - Performance metrics

### Development Dependencies
- **vite** (^5.0.0) - Build tool & dev server
- **@vitejs/plugin-react** (^4.0.0) - React fast refresh plugin

## Features

- 🧠 **Interactive 3D Brain Model** - Explore a 3D human brain mesh with orbit controls
- 🗺️ **Brain Atlas API Integration** - Query brain regions via Allen Brain Atlas API
- 🎨 **Responsive Design** - Works on desktop and tablet devices
- ⚡ **Fast Development** - Vite HMR for instant feedback

## Pages

- **Home** (`/`) - 3D brain visualization with interactive controls
- **API Test** (`/ApiTest`) - Test Allen Brain Atlas API queries

## Technologies

- **Frontend Build**: Vite (instead of Create React App)
- **UI Framework**: React 19
- **3D Rendering**: Three.js
- **Navigation**: React Router v7
- **API**: Allen Brain Atlas REST API

## Backend

The Python backend is located in the `/backend` directory. See `/backend` for setup instructions.
# brain-map-atlas
