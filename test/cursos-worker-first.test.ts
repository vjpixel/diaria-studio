/**
 * cursos-worker-first.test.ts (#4052 follow-up)
 *
 * REGRESSÃO CRÍTICA: num Worker com Static Assets, o asset é servido ANTES do
 * script — se existe arquivo casando com o path da request, o `fetch` handler
 * NUNCA é invocado. `workers/cursos/public/index.html` casa com `/`, então o
 * gate inteiro nasceu morto em produção mesmo com o worker no ar e todos os
 * secrets configurados:
 *
 *   - caminho A (`/?email=` da merge tag da newsletter) — ignorado, nenhum
 *     `Set-Cookie` era emitido;
 *   - caminho B — `POST /gate/verify` respondia `{ok:true}` e setava o cookie
 *     de sessão (essa rota não tem asset casando), mas o `GET /` seguinte
 *     servia o teaser estático de novo, sem NUNCA ler o cookie. Beco sem
 *     saída exatamente como a issue proibia: o leitor assina, a Beehiiv
 *     confirma, e a página continua bloqueada.
 *
 * Nenhum teste pegava isso porque `test/cursos-gate.test.ts` chama
 * `worker.fetch()` direto — o handler está correto; o que estava errado era o
 * roteamento do wrangler.toml, que nenhum teste lia. Este teste fecha essa
 * lacuna: o invariante é de CONFIG, então é a config que precisa ser afirmada.
 *
 * `run_worker_first` precisa cobrir `/` (e `/index.html`, o mesmo asset por
 * outro path) sempre que o worker tiver `main` + `[assets]`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WRANGLER = resolve(ROOT, "workers/cursos/wrangler.toml");

/** Extrai as linhas de uma seção `[nome]` do toml (até a próxima seção). */
function tomlSection(toml: string, name: string): string {
  const lines = toml.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === `[${name}]`);
  if (start < 0) return "";
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^\s*\[/.test(l));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

/** Valores de um array de strings toml (`chave = ["a", "b"]`), ou `null`. */
function tomlStringArray(section: string, key: string): string[] | null {
  const m = section.match(new RegExp(`^\\s*${key}\\s*=\\s*\\[([^\\]]*)\\]`, "m"));
  if (!m) return null;
  return [...m[1].matchAll(/["']([^"']*)["']/g)].map((x) => x[1]);
}

describe("workers/cursos: script roda antes do asset em / (#4052)", () => {
  const toml = readFileSync(WRANGLER, "utf8");
  const assets = tomlSection(toml, "assets");

  it("sanity: o worker tem script (`main`) E assets — senão o invariante não se aplica", () => {
    assert.match(toml, /^\s*main\s*=/m, "wrangler.toml precisa declarar `main`");
    assert.notEqual(assets, "", "wrangler.toml precisa ter a seção [assets]");
    assert.match(assets, /directory\s*=/, "[assets] precisa declarar `directory`");
  });

  it("`run_worker_first` cobre `/` — sem isso o gate nunca é consultado na home", () => {
    const boolLiteral = assets.match(/^\s*run_worker_first\s*=\s*(true|false)\s*$/m);
    if (boolLiteral) {
      assert.equal(boolLiteral[1], "true", "run_worker_first = false deixa o asset ganhar do script em /");
      return;
    }
    const routes = tomlStringArray(assets, "run_worker_first");
    assert.ok(routes, "[assets] precisa declarar `run_worker_first` (o asset ganha do script sem isso)");
    assert.ok(routes.includes("/"), `run_worker_first precisa incluir "/" — declarado: ${JSON.stringify(routes)}`);
  });

  it("`run_worker_first` também cobre `/index.html` (mesmo asset por outro path)", () => {
    const boolLiteral = assets.match(/^\s*run_worker_first\s*=\s*(true|false)\s*$/m);
    if (boolLiteral?.[1] === "true") return;
    const routes = tomlStringArray(assets, "run_worker_first") ?? [];
    assert.ok(
      routes.includes("/index.html"),
      `run_worker_first precisa incluir "/index.html" — declarado: ${JSON.stringify(routes)}`,
    );
  });

  // #4305: `run_worker_first` só faz o script RODAR; quem decide se o gate é
  // consultado é o roteamento em `src/index.ts`. Declarar um path só no toml
  // faz o worker rodar pra cair no `env.ASSETS.fetch` do fim e devolver o
  // teaser cru — o gate promete cobertura e não entrega, silenciosamente. Foi
  // o que aconteceu com `/index.html`: estava no toml, mas o `fetch` só
  // casava `pathname === "/"`. As duas listas TÊM que concordar.
  it("todo path de `run_worker_first` é roteado pra `handleIndex` em src/index.ts", async () => {
    const boolLiteral = assets.match(/^\s*run_worker_first\s*=\s*(true|false)\s*$/m);
    if (boolLiteral?.[1] === "true") return; // cobertura total: nada a conciliar
    const routes = tomlStringArray(assets, "run_worker_first") ?? [];
    const { GATED_INDEX_PATHS } = await import("../workers/cursos/src/index.ts");
    for (const r of routes) {
      assert.ok(
        GATED_INDEX_PATHS.includes(r),
        `wrangler.toml declara "${r}" em run_worker_first, mas src/index.ts não roteia esse path pra handleIndex (GATED_INDEX_PATHS = ${JSON.stringify(GATED_INDEX_PATHS)}) — o worker rodaria só pra devolver o teaser cru`,
      );
    }
  });

  it("todo path gated em src/index.ts está em `run_worker_first` (senão o script nem roda)", async () => {
    const boolLiteral = assets.match(/^\s*run_worker_first\s*=\s*(true|false)\s*$/m);
    if (boolLiteral?.[1] === "true") return;
    const routes = tomlStringArray(assets, "run_worker_first") ?? [];
    const { GATED_INDEX_PATHS } = await import("../workers/cursos/src/index.ts");
    for (const p of GATED_INDEX_PATHS) {
      assert.ok(
        routes.includes(p),
        `src/index.ts gateia "${p}", mas wrangler.toml não o declara em run_worker_first — o asset ganha e handleIndex nunca roda`,
      );
    }
  });
});
