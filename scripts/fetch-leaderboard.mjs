#!/usr/bin/env node
/**
 * pi-review-gate — OPT-IN model-capability leaderboard fetcher (GATE-EXTERNAL).
 *
 * This is the ONLY component allowed to touch the network, and it is NEVER run
 * by the review-gate extension (which is fail-closed and network-free). Its
 * sole job is to refresh the offline FAMILY_CAPABILITY snapshot in
 * lib/model-ranking.ts from public leaderboards, so adviser/reviewer selection
 * can prefer the strongest cross-family judges.
 *
 * "Score越强就越适合做 adviser/reviewer" — this pulls those scores from real,
 * public capability leaderboards:
 *
 *   • Artificial Analysis  — Intelligence Index (0–100). Requires a free API
 *                            key in ARTIFICIAL_ANALYSIS_API_KEY.
 *                            https://artificialanalysis.ai/api
 *   • OpenRouter           — model catalog (families, context, pricing), keyless.
 *                            https://openrouter.ai/api/v1/models
 *   • (LMArena / LiveBench / HF Open LLM Leaderboard are keyless datasets you
 *      can add the same way — see mapToFamily.)
 *
 * Usage:
 *   node scripts/fetch-leaderboard.mjs            # print a family-score table
 *   node scripts/fetch-leaderboard.mjs --write    # rewrite the snapshot block
 *
 * Env:
 *   ARTIFICIAL_ANALYSIS_API_KEY   free key from artificialanalysis.ai/api
 *
 * This script fails LOUDLY and never silently writes a partial snapshot.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const WRITE = process.argv.includes("--write");

// Snapshot target: default is the sibling lib/, but after a GLOBAL install the
// fetcher and the ranking lib live in different trees, so allow an explicit
// override: --snapshot-file <path>  or  SNAPSHOT_FILE=<path>.
function resolveSnapshotFile() {
  const flagIdx = process.argv.indexOf("--snapshot-file");
  if (flagIdx >= 0 && process.argv[flagIdx + 1]) return process.argv[flagIdx + 1];
  if (process.env.SNAPSHOT_FILE) return process.env.SNAPSHOT_FILE;
  return join(ROOT, "lib", "model-ranking.ts");
}
const SNAPSHOT_FILE = resolveSnapshotFile();

/**
 * Normalize any leaderboard's model/vendor name to our ModelFamily enum.
 * Kept in lock-step with `familyOf` in lib/model-ranking.ts: distinctive vendor
 * tokens are matched FIRST, generic OpenAI codenames are anchored last so they
 * cannot false-match another vendor's codename.
 */
function mapToFamily(name) {
  const id = String(name).toLowerCase();
  if (/deepseek/.test(id)) return "deepseek";
  if (/(glm|zhipu|chatglm)/.test(id)) return "zhipu";
  if (/(kimi|moonshot)/.test(id)) return "moonshot";
  if (/minimax/.test(id)) return "minimax";
  if (/qwen/.test(id)) return "qwen";
  if (/(llama|meta-)/.test(id)) return "meta";
  if (/(mistral|mixtral|codestral)/.test(id)) return "mistral";
  if (/(gemini|palm|bard|google)/.test(id)) return "google";
  if (/(claude|opus|sonnet|haiku|fable|anthropic)/.test(id)) return "anthropic";
  if (/(gpt|codex|openai)/.test(id)) return "openai";
  if (/(^|[-_/\s])o[1-9]([-_/\s]|$)/.test(id)) return "openai";
  if (/(^|[-_/\s])(sol|luna|terra)([-_/\s]|$)/.test(id)) return "openai";
  return "unknown";
}

const OPEN_WEIGHT = new Set(["deepseek", "zhipu", "moonshot", "minimax", "qwen", "meta", "mistral"]);

