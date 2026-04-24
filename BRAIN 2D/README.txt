DOWNLOAD ALL THE FILES IN THIS FOLDER
DOWNLOAD OLLAMA must use gemma3::4b
CREATE A FILE CALLED .env in the same directory you in and put this in the file -> "OPENAI_API_KEY="your_openai_api_key_here""
on the main folder directory
run these on terminal
pip install openai
pip install --upgrade pip
pip install numpy
pip install matplotlib
pip install SimpleITK
pip install Flask
pip install Flask-Cors
pip install git+https://github.com/AllenInstitute/abc_atlas_access.git
pip install langchain-community langchain-chroma langchain-huggingface langchain-text-splitters sentence-transformers
ollama pull gemma3:4b
pip install trimesh
WHEN YOU FIRST DOWNLOADED THESE FILES INTO YOUR PC
run this first "python App.py" -> let it run to download the meshes folder into your parent directory now "Crtl C" to exit the program 
when the meshes folder is populated with obj files
now run "python voxelize_meshes.py"
we done run this back again "python App.py"
GO TO THIS WEBSITE:http://localhost:5000 to check the website
