import io
import os

# Model weights are downloaded once (from Hugging Face/PaddleOCR's model hub) and cached under
# ~/.paddlex/official_models - every request after that runs entirely offline, no network call.
# This disables even the one-time connectivity *check* PaddleOCR does before using the cache, so a
# fully offline environment (weights already present) never attempts any network access at all.
os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")

from fastapi import FastAPI, File, HTTPException, UploadFile
from paddleocr import PaddleOCR
from PIL import Image

app = FastAPI()
# Loaded once at process startup, not per request - a fresh PaddleOCR() call reloads model
# weights from disk, which is the ~11s of overhead seen when benchmarking this from the CLI.
ocr = PaddleOCR(lang=os.environ.get("OCR_LANG", "en"))


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/ocr")
async def run_ocr(file: UploadFile = File(...)):
    image_bytes = await file.read()
    try:
        image = Image.open(io.BytesIO(image_bytes))
        if image.mode in ("RGBA", "LA", "P"):
            # A transparent PNG's RGB channels are undefined/arbitrary wherever alpha is 0 (often
            # black) - naively dropping the alpha channel exposes that as opaque black, which can
            # turn a document that looks like black text on white into solid black-on-black with
            # zero contrast. Composite over white first, the standard way to flatten transparency,
            # so what the OCR model sees matches what a human viewer actually sees.
            image = image.convert("RGBA")
            background = Image.new("RGB", image.size, (255, 255, 255))
            background.paste(image, mask=image.split()[3])
            image = background
        else:
            image = image.convert("RGB")
    except Exception as error:
        raise HTTPException(status_code=400, detail=f"Could not read image: {error}") from error

    import numpy as np

    results = ocr.predict(np.array(image))
    lines = []
    scores = []
    for result in results:
        lines.extend(result["rec_texts"])
        scores.extend(result["rec_scores"])
    text = "\n".join(lines)
    # Percent, matching the 0-100 scale server.js/processing.js already expect from Tesseract's
    # confidence value - callers store this as-is (see ocrDocument in processing.js).
    confidence = round(100 * (sum(scores) / len(scores))) if scores else 0
    return {"text": text, "confidence": confidence}
