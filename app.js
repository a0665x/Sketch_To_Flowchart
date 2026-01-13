const DEFAULT_PROMPT = `Constraints:\n- Keep labels short and readable.\n- Preserve decision labels (yes/no).\n- Identify lanes if the sketch looks like swimlanes.\n- Prefer ASCII labels.`;
const MAX_AUTOFIX_ATTEMPTS = 3;
const APP_BUILD = "2025-03-08-5";

function flattenLabelNewlines(text) {
  const input = String(text || "");
  let output = "";
  const stack = [];
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (char === "\r") continue;
    if (char === "[" || char === "(" || char === "{") {
      stack.push(char === "[" ? "]" : char === "(" ? ")" : "}");
      output += char;
      continue;
    }
    if ((char === "]" || char === ")" || char === "}") && stack.length) {
      const expected = stack[stack.length - 1];
      if (char === expected) {
        stack.pop();
      }
      output += char;
      continue;
    }
    if (char === "\n" && stack.length) {
      output += "<br/>";
      continue;
    }
    output += char;
  }
  return output;
}

function splitAdjacentNodes(text) {
  const input = String(text || "");
  const isIdChar = (char) => /[A-Za-z0-9_]/.test(char);
  const isSkippable = (char) => /[ \t\r\u00A0]/.test(char) || /[\u200B-\u200D\uFEFF]/.test(char);
  const out = [];
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    out.push(char);
    if (char !== "]" && char !== ")" && char !== "}") continue;
    let j = i + 1;
    while (j < input.length && isSkippable(input[j])) {
      j += 1;
    }
    if (j >= input.length || input[j] === "\n") continue;
    if (!isIdChar(input[j])) continue;
    let k = j;
    while (k < input.length && isIdChar(input[k])) {
      k += 1;
    }
    while (k < input.length && isSkippable(input[k])) {
      k += 1;
    }
    if (k < input.length && (input[k] === "[" || input[k] === "(" || input[k] === "{")) {
      out.push("\n");
    }
  }
  return out.join("");
}

function normalizeBracketLabelBreaks(text) {
  const input = String(text || "");
  let output = "";
  let inLabel = false;
  let buffer = "";
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (!inLabel) {
      if (char === "[") {
        inLabel = true;
        buffer = "";
        output += char;
        continue;
      }
      output += char;
      continue;
    }
    if (char === "]") {
      let adjusted = buffer.replace(/\r/g, "");
      let hadBreak = false;
      if (adjusted.includes("\n")) {
        adjusted = adjusted.replace(/\n/g, "\\n");
        hadBreak = true;
      }
      const replaced = adjusted.replace(/<br\s*\/?>/gi, "\\n");
      if (replaced !== adjusted) {
        hadBreak = true;
      }
      adjusted = replaced;
      if (/\\n/.test(adjusted)) {
        hadBreak = true;
      }
      if (hadBreak) {
        adjusted = adjusted.replace(/^(\\n)+/, "").replace(/(\\n)+$/, "");
        const trimmed = adjusted.trim();
        const isQuoted = trimmed.startsWith("\"") && trimmed.endsWith("\"");
        if (!isQuoted) {
          const escaped = adjusted.trim().replace(/"/g, '\\"');
          adjusted = `"${escaped}"`;
        }
      }
      output += adjusted + "]";
      inLabel = false;
      buffer = "";
      continue;
    }
    buffer += char;
  }
  if (inLabel) {
    output += buffer;
  }
  return output;
}

const BASIC_MODELS = [
  "gemini-2.5-flash",
  "gemini-2.5-pro",
  "gemini-1.5-flash-002",
  "gemini-1.5-pro-002",
];
const GROQ_MODELS = [
  "llama-3.3-70b-versatile",
  "llama-3.1-70b-versatile",
  "llama-3.1-8b-instant",
  "mixtral-8x7b-32768",
  "gemma2-9b-it",
];
const OLLAMA_DEFAULT_MODELS = [];
const LOCAL_OCR_HOST = window.location.hostname || "localhost";
const LOCAL_OCR_PROTOCOL = window.location.protocol === "file:" ? "http:" : window.location.protocol;
const LOCAL_OCR_URL = `${LOCAL_OCR_PROTOCOL}//${LOCAL_OCR_HOST}:8001/ocr`;
const CONTAINER_LOG_URL = `${LOCAL_OCR_PROTOCOL}//${LOCAL_OCR_HOST}:8001/logs`;
const LOCAL_OLLAMA_HOST = window.location.hostname || "localhost";
const LOCAL_OLLAMA_PROTOCOL = window.location.protocol === "file:" ? "http:" : window.location.protocol;
const LOCAL_OLLAMA_DIRECT_URL = `${LOCAL_OLLAMA_PROTOCOL}//${LOCAL_OLLAMA_HOST}:11434`;
const LOCAL_OLLAMA_PROXY_URL = `${LOCAL_OCR_PROTOCOL}//${LOCAL_OCR_HOST}:8001/ollama`;
const LOCAL_OLLAMA_URL = LOCAL_OLLAMA_PROXY_URL;

const SAMPLE_MERMAID = `flowchart TD
  A[User uploads sketch] --> B{Mode?}
  B -->|Gemini| C[Send to Gemini API]
  B -->|Webhook| D[Send to custom webhook]
  C --> E[Mermaid output]
  D --> E
  E --> F[Editable Mermaid]
  F --> G[Rendered preview]`;

const state = {
  mode: "gemini",
  file: null,
  base64: "",
  mime: "",
  ocr: null,
  lastProvider: null,
  lastModel: "",
  lastBaseUrl: "",
  lastGeneratedMermaid: "",
  autoFixAttempts: 0,
  autoFixInProgress: false,
  ollamaFetchInProgress: false,
  ollamaAutoFetched: false,
  containerLogOffset: 0,
  containerLogLines: [],
  containerLogPolling: false,
  mermaidRenderCount: 0,
  openaiModelFetchTimer: null,
  openaiModelsLoaded: false,
  geminiModelFetchTimer: null,
  geminiModelsLoaded: false,
  groqModelFetchTimer: null,
  groqModelsLoaded: false,
  previewResizeObserver: null,
  manualLineCounter: 1,
  selectedOcrNodeId: "",
  selectedOcrLineId: "",
  pendingNodeEdits: {},
  ocrRefreshTimer: null,
};

const elements = {
  promptInput: document.getElementById("promptInput"),
  resetPrompt: document.getElementById("resetPrompt"),
  geminiPanel: document.getElementById("geminiPanel"),
  geminiKey: document.getElementById("geminiKey"),
  geminiModel: document.getElementById("geminiModel"),
  groqPanel: document.getElementById("groqPanel"),
  groqKey: document.getElementById("groqKey"),
  groqModel: document.getElementById("groqModel"),
  groqModelList: document.getElementById("groqModelList"),
  useGroqModels: document.getElementById("useGroqModels"),
  openaiPanel: document.getElementById("openaiPanel"),
  openaiKey: document.getElementById("openaiKey"),
  openaiModel: document.getElementById("openaiModel"),
  openaiModelList: document.getElementById("openaiModelList"),
  ollamaPanel: document.getElementById("ollamaPanel"),
  ollamaUrl: document.getElementById("ollamaUrl"),
  ollamaModel: document.getElementById("ollamaModel"),
  ollamaModelSelect: document.getElementById("ollamaModelSelect"),
  fetchOllamaModels: document.getElementById("fetchOllamaModels"),
  webhookPanel: document.getElementById("webhookPanel"),
  webhookUrl: document.getElementById("webhookUrl"),
  webhookHeaders: document.getElementById("webhookHeaders"),
  fetchModels: document.getElementById("fetchModels"),
  useBasicModels: document.getElementById("useBasicModels"),
  modelStatus: document.getElementById("modelStatus"),
  geminiModelList: document.getElementById("geminiModelList"),
  complexMode: document.getElementById("complexMode"),
  finalCheck: document.getElementById("finalCheck"),
  ocrEnabled: document.getElementById("ocrEnabled"),
  ocrUrl: document.getElementById("ocrUrl"),
  ocrHeaders: document.getElementById("ocrHeaders"),
  useLocalOcr: document.getElementById("useLocalOcr"),
  ocrEditor: document.getElementById("ocrEditor"),
  houghCannyLow: document.getElementById("houghCannyLow"),
  houghCannyLowValue: document.getElementById("houghCannyLowValue"),
  houghCannyHigh: document.getElementById("houghCannyHigh"),
  houghCannyHighValue: document.getElementById("houghCannyHighValue"),
  houghThreshold: document.getElementById("houghThreshold"),
  houghThresholdValue: document.getElementById("houghThresholdValue"),
  houghMinLength: document.getElementById("houghMinLength"),
  houghMinLengthValue: document.getElementById("houghMinLengthValue"),
  houghMaxGap: document.getElementById("houghMaxGap"),
  houghMaxGapValue: document.getElementById("houghMaxGapValue"),
  houghMaxLines: document.getElementById("houghMaxLines"),
  houghMaxLinesValue: document.getElementById("houghMaxLinesValue"),
  refreshOcr: document.getElementById("refreshOcr"),
  ocrNodeSelect: document.getElementById("ocrNodeSelect"),
  ocrNodeEdit: document.getElementById("ocrNodeEdit"),
  ocrNodeRename: document.getElementById("ocrNodeRename"),
  ocrNodeActive: document.getElementById("ocrNodeActive"),
  ocrEdgeSelect: document.getElementById("ocrEdgeSelect"),
  removeEdgeBtn: document.getElementById("removeEdgeBtn"),
  applyOcrEdits: document.getElementById("applyOcrEdits"),
  edgeFromSelect: document.getElementById("edgeFromSelect"),
  edgeToSelect: document.getElementById("edgeToSelect"),
  addEdgeBtn: document.getElementById("addEdgeBtn"),
  diagramType: document.getElementById("diagramType"),
  uploadInput: document.getElementById("uploadInput"),
  dropzone: document.getElementById("dropzone"),
  imagePreview: document.getElementById("imagePreview"),
  fileBadge: document.getElementById("fileBadge"),
  convertBtn: document.getElementById("convertBtn"),
  renderBtn: document.getElementById("renderBtn"),
  sampleBtn: document.getElementById("sampleBtn"),
  clearBtn: document.getElementById("clearBtn"),
  mermaidText: document.getElementById("mermaidText"),
  diagramPreview: document.getElementById("diagramPreview"),
  statusPanel: document.getElementById("statusPanel"),
  payloadPreview: document.getElementById("payloadPreview"),
  autoRender: document.getElementById("autoRender"),
  logPanel: document.getElementById("logPanel"),
  clearLog: document.getElementById("clearLog"),
  containerLogPanel: document.getElementById("containerLogPanel"),
  clearContainerLog: document.getElementById("clearContainerLog"),
};

mermaid.initialize({ startOnLoad: false, theme: "base" });

elements.promptInput.value = DEFAULT_PROMPT;
elements.geminiModel.value = BASIC_MODELS[0];
elements.groqModel.value = GROQ_MODELS[0];
elements.openaiModel.value = "";
elements.ollamaModel.value = "";

function setStatus(message, tone = "neutral") {
  elements.statusPanel.textContent = message;
  elements.statusPanel.dataset.tone = tone;
}

function setModelStatus(message) {
  elements.modelStatus.textContent = message;
}

function logMessage(message, tone = "neutral") {
  if (!elements.logPanel) return;
  const entry = document.createElement("div");
  entry.className = `log-entry ${tone}`;
  const time = document.createElement("div");
  time.className = "log-time";
  time.textContent = new Date().toLocaleTimeString();
  const text = document.createElement("div");
  text.textContent = message;
  entry.appendChild(time);
  entry.appendChild(text);
  elements.logPanel.appendChild(entry);
  elements.logPanel.scrollTop = elements.logPanel.scrollHeight;
}

function clearLog() {
  if (elements.logPanel) {
    elements.logPanel.innerHTML = "";
  }
}

