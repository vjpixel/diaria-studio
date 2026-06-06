/**
 * check-cursos-links.ts (#1892)
 *
 * Guard de linkcheck do seed de cursos (`seed/courses/cursos-ia.json`). Cursos
 * saem do ar / mudam URL com mais frequência que livros — este guard pega o
 * drift (404 / redirect) antes de virar link quebrado na página pública.
 *
 * Faz um GET (com follow de redirect + timeout) em cada `url` e classifica:
 *   - ok       → 2xx, sem redirect de host (ou sem redirect)
 *   - redirect → 2xx mas a URL final difere da cadastrada (warning — vale
 *                atualizar o seed pro destino real)
 *   - broken   → 4xx/5xx/erro de rede/timeout (falha o guard)
 *
 * Uso:
 *   npx tsx scripts/check-cursos-links.ts            # reporta + exit 1 se broken
 *   npx tsx scripts/check-cursos-links.ts --json     # saída JSON
 *
 * Exit: 1 se algum `broken`; 0 caso contrário (redirects só avisam).
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface CourseLinkProbe {
  ok: boolean;
  status: number;
  finalUrl: string;
  originalUrl: string;
  error?: string;
}

export type CourseLinkStatus = "ok" | "redirect" | "broken";

/** Pure: host de uma URL em lowercase, sem `www.` e sem ponto final. "" se inválida. */
export function urlHost(u: string): string {
  try {
    return new URL(u).hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  } catch {
    return "";
  }
}

/**
 * Pure: classifica o resultado de uma sonda. `redirect` só quando o resultado é
 * 2xx mas mudou de HOST (mudança de path no mesmo host é tolerada — muitos sites
 * normalizam trailing slash / locale sem ser "drift" real). Rede/timeout/4xx/5xx
 * → broken.
 */
export function classifyCourseLink(p: CourseLinkProbe): CourseLinkStatus {
  if (p.error) return "broken";
  if (!p.ok || p.status < 200 || p.status >= 400) return "broken";
  const from = urlHost(p.originalUrl);
  const to = urlHost(p.finalUrl);
  if (from && to && from !== to) return "redirect";
  return "ok";
}

interface Course {
  id: string;
  title: string;
  platform: string;
  url: string;
}

export function loadCourses(root: string = ROOT): Course[] {
  const path = resolve(root, "seed", "courses", "cursos-ia.json");
  const data = JSON.parse(readFileSync(path, "utf8"));
  const arr: Course[] = data.courses ?? data;
  if (!Array.isArray(arr)) throw new Error("cursos-ia.json: esperava { courses: [...] }");
  return arr;
}

async function probe(url: string): Promise<CourseLinkProbe> {
  try {
    const r = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
      headers: {
        // alguns hosts bloqueiam UA vazio / bot — finge um browser.
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
      },
    });
    return { ok: r.ok, status: r.status, finalUrl: r.url || url, originalUrl: url };
  } catch (e) {
    return { ok: false, status: 0, finalUrl: url, originalUrl: url, error: (e as Error).message };
  }
}

async function main() {
  const json = process.argv.includes("--json");
  const courses = loadCourses();

  const results = await Promise.all(
    courses.map(async (c) => {
      const p = await probe(c.url);
      return { id: c.id, platform: c.platform, url: c.url, finalUrl: p.finalUrl, status: p.status, error: p.error, klass: classifyCourseLink(p) };
    }),
  );

  const broken = results.filter((r) => r.klass === "broken");
  const redirects = results.filter((r) => r.klass === "redirect");

  if (json) {
    console.log(JSON.stringify({ total: results.length, broken, redirects, results }, null, 2));
  } else {
    console.log(`Cursos: ${results.length} | ok: ${results.length - broken.length - redirects.length} | redirect: ${redirects.length} | broken: ${broken.length}\n`);
    for (const r of redirects) {
      console.log(`↪ REDIRECT ${r.id} (${r.platform})\n    ${r.url}\n    → ${r.finalUrl}`);
    }
    for (const r of broken) {
      console.log(`✖ BROKEN  ${r.id} (${r.platform}) [${r.error ?? r.status}]\n    ${r.url}`);
    }
  }

  if (broken.length > 0) process.exit(1);
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main();
}
