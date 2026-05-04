/**
 * json-safe.ts — helpers para JSON.parse com tratamento de erro estruturado.
 */
import { readFileSync } from "node:fs";

/** Parseia texto JSON, lança erro com contexto em falha. */
export function parseJsonSafe<T = unknown>(text: string, context?: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`JSON parse error${context ? ` in ${context}` : ""}: ${msg}`);
  }
}

/** Lê arquivo e parseia JSON. Lança erro com path em falha. */
export function readJsonFile<T = unknown>(path: string): T {
  const text = readFileSync(path, "utf8");
  return parseJsonSafe<T>(text, path);
}
