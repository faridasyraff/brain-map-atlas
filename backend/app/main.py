"""FastAPI application setup"""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from backend.app.routes import regions, search

app = FastAPI(
    title="Brain Atlas API",
    description="SQLite-backed region lookup and search with caching",
    version="0.1.0"
)

# CORS for frontend dev server
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include routes
app.include_router(regions.router)
app.include_router(search.router)


@app.get("/health")
async def health():
    """Health check endpoint"""
    return {"status": "ok"}
