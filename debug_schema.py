"""Debug schema parsing"""
from pathlib import Path

SCHEMA_PATH = Path("backend/db/schema.sql")
schema = SCHEMA_PATH.read_text(encoding="utf-8")

# Clean the schema
lines = []
for line in schema.split("\n"):
    # Remove comments but preserve the line if it has code
    if "--" in line:
        code_part = line[:line.index("--")].strip()
    else:
        code_part = line.strip()
    
    if code_part:
        lines.append(code_part)

schema_clean = " ".join(lines)

# Split by semicolon and execute each statement
statements = [s.strip() for s in schema_clean.split(";") if s.strip()]

print(f"Total statements: {len(statements)}\n")
for i, stmt in enumerate(statements, 1):
    print(f"[{i}] ({len(stmt)} chars)")
    print(f"    First 80 chars: {repr(stmt[:80])}")
    print()
