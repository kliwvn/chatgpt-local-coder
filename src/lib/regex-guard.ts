import { Worker } from "node:worker_threads";

const REGEX_TIMEOUT_MS = 1_000;
const REGEX_PATTERN_MAX_CHARS = 20_000;

type WorkerRequest = {
  id: number;
  action: "line_matches" | "multiline_count" | "replace";
  pattern: string;
  flags: string;
  text: string;
  replacement?: string;
  max_indexes?: number;
  max_result_bytes?: number;
};

type WorkerResponse = {
  id: number;
  ok: boolean;
  error?: string;
  count?: number;
  indexes?: number[];
  result?: string;
};

const WORKER_SOURCE = String.raw`
const { parentPort } = require("node:worker_threads");
parentPort.on("message", (msg) => {
  const send = (payload) => parentPort.postMessage({ id: msg.id, ...payload });
  try {
    if (msg.action === "line_matches") {
      const flags = String(msg.flags || "").replace(/[gy]/g, "");
      const regex = new RegExp(msg.pattern, flags || undefined);
      const lines = String(msg.text).split("\n");
      const indexes = [];
      const maxIndexes = Math.max(0, Number(msg.max_indexes) || 0);
      let count = 0;
      for (let i = 0; i < lines.length; i++) {
        regex.lastIndex = 0;
        if (!regex.test(lines[i])) continue;
        count++;
        if (indexes.length < maxIndexes) indexes.push(i);
      }
      send({ ok: true, count, indexes });
      return;
    }
    if (msg.action === "multiline_count") {
      let flags = String(msg.flags || "");
      if (!flags.includes("g")) flags += "g";
      const regex = new RegExp(msg.pattern, flags);
      const text = String(msg.text);
      let count = 0;
      let match;
      while ((match = regex.exec(text)) !== null) {
        count++;
        if (match[0] === "") regex.lastIndex++;
      }
      send({ ok: true, count });
      return;
    }
    if (msg.action === "replace") {
      const regex = new RegExp(msg.pattern, String(msg.flags || ""));
      const result = String(msg.text).replace(regex, String(msg.replacement || ""));
      const maxBytes = Number(msg.max_result_bytes) || 0;
      if (maxBytes > 0 && Buffer.byteLength(result, "utf8") > maxBytes) {
        throw new Error("Regex edit result exceeds configured byte budget");
      }
      send({ ok: true, result });
      return;
    }
    throw new Error("Unknown regex worker action");
  } catch (err) {
    send({ ok: false, error: err && err.message ? err.message : String(err) });
  }
});
`;

interface QueuedRequest {
  request: Omit<WorkerRequest, "id">;
  timeoutMs: number;
  resolve: (value: WorkerResponse) => void;
  reject: (error: Error) => void;
}

let worker: Worker | null = null;
let nextId = 1;
let active: (QueuedRequest & { id: number; timer: NodeJS.Timeout }) | null = null;
const queue: QueuedRequest[] = [];

function resetWorker(): void {
  const current = worker;
  worker = null;
  if (current) void current.terminate().catch(() => undefined);
}

function finishActive(error: Error | null, response?: WorkerResponse): void {
  const current = active;
  if (!current) return;
  clearTimeout(current.timer);
  active = null;
  if (error) current.reject(error);
  else current.resolve(response as WorkerResponse);
  queueMicrotask(pumpQueue);
}

function getWorker(): Worker {
  if (worker) return worker;
  const current = new Worker(WORKER_SOURCE, {
    eval: true,
    resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16 },
  });
  current.unref();
  current.on("message", (message: WorkerResponse) => {
    if (!active || active.id !== message.id) return;
    if (!message.ok) finishActive(new Error(message.error || "Regex worker failed"));
    else finishActive(null, message);
  });
  current.on("error", (err) => {
    if (worker !== current) return;
    resetWorker();
    finishActive(new Error(`Regex worker failed: ${err.message}`));
  });
  current.on("exit", (code) => {
    if (worker === current) {
      worker = null;
      if (code !== 0 && active) finishActive(new Error(`Regex worker exited unexpectedly (${code})`));
    }
  });
  worker = current;
  return current;
}

function pumpQueue(): void {
  if (active || queue.length === 0) return;
  const queued = queue.shift() as QueuedRequest;
  const id = nextId++;
  let current: Worker;
  try {
    current = getWorker();
  } catch (err) {
    queued.reject(err instanceof Error ? err : new Error(String(err)));
    queueMicrotask(pumpQueue);
    return;
  }
  const timer = setTimeout(() => {
    if (!active || active.id !== id) return;
    resetWorker();
    finishActive(new Error(`Regex execution timed out after ${queued.timeoutMs}ms`));
  }, queued.timeoutMs);
  active = { ...queued, id, timer };
  try {
    current.postMessage({ id, ...queued.request });
  } catch (err) {
    resetWorker();
    finishActive(err instanceof Error ? err : new Error(String(err)));
  }
}

function validateRegexRequest(pattern: string, flags: string): void {
  if (pattern.length > REGEX_PATTERN_MAX_CHARS) {
    throw new Error(`Regex pattern exceeds ${REGEX_PATTERN_MAX_CHARS} characters`);
  }
  if (flags.length > 16) throw new Error("Regex flags are too long");
}

async function requestRegex(
  request: Omit<WorkerRequest, "id">,
  timeoutMs = REGEX_TIMEOUT_MS
): Promise<WorkerResponse> {
  validateRegexRequest(request.pattern, request.flags);
  return new Promise<WorkerResponse>((resolve, reject) => {
    queue.push({ request, timeoutMs, resolve, reject });
    pumpQueue();
  });
}

export async function regexLineMatches(
  pattern: string,
  flags: string,
  text: string,
  maxIndexes: number
): Promise<{ count: number; indexes: number[] }> {
  const response = await requestRegex({ action: "line_matches", pattern, flags, text, max_indexes: Math.max(0, maxIndexes) });
  return { count: response.count || 0, indexes: response.indexes || [] };
}

export async function regexMultilineCount(pattern: string, flags: string, text: string): Promise<number> {
  const response = await requestRegex({ action: "multiline_count", pattern, flags, text });
  return response.count || 0;
}

export async function regexReplace(
  pattern: string,
  flags: string,
  text: string,
  replacement: string,
  maxResultBytes: number
): Promise<string> {
  const response = await requestRegex({
    action: "replace",
    pattern,
    flags,
    text,
    replacement,
    max_result_bytes: maxResultBytes,
  });
  return response.result ?? "";
}