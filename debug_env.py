import os
from pathlib import Path
from dotenv import load_dotenv

backend_dir = Path('backend').resolve()
env_file = backend_dir / '.env'
print(f'Loading from: {env_file}')
print(f'Exists: {env_file.exists()}')

# Read raw file content
print('\n--- RAW FILE CONTENT (first 300 chars) ---')
content = env_file.read_text()
print(content[:300])

# Load via dotenv
load_dotenv(dotenv_path=env_file)
db_url = os.getenv('DATABASE_URL')
print(f'\n--- LOADED VIA DOTENV ---')
print(f'DATABASE_URL length: {len(db_url) if db_url else 0}')
print(f'First 100 chars: {db_url[:100] if db_url else "None"}')
print(f'Contains neondb_owner: {"neondb_owner" in db_url if db_url else False}')
