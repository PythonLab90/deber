from pathlib import Path
from home.views import extract_text_from_pdf

pdf_path = Path('media') / '34d5fe6e5851470a9601761f0e63551b_TAREA APE- Mapa Impactos Eticos Deotologia.pdf'
text = extract_text_from_pdf(str(pdf_path))
print('EXISTS', pdf_path.exists())
print('LEN', len(text))
print('SAMPLE', repr(text[:1000]))
