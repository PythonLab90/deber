import io
from pathlib import Path
import pymupdf as fitz
from PIL import Image, ImageOps
import pytesseract

pytesseract.pytesseract.tesseract_cmd = r'C:\Program Files\Tesseract-OCR\tesseract.exe'
path = Path('media') / '34d5fe6e5851470a9601761f0e63551b_TAREA APE- Mapa Impactos Eticos Deotologia.pdf'
out_path = Path('debug_ocr_result.txt')

try:
    if not path.exists():
        out_path.write_text(f'NOFILE:{path}', encoding='utf-8')
    else:
        doc = fitz.open(str(path))
        lines = [f'EXISTS:{path.exists()} PATH:{path}', f'PAGES:{doc.page_count}']
        for idx in range(min(2, doc.page_count)):
            page = doc[idx]
            pix = page.get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False)
            img = Image.open(io.BytesIO(pix.tobytes('png')))
            img = ImageOps.grayscale(img)
            img = img.point(lambda p: 255 if p > 180 else 0)
            txt = pytesseract.image_to_string(img, lang='spa', config='--psm 6')
            lines.append(f'PAGE:{idx + 1} LEN:{len(txt)}')
            lines.append(repr(txt[:800]))
        out_path.write_text('\n'.join(lines), encoding='utf-8')
except Exception as exc:
    out_path.write_text(f'ERROR:{type(exc).__name__}: {exc}', encoding='utf-8')
