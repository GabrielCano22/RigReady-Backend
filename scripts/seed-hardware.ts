/**
 * Seed hardware catalog from PassMark mega-lists.
 *
 * Usage:
 *   npm run seed:hardware          # fetches fresh data and regenerates cpus.ts/gpus.ts
 *   npm run seed:hardware -- --offline   # uses cached scripts/data/*.json
 *
 * Sources:
 *   https://www.cpubenchmark.net/CPU_mega_page.html  (cookie) -> /data/
 *   https://www.videocardbenchmark.net/GPU_mega_page.html     -> /data/
 *
 * The PassMark data is for personal / non-commercial use.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const CPU_FLAGSHIP_PASSMARK = 72000; // ~ Ryzen 9 9950X3D = score 100
const GPU_FLAGSHIP_PASSMARK = 38935; // ~ RTX 5090 = score 100

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "scripts", "data");
const CPU_OUT = path.join(ROOT, "src", "data", "cpus.ts");
const GPU_OUT = path.join(ROOT, "src", "data", "gpus.ts");

interface RawCpu {
  id: string;
  name: string;
  cpumark: string;
  cat: string;
  cores: string;
  socket: string;
  tdp: string;
  date: string;
}
interface RawGpu {
  id: string;
  name: string;
  g3d: string;
  cat: string;
  bus: string;
  memSize: string;
  date: string;
}

type Platform = "desktop" | "laptop" | "integrated";
type Vendor = "Intel" | "AMD" | "NVIDIA" | "Apple" | "Qualcomm" | "Other";

interface NormalizedComponent {
  id: string;
  name: string;
  score: number;
  platform: Platform;
  vendor?: Vendor;
  integratedGpuId?: string;
}

// ---------- fetch helpers ----------
async function fetchMegaJson(
  megaPageUrl: string,
  dataUrl: string,
): Promise<any> {
  // Step 1: prime cookie
  const primeRes = await fetch(megaPageUrl, { headers: { "User-Agent": UA } });
  const setCookie = primeRes.headers.get("set-cookie") || "";
  const m = setCookie.match(/PHPSESSID=([^;]+)/);
  if (!m) throw new Error(`No PHPSESSID from ${megaPageUrl}`);
  const phpSessId = m[1];

  // Step 2: fetch JSON
  const ts = Date.now();
  const res = await fetch(`${dataUrl}?_=${ts}`, {
    headers: {
      "User-Agent": UA,
      "X-Requested-With": "XMLHttpRequest",
      Referer: megaPageUrl,
      Cookie: `PHPSESSID=${phpSessId}`,
    },
  });
  if (!res.ok) throw new Error(`${dataUrl} -> ${res.status}`);
  return res.json();
}

// ---------- classification helpers ----------
const nameClean = (raw: string) =>
  raw
    .replace(/&amp;/g, "&")
    .replace(/@.*$/, "")
    .replace(/\s+/g, " ")
    .trim();

const slugify = (name: string): string =>
  name
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

function detectVendor(name: string): Vendor {
  const n = name.toLowerCase();
  if (
    /intel|celeron|pentium|xeon|\bcore\b|atom|iris|\buhd\b|\bhd graphics\b|arc /i.test(
      name,
    )
  )
    return "Intel";
  if (
    /amd|ryzen|radeon|epyc|threadripper|athlon|\bfx-\d|phenom|opteron|sempron|rdna|navi|vega\b/i.test(
      name,
    )
  )
    return "AMD";
  if (
    /nvidia|geforce|\bgtx\b|\brtx\b|\btitan\b|quadro|tesla|\bgt\b\s?\d|tegra/i.test(
      name,
    )
  )
    return "NVIDIA";
  if (/\bapple\b|\bm1\b|\bm2\b|\bm3\b|\bm4\b/i.test(n)) return "Apple";
  if (/snapdragon|qualcomm|adreno/i.test(name)) return "Qualcomm";
  return "Other";
}

function cpuPlatform(cat: string, name: string): Platform {
  const c = cat.toLowerCase();
  const n = name.toLowerCase();
  // explicit laptop suffixes
  if (/-\d{3,}(u|h|hs|hx|hk|y|p)\b/i.test(name)) return "laptop";
  if (/\bapple m\d/.test(n)) return "laptop";
  if (c.includes("desktop") || c.includes("server")) return "desktop";
  if (c.includes("laptop") || c.includes("mobile")) return "laptop";
  return "desktop";
}

function gpuIsIntegrated(name: string): boolean {
  return /\b(uhd|iris|hd graphics)\b|\bradeon graphics\b|\bradeon vega\b.*(mobile|gfx)|radeon rx vega \d+( mobile)?( gfx)?$|^intel hd|graphics \(integrated\)|\bapple m\d/i.test(
    name,
  );
}

function gpuPlatform(cat: string, name: string): Platform {
  if (gpuIsIntegrated(name)) return "integrated";
  const c = cat.toLowerCase();
  if (c.includes("mobile")) return "laptop";
  if (c.includes("desktop") || c.includes("workstation")) return "desktop";
  // fallback: suffix check
  if (/\b\d{3,4}m\b|\bmobile\b|\blaptop\b/i.test(name)) return "laptop";
  return "desktop";
}

// ---------- scoring ----------
const parseNum = (s: string): number => {
  const n = parseFloat((s || "0").replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
};

function cpuScore(cpumark: string): number {
  const raw = parseNum(cpumark);
  if (raw <= 0) return 0;
  // log-ish compression so we don't crush entry-level CPUs
  // linear to flagship then cap at 115 for EPYC monsters
  const score = (raw / CPU_FLAGSHIP_PASSMARK) * 100;
  return Math.min(Math.max(Math.round(score), 1), 120);
}

function gpuScore(g3d: string): number {
  const raw = parseNum(g3d);
  if (raw <= 0) return 0;
  const score = (raw / GPU_FLAGSHIP_PASSMARK) * 100;
  return Math.min(Math.max(Math.round(score), 1), 130);
}

// ---------- normalization ----------
function normalizeCpus(raw: RawCpu[]): NormalizedComponent[] {
  const seen = new Set<string>();
  const out: NormalizedComponent[] = [];
  for (const c of raw) {
    const name = nameClean(c.name);
    if (!name) continue;
    const score = cpuScore(c.cpumark);
    if (score <= 0) continue;
    const platform = cpuPlatform(c.cat, name);
    const vendor = detectVendor(name);
    if (vendor === "Other") continue; // skip junk/unknown brands
    const slug = slugify(name);
    // Avoid doubling vendor prefix if name already starts with it
    const prefix = slug.startsWith(vendor.toLowerCase())
      ? ""
      : `${vendor.toLowerCase()}-`;
    let id = `${prefix}${slug}`;
    if (seen.has(id)) id = `${id}-${c.id}`;
    seen.add(id);
    out.push({ id, name, score, platform, vendor });
  }
  return out;
}

function normalizeGpus(raw: RawGpu[]): NormalizedComponent[] {
  const seen = new Set<string>();
  const out: NormalizedComponent[] = [];
  for (const g of raw) {
    const name = nameClean(g.name);
    if (!name) continue;
    const score = gpuScore(g.g3d);
    if (score <= 0) continue;
    const platform = gpuPlatform(g.cat, name);
    const vendor = detectVendor(name);
    if (vendor === "Other") continue;
    const slug = slugify(name);
    const prefix = slug.startsWith(vendor.toLowerCase())
      ? ""
      : `${vendor.toLowerCase()}-`;
    let id = `${prefix}${slug}`;
    if (seen.has(id)) id = `${id}-${g.id}`;
    seen.add(id);
    out.push({ id, name, score, platform, vendor });
  }
  return out;
}

// ---------- codegen ----------
function renderFile(kind: "cpu" | "gpu", items: NormalizedComponent[]): string {
  items.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const header =
    kind === "cpu"
      ? `import type { Component } from "../lib/types";\n\n// Auto-generated by scripts/seed-hardware.ts — do not edit by hand.\n// Source: PassMark cpubenchmark.net/CPU_mega_page.html (personal use).\n// Flagship (Ryzen 9 9950X3D class) ≈ score 100. Server EPYC caps at 120.\n\nconst data = [\n`
      : `import type { Component } from "../lib/types";\n\n// Auto-generated by scripts/seed-hardware.ts — do not edit by hand.\n// Source: PassMark videocardbenchmark.net/GPU_mega_page.html (personal use).\n// Flagship (RTX 5090) ≈ score 100. Workstation halo caps at 130.\n\nconst data = [\n`;
  const body = items
    .map((i) => {
      const parts = [
        `id: ${JSON.stringify(i.id)}`,
        `name: ${JSON.stringify(i.name)}`,
        `score: ${i.score}`,
        `platform: ${JSON.stringify(i.platform)}`,
      ];
      if (i.vendor) parts.push(`vendor: ${JSON.stringify(i.vendor)}`);
      if (i.integratedGpuId)
        parts.push(`integratedGpuId: ${JSON.stringify(i.integratedGpuId)}`);
      return `  { ${parts.join(", ")} },`;
    })
    .join("\n");
  const exportName = kind === "cpu" ? "cpus" : "gpus";
  return `${header}${body}\n] as const;\n\nexport const ${exportName}: Component[] = data as unknown as Component[];\n`;
}

// ---------- main ----------
async function main() {
  const offline = process.argv.includes("--offline");
  await fs.mkdir(DATA_DIR, { recursive: true });
  const cpuCache = path.join(DATA_DIR, "cpu_mega.json");
  const gpuCache = path.join(DATA_DIR, "gpu_mega.json");

  let cpuJson: { data: RawCpu[] };
  let gpuJson: { data: RawGpu[] };

  if (offline) {
    console.log("→ offline mode: reading cached data/");
    cpuJson = JSON.parse(await fs.readFile(cpuCache, "utf8"));
    gpuJson = JSON.parse(await fs.readFile(gpuCache, "utf8"));
  } else {
    console.log("→ fetching CPU mega list from PassMark…");
    cpuJson = await fetchMegaJson(
      "https://www.cpubenchmark.net/CPU_mega_page.html",
      "https://www.cpubenchmark.net/data/",
    );
    await fs.writeFile(cpuCache, JSON.stringify(cpuJson));
    console.log("→ fetching GPU mega list from PassMark…");
    gpuJson = await fetchMegaJson(
      "https://www.videocardbenchmark.net/GPU_mega_page.html",
      "https://www.videocardbenchmark.net/data/",
    );
    await fs.writeFile(gpuCache, JSON.stringify(gpuJson));
  }

  console.log(
    `→ raw sizes: CPUs=${cpuJson.data.length}, GPUs=${gpuJson.data.length}`,
  );

  const cpus = normalizeCpus(cpuJson.data);
  const gpus = normalizeGpus(gpuJson.data);

  console.log(
    `→ normalized: CPUs=${cpus.length} (desktop ${cpus.filter((c) => c.platform === "desktop").length}, laptop ${cpus.filter((c) => c.platform === "laptop").length}), GPUs=${gpus.length} (desktop ${gpus.filter((g) => g.platform === "desktop").length}, laptop ${gpus.filter((g) => g.platform === "laptop").length}, integrated ${gpus.filter((g) => g.platform === "integrated").length})`,
  );

  await fs.writeFile(CPU_OUT, renderFile("cpu", cpus));
  await fs.writeFile(GPU_OUT, renderFile("gpu", gpus));
  console.log(`✓ wrote ${CPU_OUT}`);
  console.log(`✓ wrote ${GPU_OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
