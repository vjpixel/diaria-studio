"""face_detect.py: acha os rostos de cada imagem com o Haar cascade do OpenCV (#12560).

Portado de vjpixel/edicao-video (scripts/face_detect.py). Chamado por
`scripts/video-montagem.ts face` e `gaze`. A ESCOLHA do rosto (o maior nos 2/3
de cima do quadro) e a mediana por fala ficam no TypeScript
(`scripts/lib/diaria/video-face.ts`), testáveis sem OpenCV; aqui só a detecção.

Uso:
    python -P scripts/video/face_detect.py ENTRADA.json SAIDA.json
      ENTRADA: [{"key": "...", "path": "frame.png"}, ...]
      SAIDA:   [{"key": "...", "w": px, "h": px, "faces": [{"x","y","w","h"}, ...]}, ...]
    python -P scripts/video/face_detect.py --sheet ENTRADA.json FOLHA.jpg
      ENTRADA: [{"row": "rótulo da linha", "label": "rótulo do quadro", "path": "frame.png"}]
      Recorta o rosto ampliado de cada frame e monta uma folha, uma linha por "row".
"""

import json
import os
import sys
import unicodedata


def ascii_text(t: str) -> str:
    """O putText do OpenCV não desenha acento: tira os diacríticos."""
    return "".join(ch for ch in unicodedata.normalize("NFD", t) if not unicodedata.combining(ch))


def pick_face(faces, h):
    """O maior rosto com centro nos 2/3 de cima do quadro (o botão do microfone no peito vira falso rosto).

    Mesma regra de `pickFace` em scripts/lib/diaria/video-face.ts (a folha de olhar usa esta)."""
    up = [r for r in faces if r[1] + r[3] / 2 < h * 0.66]
    pool = up if len(up) else faces
    return max(pool, key=lambda r: r[2] * r[3]) if len(pool) else None


def load_cv2():
    try:
        import cv2  # noqa: F401
    except ImportError:
        print('face_detect: OpenCV indisponível; instale no venv da montagem: pip install "opencv-python-headless<5" (scripts/video/montagem-requirements.txt)', file=sys.stderr)
        sys.exit(1)
    import cv2

    return cv2


