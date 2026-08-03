import argparse
import os

import cv2
import numpy as np


def imread_unicode(path):
    data = np.fromfile(str(path), dtype=np.uint8)
    return cv2.imdecode(data, cv2.IMREAD_COLOR)


def imwrite_unicode(path, image):
    ext = os.path.splitext(str(path))[1] or ".png"
    ok, buf = cv2.imencode(ext, image)
    if not ok:
        raise RuntimeError("cv2.imencode failed")
    buf.tofile(str(path))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--padding-ratio", type=float, default=0.15)
    args = parser.parse_args()

    image = imread_unicode(args.image)
    if image is None:
        raise RuntimeError("cannot read image: " + args.image)
    h, w = image.shape[:2]
    detector = cv2.FaceDetectorYN.create(str(args.model), "", (320, 320), 0.6, 0.3, 5000)
    detector.setInputSize((w, h))
    _, faces = detector.detect(image)
    mask = np.zeros((h, w), dtype=np.uint8)
    face_count = 0 if faces is None else len(faces)
    if faces is not None:
        for face in faces:
            x, y, fw, fh = (int(v) for v in face[:4])
            pad_x = int(fw * args.padding_ratio)
            pad_y = int(fh * args.padding_ratio)
            x0 = max(0, x - pad_x)
            y0 = max(0, y - pad_y)
            x1 = min(w, x + fw + pad_x)
            y1 = min(h, y + fh + pad_y)
            cv2.ellipse(
                mask,
                ((x0 + x1) // 2, (y0 + y1) // 2),
                ((x1 - x0) // 2, (y1 - y0) // 2),
                0,
                0,
                360,
                255,
                -1,
            )
    imwrite_unicode(args.output, mask)
    print(f"faces={face_count}")


if __name__ == "__main__":
    main()