function setupPreviewResizeObserver() {
  if (state.previewResizeObserver) {
    state.previewResizeObserver.disconnect();
    state.previewResizeObserver = null;
  }
  const stage = elements.imagePreview.querySelector(".preview-stage");
  if (!stage || typeof ResizeObserver === "undefined") return;
  state.previewResizeObserver = new ResizeObserver(() => {
    renderOcrOverlay();
  });
  state.previewResizeObserver.observe(stage);
}

function appendContainerLog(lines) {
  if (!elements.containerLogPanel || !lines.length) return;
  state.containerLogLines = state.containerLogLines.concat(lines);
  if (state.containerLogLines.length > 400) {
    state.containerLogLines = state.containerLogLines.slice(-400);
  }
  elements.containerLogPanel.textContent = state.containerLogLines.join("\n");
  elements.containerLogPanel.scrollTop = elements.containerLogPanel.scrollHeight;
}

function clearContainerLog() {
  state.containerLogLines = [];
  state.containerLogOffset = 0;
  if (elements.containerLogPanel) {
    elements.containerLogPanel.textContent = "";
  }
}

async function fetchContainerLogs({ tail = false } = {}) {
  if (state.containerLogPolling) return;
  state.containerLogPolling = true;
  try {
    const params = new URLSearchParams();
    if (tail || !state.containerLogOffset) {
      params.set("tail", "200");
    } else {
      params.set("offset", String(state.containerLogOffset));
    }
    const response = await fetch(`${CONTAINER_LOG_URL}?${params.toString()}`);
    if (!response.ok) {
      return;
    }
    const data = await response.json();
    const lines = Array.isArray(data.lines) ? data.lines : [];
    if (typeof data.offset === "number") {
      state.containerLogOffset = data.offset;
    }
    appendContainerLog(lines);
  } catch (err) {
    console.error(err);
  } finally {
    state.containerLogPolling = false;
  }
}

function updateMode(mode) {
  state.mode = mode;
  elements.geminiPanel.classList.toggle("hidden", mode !== "gemini");
  elements.webhookPanel.classList.toggle("hidden", mode !== "webhook");
  elements.groqPanel.classList.toggle("hidden", mode !== "groq");
  elements.openaiPanel.classList.toggle("hidden", mode !== "openai");
  elements.ollamaPanel.classList.toggle("hidden", mode !== "ollama");
  updatePayloadPreview();
  if (mode === "ollama" && !state.ollamaAutoFetched) {
    fetchOllamaModels({ auto: true }).then((loaded) => {
      if (loaded) {
        state.ollamaAutoFetched = true;
      }
    });
  }
  if (mode === "gemini" && !state.geminiModelsLoaded) {
    scheduleGeminiModelFetch();
  }
  if (mode === "groq" && !state.groqModelsLoaded) {
    scheduleGroqModelFetch();
  }
  if (mode === "openai" && !state.openaiModelsLoaded) {
    scheduleOpenaiModelFetch();
  }
}

function updatePayloadPreview() {
  const payload = {
    prompt: elements.promptInput.value.trim(),
    output: "mermaid",
    image: {
      mime_type: state.mime || "image/png",
      base64: state.base64 ? "<base64>" : "",
    },
  };
  const ocrPreview = serializeOcr(state.ocr);
  if (ocrPreview?.blocks?.length) {
    payload.ocr = {
      blocks: [
        {
          text: ocrPreview.blocks[0].text,
          box: ocrPreview.blocks[0].box,
        },
      ],
      note: "Only first OCR block shown in preview.",
    };
  }
  elements.payloadPreview.textContent = JSON.stringify(payload, null, 2);
}

function setPreviewImage(dataUrl) {
  elements.imagePreview.innerHTML = "";
  if (!dataUrl) {
    const placeholder = document.createElement("div");
    placeholder.className = "preview-placeholder";
    placeholder.textContent = "No preview yet";
    elements.imagePreview.appendChild(placeholder);
    return;
  }
  const stage = document.createElement("div");
  stage.className = "preview-stage";
  const img = document.createElement("img");
  img.src = dataUrl;
  const overlay = document.createElement("div");
  overlay.className = "ocr-overlay";
  stage.appendChild(img);
  stage.appendChild(overlay);
  elements.imagePreview.appendChild(stage);
  img.onload = () => {
    renderOcrOverlay();
    setupPreviewResizeObserver();
  };
}

function updateFileBadge() {
  if (!state.file) {
    elements.fileBadge.textContent = "No file";
    return;
  }
  elements.fileBadge.textContent = `${state.file.name} (${Math.round(state.file.size / 1024)} KB)`;
}

function extractMermaid(text) {
  if (!text) return "";
  const fenceMatch = text.match(/```[a-zA-Z]*\n([\s\S]*?)```/);
  if (fenceMatch) {
    return fenceMatch[1].trim();
  }
  const flowIndex = text.search(/(flowchart|graph|sequenceDiagram|stateDiagram|stateDiagram-v2|classDiagram|erDiagram|journey|gantt|mindmap)/i);
  if (flowIndex >= 0) {
    return text.slice(flowIndex).trim();
  }
  return text.trim();
}

function normalizeMermaid(code) {
  if (!code) return "";
  let text = code.trim();
  text = text.replace(/\r\n/g, "\n");
  text = text.replace(/[\u200B-\u200D\uFEFF]/g, "");
  text = text.replace(/\u00A0/g, " ");
  text = flattenLabelNewlines(text);
  text = splitAdjacentNodes(text);
  text = text.replace(/(^|\n)(\s*)(flowchart|graph)(?=[A-Za-z]{2})/gi, "$1$2$3 ");
  text = text.replace(/(\S)\s+(subgraph\b)/gi, "$1\n$2");
  text = text.replace(/(\S)\s+(end\b)/gi, "$1\n$2");
  text = text.replace(/(-->|==>|-\.->|--->|===>)\|([^|]+)\|\s*>/g, "$1|$2| ");
  text = text.replace(/([\]\)\}])\s*([A-Za-z0-9_]{1,30})(?=\s*[\[\(\{])/g, "$1\n$2");
  text = text.replace(/([\]\)\}])([A-Za-z0-9_])(?=[A-Za-z0-9_]*\s*-->)/g, "$1\n$2");
  const lines = text.split("\n");
  const fixed = [];
  lines.forEach((line) => {
    const headerMatch = line.match(/^(\s*)(flowchart|graph)\s*([A-Za-z]{2})\s*(.*)$/i);
    if (headerMatch) {
      const indent = headerMatch[1];
      const keyword = headerMatch[2];
      const direction = headerMatch[3];
      const rest = (headerMatch[4] || "").trim();
      fixed.push(`${indent}${keyword} ${direction}`);
      if (rest) {
        fixed.push(`${indent}${rest}`);
      }
      return;
    }
    const endMatch = line.match(/^(\s*)end\b(.*)$/i);
    if (endMatch) {
      const indent = endMatch[1];
      const rest = endMatch[2].trim();
      fixed.push(`${indent}end`);
      if (rest) {
        fixed.push(`${indent}${rest}`);
      }
      return;
    }
    fixed.push(line);
  });
  text = fixed.join("\n");
  const subgraphFixed = text.split("\n").map((line) => {
    const match = line.match(/^(\s*)subgraph\s+(.+)$/i);
    if (!match) return line;
    const indent = match[1];
    const rest = match[2].trim();
    if (!rest || /^["'`].*["'`]$/.test(rest) || /^\[.*\]$/.test(rest)) {
      return line;
    }
    if (/\s/.test(rest)) {
      return `${indent}subgraph "${rest}"`;
    }
    return line;
  });
  text = subgraphFixed.join("\n");
  text = normalizeBracketLabelBreaks(text);
  return text;
}

function extractJson(text) {
  if (!text) return null;
  const fenceMatch =
    text.match(/```json\s*([\s\S]*?)```/i) || text.match(/```([\s\S]*?)```/);
  const candidate = fenceMatch ? fenceMatch[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const slice = candidate.slice(start, end + 1);
    try {
      return JSON.parse(slice);
    } catch (err) {
      return null;
    }
  }
  return null;
}

function normalizeOcrBox(box) {
  if (!box) return null;
  if (Array.isArray(box) && box.length >= 4) {
    const [x, y, w, h] = box;
    return { x, y, w, h };
  }
  if (box.x !== undefined || box.y !== undefined) {
    return {
      x: box.x ?? box.left ?? 0,
      y: box.y ?? box.top ?? 0,
      w: box.w ?? box.width ?? 0,
      h: box.h ?? box.height ?? 0,
    };
  }
  return null;
}

function normalizeOcrResponse(data) {
  if (!data || typeof data !== "object") return null;
  const blocks = data.blocks || data.textBlocks || data.words || [];
  const normalized = Array.isArray(blocks)
    ? blocks
        .map((block) => {
          if (!block) return null;
          const text = String(block.text || block.value || "").trim();
          if (!text) return null;
          const box = normalizeOcrBox(block.box || block.bbox || block.boundingBox || block.rect);
          return { text, box };
        })
        .filter(Boolean)
    : [];
  const lines = Array.isArray(data.lines)
    ? data.lines
        .map((line) => {
          if (!line) return null;
          const x1 = Number(line.x1 ?? line[0]);
          const y1 = Number(line.y1 ?? line[1]);
          const x2 = Number(line.x2 ?? line[2]);
          const y2 = Number(line.y2 ?? line[3]);
          if ([x1, y1, x2, y2].some((val) => Number.isNaN(val))) return null;
          return { x1, y1, x2, y2 };
        })
        .filter(Boolean)
    : [];
  if (!normalized.length && data.text) {
    return normalizeOcrState({ blocks: [{ text: String(data.text).trim(), box: null }], lines });
  }
  if (!normalized.length && !lines.length) return null;
  return normalizeOcrState({ blocks: normalized, lines });
}

function normalizeOcrState(ocr) {
  if (!ocr) return null;
  const blocks = Array.isArray(ocr.blocks) ? ocr.blocks : [];
  const lines = Array.isArray(ocr.lines) ? ocr.lines : [];
  const normalizedBlocks = blocks.map((block, index) => {
    const text = String(block.text || block.value || "").trim();
    const box = block.box ? normalizeOcrBox(block.box) : null;
    return {
      id: block.id || `B${index + 1}`,
      text,
      box,
      active: block.active !== false,
    };
  });
  const normalizedLines = lines.map((line, index) => {
    const x1 = Number(line.x1 ?? line[0]);
    const y1 = Number(line.y1 ?? line[1]);
    const x2 = Number(line.x2 ?? line[2]);
    const y2 = Number(line.y2 ?? line[3]);
    return {
      id: line.id || `L${index + 1}`,
      x1,
      y1,
      x2,
      y2,
      source: line.source || "hough",
      active: line.active !== false,
      fromId: line.fromId || null,
      toId: line.toId || null,
    };
  });
  return { blocks: normalizedBlocks, lines: normalizedLines };
}

function syncManualLineCounter() {
  const lines = state.ocr?.lines || [];
  let maxId = 0;
  lines.forEach((line) => {
    if (line.source !== "manual") return;
    const match = String(line.id || "").match(/M(\d+)/);
    if (match) {
      maxId = Math.max(maxId, Number(match[1]));
    }
  });
  state.manualLineCounter = Math.max(state.manualLineCounter, maxId + 1);
}

function getActiveBlocks(ocr) {
  if (!ocr?.blocks?.length) return [];
  return ocr.blocks.filter((block) => block && block.active !== false);
}

function getActiveLines(ocr) {
  if (!ocr?.lines?.length) return [];
  return ocr.lines.filter((line) => line && line.active !== false);
}

function serializeOcr(ocr) {
  if (!ocr) return null;
  const blocks = getActiveBlocks(ocr).map((block) => ({
    text: block.text,
    box: block.box,
  }));
  const lines = getActiveLines(ocr).map((line) => ({
    x1: line.x1,
    y1: line.y1,
    x2: line.x2,
    y2: line.y2,
  }));
  if (!blocks.length && !lines.length) return null;
  return { blocks, lines };
}

