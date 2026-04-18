#!/usr/bin/env python3
"""
Minimal YOLOv8 (COCO-pretrained) HTTP server for ClearMarine hackathon demos.

Why: in-browser COCO-SSD often misses underwater / odd angles. YOLOv8n on the
same COCO labels can still return more hits on bottles, birds, people, etc.
It will NOT magically label "ghost net" — for that, rely on reporter form + notes.

Run (from repo):
  cd clearer/cv-server
  python3 -m venv .venv && source .venv/bin/activate   # Windows: .venv\\Scripts\\activate
  pip install -r requirements.txt
  python server.py

Frontend: set REACT_APP_CV_SERVER_URL=http://127.0.0.1:8765 in clearer/.env
"""
from __future__ import annotations

import base64
import io
import os
from flask import Flask, jsonify, request

app = Flask(__name__)

# Same mapping idea as clearer/src/lib/debrisPipeline/objectDetection.js
COCO_TO_DEBRIS = {
    "bottle": "plastic_bottle",
    "wine glass": "glass_container",
    "cup": "plastic_cup",
    "bowl": "container",
    "fork": "utensil_fragment",
    "knife": "utensil_fragment",
    "spoon": "utensil_fragment",
    "handbag": "plastic_bag",
    "backpack": "bag_or_gear",
    "suitcase": "large_container",
    "umbrella": "debris_misc",
    "sports ball": "floating_object",
    "frisbee": "floating_object",
    "surfboard": "large_debris",
    "skis": "debris_misc",
    "snowboard": "debris_misc",
    "kite": "sheet_plastic",
    "baseball bat": "debris_misc",
    "baseball glove": "debris_misc",
    "skateboard": "debris_misc",
    "tennis racket": "debris_misc",
    "chair": "debris_misc",
    "couch": "debris_misc",
    "potted plant": "debris_misc",
    "bed": "debris_misc",
    "dining table": "debris_misc",
    "toilet": "debris_misc",
    "tv": "debris_misc",
    "laptop": "debris_misc",
    "mouse": "debris_misc",
    "remote": "debris_misc",
    "keyboard": "debris_misc",
    "cell phone": "debris_misc",
    "microwave": "debris_misc",
    "oven": "debris_misc",
    "toaster": "debris_misc",
    "sink": "debris_misc",
    "refrigerator": "debris_misc",
    "book": "paper_debris",
    "clock": "debris_misc",
    "vase": "debris_misc",
    "scissors": "debris_misc",
    "teddy bear": "debris_misc",
    "hair drier": "debris_misc",
    "toothbrush": "plastic_fragment",
}

COCO_TO_ANIMAL = {
    "bird": "seabird",
    "cat": "wildlife",
    "dog": "wildlife",
    "horse": "wildlife",
    "sheep": "wildlife",
    "cow": "wildlife",
    "elephant": "wildlife",
    "bear": "wildlife",
    "zebra": "wildlife",
    "giraffe": "wildlife",
    "person": "human",
}

_model = None


def get_model():
    global _model
    if _model is None:
        from ultralytics import YOLO

        weights = os.environ.get("YOLO_WEIGHTS", "yolov8n.pt")
        _model = YOLO(weights)
    return _model


def clamp01(x: float) -> float:
    return max(0.0, min(1.0, x))


@app.after_request
def cors(resp):
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
    resp.headers["Access-Control-Allow-Methods"] = "POST, OPTIONS"
    return resp


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"ok": True, "service": "clearmarine-cv-server"})


@app.route("/detect", methods=["OPTIONS"])
def detect_options():
    return "", 204


@app.route("/detect", methods=["POST"])
def detect():
    from PIL import Image

    payload = request.get_json(silent=True) or {}
    b64 = payload.get("image_b64") or payload.get("image")
    if not b64:
        return jsonify({"ok": False, "error": "missing image_b64"}), 400

    try:
        raw = base64.b64decode(b64)
        img = Image.open(io.BytesIO(raw)).convert("RGB")
    except Exception as e:
        return jsonify({"ok": False, "error": f"bad image: {e}"}), 400

    w, h = img.size
    model = get_model()
    conf = float(os.environ.get("YOLO_CONF", "0.25"))
    results = model.predict(img, conf=conf, verbose=False)[0]
    names = results.names

    animals = []
    debris = []

    boxes = results.boxes
    if boxes is not None and len(boxes) > 0:
        xyxy = boxes.xyxy.cpu().numpy()
        conf = boxes.conf.cpu().numpy()
        cls_arr = boxes.cls.cpu().numpy().astype(int)
        for i in range(xyxy.shape[0]):
            cls_id = int(cls_arr[i])
            score = float(conf[i])
            name = str(names.get(cls_id, "")).lower()
            if name == "boat":
                continue

            x1, y1, x2, y2 = xyxy[i].tolist()
            bbox = [
                clamp01(x1 / w),
                clamp01(y1 / h),
                clamp01(x2 / w),
                clamp01(y2 / h),
            ]
            entry = {
                "class": "",
                "bbox": bbox,
                "confidence": round(score, 3),
                "coco_label": name,
            }
            if name in COCO_TO_DEBRIS:
                entry["class"] = COCO_TO_DEBRIS[name]
                debris.append(entry)
            elif name in COCO_TO_ANIMAL:
                entry["class"] = COCO_TO_ANIMAL[name]
                animals.append(entry)

    weights = os.environ.get("YOLO_WEIGHTS", "yolov8n.pt")
    return jsonify(
        {
            "ok": True,
            "animals": animals,
            "debris": debris,
            "image_width": w,
            "image_height": h,
            "detector": f"yolov8_remote_{weights.replace('.pt', '').replace('/', '_')}",
        }
    )


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8765"))
    print(f"ClearMarine CV server http://127.0.0.1:{port}  (POST /detect JSON {{image_b64, mime_type}})")
    app.run(host="0.0.0.0", port=port, threaded=True)
