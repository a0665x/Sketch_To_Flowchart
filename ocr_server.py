#!/usr/bin/env python3
import argparse
import base64
import json
import logging
import os
import urllib.error
import urllib.request
import urllib.parse
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, HTTPServer

import cv2
import easyocr
import numpy as np


def decode_base64_image(data):
    raw = base64.b64decode(data)
    array = np.frombuffer(raw, dtype=np.uint8)
    image = cv2.imdecode(array, cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError("Invalid image data")
    return image


def bbox_to_xywh(bbox):
    xs = [float(point[0]) for point in bbox]
    ys = [float(point[1]) for point in bbox]
    x = min(xs)
    y = min(ys)
    w = max(xs) - x
    h = max(ys) - y
    return [round(x, 2), round(y, 2), round(w, 2), round(h, 2)]


def build_response(handler, status, payload):
  body = json.dumps(payload).encode("utf-8")
  handler.send_response(status)
  handler.send_header("Content-Type", "application/json")
  handler.send_header("Content-Length", str(len(body)))
  handler.send_header("Access-Control-Allow-Origin", "*")
  handler.send_header("Access-Control-Allow-Headers", "Content-Type")
  handler.send_header("Access-Control-Allow-Methods", "POST, OPTIONS, GET")
  handler.end_headers()
  handler.wfile.write(body)


def build_raw_response(handler, status, body, content_type):
    handler.send_response(status)
    handler.send_header("Content-Type", content_type)
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.send_header("Access-Control-Allow-Headers", "Content-Type")
    handler.send_header("Access-Control-Allow-Methods", "POST, OPTIONS, GET")
    handler.end_headers()
    handler.wfile.write(body)


def forward_headers(handler, req):
    for name in ("Authorization", "X-API-Key"):
        value = handler.headers.get(name)
        if value:
            req.add_header(name, value)


def proxy_ollama(handler):
    base_url = os.environ.get("OLLAMA_PROXY_URL", "http://localhost:11434").rstrip("/")
    timeout = float(os.environ.get("OLLAMA_PROXY_TIMEOUT", "300"))
    suffix = handler.path[len("/ollama") :]
    if not suffix:
        suffix = "/"
    target = f"{base_url}{suffix}"
    data = None
    if handler.command in ("POST", "PUT", "PATCH"):
        content_length = int(handler.headers.get("Content-Length", "0"))
        data = handler.rfile.read(content_length)
    req = urllib.request.Request(target, data=data, method=handler.command)
    content_type = handler.headers.get("Content-Type")
    if content_type:
        req.add_header("Content-Type", content_type)
    forward_headers(handler, req)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read()
            response_type = resp.headers.get("Content-Type", "application/json")
            build_raw_response(handler, resp.status, body, response_type)
    except urllib.error.HTTPError as exc:
        body = exc.read()
        response_type = exc.headers.get("Content-Type", "application/json")
        build_raw_response(handler, exc.code, body, response_type)
    except Exception as exc:
        build_response(handler, HTTPStatus.BAD_GATEWAY, {"error": str(exc)})


def proxy_vllm(handler):
    base_url = os.environ.get("VLLM_PROXY_URL", "http://localhost:8002").rstrip("/")
    timeout = float(os.environ.get("VLLM_PROXY_TIMEOUT", "300"))
    suffix = handler.path[len("/vllm") :]
    if not suffix:
        suffix = "/"
    target = f"{base_url}{suffix}"
    data = None
    if handler.command in ("POST", "PUT", "PATCH"):
        content_length = int(handler.headers.get("Content-Length", "0"))
        data = handler.rfile.read(content_length)
    req = urllib.request.Request(target, data=data, method=handler.command)
    content_type = handler.headers.get("Content-Type")
    if content_type:
        req.add_header("Content-Type", content_type)
    forward_headers(handler, req)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read()
            response_type = resp.headers.get("Content-Type", "application/json")
            build_raw_response(handler, resp.status, body, response_type)
    except urllib.error.HTTPError as exc:
        body = exc.read()
        response_type = exc.headers.get("Content-Type", "application/json")
        build_raw_response(handler, exc.code, body, response_type)
    except Exception as exc:
        build_response(handler, HTTPStatus.BAD_GATEWAY, {"error": str(exc)})


def clamp_int(value, default, min_value=None, max_value=None):
    try:
        number = int(value)
    except (TypeError, ValueError):
        return default
    if min_value is not None:
        number = max(min_value, number)
    if max_value is not None:
        number = min(max_value, number)
    return number


def detect_lines(image, params=None):
    if not isinstance(params, dict):
        params = {}
    max_lines = clamp_int(params.get("max_lines"), 80, min_value=1, max_value=400)
    canny_low = clamp_int(params.get("canny_low"), 50, min_value=0, max_value=500)
    canny_high = clamp_int(params.get("canny_high"), 150, min_value=0, max_value=500)
    if canny_high < canny_low:
        canny_high = canny_low
    threshold = clamp_int(params.get("threshold"), 60, min_value=1, max_value=500)
    min_line_length = clamp_int(params.get("min_line_length"), 30, min_value=0, max_value=2000)
    max_line_gap = clamp_int(params.get("max_line_gap"), 8, min_value=0, max_value=500)
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    blurred = cv2.GaussianBlur(gray, (3, 3), 0)
    edges = cv2.Canny(blurred, canny_low, canny_high)
    lines = cv2.HoughLinesP(
        edges,
        1,
        np.pi / 180,
        threshold=threshold,
        minLineLength=min_line_length,
        maxLineGap=max_line_gap,
    )
    if lines is None:
        return []
    segments = []
    for line in lines:
        x1, y1, x2, y2 = map(int, line[0])
        length = ((x2 - x1) ** 2 + (y2 - y1) ** 2) ** 0.5
        segments.append({
            "x1": x1,
            "y1": y1,
            "x2": x2,
            "y2": y2,
            "length": round(float(length), 2),
        })
    segments.sort(key=lambda item: item["length"], reverse=True)
    return segments[:max_lines]


def read_log_lines(path, offset=None, tail=None):
    if not os.path.exists(path):
        return [], 0
    size = os.path.getsize(path)
    if offset is not None:
        with open(path, "rb") as file:
            file.seek(max(0, offset))
            data = file.read()
            new_offset = file.tell()
        text = data.decode("utf-8", errors="replace")
        lines = text.splitlines()
        return lines, new_offset
    if tail is None:
        tail = 200
    with open(path, "rb") as file:
        read_start = max(0, size - 1024 * 1024)
        file.seek(read_start)
        data = file.read()
    text = data.decode("utf-8", errors="replace")
    lines = text.splitlines()
    if read_start > 0 and len(lines) > tail:
        lines = lines[-tail:]
    return lines, size


def handle_logs(handler):
    parsed = urllib.parse.urlparse(handler.path)
    query = urllib.parse.parse_qs(parsed.query)
    offset = None
    tail = None
    if "offset" in query:
        try:
            offset = int(query["offset"][0])
        except (ValueError, TypeError):
            offset = None
    if "tail" in query:
        try:
            tail = int(query["tail"][0])
        except (ValueError, TypeError):
            tail = None
    log_file = os.environ.get("FLOWCHART_LOG_FILE", "/app/logs/container.log")
    lines, new_offset = read_log_lines(log_file, offset=offset, tail=tail)
    build_response(handler, HTTPStatus.OK, {"lines": lines, "offset": new_offset})


class OcrHandler(BaseHTTPRequestHandler):
    reader = None

    def log_message(self, format, *args):
        logging.info("%s - %s", self.address_string(), format % args)

    def do_OPTIONS(self):
        build_response(self, HTTPStatus.NO_CONTENT, {})

    def do_GET(self):
        if self.path.startswith("/logs"):
            handle_logs(self)
            return
        if self.path == "/vllm" or self.path.startswith("/vllm/"):
            proxy_vllm(self)
            return
        if self.path == "/ollama" or self.path.startswith("/ollama/"):
            proxy_ollama(self)
            return
        if self.path == "/health":
            build_response(self, HTTPStatus.OK, {"status": "ok"})
            return
        build_response(self, HTTPStatus.NOT_FOUND, {"error": "Not found"})

    def do_POST(self):
        if self.path == "/ollama" or self.path.startswith("/ollama/"):
            proxy_ollama(self)
            return
        if self.path == "/vllm" or self.path.startswith("/vllm/"):
            proxy_vllm(self)
            return
        if self.path != "/ocr":
            build_response(self, HTTPStatus.NOT_FOUND, {"error": "Not found"})
            return

        content_length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(content_length)
        try:
            payload = json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError:
            build_response(self, HTTPStatus.BAD_REQUEST, {"error": "Invalid JSON"})
            return

        image_data = payload.get("image", {}).get("base64")
        if not image_data:
            build_response(self, HTTPStatus.BAD_REQUEST, {"error": "Missing image.base64"})
            return

        try:
            image = decode_base64_image(image_data)
        except Exception as exc:
            build_response(self, HTTPStatus.BAD_REQUEST, {"error": str(exc)})
            return

        results = self.reader.readtext(image, detail=1, paragraph=False)
        blocks = []
        for bbox, text, conf in results:
            cleaned = str(text).strip()
            if not cleaned:
                continue
            blocks.append({
                "text": cleaned,
                "box": bbox_to_xywh(bbox),
                "confidence": round(float(conf), 4),
            })

        line_params = payload.get("line_params") if isinstance(payload, dict) else None
        lines = detect_lines(image, line_params)
        build_response(self, HTTPStatus.OK, {"blocks": blocks, "lines": lines})


def main():
    parser = argparse.ArgumentParser(description="Local EasyOCR webhook")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8001)
    parser.add_argument("--lang", default="en", help="Comma-separated language codes")
    parser.add_argument("--cpu", action="store_true", help="Force CPU mode")
    args = parser.parse_args()

    languages = [lang.strip() for lang in args.lang.split(",") if lang.strip()]
    if not languages:
        raise SystemExit("At least one language code is required")

    logging.basicConfig(level=logging.INFO, format="[%(asctime)s] %(message)s")
    logging.info("Loading EasyOCR reader: %s", ",".join(languages))
    OcrHandler.reader = easyocr.Reader(languages, gpu=not args.cpu)

    server = HTTPServer((args.host, args.port), OcrHandler)
    logging.info("EasyOCR webhook running on http://%s:%s/ocr", args.host, args.port)
    server.serve_forever()


if __name__ == "__main__":
    main()