function readHoughParams() {
  if (!elements.houghCannyLow) return {};
  const cannyLow = Number(elements.houghCannyLow.value || 0);
  const cannyHigh = Number(elements.houghCannyHigh.value || 0);
  const normalizedHigh = Math.max(cannyLow, cannyHigh);
  return {
    canny_low: cannyLow,
    canny_high: normalizedHigh,
    threshold: Number(elements.houghThreshold.value || 0),
    min_line_length: Number(elements.houghMinLength.value || 0),
    max_line_gap: Number(elements.houghMaxGap.value || 0),
    max_lines: Number(elements.houghMaxLines.value || 0),
  };
}

function syncHoughLabels() {
  if (!elements.houghCannyLow) return;
  let low = Number(elements.houghCannyLow.value || 0);
  let high = Number(elements.houghCannyHigh.value || 0);
  if (high < low) {
    high = low;
    elements.houghCannyHigh.value = String(high);
  }
  elements.houghCannyLowValue.textContent = String(low);
  elements.houghCannyHighValue.textContent = String(high);
  elements.houghThresholdValue.textContent = elements.houghThreshold.value;
  elements.houghMinLengthValue.textContent = elements.houghMinLength.value;
  elements.houghMaxGapValue.textContent = elements.houghMaxGap.value;
  elements.houghMaxLinesValue.textContent = elements.houghMaxLines.value;
}

function setOcrEditorVisibility() {
  if (!elements.ocrEditor || !elements.ocrEnabled) return;
  elements.ocrEditor.classList.toggle("hidden", !elements.ocrEnabled.checked);
}

function scheduleOcrRefresh({ preserveBlocks = true, keepManual = true } = {}) {
  if (!elements.ocrEnabled?.checked || !state.base64) return;
  if (state.ocrRefreshTimer) {
    clearTimeout(state.ocrRefreshTimer);
  }
  state.ocrRefreshTimer = setTimeout(async () => {
    try {
      await runOcr({ preserveBlocks, keepManual });
    } catch (err) {
      console.error(err);
      logMessage(err.message || "OCR refresh failed.", "error");
    } finally {
      state.ocrRefreshTimer = null;
    }
  }, 350);
}

function buildLineHints(ocr) {
  const blocks = getActiveBlocks(ocr);
  const lines = getActiveLines(ocr);
  if (!lines.length || !blocks.length) return [];
  const bounds = { maxX: 0, maxY: 0 };
  blocks.forEach((block) => {
    if (!block.box) return;
    bounds.maxX = Math.max(bounds.maxX, block.box.x + block.box.w);
    bounds.maxY = Math.max(bounds.maxY, block.box.y + block.box.h);
  });
  lines.forEach((line) => {
    bounds.maxX = Math.max(bounds.maxX, line.x1, line.x2);
    bounds.maxY = Math.max(bounds.maxY, line.y1, line.y2);
  });
  const maxDim = Math.max(bounds.maxX, bounds.maxY) || 1;
  const threshold = Math.max(40, Math.round(maxDim * 0.08));
  const centers = blocks.map((block) => {
    if (!block.box) return null;
    return {
      x: block.box.x + block.box.w / 2,
      y: block.box.y + block.box.h / 2,
    };
  });
  const edges = new Set();
  lines.forEach((line) => {
    const start = { x: line.x1, y: line.y1 };
    const end = { x: line.x2, y: line.y2 };
    const matchEndpoint = (point) => {
      let bestIndex = -1;
      let bestDist = Number.POSITIVE_INFINITY;
      centers.forEach((center, index) => {
        if (!center) return;
        const dx = point.x - center.x;
        const dy = point.y - center.y;
        const dist = Math.hypot(dx, dy);
        if (dist < bestDist) {
          bestDist = dist;
          bestIndex = index;
        }
      });
      if (bestDist > threshold) return -1;
      return bestIndex;
    };
    const a = matchEndpoint(start);
    const b = matchEndpoint(end);
    if (a >= 0 && b >= 0 && a !== b) {
      const key = a < b ? `${a + 1}<->${b + 1}` : `${b + 1}<->${a + 1}`;
      edges.add(key);
    }
  });
  return Array.from(edges);
}

function renderOcrOverlay() {
  const stage = elements.imagePreview.querySelector(".preview-stage");
  if (!stage) return;
  const img = stage.querySelector("img");
  const overlay = stage.querySelector(".ocr-overlay");
  if (!img || !overlay) return;
  overlay.innerHTML = "";
  if (!state.ocr || (!state.ocr.blocks?.length && !state.ocr.lines?.length)) {
    return;
  }
  if (!img.naturalWidth || !img.naturalHeight) {
    return;
  }
  const scaleX = img.clientWidth / img.naturalWidth;
  const scaleY = img.clientHeight / img.naturalHeight;
  if (state.ocr.lines?.length) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "ocr-lines");
    svg.setAttribute("width", String(img.clientWidth));
    svg.setAttribute("height", String(img.clientHeight));
    state.ocr.lines.forEach((line) => {
      const element = document.createElementNS("http://www.w3.org/2000/svg", "line");
      element.setAttribute("x1", String(line.x1 * scaleX));
      element.setAttribute("y1", String(line.y1 * scaleY));
      element.setAttribute("x2", String(line.x2 * scaleX));
      element.setAttribute("y2", String(line.y2 * scaleY));
      element.setAttribute("class", "ocr-line");
      if (line.source === "manual") {
        element.classList.add("manual");
      }
      if (line.active === false) {
        element.classList.add("inactive");
      }
      if (line.id && line.id === state.selectedOcrLineId) {
        element.classList.add("selected");
      }
      element.dataset.lineId = line.id;
      element.addEventListener("click", (event) => {
        event.stopPropagation();
        toggleOcrLineActive(line.id);
      });
      svg.appendChild(element);
    });
    overlay.appendChild(svg);
  }
  state.ocr.blocks.forEach((block) => {
    if (!block.box) return;
    const { x, y, w, h } = block.box;
    const box = document.createElement("div");
    box.className = "ocr-box";
    if (block.active === false) {
      box.classList.add("inactive");
    }
    if (block.id && block.id === state.selectedOcrNodeId) {
      box.classList.add("selected");
    }
    box.style.left = `${x * scaleX}px`;
    box.style.top = `${y * scaleY}px`;
    box.style.width = `${w * scaleX}px`;
    box.style.height = `${h * scaleY}px`;
    const label = document.createElement("div");
    label.className = "ocr-label";
    if (block.active === false) {
      label.classList.add("inactive");
    }
    if (block.id && block.id === state.selectedOcrNodeId) {
      label.classList.add("selected");
    }
    label.textContent = block.text;
    box.appendChild(label);
    overlay.appendChild(box);
  });
}

function updateEdgeSelectors() {
  if (!elements.edgeFromSelect || !elements.edgeToSelect) return;
  const activeBlocks = getActiveBlocks(state.ocr);
  const previousFrom = elements.edgeFromSelect.value;
  const previousTo = elements.edgeToSelect.value;
  elements.edgeFromSelect.innerHTML = "";
  elements.edgeToSelect.innerHTML = "";
  if (!activeBlocks.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No OCR nodes";
    elements.edgeFromSelect.appendChild(option.cloneNode(true));
    elements.edgeToSelect.appendChild(option);
    if (elements.addEdgeBtn) {
      elements.addEdgeBtn.disabled = true;
    }
    return;
  }
  activeBlocks.forEach((block) => {
    const label = `${block.id}: ${block.text || "Untitled"}`;
    const optionFrom = document.createElement("option");
    optionFrom.value = block.id;
    optionFrom.textContent = label;
    const optionTo = document.createElement("option");
    optionTo.value = block.id;
    optionTo.textContent = label;
    elements.edgeFromSelect.appendChild(optionFrom);
    elements.edgeToSelect.appendChild(optionTo);
  });
  if (previousFrom) {
    elements.edgeFromSelect.value = previousFrom;
  }
  if (previousTo) {
    elements.edgeToSelect.value = previousTo;
  }
  if (elements.addEdgeBtn) {
    elements.addEdgeBtn.disabled = activeBlocks.length < 2;
  }
}

function buildLineAdjacencyMap(ocr) {
  const lines = ocr?.lines || [];
  const blocks = ocr?.blocks || [];
  const map = new Map();
  if (!lines.length || !blocks.length) return map;
  const centers = blocks
    .map((block) => {
      if (!block.box) return null;
      return {
        id: block.id,
        x: block.box.x + block.box.w / 2,
        y: block.box.y + block.box.h / 2,
      };
    })
    .filter(Boolean);
  if (!centers.length) return map;
  const bounds = { maxX: 0, maxY: 0 };
  blocks.forEach((block) => {
    if (!block.box) return;
    bounds.maxX = Math.max(bounds.maxX, block.box.x + block.box.w);
    bounds.maxY = Math.max(bounds.maxY, block.box.y + block.box.h);
  });
  lines.forEach((line) => {
    bounds.maxX = Math.max(bounds.maxX, line.x1, line.x2);
    bounds.maxY = Math.max(bounds.maxY, line.y1, line.y2);
  });
  const maxDim = Math.max(bounds.maxX, bounds.maxY) || 1;
  const threshold = Math.max(40, Math.round(maxDim * 0.08));
  const matchEndpoint = (point) => {
    let bestId = "";
    let bestDist = Number.POSITIVE_INFINITY;
    centers.forEach((center) => {
      const dx = point.x - center.x;
      const dy = point.y - center.y;
      const dist = Math.hypot(dx, dy);
      if (dist < bestDist) {
        bestDist = dist;
        bestId = center.id;
      }
    });
    if (bestDist > threshold) return "";
    return bestId;
  };
  lines.forEach((line) => {
    let fromId = line.fromId || "";
    let toId = line.toId || "";
    if (!fromId || !toId) {
      const startMatch = matchEndpoint({ x: line.x1, y: line.y1 });
      const endMatch = matchEndpoint({ x: line.x2, y: line.y2 });
      fromId = fromId || startMatch;
      toId = toId || endMatch;
    }
    if (fromId || toId) {
      map.set(line.id, { fromId, toId });
    }
  });
  return map;
}

function updateOcrNodeSelectionUI() {
  if (!elements.ocrNodeEdit || !elements.ocrNodeRename || !elements.ocrNodeActive) return;
  const selectedId = state.selectedOcrNodeId;
  const block = selectedId ? state.ocr?.blocks?.find((entry) => entry.id === selectedId) : null;
  if (!block) {
    elements.ocrNodeEdit.classList.add("hidden");
    elements.ocrNodeRename.value = "";
    return;
  }
  elements.ocrNodeEdit.classList.remove("hidden");
  const pending = state.pendingNodeEdits[selectedId] || {};
  elements.ocrNodeRename.value = pending.text ?? block.text ?? "";
  elements.ocrNodeActive.checked = pending.active ?? block.active !== false;
}

function updateOcrEdgeSelectionUI() {
  if (elements.removeEdgeBtn) {
    elements.removeEdgeBtn.disabled = !state.selectedOcrLineId;
  }
}

