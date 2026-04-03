# Kim Brain Atlas Interface
### Allen CCFv3 Mouse Brain Atlas — Group 216, Penn State University

**Team Members:**
- Muhammad Danish Zahin Bin Rafizal
- Alif Danial Bin Kamarole Erifin
- Muhammad Farid Asyraf Mohd Shahimi

**Client:** Dr. Yongsoo Kim, Ph.D — Department of Neuroscience, Penn State College of Medicine

---

## Overview

The Kim Brain Atlas Interface is an interactive web-based visualization platform for exploring mouse brain regions using data from the **Allen Brain Common Coordinate Framework v3 (CCFv3)**. Users can view 2D brain slices, click regions to get functional information, perform semantic searches, and ask questions through an AI-powered RAG chatbot.

---

## Features

- **2D Brain Atlas Visualization** — Sagittal, coronal, and transverse slice views
- **Clickable Regions** — Click any pixel to identify the brain region and display its function, connectivity, and clinical relevance
- **Colour Modes** — Toggle official Allen Brain Atlas colour overlays (structure, division, substructure)
- **Region Highlight** — Visual highlight mask with outline when a region is selected
- **Semantic Search** — Search by region name, acronym, or functional keyword (e.g. "memory", "pain")
- **Hierarchy Navigation** — Browse the full Allen ontology tree (organ → category → division → structure → substructure)
- **AI Chatbot** — Ask questions about any brain region using local Ollama RAG or OpenAI GPT
- **CortexMap Integration** — Automatically fetches live PubMed-sourced research summaries for selected regions

---

## Project Structure

```
project/
├── App.py                    # Flask backend — all API endpoints
├── index.html                # Frontend single-page application
├── brain_regions_kb.json     # Local knowledge base for RAG chatbot
├── requirements.txt          # Python dependencies
├── test_app.py               # Unit tests (pytest)
├── data/
│   └── abc_atlas/            # Allen CCFv3 downloaded data files
├── chroma_db/                # ChromaDB vector store (auto-generated)
└── logs/                     # Daily log files (auto-generated)
```

---

## Requirements

### Python Dependencies
```
flask
flask-cors
numpy
scipy
matplotlib
SimpleITK
Pillow
abc-atlas-access
langchain-community
langchain-chroma
langchain-huggingface
langchain-text-splitters
chromadb
sentence-transformers
openai
```

Install all dependencies:
```bash
pip install flask flask-cors numpy scipy matplotlib SimpleITK Pillow abc-atlas-access langchain-community langchain-chroma langchain-huggingface langchain-text-splitters chromadb sentence-transformers openai
```

### External Requirements
- **Ollama** — Local LLM server. Install from https://ollama.com then run:
  ```bash
  ollama serve
  ollama pull gemma3:4b
  ```
- **Allen Brain Atlas data** — Downloaded automatically on first run (~400 MB)

---

## Running the Application

**Step 1** — Install dependencies (see above)

**Step 2** — Start Ollama (for chatbot):
```bash
ollama serve
```

**Step 3** — Start the Flask server:
```bash
python App.py
```

**Step 4** — Open your browser at:
```
http://localhost:5000
```

---

## Running the Tests

Install test dependencies:
```bash
pip install pytest pytest-cov flask flask-cors numpy
```

Run all 20 unit tests:
```bash
python -m pytest test_app.py -v
```

Run with coverage report:
```bash
python -m pytest test_app.py -v --cov=test_app --cov-report=term-missing
```

---

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | Serves the frontend HTML page |
| GET | `/api/slice` | Returns a rendered brain slice image as base64 PNG |
| POST | `/api/lookup` | Returns region info for a clicked pixel coordinate |
| POST | `/api/highlight` | Returns an RGBA highlight mask for a single region |
| POST | `/api/highlight_indices` | Returns a highlight mask for multiple region indices |
| POST | `/api/highlight_group` | Returns a highlight mask for an entire anatomical group |
| GET | `/api/search` | Semantic search for regions by name, acronym, or function |
| POST | `/api/chat` | Ask a question to the AI chatbot (Ollama or OpenAI) |
| GET | `/api/ontology` | Returns the full Allen Brain Atlas ontology tree |
| POST | `/api/region_center` | Returns the best slice indices for viewing a region |
| POST | `/api/region_center_group` | Returns the best slice indices for viewing a group |
| POST | `/api/group_by_term` | Returns all parcellation indices under an ontology term |
| POST | `/api/find_group_level` | Finds the hierarchy level for a given region name |
| POST | `/api/resolve_acronyms` | Resolves a list of acronyms to parcellation indices |
| GET | `/api/resolve_region` | Finds the single best matching region for a name |
| POST | `/api/log_warning` | Logs a rapid-click warning from the frontend |

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENAI_API_KEY` | — | OpenAI API key for GPT-4o-mini chatbot mode |
| `CORTEXMAP_URL` | `https://capstone.ssdd.dev` | Base URL for CortexMap research orchestrator |

Set `OPENAI_API_KEY` either as an environment variable or in a `.env` file next to `App.py`:
```
OPENAI_API_KEY=sk-...
```

---

## Knowledge Base

The `brain_regions_kb.json` file contains structured information about brain regions used by the RAG chatbot. To add a new region:

1. Open `brain_regions_kb.json`
2. Add an entry to the `regions` array with these fields:
   - `parcellation_index` — integer ID from the Allen Atlas
   - `structure` — region name (must match atlas name)
   - `acronym` — standard abbreviation
   - `function` — what the region does
   - `connectivity` — inputs and outputs
   - `clinical_relevance` — disease associations
3. Restart `App.py`

---

## Atlas Coordinate System

The CCFv3 volume is `1320 × 800 × 1140` voxels at 10 µm resolution:

| Axis | Direction | Size |
|------|-----------|------|
| x (axis 0) | Anterior → Posterior | 1320 |
| y (axis 1) | Superior → Inferior | 800 |
| z (axis 2) | Left → Right | 1140 |

---

## License

Open-source academic project — Penn State University, Group 216.