async function fetchJson(url, headers = {}) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status} ${res.statusText}`);
  return res.json();
}

/**
 * Artificial Analysis: Intelligence Index per model → reduce to family max.
 * Returns Map<family, score(0-100)>.
 */
async function fromArtificialAnalysis() {
  const key = process.env.ARTIFICIAL_ANALYSIS_API_KEY;
  if (!key) {
    console.error("… skipping Artificial Analysis (set ARTIFICIAL_ANALYSIS_API_KEY for Intelligence Index)");
    return new Map();
  }
  const data = await fetchJson(
    "https://artificialanalysis.ai/api/v2/data/llms/models",
    { "x-api-key": key },
  );
  const rows = Array.isArray(data) ? data : data?.data ?? [];
  const byFamily = new Map();
  for (const row of rows) {
    const name = row.name ?? row.model_name ?? row.slug ?? "";
    const idx =
      row.evaluations?.artificial_analysis_intelligence_index ??
      row.intelligence_index ??
      row.median_intelligence_index;
    if (typeof idx !== "number") continue;
    const fam = mapToFamily(name);
    if (fam === "unknown") continue;
    byFamily.set(fam, Math.max(byFamily.get(fam) ?? 0, Math.round(idx)));
  }
  return byFamily;
}

/**
 * OpenRouter: keyless catalog. Used to confirm which families are live/available
 * (does not carry a quality score, so it only fills gaps, never overrides AA).
 */
async function fromOpenRouter() {
  try {
    const data = await fetchJson("https://openrouter.ai/api/v1/models");
    const fams = new Set();
    for (const m of data?.data ?? []) fams.add(mapToFamily(m.id ?? m.name ?? ""));
    fams.delete("unknown");
    return fams;
  } catch (e) {
    console.error(`… OpenRouter catalog unavailable: ${e.message}`);
    return new Set();
  }
}

const FAMILY_ORDER = ["anthropic", "openai", "google", "deepseek", "moonshot", "zhipu", "qwen", "minimax", "meta", "mistral"];

/**
 * Parse the CURRENT snapshot's FAMILY_CAPABILITY entries out of the source file
 * so a partial fetch can MERGE (update scores it has, preserve the rest) rather
 * than silently dropping families it didn't return. Returns Map<family, {score,
 * openWeight, source}>. Best-effort: on any parse miss it returns an empty map,
 * and the caller then requires enough freshly-fetched families before writing.
 */
function parseExistingSnapshot(src) {
  const existing = new Map();
  const block = src.match(/FAMILY_CAPABILITY[^[]*\[([\s\S]*?)\]\);/);
  if (!block) return existing;
  const rowRe = /family:\s*"([^"]+)",\s*score:\s*(\d+),\s*openWeight:\s*(true|false),\s*source:\s*"([^"]*)"/g;
  let m;
  while ((m = rowRe.exec(block[1])) !== null) {
    existing.set(m[1], { score: Number(m[2]), openWeight: m[3] === "true", source: m[4] });
  }
  return existing;
}

/**
 * Merge freshly-fetched family scores over the existing snapshot. Families the
 * fetch didn't return keep their previous values (no silent drop). Families the
 * fetch DID return get an updated score and a refreshed source tag.
 */
function mergeSnapshot(existing, fetched) {
  const merged = new Map(existing);
  for (const [fam, score] of fetched) {
    // Freshly fetched from Artificial Analysis → overwrite score and source tag.
    merged.set(fam, { score, openWeight: OPEN_WEIGHT.has(fam), source: "artificial-analysis" });
  }
  return merged;
}

function renderSnapshot(merged, today) {
  const present = FAMILY_ORDER.filter((f) => merged.has(f));
  const lines = present.map((f) => {
    const row = merged.get(f);
    return `  { family: "${f}", score: ${row.score}, openWeight: ${OPEN_WEIGHT.has(f)}, source: "${row.source || "artificial-analysis"}" },`;
  });
  return { date: today, body: lines.join("\n") };
}

async function main() {
  const aa = await fromArtificialAnalysis();
  const orFamilies = await fromOpenRouter();

  if (aa.size === 0) {
    console.error("\nNo scored leaderboard data retrieved. Nothing to write.");
    console.error("Get a free key at https://artificialanalysis.ai/api and set ARTIFICIAL_ANALYSIS_API_KEY.");
    process.exitCode = 1;
    return;
  }

  // A successful-but-partial fetch must not shrink the snapshot. Require a
  // minimum number of freshly-scored families before we are willing to write.
  const MIN_FRESH_FAMILIES = 4;
  if (aa.size < MIN_FRESH_FAMILIES) {
    console.error(`\nOnly ${aa.size} families scored (< ${MIN_FRESH_FAMILIES} required). Refusing to write a partial snapshot.`);
    process.exitCode = 1;
    return;
  }

  const today = new Date().toISOString().slice(0, 10);

  console.log(`\nModel-family capability (higher = better adviser/reviewer), snapshot ${today}:`);
  for (const [fam, score] of [...aa.entries()].sort((a, b) => b[1] - a[1])) {
    const live = orFamilies.size === 0 || orFamilies.has(fam) ? "" : "  (not in OpenRouter catalog)";
    console.log(`  ${String(score).padStart(3)}  ${fam}${live}`);
  }

  if (!WRITE) {
    console.log("\n(dry-run) re-run with --write to update lib/model-ranking.ts");
    return;
  }

  let src;
  try {
    src = readFileSync(SNAPSHOT_FILE, "utf8");
  } catch {
    throw new Error(
      `Snapshot file not found: ${SNAPSHOT_FILE}\n` +
      `After a global install the ranking lib lives elsewhere; pass ` +
      `--snapshot-file <path> or set SNAPSHOT_FILE=<path> ` +
      `(e.g. ~/.pi/agent/extensions/pi-review-gate/lib/model-ranking.ts).`,
    );
  }
  const dateRe = /export const SNAPSHOT_DATE = "[^"]*";/;
  const arrRe = /export const FAMILY_CAPABILITY: readonly FamilyCapability\[\] = Object\.freeze\(\[[\s\S]*?\]\);/;
  if (!dateRe.test(src) || !arrRe.test(src)) {
    throw new Error("Could not locate SNAPSHOT_DATE / FAMILY_CAPABILITY block to rewrite — aborting to avoid corruption.");
  }
  // Merge over the existing snapshot so families AA didn't return are preserved.
  const merged = mergeSnapshot(parseExistingSnapshot(src), aa);
  const { date, body } = renderSnapshot(merged, today);
  const updated = src
    .replace(dateRe, `export const SNAPSHOT_DATE = "${date}";`)
    .replace(arrRe, `export const FAMILY_CAPABILITY: readonly FamilyCapability[] = Object.freeze([\n${body}\n]);`);
  writeFileSync(SNAPSHOT_FILE, updated);
  console.log(`\n✓ Wrote refreshed snapshot to lib/model-ranking.ts (${date}).`);
  console.log("  Review the diff and run: npm test");
}

main().catch((e) => {
  console.error(`\nfetch-leaderboard failed: ${e.message}`);
  process.exitCode = 1;
});
