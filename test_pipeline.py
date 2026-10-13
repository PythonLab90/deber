import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'pdf_excel.settings')
import django
django.setup()

from home.views import extract_pages_from_pdf, ask_llm_for_summary, parse_extracted_record, load_training_context

def main():
    media_dir = Path('media')
    pdfs = list(media_dir.glob('*.pdf'))
    if not pdfs:
        print("No hay archivos PDF en media/")
        return

    test_pdf = pdfs[0]
    print(f"Probando extracción completa con: {test_pdf.name}")
    start_time = time.time()

    # 1. Extraer páginas
    pages = extract_pages_from_pdf(str(test_pdf))
    print(f"Páginas extraídas ({len(pages)}):")
    for i, p in enumerate(pages, 1):
        print(f"  Págrina {i}: {len(p)} caracteres")

    # 2. Consultar LLM
    print("\nEnviando a Groq LLM...")
    summary_json = ask_llm_for_summary(pages)
    print(f"Respuesta JSON de LLM ({len(summary_json)} chars):")
    print(summary_json[:500])

    # 3. Mapear a Excel
    training = load_training_context()
    headers = training['headers'] if training else []
    record = parse_extracted_record(summary_json, headers)
    print("\nRecord parseado exitosamente!")
    non_empty = {k: v for k, v in record.items() if v is not None and v != ''}
    print(f"Campos no vacíos encontrados ({len(non_empty)}):")
    for k, v in list(non_empty.items())[:10]:
        print(f"  - {k}: {v}")

    print(f"\n¡PRUEBA COMPLETADA EN {time.time() - start_time:.2f} SEGUNDOS!")

if __name__ == '__main__':
    main()
