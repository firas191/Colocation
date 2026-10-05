"""Regions to blur before a photo is stored (spec 11.2 step 4): faces, visible text (documents, letters, screens
showing text) and screens. All models come from the OpenCV model zoo under permissive licences
(services/media/third_party): YuNet (MIT), PP-OCRv3 DB text detector (Apache-2.0), YOLOX-S on COCO (Apache-2.0).
Pre- and post-processing follow the zoo's demo code. Model files are downloaded at image build time and checked
against the sha256 values in models.lock (docs/DECISIONS.md D-070).

Known limits (not measured yet): YuNet finds faces of about 10 to 300 px, so faces are searched on a copy whose
long side is 640 px and, for large images, on 640 px tiles too; the text detector is trained on English and
Chinese text, so Arabic text is a likely gap; COCO has no 'document' class (text detection covers documents).
"""
from __future__ import annotations

import os
from pathlib import Path

import cv2
import numpy as np

from imaging import Box

MODEL_DIR = Path(os.environ.get("MEDIA_MODEL_DIR", Path(__file__).parent / "models"))
SCREEN_CLASSES = {62: "tv", 63: "laptop", 67: "cell phone"}       # COCO indices in the zoo's YOLOX class list


class Detectors:
    def __init__(self, model_dir: Path = MODEL_DIR, face_score: float = 0.7, text_box_min: int = 8,
                 screen_score: float = 0.4):
        self.model_dir = Path(model_dir)
        self.face_score, self.text_box_min, self.screen_score = face_score, text_box_min, screen_score
        self.face = cv2.FaceDetectorYN.create(str(self.model_dir / "face_detection_yunet_2023mar.onnx"), "", (320, 320),
                                              face_score, 0.3, 5000)
        self.text = cv2.dnn_TextDetectionModel_DB(cv2.dnn.readNet(str(self.model_dir / "text_detection_en_ppocrv3_2023may.onnx")))
        self.text.setBinaryThreshold(0.3)
        self.text.setPolygonThreshold(0.5)
        self.text.setUnclipRatio(2.0)
        self.text.setMaxCandidates(200)
        self.text.setInputSize((736, 736))
        self.text.setInputMean((123.675, 116.28, 103.53))
        self.text.setInputScale(1.0 / 255.0 / np.array([0.229, 0.224, 0.225]))
        self.yolox = cv2.dnn.readNet(str(self.model_dir / "object_detection_yolox_2022nov.onnx"))
        self._anchors()

    # ------------------------------------------------------------------ faces
    def faces(self, rgb: np.ndarray) -> list[Box]:
        bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
        h, w = bgr.shape[:2]
        found: list[Box] = []
        views = [(1.0 * 640 / max(h, w), 0, 0, bgr)]                   # whole image at 640 px
        if max(h, w) > 1280:                                            # tiles for small faces in big photos
            t = 640
            for y in range(0, h, t - 64):
                for x in range(0, w, t - 64):
                    views.append((1.0, x, y, bgr[y:y + t, x:x + t]))
        for scale, ox, oy, img in views:
            if scale != 1.0:
                img = cv2.resize(img, (max(1, round(img.shape[1] * scale)), max(1, round(img.shape[0] * scale))))
            if img.shape[0] < 10 or img.shape[1] < 10:
                continue
            self.face.setInputSize((img.shape[1], img.shape[0]))
            _, faces = self.face.detect(img)
            for f in (faces if faces is not None else []):
                x, y, fw, fh, score = f[0] / scale + ox, f[1] / scale + oy, f[2] / scale, f[3] / scale, f[-1]
                found.append(Box("face", int(x), int(y), int(fw), int(fh), float(score)))
        return _nms(found)

    # ------------------------------------------------------------------ text
    def texts(self, rgb: np.ndarray) -> list[Box]:
        bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
        h, w = bgr.shape[:2]
        resized = cv2.resize(bgr, (736, 736))
        polys, _ = self.text.detect(resized)
        out = []
        for p in polys:
            p = np.array(p, dtype=np.float32)
            p[:, 0] *= w / 736
            p[:, 1] *= h / 736
            x, y, bw, bh = cv2.boundingRect(p.astype(np.int32))
            if bw >= self.text_box_min and bh >= self.text_box_min / 2:
                out.append(Box("text", int(x), int(y), int(bw), int(bh), 1.0))
        return out

    # ------------------------------------------------------------------ screens
    def _anchors(self):
        grids, strides = [], []
        for s in (8, 16, 32):
            n = 640 // s
            xv, yv = np.meshgrid(np.arange(n), np.arange(n))
            g = np.stack((xv, yv), 2).reshape(1, -1, 2)
            grids.append(g)
            strides.append(np.full((*g.shape[:2], 1), s))
        self.grids, self.strides = np.concatenate(grids, 1), np.concatenate(strides, 1)

    def screens(self, rgb: np.ndarray) -> list[Box]:
        h, w = rgb.shape[:2]
        r = min(640 / h, 640 / w)
        pad = np.full((640, 640, 3), 114.0, dtype=np.float32)
        pad[: int(h * r), : int(w * r)] = cv2.resize(rgb, (int(w * r), int(h * r))).astype(np.float32)
        self.yolox.setInput(np.transpose(pad, (2, 0, 1))[np.newaxis])
        dets = self.yolox.forward(self.yolox.getUnconnectedOutLayersNames())[0][0]
        dets[:, :2] = (dets[:, :2] + self.grids) * self.strides
        dets[:, 2:4] = np.exp(dets[:, 2:4]) * self.strides
        scores = dets[:, 4:5] * dets[:, 5:]
        cls = scores.argmax(1)
        best = scores.max(1)
        xywh = np.stack([dets[:, 0] - dets[:, 2] / 2, dets[:, 1] - dets[:, 3] / 2, dets[:, 2], dets[:, 3]], 1)
        keep = cv2.dnn.NMSBoxesBatched(xywh.tolist(), best.tolist(), cls.tolist(), self.screen_score, 0.5)
        out = []
        for i in np.array(keep).flatten():
            if int(cls[i]) in SCREEN_CLASSES:
                x, y, bw, bh = (xywh[i] / r).tolist()
                out.append(Box("screen", int(max(0, x)), int(max(0, y)), int(bw), int(bh), float(best[i])))
        return out

    def __call__(self, rgb: np.ndarray) -> list[Box]:
        return self.faces(rgb) + self.texts(rgb) + self.screens(rgb)


def _nms(boxes: list[Box], thr: float = 0.3) -> list[Box]:
    if not boxes:
        return []
    keep = cv2.dnn.NMSBoxes([[b.x, b.y, b.w, b.h] for b in boxes], [b.score for b in boxes], 0.0, thr)
    return [boxes[i] for i in np.array(keep).flatten()]
