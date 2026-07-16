/**
 * test/poll-jogar-archive-3519.test.ts (#3519)
 *
 * Arquivo jogável de pares passados do "É IA?" standalone (EPIC #3514,
 * construído sobre a fundação #3516 + share #3517 + CTA #3518). Cobre:
 *   - `resolveJogarArchiveYear` (pure) — `?year=` explícito vs default (ano
 *     corrente em BRT), formato/range inválido cai no default.
 *   - `renderJogarArchiveHtml` (pure) — agrupamento por mês, hrefs pra
 *     `/jogar?edition=…` (NÃO pro arquivo "assinante" por e-mail), lista
 *     vazia não quebra.
 *   - `GET /jogar/arquivo` — só edições com gabarito fechado aparecem, ano
 *     futuro sem edições ainda 200, edição corrente (hoje) nunca aparece
 *     mesmo se já fechada, ordenação DESC (mais recente primeiro).
 *   - Anti-spoiler: item do arquivo não revela gabarito na PRÓPRIA listagem;
 *     `/jogar?edition=X` de uma edição fechada linkada pelo arquivo preserva
 *     o mesmo anti-gaming do #3516 (não rotula A/B antes do voto).
 *   - "Edição inexistente" tratada graciosamente: `?edition=` de uma edição
 *     nunca publicada não derruba a página (reusa o fallback client-side
 *     onerror já coberto pelo #3516 — nenhuma mudança de contrato aqui).
 *   - Regressão: `/jogar` (par do dia) e o resto do #3516/#3517/#3518
 *     continuam intactos.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  handleJogarArchivePage,
  renderJogarArchiveHtml,
  resolveJogarArchiveYear,
} from "../workers/poll/src/jogar.ts";
import worker, { type Env } from "../workers/poll/src/index.ts";

function makeMapKV(initial: Record<string, string> = {}) {
  const m = new Map<string, string>(Object.entries(initial));
  return {
    async get(key: string) {
      const v = m.get(key);
      return v === undefined ? null : v;
    },
    async getWithMetadata(key: string) {
      const v = m.get(key);
      return { value: v ?? null, metadata: null };
    },
    async put(key: string, value: string) {
      m.set(key, value);
    },
    async delete(key: string) {
      m.delete(key);
    },
    async list({ prefix = "" }: { prefix?: string; cursor?: string } = {}) {
      const keys = [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name }));
      return { keys, list_complete: true, cursor: undefined };
    },
    _map: m,
  };
}

const makeEnv = (seed: Record<string, string> = {}): Env & { POLL: ReturnType<typeof makeMapKV> } => ({
  POLL: makeMapKV(seed),
  POLL_SECRET: "poll-secret",
  ADMIN_SECRET: "admin-secret",
  ALLOWED_ORIGINS: "*",
});

// ── resolveJogarArchiveYear (pure) ──────────────────────────────────────────

describe("resolveJogarArchiveYear (#3519)", () => {
  it("sem ?year= → ano corrente em BRT", () => {
    // 2026-07-16T02:00:00Z ainda é 15/07 em BRT (UTC-3) — ano 2026 mesmo assim
    const now = new Date("2026-07-16T02:00:00Z");
    assert.equal(resolveJogarArchiveYear(null, now), "2026");
  });

  it("?year= válido sobrepõe o default", () => {
    const now = new Date("2026-07-16T12:00:00Z");
    assert.equal(resolveJogarArchiveYear("2025", now), "2025");
  });

  it("?year= malformado (não-4-dígitos, fora de range) cai no default — nunca lança", () => {
    const now = new Date("2026-07-16T12:00:00Z");
    const fallback = resolveJogarArchiveYear(null, now);
    assert.equal(resolveJogarArchiveYear("abc", now), fallback);
    assert.equal(resolveJogarArchiveYear("26", now), fallback);
    assert.equal(resolveJogarArchiveYear("1999", now), fallback);
    assert.equal(resolveJogarArchiveYear("2100", now), fallback);
    assert.equal(resolveJogarArchiveYear("", now), fallback);
  });
});

// ── renderJogarArchiveHtml (pure render) ────────────────────────────────────

describe("renderJogarArchiveHtml (#3519)", () => {
  it("linka cada edição pra /jogar?edition=… (identidade anônima) — NÃO pro arquivo por e-mail", () => {
    const html = renderJogarArchiveHtml(["260615", "260101"], "2026");
    assert.match(html, /href="\/jogar\?edition=260615"/);
    assert.match(html, /href="\/jogar\?edition=260101"/);
    assert.doesNotMatch(html, /\/leaderboard\/2026\/arquivo\//, "não deve reusar o fluxo de e-mail do arquivo assinante");
  });

  it("agrupa por mês (reusa groupEditionsByMonth de leaderboard-routes.ts)", () => {
    const html = renderJogarArchiveHtml(["260615", "260101"], "2026");
    assert.match(html, /class="month-heading"/);
    assert.match(html, /Junho/i);
    assert.match(html, /Janeiro/i);
  });

  it("lista vazia → mensagem amigável, não quebra", () => {
    const html = renderJogarArchiveHtml([], "2026");
    assert.match(html, /Nenhuma edição disponível/i);
  });

  it("link de volta pro par de hoje (/jogar) e pro leaderboard com brand=web", () => {
    const html = renderJogarArchiveHtml(["260101"], "2026");
    assert.match(html, /href="\/jogar">/);
    assert.match(html, /\/leaderboard\?brand=web/);
  });

  it("anti-spoiler: listagem não contém o gabarito (A/B) em lugar nenhum", () => {
    const html = renderJogarArchiveHtml(["260101"], "2026");
    assert.doesNotMatch(html, />A<|>B</, "a listagem não deve expor qual lado é a resposta certa");
  });
});

// ── GET /jogar/arquivo ───────────────────────────────────────────────────────

describe("GET /jogar/arquivo (#3519)", () => {
  it("lista só edições com gabarito fechado, mais recente primeiro", async () => {
    const env = makeEnv({
      "correct:260101": "A",
      "correct:260615": "B",
      "correct:250101": "A", // outro ano — não deve aparecer
    });
    const res = await worker.fetch(new Request("https://poll.test/jogar/arquivo?year=2026"), env);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    const html = await res.text();
    assert.match(html, /edition=260615/);
    assert.match(html, /edition=260101/);
    assert.doesNotMatch(html, /260125|edition=250101/);

    const idx615 = html.indexOf("edition=260615");
    const idx101 = html.indexOf("edition=260101");
    assert.ok(idx615 >= 0 && idx101 >= 0 && idx615 < idx101, "edição mais recente deve vir primeiro");
  });

  it("edição SEM gabarito fechado (poll ainda aberto) não aparece no arquivo", async () => {
    const env = makeEnv({
      "correct:260101": "A", // fechada — aparece
      // 260201 sem correct: — poll ainda em aberto, não deve entrar
    });
    const res = await worker.fetch(new Request("https://poll.test/jogar/arquivo?year=2026"), env);
    const html = await res.text();
    assert.match(html, /edition=260101/);
    assert.doesNotMatch(html, /edition=260201/);
  });

  it("ano sem nenhuma edição fechada → 200, lista vazia", async () => {
    const env = makeEnv();
    const res = await worker.fetch(new Request("https://poll.test/jogar/arquivo?year=2099"), env);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Nenhuma edição disponível/i);
  });

  it("endpoints 404 listam /jogar/arquivo", async () => {
    const env = makeEnv();
    const res = await worker.fetch(new Request("https://poll.test/rota-inexistente"), env);
    const body = await res.json() as { endpoints: string[] };
    assert.ok(body.endpoints.includes("/jogar/arquivo"));
  });
});

// ── Par corrente NÃO aparece no arquivo (critério de aceite #3519) ─────────

describe("Par corrente excluído do arquivo mesmo se já fechado (#3519)", () => {
  it("edição de HOJE com gabarito fechado não aparece na listagem — já é o default de /jogar", async () => {
    const now = new Date();
    // deriva o AAMMDD de "hoje" em BRT do jeito mais simples possível pro teste:
    // usa handleJogarArchivePage com um seed onde 'hoje' tem gabarito e confirma
    // que ele foi filtrado (não aparece), enquanto uma edição passada aparece.
    const { todayAammddBrt } = await import("../workers/poll/src/lib.ts");
    const today = todayAammddBrt(now);
    const yy = today.slice(0, 2);
    const year = `20${yy}`;
    const env = makeEnv({
      [`correct:${today}`]: "A",
      "correct:250101": "A", // outro ano, controle negativo
    });
    const res = await handleJogarArchivePage(new URL(`https://poll.test/jogar/arquivo?year=${year}`), env);
    const html = await res.text();
    assert.doesNotMatch(html, new RegExp(`edition=${today}\\b`), "edição corrente não deve aparecer no arquivo mesmo fechada");
  });
});

// ── Edição inexistente: tratamento gracioso (#3519 critério de aceite) ─────

describe("Edição inexistente via /jogar?edition= é tratada graciosamente (#3519)", () => {
  it("edição nunca publicada (sem gabarito, formato válido) → 200, não crasha, imagens dessa edição (fallback client-side onerror já cobre 'não pronta')", async () => {
    const env = makeEnv(); // KV vazio — 999901 nunca existiu
    const res = await worker.fetch(new Request("https://poll.test/jogar?edition=999901"), env);
    assert.equal(res.status, 200, "página não deve derrubar/500 numa edição inexistente");
    const html = await res.text();
    assert.match(html, /\/img\/img-999901-01-eia-A\.jpg/);
    assert.match(html, /\/img\/img-999901-01-eia-B\.jpg/);
    // Client-side: onerror troca o bloco por aviso "ainda não está pronto" —
    // mesmo mecanismo do #3516, cobrindo qualquer edição sem imagens.
    assert.match(html, /addEventListener\("error", onImgError\)/);
  });

  it("?edition= malformado cai no default (hoje) — comportamento já coberto pelo #3516, preservado aqui", async () => {
    const env = makeEnv();
    const res = await worker.fetch(new Request("https://poll.test/jogar?edition=not-a-date"), env);
    assert.equal(res.status, 200);
  });
});

// ── Anti-spoiler preservado numa edição de arquivo fechada (#3519) ─────────

describe("Anti-spoiler preservado ao jogar uma edição de arquivo já fechada (#3519)", () => {
  it("/jogar?edition=X de edição FECHADA não rotula A/B antes do voto (mesmo anti-gaming do par do dia)", async () => {
    const env = makeEnv({ "correct:260101": "A" });
    const res = await worker.fetch(new Request("https://poll.test/jogar?edition=260101"), env);
    const html = await res.text();
    assert.match(html, /alt="Imagem A"/);
    assert.match(html, /alt="Imagem B"/);
    assert.doesNotMatch(html, /Gerada por IA/);
    assert.doesNotMatch(html, /🤖|📷/);
  });

  it("copy de apoio confirma revelação PÓS-voto (edição fechada) — não antes", async () => {
    const env = makeEnv({ "correct:260101": "A" });
    const res = await worker.fetch(new Request("https://poll.test/jogar?edition=260101"), env);
    const html = await res.text();
    assert.match(html, /vote e veja na hora se acertou/i);
    assert.doesNotMatch(html, /class="msg"|resultado-revelado/i, "resultado não deve aparecer renderizado no HTML inicial");
  });
});

// ── Regressão: resto do #3516/#3517/#3518 intacto ──────────────────────────

describe("Regressão — /jogar (par do dia via ?edition=) segue intacto (#3519 não altera renderJogarPageHtml)", () => {
  it("form de voto continua apontando pro /vote com brand=web, edição resolvida normalmente", async () => {
    const env = makeEnv();
    const res = await worker.fetch(new Request("https://poll.test/jogar?edition=260101"), env);
    const html = await res.text();
    assert.match(html, /action="\/vote"/);
    assert.match(html, /name="brand"\s+value="web"/);
    assert.match(html, /name="edition"\s+value="260101"/);
  });

  // #3589 item 3: a issue exige remover o link "Jogar edições passadas" de
  // TODAS as views web — inclusive o par único (?edition= explícito, que
  // continua vivo só como ponte clarice/#3524, não mais auto-promovido). A
  // rota /jogar/arquivo em si NÃO foi deletada (ver rationale #3589 item 6
  // em jogar.ts — a mesma rota é o destino da ponte clarice→arquivo,
  // #3524/#3578), só deixou de ser linkada a partir de qualquer view web.
  it("link 'Jogar edições passadas' NÃO aparece mais na página do par único (#3589)", async () => {
    const env = makeEnv();
    const res = await worker.fetch(new Request("https://poll.test/jogar?edition=260101"), env);
    const html = await res.text();
    assert.doesNotMatch(html, /Jogar edições passadas/, "par único não deve mais auto-promover o arquivo — #3589");
    assert.doesNotMatch(html, /href="\/jogar\/arquivo"/);
  });
});
