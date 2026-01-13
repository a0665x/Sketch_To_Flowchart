# FlowSketch Visualizer

I built a lightweight web UI that turns a hand-drawn flowchart into Mermaid flow syntax and renders it locally. I support:
- Gemini API (default)
- Groq API (text-only; requires OCR Assist)
- OpenAI API
- Ollama (local, 11434)
- Custom webhook (for n8n or any local workflow)

## Run locally

I recommend using a local web server to avoid CORS/file restrictions:

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000` in a browser.

## Run with Docker

I ship a Docker image that runs both the web UI and the local OCR webhook. Ports 8000 (web) and 8001 (OCR) are published.

```bash
./Start.sh
```

Open `http://localhost:8000` in a browser. To stop and remove the container:

```bash
./Stop.sh
```

Optional environment variables:
- `OCR_LANGS=en,ch_tra` to enable additional OCR languages.
- `OCR_CPU=0` to allow GPU mode if your Docker runtime supports it.
- `OLLAMA_PROXY_URL=http://host.docker.internal:11434` to point the Ollama proxy at your host.
- `OLLAMA_PROXY_TIMEOUT=300` to allow longer Ollama generations through the proxy (seconds).
- `FLOWCHART_LOG_FILE=/app/logs/container.log` to control where container logs are stored.
- `DOCKER_BUILD_NETWORK=host` to use host DNS/network during the Docker build if apt fails to resolve.

In my UI, click **Use local EasyOCR** (or set the OCR URL to `http://localhost:8001/ocr`) to inject OCR text into the Gemini prompt.
On first run, EasyOCR will download its model files, which may take a few minutes before the OCR endpoint responds.

## Gemini flow

1. Upload a sketch image (PNG/JPG/WEBP).
2. Paste your Gemini API key.
3. Click **Convert sketch**.
4. Edit Mermaid if needed and re-render.

I treat the prompt field as *constraints* (label style, lanes, direction). Output formatting is handled by the pipeline automatically.
Use **Diagram Options** to hint the diagram type (e.g. swimlane) when auto-detection is unsure.

### Multi-stage pipeline

I provide a **Multi-stage pipeline** toggle that runs:

1. Structure extraction (JSON)
2. Mermaid draft
3. Final syntax check

I log each stage in the Pipeline log panel so you can see progress.

You can disable **Final Mermaid check** if you want faster responses.

### Model selection

Some API keys only expose specific models. I auto-load models when you enter your key, and you can still use **Fetch models**. Pick a model that supports `generateContent` and image input. If you are unsure, try:

- `gemini-2.5-flash`
- `gemini-2.5-pro`
- `gemini-1.5-flash-002`
- `gemini-1.5-pro-002`

Gemini request format (sent by me):

```json
{
  "contents": [
    {
      "role": "user",
      "parts": [
        {"text": "<prompt>"},
        {"inline_data": {"mime_type": "image/png", "data": "<base64>"}}
      ]
    }
  ],
  "generationConfig": {"temperature": 0.2, "maxOutputTokens": 2048}
}
```

## Webhook flow

Use a custom webhook when you want full control (e.g. call a local vision model or n8n). I will POST JSON to your endpoint.

### Request

```json
{
  "prompt": "<prompt>",
  "output": "mermaid",
  "image": {
    "mime_type": "image/png",
    "base64": "<base64>"
  }
}
```

### Response

Any of these keys are accepted:

```json
{
  "mermaid": "flowchart TD\n  A-->B"
}
```

```json
{
  "diagram": "flowchart TD\n  A-->B"
}
```

```json
{
  "text": "flowchart TD\n  A-->B"
}
```

## Groq flow (text-only)

Groq chat models do not accept images. I rely on OCR Assist so I can extract labels first, then send the OCR context into Groq.

1. Upload a sketch image.
2. Enable **OCR Assist** and select the local EasyOCR endpoint.
3. Switch Mode to **Groq API**, enter your key and model (models auto-load).
4. Click **Convert sketch**.

## OpenAI flow

1. Upload a sketch image.
2. Switch Mode to **OpenAI API**, enter your key.
3. I auto-load your available OpenAI models into the dropdown.
4. Click **Convert sketch**.
Note: some OpenAI models require the Responses API; if a model fails on chat/completions, try a `gpt-4o*` or `o*` model.

## Ollama flow (local)

Ollama can use local text or vision-capable models. I preload the available models on startup.

1. Start Ollama (`ollama serve`) and ensure the model is pulled.
2. Switch Mode to **Ollama (local)** and pick a model from the list (or type a model name manually).
3. If your model is text-only, enable **OCR Assist** to extract labels.
4. Click **Convert sketch**.

By default (Docker), I point the UI at the local proxy `http://localhost:8001/ollama`, which forwards to your host Ollama.
You can override the proxy target with `OLLAMA_PROXY_URL` in `Start.sh`, for example:

```bash
OLLAMA_PROXY_URL=http://host.docker.internal:11434 ./Start.sh
```

If you want to call Ollama directly from the browser, set the Base URL to `http://localhost:11434` and allow CORS for your UI origin, for example:

```bash
OLLAMA_ORIGINS=http://localhost:8000 ollama serve
```

## n8n suggestion

I suggest a minimal n8n flow:

1. Webhook (POST)
2. Function/Code node to parse the payload and build the LLM prompt
3. LLM node (Gemini/OpenAI/local)
4. Respond to Webhook with `{ "mermaid": "..." }`

The webhook response must be JSON and include Mermaid code in one of the accepted fields above.

## OCR webhook (optional)

If Gemini, Groq, or Ollama struggles with tiny labels, I can call your OCR webhook before the model and inject text blocks into the prompt.
I also visualize OCR blocks on the preview image when available.

I also stream the Docker container log from `http://localhost:8001/logs` and show it below the pipeline log.

I return detected line segments (via OpenCV HoughLinesP) to help the model infer arrow connections.
I also visualize line segments on the image preview when available.

### Local EasyOCR webhook

1. Install EasyOCR (will also install its dependencies):

```bash
pip install easyocr
```

2. Start the local OCR server:

```bash
python3 ocr_server.py --lang en --cpu
```

Notes:
- Use `--lang en,ch_sim` or `--lang en,ch_tra` if you need Chinese labels.
- First run will download OCR models and can take a while.
- The endpoint listens on `http://localhost:8001/ocr`.
In my UI, click **Use local EasyOCR** to auto-fill the OCR URL and enable it.

### OCR request

```json
{
  "image": {
    "mime_type": "image/png",
    "base64": "<base64>"
  },
  "hint": "flowchart",
  "line_params": {
    "canny_low": 50,
    "canny_high": 150,
    "threshold": 60,
    "min_line_length": 30,
    "max_line_gap": 8,
    "max_lines": 80
  }
}
```

### OCR response

```json
{
  "blocks": [
    { "text": "Start", "box": { "x": 120, "y": 40, "w": 80, "h": 20 } },
    { "text": "Approve?", "box": [220, 120, 110, 30] }
  ],
  "lines": [
    { "x1": 140, "y1": 80, "x2": 220, "y2": 120 },
    { "x1": 280, "y1": 150, "x2": 300, "y2": 220 }
  ]
}
```

I accept `blocks`, `textBlocks`, or `words` arrays. If only `text` is returned, I will still use it.

## Notes

- I render Mermaid locally in the browser.
- I do not store or transmit files beyond your chosen API/Webhook.
