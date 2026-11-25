import { createHash } from "node:crypto";

/** Retira sufixo apenas quando identifica o veículo na fonte ou no domínio. */
export function copyComparisonTitle(title: string, source?: unknown, url?: string): string {
  const suffix = title.match(/\s+[-|]\s+([^|]{1,40})$/);
  if (!suffix) return title;
  const key = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const label = key(suffix[1]);
  const names = typeof source === "string" ? [key(source)] : [];
  try { if (url) names.push(...new URL(url).hostname.split(".").map(key)); } catch { /* URL inválida não identifica veículo. */ }
  return label.length >= 3 && names.some(name => name === label || name.startsWith(label))
    ? title.slice(0, suffix.index) : title;
}

function shingles(value: unknown): Set<string> {
  if (typeof value !== "string") return new Set();
  const words = value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().match(/[a-z0-9]+/g) ?? [];
  // Resumos curtos não sustentam identidade de conteúdo.
  if (words.length < 40) return new Set();
  const hashes = new Set<string>();
  for (let i = 0; i <= words.length - 5; i++)
    hashes.add(createHash("sha256").update(words.slice(i, i + 5).join(" ")).digest("hex"));
  return hashes;
}

export function sameContentCopy(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  for (const field of ["body", "content", "summary"]) {
    const left = shingles(a[field]), right = shingles(b[field]);
    if (left.size < 20 || right.size < 20) continue;
    const shared = [...left].filter(hash => right.has(hash)).length;
    if (shared / (left.size + right.size - shared) >= 0.8) return true;
  }
  return false;
}
