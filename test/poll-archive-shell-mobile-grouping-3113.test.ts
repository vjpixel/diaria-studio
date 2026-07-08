/**
 * test/poll-archive-shell-mobile-grouping-3113.test.ts (#3113)
 *
 * Regressão para 5 achados do jogo "É IA?" (Bloco B da issue #3113):
 *
 *   Item 5 — shell editorial ausente (régua teal + rodapé de marca) no
 *   leaderboard (`renderLeaderboardHtml`) e no arquivo (`renderArchiveListHtml`)
 *   — antes, só o `<title>` carregava identidade.
 *
 *   Item 8 — no mobile do pré-voto do arquivo (`renderArchiveVoteHtml`), o
 *   layout anterior empilhava as 2 escolhas em largura total, permitindo
 *   votar em A sem nunca rolar até ver a imagem B. Fix: hint textual real
 *   (não CSS ::after) entre as 2 escolhas, visível só no recorte mobile —
 *   preserva o empilhamento full-width (decisão histórica #1779: imagens
 *   grandes e legíveis) em vez de encolher as 2 lado a lado.
 *
 *   Item 9 — `extractEditionsForYear` não filtrava por data: uma edição com
 *   gabarito já definido mas cuja data ainda não chegou aparecia como
 *   votável no arquivo antes do e-mail sair.
 *
 *   Item 9 (self-review — gap real encontrado por review independente): o
 *   filtro acima só escondia a edição futura da LISTAGEM
 *   (`renderArchiveListHtml`) — a página de voto (`handleArchiveVotePage`) e
 *   o endpoint `/vote` direto (`handleVote`, sem passar pela listagem)
 *   continuavam aceitando e PONTUANDO voto numa edição futura, já que
 *   `correct:{edition}` pode existir antes do e-mail sair. Fix: mesmo gate
 *   (`edition > todayAammddBrt(now)`) aplicado também nesses 2 pontos —
 *   `todayAammddBrt` exportada de `leaderboard-routes.ts` especificamente
 *   pra isso.
 *
 *   Item 10 — `renderArchiveListHtml` renderizava lista flat sem
 *   agrupamento (>200 itens/ano sem estrutura). Fix: `groupEditionsByMonth`.
 *
 *   Item 11 — rodapé de marca ausente na página de voto do arquivo — o
 *   corpo não tinha identidade nenhuma (nem kicker, nem régua, nem rodapé).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderBrandShellStyles, renderBrandFooter } from "../workers/poll/src/lib.ts";
import {
  extractEditionsForYear,
  groupEditionsByMonth,
  renderArchiveListHtml,
  renderArchiveVoteHtml,
  handleArchiveVotePage,
} from "../workers/poll/src/leaderboard-routes.ts";
import { handleVote } from "../workers/poll/src/vote.ts";
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

describe("#3113 item 5/11 — renderBrandShellStyles / renderBrandFooter (pure)", () => {
  it("renderBrandShellStyles inclui régua teal e borda do rodapé", () => {
    const css = renderBrandShellStyles();
    assert.match(css, /\.rule\s*\{[^}]*background:\s*#00A0A0/);
    assert.match(css, /footer\.brand-footer\s*\{[^}]*border-top:\s*1px solid #EBE5D0/);
  });

  it("renderBrandFooter(diaria) linka pro diar.ia.br", () => {
    assert.match(renderBrandFooter("diaria"), /<footer class="brand-footer"><a href="https:\/\/diar\.ia\.br">Diar\.ia<\/a>/);
  });

  it("renderBrandFooter(clarice) linka pro clarice.ai (shortName, não 'Clarice News')", () => {
    const html = renderBrandFooter("clarice");
    assert.match(html, /<a href="https:\/\/clarice\.ai\/\?via=diaria">Clarice<\/a>/);
    assert.doesNotMatch(html, />Clarice News</);
  });
});

describe("#3113 item 5 — /leaderboard e /leaderboard/{YYYY}/arquivo ganham régua + rodapé", () => {
  it("GET /leaderboard: régua entre kicker e h1, rodapé antes de </body>", async () => {
    const html = await fetchHtml("/leaderboard");
    const kickerIdx = html.indexOf('<p class="kicker">');
    const ruleIdx = html.indexOf('<hr class="rule">');
    const h1Idx = html.indexOf("<h1>");
    const footerIdx = html.indexOf('<footer class="brand-footer">');
    assert.ok(kickerIdx >= 0 && ruleIdx >= 0 && h1Idx >= 0 && kickerIdx < ruleIdx && ruleIdx < h1Idx);
    assert.ok(footerIdx >= 0 && footerIdx < html.indexOf("</body>"));
  });

  it("GET /leaderboard/{YYYY}/arquivo: mesma régua + rodapé", async () => {
    const html = await fetchHtml("/leaderboard/2026/arquivo");
    assert.match(html, /<p class="kicker">É IA\? — arquivo<\/p>\s*<hr class="rule">\s*<h1>/);
    assert.match(html, /<footer class="brand-footer">.*<\/footer>\s*<\/body>/s);
  });
});

describe("#3113 item 11 — renderArchiveVoteHtml ganha kicker + régua + rodapé", () => {
  it("antes só tinha <title> como identidade — agora tem kicker, régua e rodapé", async () => {
    const res = renderArchiveVoteHtml("260701", "2026", "diaria");
    const html = await res.text();
    const kickerIdx = html.indexOf('<p class="kicker">É IA?</p>');
    const ruleIdx = html.indexOf('<hr class="rule">');
    const h1Idx = html.indexOf("<h1>Qual imagem");
    assert.ok(kickerIdx >= 0 && ruleIdx >= 0 && h1Idx >= 0 && kickerIdx < ruleIdx && ruleIdx < h1Idx);
    assert.match(html, /<footer class="brand-footer">.*<\/footer>\s*<\/body>/s);
  });

  it("anti-gaming preservado: novos elementos não revelam qual imagem é IA (#2867)", async () => {
    const res = renderArchiveVoteHtml("260701", "2026", "diaria");
    const html = await res.text();
    assert.doesNotMatch(html, /🤖/);
    assert.doesNotMatch(html, /📷/);
    assert.doesNotMatch(html, /clicked|"you"/i);
  });
});

describe("#3113 item 8 — hint de scroll mobile (preserva empilhamento full-width, #1779)", () => {
  it("hint textual real entre as 2 escolhas, escondido por padrão", async () => {
    const res = renderArchiveVoteHtml("260701", "2026", "diaria");
    const html = await res.text();
    const choiceAIdx = html.indexOf('name="choice" value="A"');
    const hintIdx = html.indexOf('class="scroll-hint"');
    const choiceBIdx = html.indexOf('name="choice" value="B"');
    assert.ok(choiceAIdx >= 0 && hintIdx >= 0 && choiceBIdx >= 0 && choiceAIdx < hintIdx && hintIdx < choiceBIdx);
    assert.match(html, /\.scroll-hint\s*\{\s*display:\s*none;\s*\}/);
  });

  it("mobile continua empilhando full-width (decisão #1779 preservada — não encolhe as imagens)", async () => {
    const res = renderArchiveVoteHtml("260701", "2026", "diaria");
    const html = await res.text();
    const mediaBlock = html.slice(html.indexOf("@media (max-width: 600px)"), html.indexOf("</style>"));
    assert.match(mediaBlock, /\.choice\s*\{\s*flex-basis:\s*100%;\s*max-width:\s*100%;\s*\}/);
    assert.match(mediaBlock, /\.scroll-hint\s*\{[^}]*display:\s*block/);
  });
});

describe("extractEditionsForYear — filtra edições futuras (#3113 item 9)", () => {
  it("exclui edição com data > hoje (BRT), mesmo com gabarito definido", () => {
    const now = new Date("2026-06-15T12:00:00Z");
    const editions = extractEditionsForYear(["correct:260610", "correct:260620", "correct:260601"], "2026", now);
    assert.deepEqual(editions, ["260610", "260601"]);
  });

  it("inclui a edição de HOJE", () => {
    const now = new Date("2026-06-15T12:00:00Z");
    assert.deepEqual(extractEditionsForYear(["correct:260615"], "2026", now), ["260615"]);
  });

  it("sem `now` explícito, usa a data real — smoke test", () => {
    assert.deepEqual(extractEditionsForYear(["correct:991231"], "2099"), []);
  });

  it("considera o offset BRT na fronteira da meia-noite", () => {
    const now = new Date("2026-06-16T02:00:00Z"); // == 2026-06-15T23:00 BRT
    assert.deepEqual(extractEditionsForYear(["correct:260615", "correct:260616"], "2026", now), ["260615"]);
  });
});

describe("#3113 item 9 (self-review) — handleArchiveVotePage também bloqueia edição futura", () => {
  it("edição futura com gabarito definido → 404, não 200 (antes só a LISTAGEM escondia)", async () => {
    const env = makeEnv({ "correct:991231": "A" }); // ano 2099, bem no futuro
    const res = await handleArchiveVotePage("2099", "991231", env, "diaria");
    assert.equal(res.status, 404, "página de voto deve bloquear edição futura, não só a listagem");
  });

  it("edição de HOJE ou passada com gabarito definido continua 200 (não regride o caso normal)", async () => {
    const env = makeEnv({ "correct:260101": "A" }); // ano passado — nunca é "futuro"
    const res = await handleArchiveVotePage("2026", "260101", env, "diaria");
    assert.equal(res.status, 200);
  });
});

describe("#3113 item 9 (self-review) — handleVote bloqueia edição futura mesmo via /vote direto", () => {
  it("edição futura com gabarito já definido → 410, mesmo pulando a página de arquivo (bypass direto)", async () => {
    const env = makeEnv({ "correct:991231": "A" });
    const url = new URL("https://poll.diaria.workers.dev/vote");
    url.searchParams.set("email", "future-voter@x.com");
    url.searchParams.set("edition", "991231");
    url.searchParams.set("choice", "A");
    const res = await handleVote(url, env, "diaria");
    assert.equal(res.status, 410, "voto em edição futura deve ser rejeitado mesmo direto no /vote");
    const html = await res.text();
    assert.match(html, /não aceita mais votos/i);
    const voteRaw = await env.POLL.get("vote:991231:future-voter@x.com");
    assert.equal(voteRaw, null, "voto NÃO deve ser gravado no KV");
  });

  it("edição passada com gabarito definido continua aceita (não regride o arquivo retroativo, #2867)", async () => {
    const env = makeEnv({ "correct:260101": "A" });
    const url = new URL("https://poll.diaria.workers.dev/vote");
    url.searchParams.set("email", "past-voter@x.com");
    url.searchParams.set("edition", "260101");
    url.searchParams.set("choice", "A");
    const res = await handleVote(url, env, "diaria");
    assert.equal(res.status, 200);
    const voteRaw = await env.POLL.get("vote:260101:past-voter@x.com");
    assert.ok(voteRaw !== null, "voto retroativo em edição PASSADA continua sendo gravado normalmente");
  });

  it("formato de ciclo mensal Clarice (YYMM-MM) não é afetado pelo gate de data (não é AAMMDD)", async () => {
    // Chamando handleVote diretamente (sem o wrapper brandedEnv do dispatcher
    // em index.ts) — chaves NÃO prefixadas por brand aqui de propósito, só
    // testando que o novo gate (regex /^\d{6}$/) não trata "2605-06" como
    // AAMMDD comparável, independente de namespacing por brand.
    const env = makeEnv({ "correct:2605-06": "A", "valid_editions": JSON.stringify(["2605-06"]) });
    const url = new URL("https://poll.diaria.workers.dev/vote");
    url.searchParams.set("email", "clarice-voter@x.com");
    url.searchParams.set("edition", "2605-06");
    url.searchParams.set("choice", "A");
    const res = await handleVote(url, env, "clarice");
    assert.equal(res.status, 200, "ciclo mensal Clarice não deve ser bloqueado pelo gate de data diário");
  });
});

describe("groupEditionsByMonth (#3113 item 10)", () => {
  it("agrupa edições consecutivas do mesmo mês", () => {
    const groups = groupEditionsByMonth(["260620", "260615", "260601"]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].monthLabel, "Junho");
  });

  it("cria um grupo por mês, preservando ordem DESC", () => {
    const groups = groupEditionsByMonth(["260715", "260701", "260620", "260601"]);
    assert.deepEqual(groups.map((g) => g.monthLabel), ["Julho", "Junho"]);
  });

  it("lista vazia → nenhum grupo", () => {
    assert.deepEqual(groupEditionsByMonth([]), []);
  });
});

describe("renderArchiveListHtml — agrupamento por mês (#3113 item 10)", () => {
  it("renderiza heading .month-heading por mês, mais recente primeiro", async () => {
    const res = renderArchiveListHtml(["260715", "260701", "260620"], "2026", "diaria");
    const html = await res.text();
    assert.match(html, /<h2 class="month-heading">Julho<\/h2>\s*<ul>/);
    assert.match(html, /<h2 class="month-heading">Junho<\/h2>\s*<ul>/);
    assert.ok(html.indexOf(">Julho<") < html.indexOf(">Junho<"));
  });

  it("lista vazia → fallback, sem heading de mês", async () => {
    const res = renderArchiveListHtml([], "2026", "diaria");
    const html = await res.text();
    assert.match(html, /Nenhuma edição disponível ainda\./);
    const body = html.slice(html.indexOf("<body>"));
    assert.doesNotMatch(body, /<h2 class="month-heading">/);
  });
});
