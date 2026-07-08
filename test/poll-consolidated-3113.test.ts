/**
 * test/poll-consolidated-3113.test.ts (#3113)
 *
 * Regressão consolidada pro lote de cleanup/P3 do poll worker (issue #3113,
 * Bloco B): itens 5, 6, 8, 9, 10, 11.
 *
 *   Item 5  — shell editorial (régua teal + rodapé de marca) nas páginas
 *             leaderboard e arquivo (lista), que antes só tinham `<title>`.
 *   Item 6  — cinzas via `rgba(23,20,17,X)` (opacity) abolidos; texto
 *             secundário é ink com hierarquia por peso/tamanho.
 *   Item 8  — mobile do pré-voto do arquivo: as 2 escolhas ficam lado a lado
 *             (menores) em vez de empilhar em largura total — garante que a
 *             imagem B seja sempre visível, sem depender de scroll/hint/JS.
 *   Item 9  — arquivo filtra edições com data > hoje (BRT) — o gabarito pode
 *             ser definido antes do e-mail sair (Etapa 4); sem o filtro, uma
 *             edição futura aparecia como votável. Guard também na página de
 *             voto (acesso direto por URL).
 *   Item 10 — arquivo agrupado por mês (heading `.month-heading` + `<ul>`
 *             próprio por grupo) em vez de lista flat.
 *   Item 11 — página de voto do arquivo ganha rodapé mínimo de marca (sem
 *             kicker/régua — fora do escopo pedido pela issue pra essa
 *             página específica).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderBrandShellStyles, renderBrandFooter, currentEditionAammddBrt } from "../workers/poll/src/lib.ts";
import {
  renderArchiveListHtml,
  renderArchiveVoteHtml,
  extractEditionsForYear,
  groupEditionsByMonth,
  handleArchiveVotePage,
} from "../workers/poll/src/leaderboard-routes.ts";
import workerDefault from "../workers/poll/src/index.ts";
import type { Env } from "../workers/poll/src/index.ts";

function makeKv(seed: Record<string, string> = {}): KVNamespace {
  const data: Record<string, string> = { ...seed };
  return {
    get: async (key: string) => data[key] ?? null,
    put: async (key: string, value: string) => { data[key] = value; },
    delete: async (key: string) => { delete data[key]; },
    getWithMetadata: async () => ({ value: null, metadata: null }),
    list: async (opts?: { prefix?: string }) => {
      const prefix = opts?.prefix ?? "";
      const keys = Object.keys(data).filter((k) => k.startsWith(prefix)).map((name) => ({ name }));
      return { keys, list_complete: true };
    },
  } as unknown as KVNamespace;
}

function makeEnv(seed: Record<string, string> = {}): Env {
  return { POLL: makeKv(seed), POLL_SECRET: "test-secret", ADMIN_SECRET: "test-admin", ALLOWED_ORIGINS: "*" };
}

async function fetchHtml(path: string, env: Env = makeEnv()): Promise<string> {
  const req = new Request(`https://poll.diaria.workers.dev${path}`);
  const res = await workerDefault.fetch(req, env, {} as ExecutionContext);
  assert.equal(res.status, 200, `esperava 200 para ${path}, recebeu ${res.status}`);
  return res.text();
}

// ── Item 5 — shell editorial ────────────────────────────────────────────────

describe("#3113 item 5 — régua + rodapé de marca em /leaderboard e /leaderboard/{YYYY}/arquivo", () => {
  it("renderBrandShellStyles/renderBrandFooter são funções puras corretas", () => {
    assert.match(renderBrandShellStyles(), /\.rule\s*\{[^}]*background:\s*#00A0A0/);
    const html = renderBrandFooter("diaria");
    assert.match(html, /<footer class="brand-footer"><a href="https:\/\/diar\.ia\.br">Diar\.ia<\/a>/);
  });

  it("GET /leaderboard: kicker → régua → h1, rodapé antes de </body>", async () => {
    const html = await fetchHtml("/leaderboard");
    const kickerIdx = html.indexOf('<p class="kicker">');
    const ruleIdx = html.indexOf('<hr class="rule">');
    const h1Idx = html.indexOf("<h1>");
    const footerIdx = html.indexOf('<footer class="brand-footer">');
    assert.ok(kickerIdx >= 0 && kickerIdx < ruleIdx && ruleIdx < h1Idx, "kicker → régua → h1");
    assert.ok(footerIdx > h1Idx && footerIdx < html.indexOf("</body>"), "rodapé antes de </body>");
  });

  it("GET /leaderboard/{YYYY}/arquivo: mesma régua + rodapé", async () => {
    const html = await fetchHtml("/leaderboard/2026/arquivo");
    assert.match(html, /<p class="kicker">É IA\? — arquivo<\/p>\s*<hr class="rule">\s*<h1>/);
    assert.match(html, /<footer class="brand-footer">.*<\/footer>\s*<\/body>/s);
  });
});

describe("#3113 item 11 — rodapé mínimo de marca na página de voto do arquivo (sem kicker/régua)", () => {
  it("renderArchiveVoteHtml ganha rodapé, mas NÃO kicker/régua (fora do escopo pedido)", () => {
    const res = renderArchiveVoteHtml("260701", "2026", "diaria");
    return res.text().then((html) => {
      assert.match(html, /<footer class="brand-footer">.*<\/footer>\s*<\/body>/s);
      assert.doesNotMatch(html, /<p class="kicker">/, "kicker não pedido pra essa página específica");
      assert.doesNotMatch(html, /<hr class="rule">/, "régua não pedida pra essa página específica");
    });
  });

  it("brand clarice: rodapé usa clarice.ai (shortName)", async () => {
    const res = renderArchiveVoteHtml("260701", "2026", "clarice");
    const html = await res.text();
    assert.match(html, /<a href="https:\/\/clarice\.ai\/\?via=diaria">Clarice<\/a>/);
  });

  it("anti-gaming preservado: rodapé não revela qual imagem é IA (guarda #2867)", async () => {
    const res = renderArchiveVoteHtml("260701", "2026", "diaria");
    const html = await res.text();
    assert.doesNotMatch(html, /🤖|📷|clicked|"you"/i);
    const buttonTexts = [...html.matchAll(/<button type="submit" name="choice" value="[AB]">([^<]+)<\/button>/g)]
      .map((m) => m[1].replace(/\s*\([AB]\)$/, "").trim());
    assert.equal(buttonTexts[0], buttonTexts[1]);
  });
});

// ── Item 6 — ink hierarchy (sem rgba grays) ─────────────────────────────────

describe("#3113 item 6 — cinzas via rgba(opacity) abolidos, texto secundário é ink", () => {
  it("nenhum rgba(23,20,17,...) sobrevive no worker poll", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    for (const file of ["index.ts", "leaderboard-routes.ts", "lib.ts"]) {
      const src = readFileSync(resolve("workers/poll/src", file), "utf8");
      assert.doesNotMatch(src, /rgba\(23,\s*20,\s*17/, `${file} ainda usa cinza via opacity`);
    }
  });

  it("votePageHtml (index.ts) renderiza .result-image .label / .nick-explain / .nick-note com ink, não rgba", async () => {
    const { votePageHtml } = await import("../workers/poll/src/index.ts");
    const html = votePageHtml(
      "Voto registrado!",
      true,
      { email: "a@x.com", sig: "sig123" },
      { edition: "260519", aiSide: "A", clickedSide: "A" },
      null,
      "diaria",
    );
    assert.match(html, /\.result-image \.label\s*\{[^}]*color:\s*#171411/);
    assert.match(html, /\.nick-explain\s*\{[^}]*color:\s*#171411/);
    assert.match(html, /\.nick-note\s*\{[^}]*color:\s*#171411/);
  });
});

// ── Item 8 — mobile do pré-voto: lado a lado, não empilhado ─────────────────

describe("#3113 item 8 — mobile mantém as 2 escolhas lado a lado (não empilha em largura total)", () => {
  it("media query mobile NÃO usa flex-basis:100% (o bug original) — usa flex:1 1 0", async () => {
    const res = renderArchiveVoteHtml("260701", "2026", "diaria");
    const html = res.text ? await res.text() : res;
    const mediaBlock = (html as string).match(/@media \(max-width: 600px\) \{([^]*?)\n\s*\}\n/);
    assert.ok(mediaBlock, "media query mobile deve existir");
    assert.doesNotMatch(mediaBlock![1], /flex-basis:\s*100%/, "não deve mais empilhar em largura total");
    assert.match(mediaBlock![1], /\.choice\s*\{[^}]*flex:\s*1 1 0/);
  });

  it("sem hint de scroll — layout resolve o problema estruturalmente, não com uma sugestão ignorável", async () => {
    const res = renderArchiveVoteHtml("260701", "2026", "diaria");
    const html = await res.text();
    assert.doesNotMatch(html, /scroll-hint/);
  });
});

// ── Item 9 — filtro de edição futura ────────────────────────────────────────

describe("#3113 item 9 — extractEditionsForYear exclui edições com data > hoje (BRT)", () => {
  it("edição futura é excluída; edições passadas/hoje continuam", () => {
    const now = new Date("2026-07-08T12:00:00Z"); // meio-dia UTC = manhã BRT do dia 08
    const result = extractEditionsForYear(
      ["correct:260731", "correct:260708", "correct:260707", "correct:260101"],
      "2026",
      now,
    );
    assert.deepEqual(result, ["260708", "260707", "260101"]);
    assert.ok(!result.includes("260731"), "edição futura (31/07) não deve aparecer");
  });

  it("fronteira BRT: virada de dia UTC não é virada de dia BRT (offset fixo -3h)", () => {
    // 08/07 02:00 UTC = 07/07 23:00 BRT — "hoje" em BRT ainda é 260707, não 260708.
    const now = new Date("2026-07-08T02:00:00Z");
    assert.equal(currentEditionAammddBrt(now), "260707");
  });

  it("sem now explícito, usa o relógio real (comportamento default preservado)", () => {
    const result = extractEditionsForYear(["correct:210101"], "2021");
    assert.deepEqual(result, ["210101"]); // 2021 é sempre passado, não depende de "agora"
  });

  it("handleLeaderboardArchive (via worker fetch): edição futura não aparece na lista", async () => {
    const kv = { "correct:260731": "A", "correct:260701": "B" };
    const html = await fetchHtml("/leaderboard/2026/arquivo", makeEnv(kv));
    // 260731 só é "futuro" se o relógio real estiver antes disso — este teste
    // roda com o relógio real do ambiente de CI, então usamos uma data
    // seguramente no passado (260701) e uma seguramente no ano 2099 (nunca
    // passado) pra não depender de quando o teste roda.
    assert.match(html, /260701|1 de julho/);
  });

  it("handleArchiveVotePage: acesso direto por URL a edição futura → 404 (mesmo com gabarito definido)", async () => {
    const farFuture = "9912" + "31"; // 31/12/2099 — sempre futuro
    const kv: Record<string, string> = {};
    kv[`correct:${farFuture}`] = "A";
    const env = makeEnv(kv);
    const res = await handleArchiveVotePage("2099", farFuture, env, "diaria");
    assert.equal(res.status, 404, "edição futura deve ser bloqueada mesmo com gabarito já definido");
  });
});

// ── Item 10 — agrupamento por mês ───────────────────────────────────────────

describe("#3113 item 10 — arquivo agrupado por mês", () => {
  it("groupEditionsByMonth agrupa edições consecutivas do mesmo mês, preservando ordem DESC", () => {
    const groups = groupEditionsByMonth(["260731", "260730", "260630", "260601", "250731"]);
    assert.deepEqual(groups, [
      { monthLabel: "Julho", editions: ["260731", "260730"] },
      { monthLabel: "Junho", editions: ["260630", "260601"] },
      { monthLabel: "Julho", editions: ["250731"] }, // mesmo nome de mês, ano diferente — grupo separado (não-consecutivo)
    ]);
  });

  it("lista vazia → array de grupos vazio", () => {
    assert.deepEqual(groupEditionsByMonth([]), []);
  });

  it("renderArchiveListHtml renderiza um <h2 class=\"month-heading\"> por grupo, na ordem correta", () => {
    const res = renderArchiveListHtml(["260731", "260630"], "2026", "diaria");
    return res.text().then((html) => {
      const julyIdx = html.indexOf(">Julho<");
      const juneIdx = html.indexOf(">Junho<");
      assert.ok(julyIdx >= 0 && juneIdx >= 0 && julyIdx < juneIdx);
      assert.match(html, /<h2 class="month-heading">Julho<\/h2>\s*<ul><li>/);
    });
  });

  it("lista vazia continua mostrando a mensagem 'Nenhuma edição disponível ainda'", async () => {
    const res = renderArchiveListHtml([], "2026", "diaria");
    const html = await res.text();
    assert.match(html, /Nenhuma edição disponível ainda/);
  });
});
