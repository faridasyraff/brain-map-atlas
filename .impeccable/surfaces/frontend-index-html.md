---
version: 1
slug: "frontend-index-html"
primary_target: "frontend/index.html"
related_targets: ["frontend/home.html"]
---

# Brain Atlas: atlas (/app) and home (/)

Scope: the atlas at `/app` (mode: Experience: the brain itself leads) and the home page at `/` (mode: Persuade). Audience, job, learning model and constraints: PRODUCT.md. Every existing capability stays first-class; the atlas opens with the 3D brain and the three sections on screen and clickable.

Memorable moment: the spotlight. Choosing a region swings the case light onto it, the rest of the brain dims to designed ghosts, and its label is pinned beside it.

Unresolved: Level 1 text source at scale; connection data source; display face confirmation after the first build.

## Direction contract

THESIS: The atlas is a hands-on exhibit in a modern science museum: the brain is the specimen in a lit case, every structure carries a museum label, and exploring means walking from case to case. It refuses the dark viewer with neon accents and the sterile white medical page.

OWN-WORLD: Deep gallery-teal walls own the page; the case interior is darker teal under one warm spotlight. Specimen labels are small off-white printed cards with ink type and a catalog number (the Allen structure ID). Brass marks the interactive: round push buttons for Isolate, Compare and Reset, the selection pin, wayfinding numerals. Archivo, wide for gallery titles painted on the wall, condensed for catalog numbers and coordinates, regular for reading. Region colours stay the Allen data colours. Unselected structures are designed ghosts, never hidden. (Raised by seven-segment: absence is drawn as deliberately as light.)

STORY: A student lands in front of the whole brain lit in its case, with the three sections on a light box below. They hover to identify, press a structure to spotlight it, read the short label in plain words, open the long label for anatomy, metadata, connections and references, follow the wayfinding to a neighbour, isolate or compare, ask the assistant, and leave a trail they can pick up next time.

FIRST VIEWPORT: Atlas: a thin gallery bar (wordmark, search, your trail, account). The specimen case fills the stage, about 72% of the width, the brain under the spotlight. A light box strip with the three sections sits along the case's foot. The label rail on the right holds the specimen label and the long label. The brass push buttons sit on the case's front rail. Primary action: press a structure (or search). Home: the lit case at full width with the wall title "The brain, on display" and one brass "Enter the exhibit" button.

FORM: The natural-history museum case, made contemporary (Exploratorium-grade hands-on, not dusty). Position 4 of the ordered list. seed:d98b8ab80c4977f0. Raises: from the WebGL portal, the 3D scene fills the whole stage and the interface sits on it; from the fashion flagship, generous active emptiness around the specimen; from the teen-magazine quiz, explored regions leave a mark that becomes the visitor's trail. Signature interaction: the spotlight (camera flight plus a light pool that travels to the region, 800ms ease-in-out; the rest dims to ghosts over 400ms). Motion grammar: spatial moves ease-in-out; labels slide out from the rail on the drawer curve; brass buttons press down 2px with a short release; hover identifies with a thin outline and a floating label, never a glow.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
