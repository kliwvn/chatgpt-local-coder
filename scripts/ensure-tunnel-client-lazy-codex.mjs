#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureLazyCodexTunnelRuntime } from "../manager/tunnel-runtime.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const result = await ensureLazyCodexTunnelRuntime({ root });

if (!result.ok) {
  console.error(result.error || "Required patched OpenAI Tunnel runtime is unavailable.");
  process.exitCode = 1;
} else if (!result.required) {
  console.log("Patched OpenAI Tunnel runtime is not required on this platform.");
} else {
  console.log(`${result.rebuilt ? "Rebuilt and verified" : "Verified"} patched OpenAI Tunnel runtime: ${result.path}`);
}
