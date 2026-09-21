from app.services.ingestion import load_file, chunk_documents
from pathlib import Path

docs = load_file(Path("data\sample_kb\Verdantis_HR_Handbook.md"))

chunked_docs = chunk_documents(docs)

print(chunked_docs)