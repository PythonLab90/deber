# Servicio de extracción de acuerdos

Aplicación Django local para extraer información de acuerdos en PDF y generar un Excel usando los encabezados del archivo matriz.

## Preparar el entorno en Windows

Desde la carpeta del proyecto, en PowerShell:

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r requirements.txt
```

Copia `.env.example` como `.env` y agrega tu clave de Groq antes de procesar documentos. En PowerShell:

```powershell
Copy-Item .env.example .env
# Edita .env y define GROQ_API_KEY
$env:GROQ_API_KEY = "tu-clave-de-groq"
```

Si procesas PDF escaneados, instala Tesseract OCR con el paquete de idioma español y, si no está en `PATH`, configura su ejecutable:

```powershell
$env:TESSERACT_CMD = "C:\Program Files\Tesseract-OCR\tesseract.exe"
```

Inicia Django y abre <http://127.0.0.1:8000/>:

```powershell
python manage.py migrate
python manage.py runserver
```

## Desplegar en Render

Crea un servicio web conectado a este repositorio y configura:

- **Runtime:** Python 3
- **Build command:** `pip install -r requirements.txt && python manage.py migrate --noinput && python manage.py collectstatic --noinput`
- **Start command:** `gunicorn pdf_excel.wsgi:application`

En **Environment Variables**, define `DJANGO_DEBUG=0`, `DJANGO_SECRET_KEY` con una clave secreta nueva y `GROQ_API_KEY` con una clave nueva de Groq. La aplicación permite automáticamente el dominio `onrender.com` asignado por Render. Configura `DJANGO_ALLOWED_HOSTS` solo si necesitas agregar dominios propios adicionales, separados por comas. No subas `.env` ni claves al repositorio.

La aplicación necesita también el archivo de Excel de referencia para la función de extracción a Excel. Como los archivos `.xlsx` están excluidos de Git, configura `TRAINING_EXCEL_PATH` a una ruta disponible en el servicio o añade el archivo de referencia al despliegue por un medio privado.

El Excel de referencia se busca por defecto como `ACUERDOS DE COMPROMISO RI Agosto 2026.xlsx` en la raíz del proyecto. Se puede cambiar con `TRAINING_EXCEL_PATH`. Los PDF se limitan a 20 MB, 500 páginas y 1 000 000 de caracteres extraídos.

## Flujo de análisis y conversión

1. Selecciona o arrastra un PDF a la zona de carga. Se comprueba su firma, se extrae el texto y se indica el progreso sin bloquear la interacción de la página.
2. El texto se analiza por fragmentos para manejar documentos extensos. Groq devuelve los resultados en una estructura verificable con páginas de origen cuando el modelo puede identificarlas.
3. En la pantalla de revisión se puede consultar el PDF original, avanzar entre páginas, acercar o alejar, buscar coincidencias y editar, incluir, eliminar o reordenar las secciones. Los cambios actualizan la vista previa del archivo.
4. El usuario debe confirmar la conversión para descargar el resultado. Formatos: Word, PDF, texto y Markdown; Excel se habilita cuando el análisis encuentra tablas utilizables.

El modo **completo** conserva el PDF original cuando la salida es PDF. Para Word, texto y Markdown incluye el texto extraído de todas las páginas, no reconstruye imágenes ni el diseño del original. El modo **inteligente** genera un documento nuevo a partir de las secciones seleccionadas. Las tablas exportadas a Excel contienen texto editable y no recrean tablas complejas fusionadas.

La clave se lee desde `GROQ_API_KEY` en un `.env` local situado junto a `manage.py` o desde una variable de entorno; `.env` está excluido del control de versiones. Copia `.env.example` a `.env` y pega una clave válida únicamente en `.env`, nunca en el archivo de ejemplo:

```powershell
Copy-Item .env.example .env
notepad .env
```

Reinicia `runserver` después de cambiar la clave o el modelo. El modelo inicial es `openai/gpt-oss-20b`. Si Groq lo deniega, la aplicación consulta el catálogo `/models` de esa misma clave y prueba como máximo los modelos alternativos `qwen/qwen3.8-27b` y `openai/gpt-oss-120b` cuando aparecen en el catálogo. El primer modelo alternativo que responde correctamente queda seleccionado en memoria para las siguientes partes del documento. Si la clave no puede consultar el catálogo ni ejecutar sus modelos, revisa sus permisos de inferencia y el proyecto asociado en Groq Console; un HTTP 403 no se corrige cambiando al azar el nombre del modelo.

Los archivos temporales de PDF se guardan fuera de `media/`, vinculados a la sesión y se limpian al volver a subir un archivo o después de 24 horas. Los formatos Word y PDF se generan con `python-docx` y ReportLab. Los PDF escaneados requieren instalar Tesseract OCR y el paquete de idioma configurado en `TESSERACT_LANG`.

## Completar un cronograma con una plantilla Excel

Desde la página principal, abre **Completa un cronograma Excel** y carga el PDF fuente junto con el archivo de plantilla `.xlsx` (cada archivo admite hasta 20 MB). La IA propone cambios únicamente para celdas vacías existentes y muestra una vista previa editable antes de descargar.

Al confirmar, se crea una copia de la plantilla y se parchea únicamente el XML de las hojas/celdas aprobadas. No se reconstruye la tabla ni se guardan de nuevo las demás partes del libro. Se mantienen los estilos de celda existentes, fórmulas, celdas combinadas, nombres y orden de las hojas, imágenes, vínculos y configuración de impresión al conservar sin cambios el resto de las partes del paquete `.xlsx`. La plantilla que subió el usuario permanece intacta.
