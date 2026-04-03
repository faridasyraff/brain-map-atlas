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
- **Colour Modes** — Toggle official Allen Brain Atlas colour overlays
- **Region Highlight** — Visual highlight mask with outline when a region is selected
- **Semantic Search** — Search by region name, acronym, or functional keyword (e.g. "memory", "pain")
- **Hierarchy Navigation** — Browse the full Allen ontology tree
- **AI Chatbot** — Ask questions about any brain region using local Ollama RAG or OpenAI GPT
- **CortexMap Integration** — Automatically fetches live PubMed-sourced research summaries

---

## Setup Instructions

### Step 1 — Download the project files

Download all files in this repository into a folder on your computer.

---

### Step 2 — Download and install Ollama

Download Ollama from: **https://ollama.com**

Ollama is required to run the local AI chatbot. The model used is **gemma3:4b**.

---

### Step 3 — Create a `.env` file

In the **same folder as `App.py`**, create a new file called exactly:
```
.env
```

Open it and paste this inside:
```
OPENAI_API_KEY="your_openai_api_key_here"
```

Replace `your_openai_api_key_here` with your actual OpenAI API key if you have one.
If you do not have an OpenAI key, leave it as is — the app will still work using the local Ollama chatbot.

---

### Step 4 — Open a terminal in the project folder

Navigate to the folder where `App.py` is located, then run the following commands **one by one**:

```bash
pip install openai
pip install --upgrade pip
pip install numpy
pip install matplotlib
pip install SimpleITK
pip install Flask
pip install Flask-Cors
pip install git+https://github.com/AllenInstitute/abc_atlas_access.git
pip install langchain-community langchain-chroma langchain-huggingface langchain-text-splitters sentence-transformers
```

---

### Step 5 — Pull the Ollama AI model

Make sure Ollama is installed and running, then run:
```bash
ollama pull gemma3:4b
```

This downloads the **gemma3:4b** language model used by the chatbot. It may take a few minutes depending on your internet speed.

---

### Step 6 — Start the application

Run the Flask backend server:
```bash
python App.py
```

Wait until you see a message that says the server is ready. The first run will also download the Allen Brain Atlas data files which may take several minutes.

---

### Step 7 — Open the browser

Go to this address in your web browser:
```
http://localhost:5000
```

The brain atlas interface will load and you can start exploring.

---

## Running the Unit Tests

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

## Project File Structure

```
project/
├── App.py                    # Flask backend — all API endpoints
├── index.html                # Frontend single-page application
├── brain_regions_kb.json     # Local knowledge base for RAG chatbot
├── test_app.py               # Unit tests (pytest)
├── .env                      # Your OpenAI API key (create this manually)
├── data/
│   └── abc_atlas/            # Allen CCFv3 downloaded data (auto-generated)
├── chroma_db/                # ChromaDB vector store (auto-generated)
└── logs/                     # Daily log files (auto-generated)
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
| POST | `/api/region_center_indices` | Returns best slice indices for a list of indices |
| POST | `/api/group_by_term` | Returns all parcellation indices under an ontology term |
| POST | `/api/find_group_level` | Finds the hierarchy level for a given region name |
| POST | `/api/resolve_acronyms` | Resolves a list of acronyms to parcellation indices |
| GET | `/api/resolve_region` | Finds the single best matching region for a name |
| POST | `/api/log_warning` | Logs a rapid-click warning from the frontend |
| GET | `/api/debug_name` | Developer debug search across atlas metadata columns |

---

## Environment Variables

| Variable | Description |
|----------|-------------|
| `OPENAI_API_KEY` | OpenAI API key for GPT-4o-mini chatbot mode (optional) |
| `CORTEXMAP_URL` | CortexMap research orchestrator URL (default: https://capstone.ssdd.dev) |

---

## Atlas Coordinate System

The CCFv3 volume is `1320 × 800 × 1140` voxels at 10 µm resolution:

| Axis | Direction | Size |
|------|-----------|------|
| x (axis 0) | Anterior → Posterior | 1320 |
| y (axis 1) | Superior → Inferior | 800 |
| z (axis 2) | Left → Right | 1140 |

---

## Troubleshooting

**App won't start** — Make sure all pip packages are installed and Ollama is running (`ollama serve`).

**Chatbot not working** — Make sure you have run `ollama pull gemma3:4b` and Ollama is running in the background.

**Slow first load** — The first run downloads Allen Brain Atlas data files (~400 MB). This is normal and only happens once.

**OpenAI not working** — Check that your `.env` file exists in the same folder as `App.py` and contains a valid API key.

---

## License

Open-source academic project — Penn State University, Group 216.
