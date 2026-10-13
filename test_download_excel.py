import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path('.').resolve()))
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'pdf_excel.settings')
import django
django.setup()

from django.test import RequestFactory
from home.views import download_excel, extract_pages_from_pdf, ask_llm_for_summary, load_training_context, parse_extracted_record

def main():
    pdf = list(Path('media').glob('*.pdf'))[0]
    pages = extract_pages_from_pdf(str(pdf))
    result = ask_llm_for_summary(pages)
    headers = load_training_context()['headers']
    record = parse_extracted_record(result, headers)

    factory = RequestFactory()
    request = factory.get('/download-excel')
    request.session = {'last_extracted_record': record}

    response = download_excel(request)
    output_path = Path('media') / 'test_descarga_formateada.xlsx'
    output_path.write_bytes(response.content)

    print("¡EXCEL DESCARGABLE GENERADO EXITOSAMENTE CON ESTILOS!")
    print(f"Ruta: {output_path.resolve()} ({output_path.stat().st_size} bytes)")

if __name__ == '__main__':
    main()
