"""Achica una imagen antes de mandarla a un modelo de visión.

Por qué hace falta: una foto de celular viene en 3000-4000 px de ancho, y eso son
miles de tokens por request (Groq en tier gratuito corta en 8000 TPM). Bajarla a
~1600 px no le saca legibilidad a una hoja impresa —que es lo que se fotografía
acá— y recorta el costo de cada lectura a una fracción.

Además normaliza el formato: los celulares sacan HEIC, que varios modelos no
aceptan, y acá sale siempre JPEG.

Uso:  python3 shrink.py <entrada> <salida> [ancho_max]
Devuelve por stdout una línea JSON con las medidas finales.
"""
import json
import sys

from PIL import Image, ImageOps

ANCHO_MAX_DEFECTO = 1600
CALIDAD = 82


def main():
    if len(sys.argv) < 3:
        print(json.dumps({"error": "uso: shrink.py <entrada> <salida> [ancho_max]"}))
        return 1

    entrada, salida = sys.argv[1], sys.argv[2]
    ancho_max = int(sys.argv[3]) if len(sys.argv) > 3 else ANCHO_MAX_DEFECTO

    try:
        img = Image.open(entrada)
        # Las fotos de celular traen la rotación en el EXIF en vez de en los
        # píxeles: sin esto una hoja sacada en vertical llega acostada.
        img = ImageOps.exif_transpose(img)

        ancho_original, alto_original = img.size

        # Solo se achica: agrandar una foto chica no agrega información y sí tokens.
        if ancho_original > ancho_max:
            alto = round(alto_original * ancho_max / ancho_original)
            img = img.resize((ancho_max, alto), Image.LANCZOS)

        if img.mode not in ("RGB", "L"):
            img = img.convert("RGB")

        img.save(salida, "JPEG", quality=CALIDAD, optimize=True)
        print(json.dumps({
            "width": img.size[0],
            "height": img.size[1],
            "original_width": ancho_original,
            "original_height": alto_original,
        }))
        return 0
    except Exception as exc:  # noqa: BLE001 — el error va al cliente como texto
        print(json.dumps({"error": str(exc)[:200]}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
