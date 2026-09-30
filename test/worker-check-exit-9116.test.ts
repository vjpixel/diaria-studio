/**
 * test/worker-check-exit-9116.test.ts (#9116)
 *
 * Edição 260930: `check-worker-cors.ts` imprimiu `ok: true` + `status: 404` e
 * o Node abortou com `UV_HANDLE_CLOSING` (exit 127) no Windows;
 * `preflight-poll-dispatch.ts` avisou "Worker inacessível (DNS + DoH ambos
 * falharam). HTTP 404" e o smoke-test votou OK logo depois.
 *
 * Três causas, três regressões:
 *   1. `process.exit()` depois de fetch → UV_HANDLE_CLOSING (classe
 *      #1401/#4653). Asserção estática: nenhum `process.exit(` depois do 1º
 *      `await` de `main()` nem no `.catch()` do bloco isMainModule.
 *   2. O pre-check do preflight sondava `/health`, rota que o Worker `poll`
 *      não tem → 404 sempre. Agora sonda `/robots.txt` (estática no Worker).
 *   3. Um 404 DIRETO (DNS e conexão OK) caía no ramo "DNS + DoH falharam".
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  describeReachability,
  reachabilityProbeUrl,
} from "../scripts/preflight-poll-dispatch.ts";
import { probeStatusNote } from "../scripts/check-worker-cors.ts";
import pollWorker from "../workers/poll/src/index.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/** Trecho de `main()` a partir do 1º await até o fim do arquivo (inclui o catch do isMainModule). */
function afterFirstAwaitInMain(rel: string): string {
  const src = stripComments(readFileSync(resolve(ROOT, rel), "utf8"));
  const mainIdx = src.indexOf("async function main(");
  assert.ok(mainIdx >= 0, `main() não encontrado em ${rel}`);
  const awaitIdx = src.indexOf("await ", mainIdx);
  assert.ok(awaitIdx >= 0, `nenhum await em main() de ${rel}`);
  return src.slice(awaitIdx);
}

describe("#9116 — sem process.exit() depois de fetch (UV_HANDLE_CLOSING)", () => {
  for (const rel of ["scripts/check-worker-cors.ts", "scripts/preflight-poll-dispatch.ts"]) {
    it(`${rel}: nenhum process.exit( após o 1º await de main()`, () => {
      const tail = afterFirstAwaitInMain(rel);
      assert.equal(
        /process\.exit\s*\(/.test(tail),
        false,
        "usar process.exitCode = N (process.exit força shutdown do libuv com sockets keep-alive fechando)",
      );
      assert.match(tail, /process\.exitCode\s*=\s*1/);
    });
  }
});

describe("#9116 — pre-check de reachability sonda rota existente", () => {
  it("usa /robots.txt, não /health", () => {
    assert.equal(reachabilityProbeUrl("https://eia.diar.ia.br"), "https://eia.diar.ia.br/robots.txt");
    assert.equal(reachabilityProbeUrl("https://eia.diar.ia.br/"), "https://eia.diar.ia.br/robots.txt");
  });

  it("o Worker poll responde 200 em /robots.txt e 404 em /health", async () => {
    const env = {} as unknown as Parameters<typeof pollWorker.fetch>[1];
    const robots = await pollWorker.fetch(new Request("https://eia.diar.ia.br/robots.txt"), env);
    assert.equal(robots.status, 200);
    const health = await pollWorker.fetch(new Request("https://eia.diar.ia.br/health"), env);
    assert.equal(health.status, 404);
  });

  it("main() usa reachabilityProbeUrl + describeReachability (não URL hard-coded)", () => {
    const src = stripComments(readFileSync(resolve(ROOT, "scripts/preflight-poll-dispatch.ts"), "utf8"));
    const main = src.slice(src.indexOf("async function main("));
    assert.match(main, /isWorkerReachable\(reachabilityProbeUrl\(/);
    assert.match(main, /describeReachability\(/);
    assert.equal(/\/health/.test(main), false);
  });
});

describe("#9116 — describeReachability", () => {
  const host = "eia.diar.ia.br";

  it("404 direto NÃO é reportado como falha de DNS/DoH", () => {
    const msg = describeReachability(
      { up: false, local_dns_filtered: false, via: "direct", status: 404, error: "HTTP 404" },
      host,
    );
    assert.ok(msg);
    assert.match(msg, /respondeu HTTP 404/);
    assert.doesNotMatch(msg, /DNS \+ DoH|DoH ambos/);
  });

  it("up direto → sem mensagem", () => {
    assert.equal(
      describeReachability({ up: true, local_dns_filtered: false, via: "direct", status: 200 }, host),
      null,
    );
  });

  it("up via DoH com DNS filtrado → info", () => {
    const msg = describeReachability(
      { up: true, local_dns_filtered: true, via: "doh_anycast", status: 200 },
      host,
    );
    assert.match(msg ?? "", /DNS local filtra/);
  });

  it("DNS local + DoH falharam (sem status) → inacessível", () => {
    const msg = describeReachability(
      { up: false, local_dns_filtered: false, via: "doh_anycast", error: "local DNS failed + DoH failed: x" },
      host,
    );
    assert.match(msg ?? "", /Worker inacessível/);
    assert.match(msg ?? "", /Continuando smoke-test/);
  });

  it("HTTP de erro via anycast com DNS filtrado NÃO diz 'DNS e conexão OK'", () => {
    const msg = describeReachability(
      { up: false, local_dns_filtered: true, via: "doh_anycast", status: 503, error: "HTTP 503 via anycast" },
      host,
    );
    assert.match(msg ?? "", /respondeu HTTP 503/);
    assert.match(msg ?? "", /DNS local filtrado/);
    assert.doesNotMatch(msg ?? "", /DNS e conexão OK/);
  });

  it("DNS filtrado + anycast sem resposta (sem status) → aviso de filtro", () => {
    const msg = describeReachability(
      { up: false, local_dns_filtered: true, via: "doh_anycast", error: "local DNS filtered + anycast failed: x" },
      host,
    );
    assert.match(msg ?? "", /DNS local filtrando/);
  });

  it("up após timeout do fetch nativo → info de timeout", () => {
    const msg = describeReachability(
      { up: true, local_dns_filtered: false, abort_timeout: true, via: "doh_anycast", status: 200 },
      host,
    );
    assert.match(msg ?? "", /Timeout no fetch nativo/);
  });

  it("timeout (abort) sem status → mensagem de timeout", () => {
    const msg = describeReachability(
      { up: false, local_dns_filtered: false, abort_timeout: true, via: "doh_anycast", error: "e" },
      host,
    );
    assert.match(msg ?? "", /Timeout de conexão/);
  });
});

describe("#9116 — check-worker-cors explica o 404 esperado", () => {
  it("404 ganha nota explicativa", () => {
    assert.match(probeStatusNote(404) ?? "", /404 esperado/);
  });
  it("outros status não ganham nota", () => {
    assert.equal(probeStatusNote(200), undefined);
    assert.equal(probeStatusNote(500), undefined);
  });
});
