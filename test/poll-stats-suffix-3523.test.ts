/**
 * test/poll-stats-suffix-3523.test.ts
 *
 * Regressão para #3523 (sub-issue [AMBAS] do EPIC #3514 "É IA? standalone")
 * — stats pós-voto ("X% acertaram este par").
 *
 * O endpoint `/stats` (handleStats, vote.ts) já agregava votos por edição via
 * `StatsCounter` DO + espelho KV (#2223/#3115/#3261) — esta issue só precisava
 * EXIBIR esse dado já calculado, pós-voto, nos canais que renderizam a
 * mensagem de resultado (`msg`, dentro de `.msg` no HTML de `votePageHtml`).
 *
 * Ponto de reuso central: `jogar.ts` (par do dia + arquivo, #3516/#3519) e
 * `leaderboard-routes.ts` (`renderArchiveVoteHtml`, arquivo "assinante" via
 * e-mail digitado) já extraem/renderizam o `.msg` retornado por `/vote` —
 * standalone via fetch+DOMParser (`jogar.ts`), arquivo "assinante" via
 * navegação de página cheia direto pro `/vote`. O canal e-mail (Beehiiv) TAMBÉM
 * navega direto pro `/vote` e recebe o HTML de `votePageHtml` como resposta.
 * Logo: mudar o `msg` em `handleVote` (vote.ts) é o ÚNICO ponto de mudança
 * necessário pra cobrir os 3 canais — mesmo padrão de reuso que #3522 (streak)
 * já validou (ver header de test/poll-streak-3522.test.ts).
 *
 * Escopo deliberadamente conservador (mesma disciplina do #3522): o quiz
 * relâmpago (#3520, `/jogar/quiz/answer`) NÃO é coberto aqui — é um modo de
 * jogo distinto (rodadas rápidas com placar final agregado do PRÓPRIO
 * jogador), com seu próprio endpoint de resposta por rodada (`data.correct
 * === choice`), não passa por `handleVote`/`.msg`. Adicionar "X% acertaram
 * este par" a CADA rodada do quiz arriscaria poluir um fluxo desenhado pra
 * ser rápido — fora do escopo desta issue, não solicitado no Aceite.
 *
 * Newsletter (revelação "ontem, X% acertaram" na edição seguinte) também não
 * é implementada aqui — exigiria mudança no pipeline de render da Etapa 2
 * (fora do worker), documentada como follow-up no PR.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import workerDefault from "../workers/poll/src/index.ts";
import { renderStatsSuffix, MIN_VOTES_FOR_STATS_DISPLAY } from "../workers/poll/src/lib.ts";
import { makeTrackedKv, readKv } from "./_helpers/make-tracked-kv.ts";
import { makePollEnv } from "./_helpers/make-poll-env.ts";

function voteUrl(email: string, edition: string, choice: "A" | "B", brand?: string): URL {
  const url = new URL("https://poll.diaria.workers.dev/vote");
  url.searchParams.set("email", email);
  url.searchParams.set("edition", edition);
  url.searchParams.set("choice", choice);
  if (brand) url.searchParams.set("brand", brand);
  return url; // sig ausente = merge-tag mode, sem HMAC exigido
}

async function vote(kv: ReturnType<typeof makeTrackedKv>, email: string, edition: string, choice: "A" | "B", brand?: string) {
  const env = makePollEnv(kv);
  return workerDefault.fetch(new Request(voteUrl(email, edition, choice, brand).toString()), env, {} as ExecutionContext);
}

// ── 1. Pure (lib.ts): renderStatsSuffix ─────────────────────────────────────

describe("renderStatsSuffix (#3523)", () => {
  it("stats null → sem sufixo (fail-soft: fetch falhou/indisponível)", () => {
    assert.equal(renderStatsSuffix(null), "");
  });

  it("amostra abaixo do mínimo (total < minVotes) → sem sufixo", () => {
    assert.equal(renderStatsSuffix({ total: 0, correct_count: 0 }), "");
    assert.equal(renderStatsSuffix({ total: 19, correct_count: 19 }), "", "19 < 20 (default MIN_VOTES_FOR_STATS_DISPLAY) — sem sufixo");
  });

  it("amostra no mínimo exato (total === minVotes) → mostra sufixo", () => {
    assert.equal(renderStatsSuffix({ total: 20, correct_count: 15 }), " 75% dos jogadores acertaram este par.");
  });

  it("percentual arredondado (mesmo critério de correct_pct em handleStats)", () => {
    // 2/3 = 66.66...% → arredonda pra 67%.
    assert.equal(renderStatsSuffix({ total: 3, correct_count: 2 }, 1), " 67% dos jogadores acertaram este par.");
  });

  it("100% e 0% são valores válidos (amostra suficiente, extremos não são censurados)", () => {
    assert.equal(renderStatsSuffix({ total: 20, correct_count: 20 }), " 100% dos jogadores acertaram este par.");
    assert.equal(renderStatsSuffix({ total: 20, correct_count: 0 }), " 0% dos jogadores acertaram este par.");
  });

  it("minVotes customizável (parâmetro opcional, default = MIN_VOTES_FOR_STATS_DISPLAY)", () => {
    assert.equal(MIN_VOTES_FOR_STATS_DISPLAY, 20);
    assert.equal(renderStatsSuffix({ total: 5, correct_count: 4 }, 5), " 80% dos jogadores acertaram este par.");
    assert.equal(renderStatsSuffix({ total: 4, correct_count: 4 }, 5), "");
  });
});

// ── 2. Integração via /vote: sufixo pós-voto (canais e-mail/web reusam .msg) ─

describe("stats pós-voto via /vote — sufixo aparece quando gabarito revelado + amostra suficiente (#3523)", () => {
  it("votou certo, amostra cruza o mínimo NESTE voto (19→20) → sufixo aparece com o % correto", async () => {
    const kv = makeTrackedKv({
      "correct:260701": "A",
      // Estado agregado ANTES deste voto: 19 votos, 14 acertos.
      "stats:260701": JSON.stringify({ total: 19, voted_a: 14, voted_b: 5, correct_count: 14 }),
    });

    const res = await vote(kv, "reader-a@x.com", "260701", "A"); // acerta (gabarito é A)
    assert.equal(res.status, 200);
    const html = await res.text();

    // Pós-incremento: total=20, correct_count=15 → 75%.
    assert.match(html, /✅ Acertou! Era a imagem gerada por IA\./);
    assert.match(html, /75% dos jogadores acertaram este par\./, "sufixo deve refletir o total JÁ incluindo o voto atual");

    const stats = JSON.parse(await readKv(kv, "stats:260701"));
    assert.equal(stats.total, 20);
    assert.equal(stats.correct_count, 15);
  });

  it("votou errado (correct===false) — sufixo agregado ainda aparece (independe do próprio acerto)", async () => {
    const kv = makeTrackedKv({
      "correct:260702": "A",
      "stats:260702": JSON.stringify({ total: 19, voted_a: 14, voted_b: 5, correct_count: 14 }),
    });

    const res = await vote(kv, "reader-b@x.com", "260702", "B"); // erra (gabarito é A)
    assert.equal(res.status, 200);
    const html = await res.text();

    assert.match(html, /❌ Não foi dessa vez — era a foto real\./);
    // total=20 (voto errado ainda soma ao total), correct_count continua 14 → 70%.
    assert.match(html, /70% dos jogadores acertaram este par\./);
  });

  it("amostra insuficiente mesmo após o voto (total < 20) → sem sufixo", async () => {
    const kv = makeTrackedKv({
      "correct:260703": "A",
      // Sem stats pré-existente: este é o 1º voto da edição → total=1 pós-voto.
    });

    const res = await vote(kv, "reader-c@x.com", "260703", "A");
    assert.equal(res.status, 200);
    const html = await res.text();

    assert.match(html, /✅ Acertou! Era a imagem gerada por IA\./);
    assert.doesNotMatch(html, /dos jogadores acertaram este par/, "amostra de 1 voto não deve expor percentual (anti-sample-size-lie)");
  });

  it("brand=web (standalone /jogar, par do dia) — mesmo caminho de código, mesmo sufixo", async () => {
    // #3517/#3522 já validaram que o mesmo /vote (brand=web, identidade por
    // token) serve o standalone; aqui confirmamos que o sufixo de #3523 segue
    // o mesmo caminho sem exigir nenhuma mudança em jogar.ts (extração de
    // .msg via DOMParser já é genérica).
    const token = "33333333-3333-4333-8333-333333333333@web.eia.diaria.local";
    const kv = makeTrackedKv({
      // #3600: gabarito é lido CRU (sem prefixo de brand) por handleVote —
      // "web:correct:260704" nunca é escrito em produção (close-poll.ts só
      // grava "correct:{edition}"). Stats seguem branded normalmente.
      "correct:260704": "A",
      "web:stats:260704": JSON.stringify({ total: 25, voted_a: 20, voted_b: 5, correct_count: 20 }),
    });

    const res = await vote(kv, token, "260704", "A", "web");
    assert.equal(res.status, 200);
    const html = await res.text();

    // Pós-incremento: total=26, correct_count=21 → round(21/26*100)=81%.
    assert.match(html, /81% dos jogadores acertaram este par\./);
  });
});

describe("stats pós-voto via /vote — anti-spoiler: gabarito ainda não revelado (#3523)", () => {
  it("correct:{edition} ausente (poll ainda aberto) → NUNCA mostra percentual, mesmo com stats agregados enormes", async () => {
    const kv = makeTrackedKv({
      // Deliberadamente SEM "correct:260705" — gabarito ainda não fechado.
      "valid_editions": JSON.stringify(["260705"]),
      // Amostra gigante hipotética — não deveria importar, o gate é
      // `correct !== null`, nunca o tamanho da amostra.
      "stats:260705": JSON.stringify({ total: 5000, voted_a: 3000, voted_b: 2000, correct_count: 4000 }),
    });

    const res = await vote(kv, "reader-d@x.com", "260705", "A");
    assert.equal(res.status, 200);
    const html = await res.text();

    assert.match(html, /Voto registrado! O resultado sai na próxima edição\./);
    assert.doesNotMatch(html, /% dos jogadores acertaram/, "anti-spoiler: % nunca vaza antes do gabarito ser revelado");
    // Escopado ao conteúdo de `.msg` (não ao HTML inteiro) — o resto da
    // página tem `%` legitimamente em CSS (ex: `width: 100%`), que não é o
    // que este teste quer proteger.
    const msgMatch = html.match(/<p class="msg">([^<]*)<\/p>/);
    assert.ok(msgMatch, "resposta deve conter o elemento .msg");
    assert.doesNotMatch(msgMatch![1], /\d+%/, "nenhum percentual deve aparecer no texto de resultado pré-revelação");
  });
});

describe("stats pós-voto via /vote — fail-soft: falha ao buscar stats nunca derruba o voto (#3523)", () => {
  it("2ª leitura de stats:{edition} (dentro de getSummedEditionStats) lança → voto ainda sucede, sem sufixo", async () => {
    const base = makeTrackedKv({
      "correct:260706": "A",
      "stats:260706": JSON.stringify({ total: 19, voted_a: 14, voted_b: 5, correct_count: 14 }),
    });
    // A 1ª leitura de "stats:260706" acontece dentro do fallback KV RMW de
    // updateStatsCounter (sem STATS_COUNTER DO no ambiente de teste) — precisa
    // suceder normalmente pro voto incrementar. A 2ª leitura (getSummedEditionStats,
    // chamada pra montar o sufixo pós-voto) é a que simulamos falhar aqui —
    // isolando especificamente o caminho NOVO desta issue (#3523), não o
    // increment pré-existente (#2223).
    let statsGetCount = 0;
    const kv = {
      ...base,
      async get(key: string) {
        if (key === "stats:260706") {
          statsGetCount += 1;
          if (statsGetCount >= 2) throw new Error("simulated KV failure (#3523 fail-soft test)");
        }
        return base.get(key);
      },
    };

    const res = await vote(kv as unknown as ReturnType<typeof makeTrackedKv>, "reader-e@x.com", "260706", "A");
    assert.equal(res.status, 200, "voto NUNCA deve falhar por causa do fetch de stats pra exibição");
    const html = await res.text();
    assert.match(html, /✅ Acertou! Era a imagem gerada por IA\./, "mensagem de resultado principal intacta");
    assert.doesNotMatch(html, /dos jogadores acertaram este par/, "sufixo omitido (fail-soft), mas resto do voto funciona normalmente");

    // Voto foi de fato commitado apesar da falha no fetch de exibição.
    const voteRecord = JSON.parse(await readKv(base as unknown as ReturnType<typeof makeTrackedKv>, "vote:260706:reader-e@x.com"));
    assert.equal(voteRecord.choice, "A");
    assert.equal(voteRecord.correct, true);
  });
});