function renderOcrEditor() {
  if (!elements.ocrNodeSelect || !elements.ocrEdgeSelect) return;
  const blocks = state.ocr?.blocks || [];
  const lines = state.ocr?.lines || [];
  elements.ocrNodeSelect.innerHTML = "";
  const nodePlaceholder = document.createElement("option");
  nodePlaceholder.value = "";
  nodePlaceholder.textContent = blocks.length ? "Select node..." : "No OCR nodes";
  elements.ocrNodeSelect.appendChild(nodePlaceholder);
  elements.ocrNodeSelect.disabled = !blocks.length;
  blocks.forEach((block) => {
    const option = document.createElement("option");
    option.value = block.id;
    const off = block.active === false ? " [off]" : "";
    option.textContent = `${block.id}${off} ${block.text || "Untitled"}`;
    elements.ocrNodeSelect.appendChild(option);
  });
  if (!blocks.some((block) => block.id === state.selectedOcrNodeId)) {
    state.selectedOcrNodeId = "";
  }
  elements.ocrNodeSelect.value = state.selectedOcrNodeId || "";
  updateOcrNodeSelectionUI();

  elements.ocrEdgeSelect.innerHTML = "";
  const edgePlaceholder = document.createElement("option");
  edgePlaceholder.value = "";
  edgePlaceholder.textContent = lines.length ? "Select edge..." : "No OCR edges";
  elements.ocrEdgeSelect.appendChild(edgePlaceholder);
  elements.ocrEdgeSelect.disabled = !lines.length;
  const adjacencyMap = buildLineAdjacencyMap(state.ocr);
  lines.forEach((line) => {
    const option = document.createElement("option");
    option.value = line.id;
    const off = line.active === false ? " [off]" : "";
    const adjacency = adjacencyMap.get(line.id);
    const fromLabel = adjacency?.fromId || "?";
    const toLabel = adjacency?.toId || "?";
    const linkLabel = adjacency ? ` ${fromLabel}<->${toLabel}` : "";
    const sourceLabel = line.source === "manual" ? " manual" : " hough";
    option.textContent = `${line.id}${off}${linkLabel}${sourceLabel}`;
    elements.ocrEdgeSelect.appendChild(option);
  });
  if (!lines.some((line) => line.id === state.selectedOcrLineId)) {
    state.selectedOcrLineId = "";
  }
  elements.ocrEdgeSelect.value = state.selectedOcrLineId || "";
  updateOcrEdgeSelectionUI();

  updateEdgeSelectors();
}

function toggleOcrLineActive(lineId) {
  if (!state.ocr?.lines?.length) return;
  const line = state.ocr.lines.find((entry) => entry.id === lineId);
  if (!line) return;
  line.active = line.active === false ? true : false;
  state.selectedOcrLineId = line.id;
  renderOcrOverlay();
  renderOcrEditor();
  updatePayloadPreview();
}

function applyOcrEdits() {
  if (!state.ocr) return;
  const edits = state.pendingNodeEdits || {};
  Object.keys(edits).forEach((id) => {
    const block = state.ocr.blocks.find((entry) => entry.id === id);
    if (!block) return;
    const change = edits[id] || {};
    if (change.text !== undefined) {
      const trimmed = String(change.text || "").trim();
      if (trimmed) {
        block.text = trimmed;
      }
    }
    if (change.active !== undefined) {
      block.active = change.active;
    }
  });
  state.pendingNodeEdits = {};
  renderOcrOverlay();
  renderOcrEditor();
  updatePayloadPreview();
  logMessage("OCR edits applied.", "ok");
}

function removeSelectedEdge() {
  if (!state.ocr?.lines?.length || !state.selectedOcrLineId) return;
  state.ocr.lines = state.ocr.lines.filter((line) => line.id !== state.selectedOcrLineId);
  state.selectedOcrLineId = "";
  renderOcrOverlay();
  renderOcrEditor();
  updatePayloadPreview();
  logMessage("OCR edge removed.", "ok");
}

function getBlockCenter(block) {
  if (!block?.box) return null;
  return {
    x: block.box.x + block.box.w / 2,
    y: block.box.y + block.box.h / 2,
  };
}

function addManualEdge() {
  if (!state.ocr) {
    setStatus("OCR data is required to add edges.", "error");
    return;
  }
  const fromId = elements.edgeFromSelect?.value;
  const toId = elements.edgeToSelect?.value;
  if (!fromId || !toId || fromId === toId) {
    setStatus("Select two different OCR nodes to add an edge.", "error");
    return;
  }
  const fromBlock = state.ocr.blocks.find((entry) => entry.id === fromId);
  const toBlock = state.ocr.blocks.find((entry) => entry.id === toId);
  const fromCenter = getBlockCenter(fromBlock);
  const toCenter = getBlockCenter(toBlock);
  if (!fromCenter || !toCenter) {
    setStatus("Selected nodes must have bounding boxes.", "error");
    return;
  }
  const duplicate = state.ocr.lines?.some(
    (line) =>
      line.source === "manual" &&
      ((line.fromId === fromId && line.toId === toId) || (line.fromId === toId && line.toId === fromId))
  );
  if (duplicate) {
    setStatus("Manual edge already exists for those nodes.", "error");
    return;
  }
  const lineId = `M${state.manualLineCounter++}`;
  const newLine = {
    id: lineId,
    x1: fromCenter.x,
    y1: fromCenter.y,
    x2: toCenter.x,
    y2: toCenter.y,
    source: "manual",
    active: true,
    fromId,
    toId,
  };
  if (!state.ocr.lines) {
    state.ocr.lines = [];
  }
  state.ocr.lines.push(newLine);
  state.selectedOcrLineId = newLine.id;
  renderOcrOverlay();
  renderOcrEditor();
  updatePayloadPreview();
  setStatus("Manual edge added.", "ok");
}

function buildOcrContext(ocr) {
  if (!ocr?.blocks?.length) return "";
  const activeBlocks = getActiveBlocks(ocr);
  if (!activeBlocks.length) return "";
  const maxBlocks = 120;
  const lines = activeBlocks.slice(0, maxBlocks).map((block, index) => {
    const box = block.box ? `${block.box.x},${block.box.y},${block.box.w},${block.box.h}` : "n/a";
    return `${index + 1}. "${block.text}" @ ${box}`;
  });
  const content = ["OCR blocks (text @ x,y,w,h):", ...lines];
  const activeLines = getActiveLines(ocr);
  if (activeLines.length) {
    const maxLines = 80;
    const lineList = activeLines.slice(0, maxLines).map((line, index) => {
      return `L${index + 1}: ${line.x1},${line.y1} -> ${line.x2},${line.y2}`;
    });
    content.push("", "Detected line segments (x1,y1 -> x2,y2):", ...lineList);
    const edgeHints = buildLineHints(ocr);
    if (edgeHints.length) {
      content.push("", "Line adjacency hints (OCR block indices):", ...edgeHints.map((edge) => `- ${edge}`));
    }
  }
  return content.join("\n");
}