def detect(cv2, cascade, img):
    h, w = img.shape[:2]
    gray = cv2.equalizeHist(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY))
    return cascade.detectMultiScale(gray, scaleFactor=1.08, minNeighbors=6, minSize=(max(24, w // 12), max(24, w // 12)))


def load_cascade(cv2):
    """O cascade de rosto; vazio (XML ausente) é erro explícito, não uma asserção opaca do OpenCV."""
    path = os.path.join(cv2.data.haarcascades, "haarcascade_frontalface_default.xml")
    cascade = cv2.CascadeClassifier(path)
    if cascade.empty():
        print(f"face_detect: cascade não carregou: {path}", file=sys.stderr)
        sys.exit(1)
    return cascade


def read_image(cv2, path):
    """imread que aceita caminho com acento no Windows (imdecode sobre os bytes); None se o arquivo não existe."""
    import numpy as np

    try:
        data = np.fromfile(path, dtype=np.uint8)
    except OSError:
        return None
    return cv2.imdecode(data, cv2.IMREAD_COLOR) if data.size else None


def sheet(inp: str, out: str) -> int:
    cv2 = load_cv2()
    import numpy as np

    cascade = load_cascade(cv2)
    with open(inp, encoding="utf-8") as f:
        items = json.load(f)
    rows: dict = {}
    order = []
    H = 220
    # 1ª passada: detecta em todos; a mediana da linha (mesma fala) corrige falso positivo e rosto não achado.
    det = []
    for it in items:
        img = read_image(cv2, it["path"])
        if img is None:
            det.append(None)
            continue
        h = img.shape[0]
        det.append((img, pick_face(detect(cv2, cascade, img), h)))
    by_row: dict = {}
    for it, d in zip(items, det):
        if d and d[1] is not None:
            by_row.setdefault(it["row"], []).append(d[1])
    med = {}
    for r, boxes in by_row.items():
        srt = lambda k: sorted(b[k] + (b[k + 2] / 2 if k < 2 else 0) for b in boxes)[len(boxes) // 2]
        med[r] = (srt(0), srt(1), sorted(max(b[2], b[3]) for b in boxes)[len(boxes) // 2])
    all_boxes = [b for bs in by_row.values() for b in bs]
    for it, d in zip(items, det):
        if not d:
            continue
        img, best = d
        h, w = img.shape[:2]
        ref = med.get(it["row"])
        guessed = False
        if best is not None:
            cx, cy, side = best[0] + best[2] / 2, best[1] + best[3] / 2, max(best[2], best[3])
            if ref and abs(cx - ref[0]) + abs(cy - ref[1]) > 0.6 * ref[2]:
                cx, cy, side, guessed = ref[0], ref[1], ref[2], True
        elif ref:
            cx, cy, side, guessed = ref[0], ref[1], ref[2], True
        elif all_boxes:
            b = all_boxes[len(all_boxes) // 2]
            cx, cy, side, guessed = b[0] + b[2] / 2, b[1] + b[3] / 2, max(b[2], b[3]), True
        else:
            cx, cy, side, guessed = w / 2, h * 0.3, w * 0.26, True
        side *= 1.9
        x0, y0 = int(max(0, cx - side / 2)), int(max(0, cy - side / 2))
        crop = img[y0 : int(min(h, y0 + side)), x0 : int(min(w, x0 + side))]
        crop = cv2.resize(crop, (int(H * crop.shape[1] / max(1, crop.shape[0])), H))
        crop = cv2.copyMakeBorder(crop, 26, 2, 2, 2, cv2.BORDER_CONSTANT, value=(255, 255, 255))
        cv2.putText(crop, ascii_text(it.get("label", "")) + (" (rosto estimado)" if guessed else ""), (4, 19), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 200), 1, cv2.LINE_AA)
        if it["row"] not in rows:
            rows[it["row"]] = []
            order.append(it["row"])
        rows[it["row"]].append(crop)
    if not order:
        print("face_detect: nenhum frame legível para a folha", file=sys.stderr)
        return 1
    lines = []
    width = 0
    for r in order:
        head = np.full((H + 28, 230, 3), 255, np.uint8)
        y = 24
        txt = ascii_text(r)
        for chunk in [txt[i : i + 22] for i in range(0, len(txt), 22)][:8]:
            cv2.putText(head, chunk, (6, y), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 0), 1, cv2.LINE_AA)
            y += 22
        line = cv2.hconcat([head] + rows[r])
        lines.append(line)
        width = max(width, line.shape[1])
    lines = [cv2.copyMakeBorder(l, 0, 4, 0, width - l.shape[1], cv2.BORDER_CONSTANT, value=(40, 40, 40)) for l in lines]
    ok, buf = cv2.imencode(".jpg", cv2.vconcat(lines))
    if not ok:
        print(f"face_detect: falha ao codificar a folha {out}", file=sys.stderr)
        return 1
    buf.tofile(out)
    return 0


def main() -> int:
    if len(sys.argv) == 4 and sys.argv[1] == "--sheet":
        return sheet(sys.argv[2], sys.argv[3])
    if len(sys.argv) != 3:
        print(__doc__, file=sys.stderr)
        return 2
    cv2 = load_cv2()
    cascade = load_cascade(cv2)
    with open(sys.argv[1], encoding="utf-8") as f:
        items = json.load(f)
    out = []
    for it in items:
        img = read_image(cv2, it["path"])
        if img is None:
            out.append({"key": it["key"], "w": 0, "h": 0, "faces": []})
            continue
        h, w = img.shape[:2]
        faces = [{"x": int(r[0]), "y": int(r[1]), "w": int(r[2]), "h": int(r[3])} for r in detect(cv2, cascade, img)]
        out.append({"key": it["key"], "w": w, "h": h, "faces": faces})
    with open(sys.argv[2] + ".tmp", "w", encoding="utf-8") as f:
        json.dump(out, f)
    os.replace(sys.argv[2] + ".tmp", sys.argv[2])
    return 0


if __name__ == "__main__":
    sys.exit(main())
