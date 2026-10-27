/**
 * Patch @anthropic-ai/claude-agent-sdk for Node.js 18 compatibility.
 *
 * The SDK uses [Symbol.dispose] and [Symbol.asyncDispose] as computed property
 * keys, but Symbol.dispose / Symbol.asyncDispose are only available natively in
 * Node.js 22+. On Node 18, Symbol.dispose is undefined, so the computed key
 * becomes the string "undefined" instead of the Symbol used by the disposal
 * helper (_e / __addDisposableResource), causing "Object not disposable" errors.
 *
 * This script replaces [Symbol.dispose] with [wz] and [Symbol.asyncDispose]
 * with [kz], where wz/kz are the SDK's own fallback variables:
 *   wz = Symbol.dispose || Symbol.for("Symbol.dispose")
 *   kz = Symbol.asyncDispose || Symbol.for("Symbol.asyncDispose")
 *
 * It also patches the b2 helper function that checks Symbol.asyncDispose/dispose
 * on objects to use the wz/kz variables instead.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sdkPath = path.join(__dirname, "..", "node_modules", "@anthropic-ai", "claude-agent-sdk", "sdk.mjs");

if (!fs.existsSync(sdkPath)) {
  console.log("[patch-sdk] sdk.mjs not found, skipping patch.");
  process.exit(0);
}

let code = fs.readFileSync(sdkPath, "utf8");

// Verify the wz/kz variables exist (the fallback definitions)
if (!code.includes("Symbol.dispose||Symbol.for") || !code.includes("Symbol.asyncDispose||Symbol.for")) {
  console.log("[patch-sdk] SDK structure has changed — wz/kz fallbacks not found. Skipping patch.");
  process.exit(0);
}

// Check if already patched
if (code.includes("/* patched-dispose */")) {
  console.log("[patch-sdk] Already patched, skipping.");
  process.exit(0);
}

let patchCount = 0;

// 1. Replace [Symbol.dispose]() with [wz]() in class method definitions
//    but NOT in Symbol.dispose||Symbol.for (the fallback definition itself)
code = code.replace(/\[Symbol\.dispose\]\(\)/g, (match, offset) => {
  const before = code.substring(Math.max(0, offset - 40), offset);
  if (before.includes("Symbol.dispose||")) return match;
  patchCount++;
  return "[wz]()/* patched-dispose */";
});

// 2. Replace [Symbol.asyncDispose]() with [kz]() in class method definitions
code = code.replace(/\[Symbol\.asyncDispose\]\(\)/g, (match, offset) => {
  const before = code.substring(Math.max(0, offset - 40), offset);
  if (before.includes("Symbol.asyncDispose||")) return match;
  patchCount++;
  return "[kz]()/* patched-dispose */";
});

// 3. Replace [Symbol.dispose]:r with [wz]:r (the disposable registry callback)
code = code.replace(/\[Symbol\.dispose\]:r/g, (match, offset) => {
  const before = code.substring(Math.max(0, offset - 40), offset);
  if (before.includes("Symbol.dispose||")) return match;
  patchCount++;
  return "[wz]:r/* patched-dispose */";
});

// 4. Patch the b2 helper that checks for dispose methods on objects
//    Pattern: Symbol.asyncDispose in e  →  kz in e
//    Pattern: e[Symbol.asyncDispose]     →  e[kz]
//    Pattern: e[Symbol.dispose]          →  e[wz]
code = code.replace(/Symbol\.asyncDispose in e/g, () => {
  patchCount++;
  return "kz in e/* patched-dispose */";
});

code = code.replace(/e\[Symbol\.asyncDispose\]/g, () => {
  patchCount++;
  return "e[kz]/* patched-dispose */";
});

code = code.replace(/e\[Symbol\.dispose\]/g, (match, offset) => {
  const before = code.substring(Math.max(0, offset - 40), offset);
  if (before.includes("Symbol.dispose||")) return match;
  patchCount++;
  return "e[wz]/* patched-dispose */";
});

fs.writeFileSync(sdkPath, code, "utf8");
console.log(`[patch-sdk] Applied ${patchCount} patches to sdk.mjs for Node 18 compatibility.`);