function normalizeModelName(model) {
  if (!model) return "";
  return model.replace(/^models\//, "");
}

function setModelOptions(models, note) {
  elements.geminiModelList.innerHTML = "";
  const unique = Array.from(new Set(models)).filter(Boolean);
  unique.forEach((name) => {
    const option = document.createElement("option");
    option.value = name;
    elements.geminiModelList.appendChild(option);
  });
  if (note) {
    setModelStatus(note);
  } else {
    setModelStatus(`Loaded ${unique.length} model(s).`);
  }
}

function getDiagramTypeHint() {
  const value = elements.diagramType?.value || "auto";
  return value.trim();
}

function buildDiagramHintNotes() {
  const hint = getDiagramTypeHint();
  if (!hint || hint === "auto") return "";
  if (hint === "swimlane") {
    return "User hint: swimlane diagram. Use subgraph lanes with labels.";
  }
  return `User hint: diagram_type=${hint}.`;
}

function setGroqModelOptions(models) {
  elements.groqModelList.innerHTML = "";
  const unique = Array.from(new Set(models)).filter(Boolean);
  unique.forEach((name) => {
    const option = document.createElement("option");
    option.value = name;
    elements.groqModelList.appendChild(option);
  });
}

function setOpenaiModelOptions(models) {
  elements.openaiModelList.innerHTML = "";
  const unique = Array.from(new Set(models)).filter(Boolean);
  unique.forEach((name) => {
    const option = document.createElement("option");
    option.value = name;
    elements.openaiModelList.appendChild(option);
  });
}

function scheduleOpenaiModelFetch() {
  if (state.openaiModelFetchTimer) {
    clearTimeout(state.openaiModelFetchTimer);
  }
  state.openaiModelFetchTimer = setTimeout(async () => {
    const apiKey = elements.openaiKey.value.trim();
    if (!apiKey) return;
    try {
      setStatus("Fetching OpenAI models...", "working");
      const models = await listOpenAIModels(apiKey);
      if (!models.length) {
        setStatus("No OpenAI models found.", "error");
        return;
      }
      setOpenaiModelOptions(models);
      if (!elements.openaiModel.value.trim()) {
        elements.openaiModel.value = models[0];
      }
      state.openaiModelsLoaded = true;
      setStatus(`Loaded ${models.length} OpenAI model(s).`, "ok");
      logMessage(`OpenAI: loaded ${models.length} model(s).`, "ok");
    } catch (err) {
      console.error(err);
      setStatus(err.message || "Failed to fetch OpenAI models.", "error");
    }
  }, 500);
}

function scheduleGeminiModelFetch() {
  if (state.geminiModelFetchTimer) {
    clearTimeout(state.geminiModelFetchTimer);
  }
  state.geminiModelFetchTimer = setTimeout(async () => {
    const apiKey = elements.geminiKey.value.trim();
    if (!apiKey) return;
    try {
      setModelStatus("Fetching models...");
      const models = await listGeminiModels(apiKey);
      if (!models.length) {
        setModelStatus("No models found for this key.");
        return;
      }
      setModelOptions(models);
      if (!elements.geminiModel.value.trim()) {
        elements.geminiModel.value = models[0];
      }
      state.geminiModelsLoaded = true;
      setModelStatus(`Loaded ${models.length} model(s).`);
    } catch (err) {
      console.error(err);
      setModelStatus(err.message || "Failed to fetch models.");
    }
  }, 500);
}

function scheduleGroqModelFetch() {
  if (state.groqModelFetchTimer) {
    clearTimeout(state.groqModelFetchTimer);
  }
  state.groqModelFetchTimer = setTimeout(async () => {
    const apiKey = elements.groqKey.value.trim();
    if (!apiKey) return;
    try {
      setStatus("Fetching Groq models...", "working");
      const models = await listGroqModels(apiKey);
      if (!models.length) {
        setStatus("No Groq models found.", "error");
        return;
      }
      setGroqModelOptions(models);
      if (!elements.groqModel.value.trim()) {
        elements.groqModel.value = models[0];
      }
      state.groqModelsLoaded = true;
      setStatus(`Loaded ${models.length} Groq model(s).`, "ok");
    } catch (err) {
      console.error(err);
      setStatus(err.message || "Failed to fetch Groq models.", "error");
    }
  }, 500);
}

function setOllamaModelOptions(models) {
  elements.ollamaModelSelect.innerHTML = "";
  const unique = Array.from(new Set(models)).filter(Boolean).sort();
  if (!unique.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No models loaded";
    elements.ollamaModelSelect.appendChild(option);
    return;
  }
  unique.forEach((name) => {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = name;
    elements.ollamaModelSelect.appendChild(option);
  });
}

function buildStage1Prompt(userPrompt) {
  const ocrContext = buildOcrContext(state.ocr);
  const diagramHint = buildDiagramHintNotes();
  return [
    "You are a flowchart analyst.",
    "Read the image and return JSON only.",
    "Schema:",
    "{",
    '  \"diagram_type\": \"flowchart|tree|swimlane|sequence|state|unknown\",',
    '  \"direction\": \"TD|LR|TB|RL\",',
    '  \"nodes\": [{\"id\":\"A\",\"label\":\"Start\",\"shape\":\"round\"}],',
    '  \"edges\": [{\"from\":\"A\",\"to\":\"B\",\"label\":\"Yes\"}],',
    '  \"lanes\": [{\"id\":\"L1\",\"label\":\"User\",\"nodes\":[\"A\",\"B\"]}]',
    "}",
    "Rules:",
    "- Output JSON only, no markdown fences.",
    "- Use short ASCII ids (A, B, C...).",
    "- Keep labels short and readable.",
    "- Every edge must reference existing node ids.",
    "- Do not invent edges based on label meaning; only use visible connections.",
    "- If a connection is unclear, omit it instead of guessing.",
    "- Make sure node ids are unique and referenced consistently in edges.",
    "- If lanes are not present, return an empty array for lanes.",
    diagramHint ? "- If the user hint specifies a diagram type, set diagram_type to that value." : "",
    "- If line segments are provided, use them to infer node connections.",
    "- If arrowheads are unclear, infer direction using layout (top-to-bottom, left-to-right).",
    "- If still unclear, omit the edge.",
    ocrContext ? "Use OCR blocks to recover small text labels." : "",
    ocrContext,
    diagramHint,
    userPrompt ? `User constraints:\n${userPrompt}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function buildSingleShotPrompt(userPrompt) {
  const ocrContext = buildOcrContext(state.ocr);
  const diagramHint = buildDiagramHintNotes();
  return [
    "You are a flowchart analyst.",
    "Read the image and output Mermaid code only.",
    "Rules:",
    "- Prefer flowchart TD unless the diagram is clearly sequence or state.",
    "- If the diagram is sequence, use sequenceDiagram.",
    "- If the diagram is state-based, use stateDiagram-v2.",
    "- For swimlanes, use subgraph blocks.",
    diagramHint ? "- Follow the user hint for diagram type." : "",
    "- Use line segments to infer connections between nodes.",
    "- If arrowheads are unclear, infer direction from layout.",
    "- Keep labels short and readable.",
    "- Put exactly one statement per line; never place two node definitions on one line.",
    "- If a label needs multiple lines, use <br/> inside the label.",
    "- Do not invent edges that are not visible in the image.",
    "- No markdown fences or extra commentary.",
    ocrContext ? "Use OCR blocks to recover small text labels." : "",
    ocrContext,
    diagramHint,
    userPrompt ? `User constraints:\n${userPrompt}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function buildStage2Prompt(structure, userPrompt) {
  const jsonBlock = JSON.stringify(structure, null, 2);
  const diagramHint = buildDiagramHintNotes();
  return [
    "You are a Mermaid author.",
    "Using the JSON structure below, output Mermaid code only.",
    "Rules:",
    "- If diagram_type is sequence, use sequenceDiagram.",
    "- If diagram_type is state, use stateDiagram-v2.",
    "- Otherwise use flowchart with direction from JSON.",
    "- If direction is missing, default to TD.",
    "- Map shapes: round -> ( ), square -> [ ], diamond -> { }.",
    "- If lanes are provided, use subgraph blocks per lane.",
    diagramHint ? "- Follow the user hint for diagram type." : "",
    diagramHint && diagramHint.includes("swimlane")
      ? "- If diagram_type is swimlane and lanes are empty, infer lanes or create generic lanes."
      : "",
    "- No markdown fences or extra commentary.",
    "- Output exactly the nodes and edges from JSON; do not add or drop any.",
    "- Put exactly one statement per line; never place two node definitions on one line.",
    "- If a label needs multiple lines, use <br/> inside the label.",
    "- Do not invent edges or reorder relationships; keep the JSON graph structure.",
    userPrompt ? `User constraints:\n${userPrompt}` : "",
    diagramHint,
    "JSON:",
    jsonBlock,
  ]
    .filter(Boolean)
    .join("\n");
}

function buildFinalCheckPrompt(mermaidCode) {
  return [
    "You are a Mermaid syntax checker.",
    "Fix any Mermaid syntax errors and return Mermaid code only.",
    "If the code is already valid, return it unchanged.",
    "Ensure the first line is just the diagram header (e.g. flowchart TD).",
    "Remove stray '>' after edge labels (use: A -->|label| B).",
    "Do not include graph/flowchart directives on lines after the header.",
    "Ensure exactly one statement per line; split adjacent node definitions onto separate lines.",
    "If a label needs multiple lines, use <br/> inside the label.",
    "Do not change the graph structure (nodes/edges); only fix syntax.",
    "No markdown fences or extra commentary.",
    "Mermaid:",
    mermaidCode,
  ].join("\n");
}

function buildRepairPrompt(mermaidCode, errorMessage, originalMermaid) {
  return [
    "You fix Mermaid syntax errors.",
    "Given the Mermaid code and parser error, return corrected Mermaid only.",
    "Do not add explanations or markdown fences.",
    "Ensure the first line is a proper header (e.g. flowchart TD).",
    "Use correct edge label syntax: A -->|label| B (no extra '>').",
    "Preserve every node label and relationship; do not drop any text.",
    "If a node label needs multiple lines, keep it in one node using <br/>.",
    "Ensure exactly one statement per line; split adjacent node definitions onto separate lines.",
    "Do not invent or remove edges; keep the same structure.",
    originalMermaid && originalMermaid !== mermaidCode
      ? "Original Mermaid (do not drop any labels or relationships):\n" + originalMermaid
      : "",
    "Error:",
    errorMessage,
    "Mermaid:",
    mermaidCode,
  ].join("\n");
}

function rememberGeneration({ provider, model, baseUrl, mermaidText }) {
  state.lastProvider = provider;
  state.lastModel = model || "";
  state.lastBaseUrl = baseUrl || "";
  state.lastGeneratedMermaid = mermaidText || "";
  state.autoFixAttempts = 0;
}

function getOllamaModel() {
  const typed = elements.ollamaModel.value.trim();
  if (typed) {
    return typed;
  }
  return elements.ollamaModelSelect.value.trim();
}

async function fetchOllamaModels({ auto = false } = {}) {
  if (state.ollamaFetchInProgress) return false;
  state.ollamaFetchInProgress = true;
  let loaded = false;
  const baseUrl = elements.ollamaUrl.value.trim() || LOCAL_OLLAMA_URL;
  const currentModel = (elements.ollamaModel.value || elements.ollamaModelSelect.value || "").trim();
  elements.ollamaUrl.value = baseUrl;
  try {
    if (!auto) {
      setStatus("Fetching Ollama models...", "working");
    }
    logMessage(`Ollama: fetching models from ${baseUrl}/api/tags`, "neutral");
    let models = await listOllamaModels(baseUrl);
    if (!models.length && baseUrl === LOCAL_OLLAMA_PROXY_URL) {
      logMessage(`Ollama: proxy empty, trying direct ${LOCAL_OLLAMA_DIRECT_URL}`, "neutral");
      models = await listOllamaModels(LOCAL_OLLAMA_DIRECT_URL);
      if (models.length) {
        elements.ollamaUrl.value = LOCAL_OLLAMA_DIRECT_URL;
      }
    }
    if (!models.length) {
      if (!auto) {
        setStatus("No Ollama models found.", "error");
      }
      return false;
    }
    setOllamaModelOptions(models);
    if (currentModel && !models.includes(currentModel)) {
      const customOption = document.createElement("option");
      customOption.value = currentModel;
      customOption.textContent = `Custom: ${currentModel}`;
      elements.ollamaModelSelect.insertBefore(customOption, elements.ollamaModelSelect.firstChild);
    }
    if (currentModel && models.includes(currentModel)) {
      elements.ollamaModelSelect.value = currentModel;
      elements.ollamaModel.value = currentModel;
    } else if (currentModel) {
      elements.ollamaModelSelect.value = currentModel;
      elements.ollamaModel.value = currentModel;
    } else {
      elements.ollamaModelSelect.value = models[0];
      elements.ollamaModel.value = models[0];
    }
    if (!auto) {
      setStatus(`Loaded ${models.length} Ollama model(s).`, "ok");
    }
    logMessage(`Ollama: loaded ${models.length} model(s).`, "ok");
    loaded = true;
  } catch (err) {
    console.error(err);
    const hint = baseUrl.includes("/ollama")
      ? "Failed to reach Ollama proxy. Check OLLAMA_PROXY_URL or try direct (http://localhost:11434)."
      : "Failed to reach Ollama. Check URL or CORS, or use the proxy (http://localhost:8001/ollama).";
    logMessage(err.message || hint, "error");
    if (!auto) {
      setStatus(err.message || hint, "error");
    }
    return false;
  } finally {
    state.ollamaFetchInProgress = false;
  }
  return loaded;
}

function shouldAutoFix(code) {
  if (!state.lastProvider || state.lastProvider === "webhook") return false;
  if (state.autoFixInProgress) return false;
  if (state.autoFixAttempts >= MAX_AUTOFIX_ATTEMPTS) return false;
  if (!state.lastGeneratedMermaid) return false;
  return normalizeMermaid(state.lastGeneratedMermaid) === normalizeMermaid(code);
}

function localMermaidRepair(code) {
  let fixed = flattenLabelNewlines(code);
  fixed = splitAdjacentNodes(fixed);
  return normalizeMermaid(fixed);
}

async function validateMermaid(code) {
  const normalized = normalizeMermaid(code);
  try {
    state.mermaidRenderCount += 1;
    const renderId = `flowchart-${state.mermaidRenderCount}`;
    await mermaid.render(renderId, normalized);
    return { ok: true };
  } catch (err) {
    const message = err?.message ? `Mermaid render error: ${err.message}` : "Mermaid render error. Check code.";
    return { ok: false, message };
  }
}

async function attemptAutoFix(code, errorMessage) {
  if (!shouldAutoFix(code)) return;
  state.autoFixInProgress = true;
  try {
    const provider = state.lastProvider;
    const model = state.lastModel;
    const baseUrl = state.lastBaseUrl;
    let apiKey = "";
    if (provider === "gemini") {
      apiKey = elements.geminiKey.value.trim();
    } else if (provider === "groq") {
      apiKey = elements.groqKey.value.trim();
    } else if (provider === "openai") {
      apiKey = elements.openaiKey.value.trim();
    }
    const originalMermaid = state.lastGeneratedMermaid || code;
    let working = normalizeMermaid(code);
    let lastError = errorMessage;
    for (let attempt = state.autoFixAttempts; attempt < MAX_AUTOFIX_ATTEMPTS; attempt += 1) {
      state.autoFixAttempts = attempt + 1;
      logMessage(`Auto-fix: attempt ${attempt + 1} of ${MAX_AUTOFIX_ATTEMPTS}...`, "working");
      let repaired = working;
      try {
        repaired = await runRepairCheck({
          provider,
          apiKey,
          model,
          baseUrl,
          mermaidText: working,
          errorMessage: lastError,
          originalMermaid,
        });
      } catch (err) {
        console.error(err);
        logMessage(err.message || "Auto-fix failed.", "error");
      }
      let normalized = normalizeMermaid(repaired);
      if (!normalized || normalized === working) {
        const local = localMermaidRepair(working);
        if (local && local !== working) {
          normalized = local;
        }
      }
      if (!normalized || normalized === working) {
        logMessage("Auto-fix did not change Mermaid.", "error");
        continue;
      }
      const validation = await validateMermaid(normalized);
      if (validation.ok) {
        setMermaidText(normalized);
        state.lastGeneratedMermaid = normalized;
        logMessage("Auto-fix applied.", "ok");
        return;
      }
      lastError = validation.message || lastError;
      working = normalized;
      logMessage(lastError, "error");
    }
    if (state.autoFixAttempts >= MAX_AUTOFIX_ATTEMPTS) {
      logMessage(`Auto-fix stopped after ${MAX_AUTOFIX_ATTEMPTS} attempts.`, "error");
    }
  } catch (err) {
    console.error(err);
    logMessage(err.message || "Auto-fix failed.", "error");
  } finally {
    state.autoFixInProgress = false;
  }
}

async function renderMermaid(code) {
  elements.diagramPreview.textContent = "";
  if (!code) {
    elements.diagramPreview.textContent = "No Mermaid code yet.";
    return;
  }
  const normalized = normalizeMermaid(code);
  try {
    state.mermaidRenderCount += 1;
    const renderId = `flowchart-${state.mermaidRenderCount}`;
    const { svg } = await mermaid.render(renderId, normalized);
    elements.diagramPreview.innerHTML = svg;
    setStatus("Rendered Mermaid preview.", "ok");
    logMessage("Mermaid render success.", "ok");
  } catch (err) {
    console.error(err);
    const message = err?.message ? `Mermaid render error: ${err.message}` : "Mermaid render error. Check code.";
    setStatus(message, "error");
    logMessage(message, "error");
    const localRepaired = localMermaidRepair(normalized);
    if (localRepaired && localRepaired !== normalized) {
      try {
        state.mermaidRenderCount += 1;
        const renderId = `flowchart-${state.mermaidRenderCount}`;
        const { svg } = await mermaid.render(renderId, localRepaired);
        elements.diagramPreview.innerHTML = svg;
        elements.mermaidText.value = localRepaired;
        state.lastGeneratedMermaid = localRepaired;
        setStatus("Rendered Mermaid preview (local repair).", "ok");
        logMessage("Local repair applied.", "ok");
        return;
      } catch (repairErr) {
        console.error(repairErr);
        const repairMessage = repairErr?.message
          ? `Mermaid render error: ${repairErr.message}`
          : "Mermaid render error. Check code.";
        logMessage(repairMessage, "error");
      }
    }
    await attemptAutoFix(normalized, message);
  }
}

async function listGeminiModels(apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
  const response = await fetch(url);
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`List models failed: ${response.status} ${errorText}`);
  }
  const data = await response.json();
  const models = data.models || [];
  const filtered = models.filter((model) =>
    (model.supportedGenerationMethods || []).includes("generateContent")
  );
  return filtered.map((model) => normalizeModelName(model.name));
}

async function listOllamaModels(baseUrl) {
  const sanitized = baseUrl.replace(/\/+$/, "");
  const url = `${sanitized}/api/tags`;
  const response = await fetch(url);
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Ollama list models failed: ${response.status} ${errorText}`);
  }
  const data = await response.json();
  const models = Array.isArray(data.models)
    ? data.models
    : Array.isArray(data)
      ? data
      : [];
  return models.map((model) => model.name || model.model || model).filter(Boolean);
}

async function callGemini({ apiKey, model, prompt, base64, mimeType }) {
  const modelName = normalizeModelName(model);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
  const parts = [{ text: prompt }];
  if (base64) {
    parts.push({ inline_data: { mime_type: mimeType, data: base64 } });
  }
  const body = {
    contents: [
      {
        role: "user",
        parts,
      },
    ],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 2048,
    },
  };

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini API error: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("\n");
  return text || "";
}

async function callGroq({ apiKey, model, prompt }) {
  const url = "https://api.groq.com/openai/v1/chat/completions";
  const body = {
    model,
    messages: [{ role: "user", content: prompt }],
    temperature: 0.2,
    max_tokens: 2048,
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Groq API error: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  const text = data?.choices?.[0]?.message?.content;
  return text || "";
}

async function callOpenAI({ apiKey, model, prompt, base64, mimeType }) {
  const url = "https://api.openai.com/v1/chat/completions";
  const messages = [
    {
      role: "user",
      content: base64
        ? [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64}` } },
          ]
        : prompt,
    },
  ];
  const body = {
    model,
    messages,
    max_completion_tokens: 2048,
  };
  const withTemperature = { ...body, temperature: 0.2 };

  const sendRequest = async (payload) => {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
    });
    return response;
  };

  let response = await sendRequest(withTemperature);
  if (!response.ok) {
    const errorText = await response.text();
    let parsed = null;
    try {
      parsed = JSON.parse(errorText);
    } catch (err) {
      parsed = null;
    }
    const param = parsed?.error?.param;
    const message = parsed?.error?.message || errorText;
    if (param === "temperature" || /temperature/i.test(message)) {
      response = await sendRequest(body);
    } else {
      throw new Error(`OpenAI API error: ${response.status} ${errorText}`);
    }
  }

  const data = await response.json();
  const text = data?.choices?.[0]?.message?.content;
  return text || "";
}

