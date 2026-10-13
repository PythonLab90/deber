import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path('.').resolve()))
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'pdf_excel.settings')
import django
django.setup()

from home.views import extract_pages_from_pdf, ask_llm_for_summary, load_training_context, parse_extracted_record

def main():
    pdf = list(Path('media').glob('*.pdf'))[0]
    print('PDF:', pdf.name)
    pages = extract_pages_from_pdf(str(pdf))
    result = ask_llm_for_summary(pages)
    headers = load_training_context()['headers']
    record = parse_extracted_record(result, headers)

    categories = [
        {'title': '📌 Información Principal del Acuerdo y Entidad', 'headers': headers[0:11]},
        {'title': '📍 Ubicación y Contacto de la Entidad', 'headers': headers[11:17]},
        {'title': '👤 Firmantes y Contactos', 'headers': headers[17:34]},
        {'title': '🎓 Modalidad y Participantes', 'headers': headers[34:41]},
        {'title': '📚 Carreras Aplicables', 'headers': headers[41:]},
    ]

    for cat in categories:
        found = [h for h in cat['headers'] if record.get(h) not in (None, '', 'null', 'NULL')]
        print(f"{cat['title']}: {len(found)} campos de {len(cat['headers'])}")

if __name__ == '__main__':
    main()
