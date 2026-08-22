/**
 * test/workers-observability-guard.test.ts (#5920)
 *
 * Guard de regressão: todo Worker que declara `main = "..."` (tem script)
 * E expõe uma rota pública (`custom_domain = true` em algum `[[routes]]`)
 * DEVE ter `[observability] enabled = true` no wrangler.toml.
 *
 * Motivo: sem Workers Logs ligado, console.log/console.error do worker só
 * existem enquanto alguém tem `wrangler tail` aberto — e fail-soft que responde
 * 200 some também do gráfico de erro nativo do Cloudflare. Cada worker novo
 * ou refactor que esqueça a sessão de observabilidade entra em produção cego.
 *
 * Workers sem `main` (static-only, ex: diaria-artigos) ou sem rota pública
 * (internos, ex: brevo-dashboard) são excluídos deliberadamente — não têm
 * `console.log` de instrumentação pra expor.
 *
 * Fix do drift: adicionar bloco abaixo no wrangler.toml correspondente:
 *   [observability]
 *   enabled = true
 *   head_sampling_rate = 1
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKERS_DIR = join(ROOT, "workers");

interface WorkerObservabilityEntry {
  worker: string;
  hasMain: boolean;
  hasPublicRoute: boolean;
  hasObservability: boolean;
}

/**
 * Varre todos os workers/{nome}/wrangler.toml e retorna o estado de observabilidade
 * de cada um. Workers sem wrangler.toml são ignorados.
 */
function scanWorkersObservability(): WorkerObservabilityEntry[] {
  if (!existsSync(WORKERS_DIR)) return [];
  const out: WorkerObservabilityEntry[] = [];
  for (const name of readdirSync(WORKERS_DIR)) {
    const wranglerToml = join(WORKERS_DIR, name, "wrangler.toml");
    if (!existsSync(wranglerToml)) continue;
    const src = readFileSync(wranglerToml, "utf8");
    const hasMain = /^\s*main\s*=\s*['"]\S+["']/m.test(src);
    const hasPublicRoute = /custom_domain\s*=\s*true/.test(src);
    const hasObservability = /^\s*\[observability\]/m.test(src) &&
      /enabled\s*=\s*true/.test(src);
    out.push({ worker: name, hasMain, hasPublicRoute, hasObservability });
  }
  return out;
}

describe("workers públicos com main têm Workers Logs ligado (#5920)", () => {
  const workers = scanWorkersObservability();

  it("sanity: encontrou workers conhecidos com main + rota pública", () => {
    const publicScriptWorkers = workers.filter(
      (w) => w.hasMain && w.hasPublicRoute,
    );
    assert.ok(
      publicScriptWorkers.length >= 4,
      `esperava >=4 workers com main + custom_domain, achou ${publicScriptWorkers.length}: ` +
        `${publicScriptWorkers.map((w) => w.worker).join(", ")}`,
    );
  });

  it("todo worker com main + rota pública tem [observability] enabled=true", () => {
    const violations = workers.filter(
      (w) => w.hasMain && w.hasPublicRoute && !w.hasObservability,
    );
    if (violations.length > 0) {
      const names = violations.map((w) => w.worker).join(", ");
      const detail = violations
        .map(
          (w) =>
            `  - workers/${w.worker}/wrangler.toml: tem main + custom_domain mas [observability] ausente\n` +
            `    Adicionar:\n` +
            `    [observability]\n` +
            `    enabled = true\n` +
            `    head_sampling_rate = 1`,
        )
        .join("\n");
      assert.fail(
        `Workers públicos sem observabilidade (#5920):\n${detail}\n\nWorkers verificados: ${names}`,
      );
    }
  });

  it("workers sem main (static-only) NÃO são exigidos a ter observabilidade", () => {
    // diaria-artigos é static-only (sem main) — não precisa de observability
    // porque não tem console.log de instrumentação no bundle. Este teste é
    // documental: confirma que a exclusão deliberada do guard é intencional.
    const staticOnly = workers.filter((w) => !w.hasMain);
    assert.ok(
      staticOnly.length >= 1,
      "esperava pelo menos 1 worker static-only (ex: diaria-artigos)",
    );
  });
});