async function listOpenAIModels(apiKey) {
  const url = "https://api.openai.com/v1/models";
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI list models failed: ${response.status} ${errorText}`);
  }
  const data = await response.json();
  const models = Array.isArray(data.data) ? data.data : [];
  const ids = models
    .map((model) => model.id)
    .filter((id) => /^gpt-|^o\d/.test(id));
  return ids.sort();
}

async function listGroqModels(apiKey) {
  const url = "https://api.groq.com/openai/v1/models";
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Groq list models failed: ${response.status} ${errorText}`);
  }
  const data = await response.json();
  const models = Array.isArray(data.data) ? data.data : [];
  const ids = models.map((model) => model.id).filter(Boolean);
  return ids.sort();
}

async function callOllamaChat({ baseUrl, model, prompt, images }) {
  const sanitized = baseUrl.replace(/\/+$/, "");
  const url = `${sanitized}/api/chat`;
  const userMessage = { role: "user", content: prompt };
  if (images && images.length) {
    userMessage.images = images;
  }
  const body = {
    model,
    messages: [userMessage],
    stream: false,
  };

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Ollama chat error: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  return data?.message?.content || "";
}

async function callOllamaGenerate({ baseUrl, model, prompt, images }) {
  const sanitized = baseUrl.replace(/\/+$/, "");
  const url = `${sanitized}/api/generate`;
  const body = {
    model,
    prompt,
    stream: false,
  };
  if (images && images.length) {
    body.images = images;
  }

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Ollama generate error: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  return data?.response || "";
}

async function callOllamaWithImagesFallback(endpointFn, payload) {
  try {
    return await endpointFn(payload);
  } catch (err) {
    const message = String(err.message || "");
    if (payload.images?.length && /image|vision/i.test(message)) {
      return endpointFn({ ...payload, images: [] });
    }
    throw err;
  }
}

async function callOllama({ baseUrl, model, prompt, images }) {
  let lastError = null;
  const payload = { baseUrl, model, prompt, images };
  try {
    return await callOllamaWithImagesFallback(callOllamaChat, payload);
  } catch (err) {
    lastError = err;
  }
  try {
    return await callOllamaWithImagesFallback(callOllamaGenerate, payload);
  } catch (err) {
    lastError = err;
  }
  throw lastError || new Error("Ollama request failed.");
}

async function callOcrWebhook({ url, headers, payload }) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OCR webhook error: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  return data;
}

async function runFinalCheck({ provider, apiKey, model, mermaidText, baseUrl }) {
  const prompt = buildFinalCheckPrompt(mermaidText);
  let responseText = "";
  if (provider === "groq") {
    responseText = await callGroq({ apiKey, model, prompt });
  } else if (provider === "openai") {
    responseText = await callOpenAI({
      apiKey,
      model,
      prompt,
      base64: "",
      mimeType: state.mime,
    });
  } else if (provider === "ollama") {
    responseText = await callOllama({ baseUrl, model, prompt, images: [] });
  } else {
    responseText = await callGemini({
      apiKey,
      model,
      prompt,
      base64: "",
      mimeType: state.mime,
    });
  }
  const cleaned = extractMermaid(responseText);
  return cleaned || mermaidText;
}

async function runRepairCheck({
  provider,
  apiKey,
  model,
  mermaidText,
  baseUrl,
  errorMessage,
  originalMermaid,
}) {
  const prompt = buildRepairPrompt(mermaidText, errorMessage, originalMermaid);
  let responseText = "";
  if (provider === "groq") {
    responseText = await callGroq({ apiKey, model, prompt });
  } else if (provider === "openai") {
    responseText = await callOpenAI({
      apiKey,
      model,
      prompt,
      base64: "",
      mimeType: state.mime,
    });
  } else if (provider === "ollama") {
    responseText = await callOllama({ baseUrl, model, prompt, images: [] });
  } else {
    responseText = await callGemini({
      apiKey,
      model,
      prompt,
      base64: "",
      mimeType: state.mime,
    });
  }
  const cleaned = extractMermaid(responseText);
  return cleaned || mermaidText;
}

async function callWebhook({ url, headers, payload }) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Webhook error: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  return data;
}

function parseHeaders(text) {
  if (!text.trim()) return {};
  try {
    const headers = JSON.parse(text);
    if (headers && typeof headers === "object") {
      return headers;
    }
  } catch (err) {
    throw new Error("Webhook headers must be valid JSON.");
  }
  throw new Error("Webhook headers must be a JSON object.");
}

function setMermaidText(text) {
  elements.mermaidText.value = text;
  if (elements.autoRender.checked) {
    renderMermaid(text);
  }
}

function resetAll() {
  state.file = null;
  state.base64 = "";
  state.mime = "";
  state.ocr = null;
  state.manualLineCounter = 1;
  state.selectedOcrNodeId = "";
  state.selectedOcrLineId = "";
  state.pendingNodeEdits = {};
  if (state.ocrRefreshTimer) {
    clearTimeout(state.ocrRefreshTimer);
    state.ocrRefreshTimer = null;
  }
  elements.uploadInput.value = "";
  elements.mermaidText.value = "";
  setPreviewImage("");
  updateFileBadge();
  updatePayloadPreview();
  elements.diagramPreview.textContent = "";
  clearLog();
  setStatus("Cleared.");
  renderOcrOverlay();
  renderOcrEditor();
}

async function runOcr({ preserveBlocks = false, keepManual = true } = {}) {
  if (!elements.ocrEnabled.checked) return null;
  if (!state.base64) return null;
  const ocrUrl = elements.ocrUrl.value.trim();
  if (!ocrUrl) {
    setStatus("OCR webhook URL is required.", "error");
    return null;
  }
  const ocrHeaders = parseHeaders(elements.ocrHeaders.value);
  const ocrPayload = {
    image: {
      mime_type: state.mime,
      base64: state.base64,
    },
    hint: "flowchart",
    line_params: readHoughParams(),
  };
  logMessage("OCR: sending image...", "working");
  const ocrResponse = await callOcrWebhook({ url: ocrUrl, headers: ocrHeaders, payload: ocrPayload });
  const normalized = normalizeOcrResponse(ocrResponse);
  if (!normalized) {
    logMessage("OCR: no usable text blocks returned.", "error");
    return null;
  }
  let nextOcr = normalized;
  if (preserveBlocks && state.ocr?.blocks?.length) {
    nextOcr = {
      ...nextOcr,
      blocks: state.ocr.blocks.map((block) => ({ ...block })),
    };
  }
  if (keepManual && state.ocr?.lines?.length) {
    const manualLines = state.ocr.lines
      .filter((line) => line.source === "manual")
      .map((line) => ({ ...line }));
    if (manualLines.length) {
      nextOcr = {
        ...nextOcr,
        lines: [...(nextOcr.lines || []), ...manualLines],
      };
    }
  }
  state.ocr = normalizeOcrState(nextOcr);
  if (!preserveBlocks) {
    state.pendingNodeEdits = {};
    state.selectedOcrNodeId = "";
    state.selectedOcrLineId = "";
  }
  syncManualLineCounter();
  logMessage(`OCR: ${state.ocr.blocks.length} text blocks received.`, "ok");
  renderOcrOverlay();
  renderOcrEditor();
  updatePayloadPreview();
  return state.ocr;
}

async function handleConvert() {
  if (!state.file || !state.base64) {
    setStatus("Please upload a sketch image first.", "error");
    return;
  }

  const userPrompt = elements.promptInput.value.trim();
  const diagramHint = getDiagramTypeHint();

  try {
    setStatus("Converting sketch...", "working");
    if (diagramHint && diagramHint !== "auto") {
      logMessage(`Diagram hint: ${diagramHint}`, "neutral");
    }
    if (elements.ocrEnabled.checked) {
      if (!state.ocr) {
        await runOcr({ preserveBlocks: false, keepManual: false });
      }
    } else {
      state.ocr = null;
      renderOcrOverlay();
      renderOcrEditor();
      updatePayloadPreview();
    }
    if (state.mode === "gemini") {
      const apiKey = elements.geminiKey.value.trim();
      if (!apiKey) {
        setStatus("Gemini API key is required.", "error");
        return;
      }
      const model = elements.geminiModel.value.trim();
      if (!model) {
        setStatus("Gemini model is required.", "error");
        return;
      }
      if (elements.complexMode.checked) {
        logMessage("Stage 1: analyzing structure...", "working");
        const analysisText = await callGemini({
          apiKey,
          model,
          prompt: buildStage1Prompt(userPrompt),
          base64: state.base64,
          mimeType: state.mime,
        });
        const structure = extractJson(analysisText);
        if (!structure) {
          logMessage("Stage 1 failed to parse JSON. Falling back to single-shot.", "error");
        } else {
          const hint = getDiagramTypeHint();
          if (hint && hint !== "auto") {
            structure.diagram_type = hint;
            if (hint === "swimlane" && !Array.isArray(structure.lanes)) {
              structure.lanes = [];
            }
          }
          const nodes = Array.isArray(structure.nodes) ? structure.nodes.length : 0;
          const edges = Array.isArray(structure.edges) ? structure.edges.length : 0;
          if (structure.diagram_type) {
            logMessage(`Stage 1 type: ${structure.diagram_type}`, "ok");
          }
          logMessage(`Stage 1 complete: ${nodes} nodes, ${edges} edges.`, "ok");
          logMessage("Stage 2: drafting Mermaid...", "working");
          const draftText = await callGemini({
            apiKey,
            model,
            prompt: buildStage2Prompt(structure, userPrompt),
            base64: "",
            mimeType: state.mime,
          });
          let mermaidText = extractMermaid(draftText);
          if (!mermaidText) {
            mermaidText = draftText.trim();
          }
          logMessage("Stage 2 complete: Mermaid draft ready.", "ok");
          if (elements.finalCheck.checked) {
            logMessage("Stage 3: validating Mermaid...", "working");
            mermaidText = await runFinalCheck({ provider: "gemini", apiKey, model, mermaidText });
            logMessage("Stage 3 complete: Mermaid validated.", "ok");
          }
          const normalizedMermaid = normalizeMermaid(mermaidText);
          setMermaidText(normalizedMermaid);
          rememberGeneration({ provider: "gemini", model, mermaidText: normalizedMermaid });
          setStatus("Gemini conversion complete.", "ok");
          return;
        }
      }

      logMessage("Single-shot: generating Mermaid...", "working");
      const responseText = await callGemini({
        apiKey,
        model,
        prompt: buildSingleShotPrompt(userPrompt),
        base64: state.base64,
        mimeType: state.mime,
      });
      let mermaidText = extractMermaid(responseText);
      if (!mermaidText) {
        mermaidText = responseText.trim();
      }
      if (elements.finalCheck.checked) {
        logMessage("Final check: validating Mermaid...", "working");
        mermaidText = await runFinalCheck({ provider: "gemini", apiKey, model, mermaidText });
        logMessage("Final check complete.", "ok");
      }
      const normalizedMermaid = normalizeMermaid(mermaidText);
      setMermaidText(normalizedMermaid);
      rememberGeneration({ provider: "gemini", model, mermaidText: normalizedMermaid });
      logMessage("Single-shot complete: Mermaid ready.", "ok");
      setStatus("Gemini conversion complete.", "ok");
    } else if (state.mode === "groq") {
      const apiKey = elements.groqKey.value.trim();
      if (!apiKey) {
        setStatus("Groq API key is required.", "error");
        return;
      }
      const model = elements.groqModel.value.trim();
      if (!model) {
        setStatus("Groq model is required.", "error");
        return;
      }
      if (!elements.ocrEnabled.checked) {
        setStatus("Groq mode requires OCR assist (text-only). Enable OCR webhook.", "error");
        return;
      }
      if (!state.ocr?.blocks?.length) {
        setStatus("OCR returned no text blocks. Groq needs OCR text.", "error");
        return;
      }
      if (elements.complexMode.checked) {
        logMessage("Stage 1: analyzing structure...", "working");
        const analysisText = await callGroq({
          apiKey,
          model,
          prompt: buildStage1Prompt(userPrompt),
        });
        const structure = extractJson(analysisText);
        if (!structure) {
          logMessage("Stage 1 failed to parse JSON. Falling back to single-shot.", "error");
        } else {
          const hint = getDiagramTypeHint();
          if (hint && hint !== "auto") {
            structure.diagram_type = hint;
            if (hint === "swimlane" && !Array.isArray(structure.lanes)) {
              structure.lanes = [];
            }
          }
          const nodes = Array.isArray(structure.nodes) ? structure.nodes.length : 0;
          const edges = Array.isArray(structure.edges) ? structure.edges.length : 0;
          if (structure.diagram_type) {
            logMessage(`Stage 1 type: ${structure.diagram_type}`, "ok");
          }
          logMessage(`Stage 1 complete: ${nodes} nodes, ${edges} edges.`, "ok");
          logMessage("Stage 2: drafting Mermaid...", "working");
          const draftText = await callGroq({
            apiKey,
            model,
            prompt: buildStage2Prompt(structure, userPrompt),
          });
          let mermaidText = extractMermaid(draftText);
          if (!mermaidText) {
            mermaidText = draftText.trim();
          }
          logMessage("Stage 2 complete: Mermaid draft ready.", "ok");
          if (elements.finalCheck.checked) {
            logMessage("Stage 3: validating Mermaid...", "working");
            mermaidText = await runFinalCheck({ provider: "groq", apiKey, model, mermaidText });
            logMessage("Stage 3 complete: Mermaid validated.", "ok");
          }
          const normalizedMermaid = normalizeMermaid(mermaidText);
          setMermaidText(normalizedMermaid);
          rememberGeneration({ provider: "groq", model, mermaidText: normalizedMermaid });
          setStatus("Groq conversion complete.", "ok");
          return;
        }
      }
      logMessage("Single-shot: generating Mermaid...", "working");
      const responseText = await callGroq({
        apiKey,
        model,
        prompt: buildSingleShotPrompt(userPrompt),
      });
      let mermaidText = extractMermaid(responseText);
      if (!mermaidText) {
        mermaidText = responseText.trim();
      }
      if (elements.finalCheck.checked) {
        logMessage("Final check: validating Mermaid...", "working");
        mermaidText = await runFinalCheck({ provider: "groq", apiKey, model, mermaidText });
        logMessage("Final check complete.", "ok");
      }
      const normalizedMermaid = normalizeMermaid(mermaidText);
      setMermaidText(normalizedMermaid);
      rememberGeneration({ provider: "groq", model, mermaidText: normalizedMermaid });
      logMessage("Single-shot complete: Mermaid ready.", "ok");
      setStatus("Groq conversion complete.", "ok");
    } else if (state.mode === "openai") {
      const apiKey = elements.openaiKey.value.trim();
      if (!apiKey) {
        setStatus("OpenAI API key is required.", "error");
        return;
      }
      const model = elements.openaiModel.value.trim();
      if (!model) {
        setStatus("OpenAI model is required.", "error");
        return;
      }
      if (elements.complexMode.checked) {
        logMessage("Stage 1: analyzing structure...", "working");
        const analysisText = await callOpenAI({
          apiKey,
          model,
          prompt: buildStage1Prompt(userPrompt),
          base64: state.base64,
          mimeType: state.mime,
        });
        const structure = extractJson(analysisText);
        if (!structure) {
          logMessage("Stage 1 failed to parse JSON. Falling back to single-shot.", "error");
        } else {
          const hint = getDiagramTypeHint();
          if (hint && hint !== "auto") {
            structure.diagram_type = hint;
            if (hint === "swimlane" && !Array.isArray(structure.lanes)) {
              structure.lanes = [];
            }
          }
          const nodes = Array.isArray(structure.nodes) ? structure.nodes.length : 0;
          const edges = Array.isArray(structure.edges) ? structure.edges.length : 0;
          if (structure.diagram_type) {
            logMessage(`Stage 1 type: ${structure.diagram_type}`, "ok");
          }
          logMessage(`Stage 1 complete: ${nodes} nodes, ${edges} edges.`, "ok");
          logMessage("Stage 2: drafting Mermaid...", "working");
          const draftText = await callOpenAI({
            apiKey,
            model,
            prompt: buildStage2Prompt(structure, userPrompt),
            base64: "",
            mimeType: state.mime,
          });
          let mermaidText = extractMermaid(draftText);
          if (!mermaidText) {
            mermaidText = draftText.trim();
          }
          logMessage("Stage 2 complete: Mermaid draft ready.", "ok");
          if (elements.finalCheck.checked) {
            logMessage("Stage 3: validating Mermaid...", "working");
            mermaidText = await runFinalCheck({ provider: "openai", apiKey, model, mermaidText });
            logMessage("Stage 3 complete: Mermaid validated.", "ok");
          }
          const normalizedMermaid = normalizeMermaid(mermaidText);
          setMermaidText(normalizedMermaid);
          rememberGeneration({ provider: "openai", model, mermaidText: normalizedMermaid });
          setStatus("OpenAI conversion complete.", "ok");
          return;
        }
      }

      logMessage("Single-shot: generating Mermaid...", "working");
      const responseText = await callOpenAI({
        apiKey,
        model,
        prompt: buildSingleShotPrompt(userPrompt),
        base64: state.base64,
        mimeType: state.mime,
      });
      let mermaidText = extractMermaid(responseText);
      if (!mermaidText) {
        mermaidText = responseText.trim();
      }
      if (elements.finalCheck.checked) {
        logMessage("Final check: validating Mermaid...", "working");
        mermaidText = await runFinalCheck({ provider: "openai", apiKey, model, mermaidText });
        logMessage("Final check complete.", "ok");
      }
      const normalizedMermaid = normalizeMermaid(mermaidText);
      setMermaidText(normalizedMermaid);
      rememberGeneration({ provider: "openai", model, mermaidText: normalizedMermaid });
      logMessage("Single-shot complete: Mermaid ready.", "ok");
      setStatus("OpenAI conversion complete.", "ok");
    } else if (state.mode === "ollama") {
      const baseUrl = elements.ollamaUrl.value.trim();
      if (!baseUrl) {
        setStatus("Ollama base URL is required.", "error");
        return;
      }
      const model = getOllamaModel();
      if (!model) {
        setStatus("Ollama model is required.", "error");
        return;
      }
      logMessage(`Ollama: using ${model}`, "neutral");
      const images = state.base64 ? [state.base64] : [];
      if (elements.complexMode.checked) {
        logMessage("Stage 1: analyzing structure...", "working");
        const analysisText = await callOllama({
          baseUrl,
          model,
          prompt: buildStage1Prompt(userPrompt),
          images,
        });
        const structure = extractJson(analysisText);
        if (!structure) {
          logMessage("Stage 1 failed to parse JSON. Falling back to single-shot.", "error");
        } else {
          const hint = getDiagramTypeHint();
          if (hint && hint !== "auto") {
            structure.diagram_type = hint;
            if (hint === "swimlane" && !Array.isArray(structure.lanes)) {
              structure.lanes = [];
            }
          }
          const nodes = Array.isArray(structure.nodes) ? structure.nodes.length : 0;
          const edges = Array.isArray(structure.edges) ? structure.edges.length : 0;
          if (structure.diagram_type) {
            logMessage(`Stage 1 type: ${structure.diagram_type}`, "ok");
          }
          logMessage(`Stage 1 complete: ${nodes} nodes, ${edges} edges.`, "ok");
          logMessage("Stage 2: drafting Mermaid...", "working");
          const draftText = await callOllama({
            baseUrl,
            model,
            prompt: buildStage2Prompt(structure, userPrompt),
            images: [],
          });
          let mermaidText = extractMermaid(draftText);
          if (!mermaidText) {
            mermaidText = draftText.trim();
          }
          logMessage("Stage 2 complete: Mermaid draft ready.", "ok");
          if (elements.finalCheck.checked) {
            logMessage("Stage 3: validating Mermaid...", "working");
            mermaidText = await runFinalCheck({
              provider: "ollama",
              model,
              mermaidText,
              baseUrl,
            });
            logMessage("Stage 3 complete: Mermaid validated.", "ok");
          }
          const normalizedMermaid = normalizeMermaid(mermaidText);
          setMermaidText(normalizedMermaid);
          rememberGeneration({
            provider: "ollama",
            model,
            baseUrl,
            mermaidText: normalizedMermaid,
          });
          setStatus("Ollama conversion complete.", "ok");
          return;
        }
      }
      logMessage("Single-shot: generating Mermaid...", "working");
      const responseText = await callOllama({
        baseUrl,
        model,
        prompt: buildSingleShotPrompt(userPrompt),
        images,
      });
      let mermaidText = extractMermaid(responseText);
      if (!mermaidText) {
        mermaidText = responseText.trim();
      }
      if (elements.finalCheck.checked) {
        logMessage("Final check: validating Mermaid...", "working");
        mermaidText = await runFinalCheck({
          provider: "ollama",
          model,
          mermaidText,
          baseUrl,
        });
        logMessage("Final check complete.", "ok");
      }
      const normalizedMermaid = normalizeMermaid(mermaidText);
      setMermaidText(normalizedMermaid);
      rememberGeneration({
        provider: "ollama",
        model,
        baseUrl,
        mermaidText: normalizedMermaid,
      });
      logMessage("Single-shot complete: Mermaid ready.", "ok");
      setStatus("Ollama conversion complete.", "ok");
    } else {
      const url = elements.webhookUrl.value.trim();
      if (!url) {
        setStatus("Webhook URL is required.", "error");
        return;
      }
      const headers = parseHeaders(elements.webhookHeaders.value);
      const payload = {
        prompt: userPrompt,
        output: "mermaid",
        image: {
          mime_type: state.mime,
          base64: state.base64,
        },
      };
      const ocrPayload = serializeOcr(state.ocr);
      if (ocrPayload) {
        payload.ocr = ocrPayload;
      }
      logMessage("Webhook: sending payload...", "working");
      const responseData = await callWebhook({ url, headers, payload });
      const mermaidText = extractMermaid(responseData.mermaid || responseData.diagram || responseData.text || "");
      const normalizedMermaid = normalizeMermaid(mermaidText);
      setMermaidText(normalizedMermaid);
      rememberGeneration({ provider: "webhook", mermaidText: normalizedMermaid });
      logMessage("Webhook response received.", "ok");
      setStatus("Webhook conversion complete.", "ok");
    }
  } catch (err) {
    console.error(err);
    if (String(err.message).includes("not found for API version")) {
      setModelStatus("Model not found. Try gemini-2.5-flash or click Fetch models.");
    }
    logMessage(err.message || "Conversion failed.", "error");
    setStatus(err.message || "Conversion failed.", "error");
  }
}

function handleFile(file) {
  if (!file) return;
  state.file = file;
  state.mime = file.type || "image/png";
  state.ocr = null;
  state.manualLineCounter = 1;
  state.selectedOcrNodeId = "";
  state.selectedOcrLineId = "";
  state.pendingNodeEdits = {};
  const reader = new FileReader();
  reader.onload = () => {
    const result = reader.result;
    if (typeof result === "string") {
      setPreviewImage(result);
      const base64 = result.split(",")[1];
      state.base64 = base64 || "";
      updatePayloadPreview();
      if (elements.ocrEnabled.checked) {
        runOcr({ preserveBlocks: false, keepManual: false }).catch((err) => {
          console.error(err);
          setStatus(err.message || "OCR failed.", "error");
        });
      }
    }
  };
  reader.readAsDataURL(file);
  updateFileBadge();
  renderOcrOverlay();
  renderOcrEditor();
}

function bindEvents() {
  document.querySelectorAll("input[name='mode']").forEach((radio) => {
    radio.addEventListener("change", (event) => {
      updateMode(event.target.value);
    });
  });

  elements.fetchModels.addEventListener("click", async () => {
    const apiKey = elements.geminiKey.value.trim();
    if (!apiKey) {
      setModelStatus("Enter a Gemini API key first.");
      return;
    }
    try {
      setModelStatus("Fetching models...");
      const models = await listGeminiModels(apiKey);
      if (!models.length) {
        setModelStatus("No models found for this key.");
        return;
      }
      setModelOptions(models);
      elements.geminiModel.value = models[0];
    } catch (err) {
      console.error(err);
      setModelStatus(err.message || "Failed to fetch models.");
    }
  });

  elements.useBasicModels.addEventListener("click", () => {
    setModelOptions(BASIC_MODELS, "Loaded basic models.");
    elements.geminiModel.value = BASIC_MODELS[0];
  });

  elements.useGroqModels.addEventListener("click", () => {
    setGroqModelOptions(GROQ_MODELS);
    elements.groqModel.value = GROQ_MODELS[0];
    setStatus("Loaded Groq default models.", "ok");
  });

  if (elements.openaiKey) {
    elements.openaiKey.addEventListener("input", () => {
      state.openaiModelsLoaded = false;
      scheduleOpenaiModelFetch();
    });
    elements.openaiKey.addEventListener("blur", () => {
      if (!state.openaiModelsLoaded) {
        scheduleOpenaiModelFetch();
      }
    });
  }

  elements.ollamaModelSelect.addEventListener("change", () => {
    elements.ollamaModel.value = elements.ollamaModelSelect.value;
  });

  elements.ollamaModel.addEventListener("input", () => {
    if (elements.ollamaModel.value.trim()) {
      elements.ollamaModelSelect.value = "";
    }
  });

  elements.fetchOllamaModels.addEventListener("click", () => {
    fetchOllamaModels({ auto: false });
  });

  if (elements.geminiKey) {
    elements.geminiKey.addEventListener("input", () => {
      state.geminiModelsLoaded = false;
      scheduleGeminiModelFetch();
    });
    elements.geminiKey.addEventListener("blur", () => {
      if (!state.geminiModelsLoaded) {
        scheduleGeminiModelFetch();
      }
    });
  }

  if (elements.groqKey) {
    elements.groqKey.addEventListener("input", () => {
      state.groqModelsLoaded = false;
      scheduleGroqModelFetch();
    });
    elements.groqKey.addEventListener("blur", () => {
      if (!state.groqModelsLoaded) {
        scheduleGroqModelFetch();
      }
    });
  }

  elements.useLocalOcr.addEventListener("click", () => {
    elements.ocrEnabled.checked = true;
    elements.ocrUrl.value = LOCAL_OCR_URL;
    setStatus("Local EasyOCR selected.", "ok");
    logMessage("OCR: using local EasyOCR endpoint.", "ok");
    setOcrEditorVisibility();
    if (state.base64) {
      runOcr({ preserveBlocks: false, keepManual: true }).catch((err) => {
        console.error(err);
        setStatus(err.message || "OCR failed.", "error");
      });
    }
  });

  if (elements.ocrEnabled) {
    elements.ocrEnabled.addEventListener("change", () => {
      setOcrEditorVisibility();
      if (!elements.ocrEnabled.checked) {
        state.ocr = null;
        state.pendingNodeEdits = {};
        state.selectedOcrNodeId = "";
        state.selectedOcrLineId = "";
        if (state.ocrRefreshTimer) {
          clearTimeout(state.ocrRefreshTimer);
          state.ocrRefreshTimer = null;
        }
        renderOcrOverlay();
        renderOcrEditor();
        updatePayloadPreview();
        return;
      }
      if (state.base64) {
        runOcr({ preserveBlocks: false, keepManual: false }).catch((err) => {
          console.error(err);
          setStatus(err.message || "OCR failed.", "error");
        });
      }
    });
  }

  if (elements.ocrNodeSelect) {
    elements.ocrNodeSelect.addEventListener("change", () => {
      state.selectedOcrNodeId = elements.ocrNodeSelect.value;
      updateOcrNodeSelectionUI();
      renderOcrOverlay();
    });
  }

  if (elements.ocrNodeRename) {
    elements.ocrNodeRename.addEventListener("input", () => {
      const selectedId = state.selectedOcrNodeId;
      if (!selectedId) return;
      const current = state.pendingNodeEdits[selectedId] || {};
      state.pendingNodeEdits[selectedId] = { ...current, text: elements.ocrNodeRename.value };
    });
  }

  if (elements.ocrNodeActive) {
    elements.ocrNodeActive.addEventListener("change", () => {
      const selectedId = state.selectedOcrNodeId;
      if (!selectedId) return;
      const current = state.pendingNodeEdits[selectedId] || {};
      state.pendingNodeEdits[selectedId] = { ...current, active: elements.ocrNodeActive.checked };
    });
  }

  if (elements.ocrEdgeSelect) {
    elements.ocrEdgeSelect.addEventListener("change", () => {
      state.selectedOcrLineId = elements.ocrEdgeSelect.value;
      updateOcrEdgeSelectionUI();
      renderOcrOverlay();
    });
  }

  if (elements.removeEdgeBtn) {
    elements.removeEdgeBtn.addEventListener("click", () => {
      removeSelectedEdge();
    });
  }

  if (elements.refreshOcr) {
    elements.refreshOcr.addEventListener("click", async () => {
      if (!state.base64) {
        setStatus("Upload a sketch image first.", "error");
        return;
      }
      if (!elements.ocrEnabled.checked) {
        setStatus("Enable OCR assist before refreshing.", "error");
        return;
      }
      try {
        setStatus("Refreshing OCR...", "working");
        await runOcr({ preserveBlocks: true, keepManual: true });
        setStatus("OCR refreshed.", "ok");
      } catch (err) {
        console.error(err);
        setStatus(err.message || "OCR refresh failed.", "error");
      }
    });
  }

  if (elements.applyOcrEdits) {
    elements.applyOcrEdits.addEventListener("click", () => {
      applyOcrEdits();
      setStatus("OCR edits applied.", "ok");
    });
  }

  if (elements.addEdgeBtn) {
    elements.addEdgeBtn.addEventListener("click", () => {
      addManualEdge();
    });
  }

  [
    elements.houghCannyLow,
    elements.houghCannyHigh,
    elements.houghThreshold,
    elements.houghMinLength,
    elements.houghMaxGap,
    elements.houghMaxLines,
  ].forEach((slider) => {
    if (!slider) return;
    slider.addEventListener("input", () => {
      syncHoughLabels();
      scheduleOcrRefresh({ preserveBlocks: true, keepManual: true });
    });
  });

  elements.resetPrompt.addEventListener("click", () => {
    elements.promptInput.value = DEFAULT_PROMPT;
    updatePayloadPreview();
  });

  elements.promptInput.addEventListener("input", updatePayloadPreview);

  elements.uploadInput.addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    handleFile(file);
  });

  elements.dropzone.addEventListener("dragover", (event) => {
    event.preventDefault();
    elements.dropzone.classList.add("dragging");
  });

  elements.dropzone.addEventListener("dragleave", () => {
    elements.dropzone.classList.remove("dragging");
  });

  elements.dropzone.addEventListener("drop", (event) => {
    event.preventDefault();
    elements.dropzone.classList.remove("dragging");
    const file = event.dataTransfer.files?.[0];
    handleFile(file);
  });

  elements.convertBtn.addEventListener("click", handleConvert);

  elements.renderBtn.addEventListener("click", () => {
    renderMermaid(elements.mermaidText.value);
  });

  elements.sampleBtn.addEventListener("click", () => {
    setMermaidText(SAMPLE_MERMAID);
    setStatus("Loaded sample Mermaid.", "ok");
  });

  elements.clearBtn.addEventListener("click", resetAll);

  elements.clearLog.addEventListener("click", () => {
    clearLog();
    setStatus("Log cleared.");
  });

  if (elements.clearContainerLog) {
    elements.clearContainerLog.addEventListener("click", () => {
      clearContainerLog();
      fetchContainerLogs({ tail: true });
    });
  }

  elements.mermaidText.addEventListener("input", () => {
    if (elements.autoRender.checked) {
      renderMermaid(elements.mermaidText.value);
    }
  });

  window.addEventListener("resize", () => {
    renderOcrOverlay();
  });
}

bindEvents();
updateMode(state.mode);
updatePayloadPreview();
setModelOptions(BASIC_MODELS, "Model list ready.");
setGroqModelOptions(GROQ_MODELS);
setOllamaModelOptions(OLLAMA_DEFAULT_MODELS);
elements.ocrUrl.value = LOCAL_OCR_URL;
elements.ollamaUrl.value = LOCAL_OLLAMA_URL;
setPreviewImage("");
renderOcrEditor();
syncHoughLabels();
setOcrEditorVisibility();
setStatus("Ready. Upload a sketch to begin.");
clearLog();
logMessage("Ready. Upload a sketch to begin.", "ok");
logMessage(`UI build: ${APP_BUILD}`, "neutral");

if (!state.ollamaAutoFetched) {
  fetchOllamaModels({ auto: true }).then((loaded) => {
    if (loaded) {
      state.ollamaAutoFetched = true;
    }
  });
}

fetchContainerLogs({ tail: true });
setInterval(() => {
  fetchContainerLogs({ tail: false });
}, 2000);
