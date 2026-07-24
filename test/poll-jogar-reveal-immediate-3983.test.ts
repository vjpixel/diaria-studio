/**
 * test/poll-jogar-reveal-immediate-3983.test.ts (#3983)
 *
 * Reverte deliberadamente o modelo "Suspense" (#3595): a partir de agora,
 * clicar numa imagem do "É IA?" revela acertou/errou IMEDIATAMENTE — sem
 * esperar a rodada seguinte nem a tela final. #3983 SUPERSEDE #3595 (que por
 * sua vez supersedia o comportamento original pré-#3595) — ver os headers de
 * jogar.ts/vote.ts pro rationale completo de por que a reversão acontece.
 *
 * Duas frentes:
 *
 *   1. Backend (vote.ts): `handleVote` ganha um fast-path — quando chamado
 *      com um `ExecutionContext` de verdade (`ctx.waitUntil` é uma function),
 *      responde o veredito (acertou/errou) assim que `correct:{edition}` é
 *      lido, e adia a contabilidade pesada (dedup DO, guard-keys de
 *      stats/score/month, commit do voteKey, vote-log) pra `ctx.waitUntil()`.
 *      Sem um ctx real (nenhum teste pré-existente passa um — ver guard
 *      `typeof ctx?.waitUntil === "function"`), o caminho síncrono legado
 *      roda intocado — cobertura de zero-regressão fica nos testes
 *      pré-existentes (poll-vote-dedup-2187, poll-streak-3522, etc.), não
 *      duplicada aqui.
 *
 *   2. Frontend (jogar.ts): tanto o par único (`renderJogarPageHtml`) quanto
 *      a sequência (`renderJogarSequencePageHtml`) passam a aguardar a
 *      resposta do `/vote` antes de revelar — nenhum avanço/hide síncrono
 *      antes do fetch resolver. A sequência ganha um bloco de reveal por
 *      rodada (`#seq-round-result`) com destaque visual da imagem correta
 *      (extraído de `.result-images`, a mesma marcação que `votePageHtml`
 *      já usa no `/vote` renderizado direto) e um botão/auto-avanço pra
 *      próxima rodada.
 *
 * Anti-cheat (não-negociável, ver header de jogar.ts): o gabarito NUNCA é
 * embutido no HTML/JS antes do clique — o veredito só existe na RESPOSTA do
 * `/vote`, nunca no markup estático da página.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { handleVote } from "../workers/poll/src/vote.ts";
import { VoteDedup } from "../workers/poll/src/vote-dedup.ts";
import { makeTrackedKv } from "./_helpers/make-tracked-kv.ts";
import { renderJogarPageHtml, renderJogarSequencePageHtml } from "../workers/poll/src/jogar.ts";
import worker, { type Env } from "../workers/poll/src/index.ts";

// ── fixtures ─────────────────────────────────────────────────────────────

/** ExecutionContext fake com waitUntil REAL — coleta as promises agendadas
 * pra que o teste possa aguardá-las explicitamente (simula o Workers
 * runtime real, que executa waitUntil em background após a resposta). */
function makeRealCtx(): { ctx: ExecutionContext; scheduled: Promise<unknown>[] } {
  const scheduled: Promise<unknown>[] = [];
  const ctx = {
    waitUntil(p: Promise<unknown>) {
      scheduled.push(p);
    },
    passThroughOnException() {},
  } as unknown as ExecutionContext;
  return { ctx, scheduled };
}

/** Aguarda TODAS as promises agendadas via ctx.waitUntil (a contabilidade
 * de background rodou por completo). */
async function flush(scheduled: Promise<unknown>[]): Promise<void> {
  await Promise.all(scheduled);
}

function makeEnv(seed: Record<string, string> = {}): Env & { POLL: ReturnType<typeof makeTrackedKv> } {
  return {
    POLL: makeTrackedKv(seed),
    POLL_SECRET: "poll-secret",
    ADMIN_SECRET: "admin-secret",
    ALLOWED_ORIGINS: "*",
  } as Env & { POLL: ReturnType<typeof makeTrackedKv> };
}

/** Mock de VOTE_DEDUP com instâncias reais de VoteDedup (mesma lógica de
 * produção) — reusa o padrão já estabelecido em poll-vote-dedup-2187.test.ts. */
function makeMockVoteDedupNs(): DurableObjectNamespace {
  const doInstances = new Map<string, VoteDedup>();
  return {
    idFromName: (name: string): DurableObjectId => ({ name, toString: () => name }) as unknown as DurableObjectId,
    get: (id: DurableObjectId): DurableObjectStub => {
      const name = id.toString();
      if (!doInstances.has(name)) doInstances.set(name, new VoteDedup(makeMockDoState()));
      const inst = doInstances.get(name)!;
      return {
        fetch: (url: RequestInfo, init?: RequestInit) => inst.fetch(new Request(url as string, init)),
      } as unknown as DurableObjectStub;
    },
  } as unknown as DurableObjectNamespace;
}

// Mock mínimo de DurableObjectState com blockConcurrencyWhile + storage em
// memória (mesmo padrão de test/_helpers/make-mock-do-state.ts, inlined
// aqui pra não acoplar a um helper compartilhado que pode evoluir por outro
// motivo — VoteDedup só precisa de storage.get/put/delete + blockConcurrencyWhile).
function makeMockDoState(): DurableObjectState {
  const storage = new Map<string, unknown>();
  let chain: Promise<unknown> = Promise.resolve();
  return {
    storage: {
      async get(keys: unknown) {
        if (Array.isArray(keys)) {
          const m = new Map<string, unknown>();
          for (const k of keys) if (storage.has(k)) m.set(k, storage.get(k));
          return m;
        }
        return storage.get(keys as string);
      },
      async put(key: string, value: unknown) {
        storage.set(key, value);
      },
      async delete(key: string) {
        storage.delete(key);
      },
    },
    async blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> {
      const run = chain.then(fn, fn);
      chain = run.catch(() => {});
      return run;
    },
  } as unknown as DurableObjectState;
}

const voteUrl = (email: string, edition: string, choice: string, brand?: string): URL => {
  const u = new URL("https://poll.test/vote");
  u.searchParams.set("email", email);
  u.searchParams.set("edition", edition);
  u.searchParams.set("choice", choice);
  if (brand) u.searchParams.set("brand", brand);
  return u;
};

// ── 1. Backend fast-path — reveal imediato ──────────────────────────────────

describe("handleVote fast-path (#3983) — veredito imediato, contabilidade em background", () => {
  it("com ctx real: responde ✅ Acertou! SEM esperar a escrita do voteKey no KV", async () => {
    const env = makeEnv({ "correct:260601": "A" });
    const { ctx, scheduled } = makeRealCtx();
    const res = await handleVote(voteUrl("a@x.com", "260601", "A"), env, "diaria", env, ctx);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /✅ Acertou! Era a imagem gerada por IA\./);

    // A resposta já voltou — a escrita do voteKey ainda NÃO aconteceu (só
    // acontece dentro da promise agendada via ctx.waitUntil).
    assert.equal(await env.POLL.get("vote:260601:a@x.com"), null, "voteKey não deve estar gravado antes do waitUntil resolver");

    await flush(scheduled);

    // Agora sim — a contabilidade de background já rodou.
    const voteRaw = await env.POLL.get("vote:260601:a@x.com");
    assert.ok(voteRaw, "voteKey deve estar gravado depois do waitUntil resolver");
    assert.deepEqual(JSON.parse(voteRaw!).choice, "A");
  });

  it("com ctx real: ❌ Não foi dessa vez — mesma disciplina de latência", async () => {
    const env = makeEnv({ "correct:260601": "A" });
    const { ctx, scheduled } = makeRealCtx();
    const res = await handleVote(voteUrl("b@x.com", "260601", "B"), env, "diaria", env, ctx);
    const html = await res.text();
    assert.match(html, /❌ Não foi dessa vez — era a foto real\./);
    await flush(scheduled);
    const scoreRaw = await env.POLL.get("score:b@x.com");
    assert.ok(scoreRaw, "score deve ter sido gravado em background");
  });

  it("edição SEM gabarito ainda (correctRaw null): mensagem de espera preservada, score ainda incrementa em background", async () => {
    const env = makeEnv(); // sem correct:260601 — poll do dia ainda não fechou
    const { ctx, scheduled } = makeRealCtx();
    const res = await handleVote(voteUrl("c@x.com", "260601", "A"), env, "diaria", env, ctx);
    const html = await res.text();
    assert.match(html, /Voto registrado! O resultado sai na próxima edição\./);
    await flush(scheduled);
    const scoreRaw = await env.POLL.get("score:c@x.com");
    assert.ok(scoreRaw, "total deve incrementar mesmo sem gabarito (mesma semântica do caminho legado)");
    assert.equal(JSON.parse(scoreRaw!).total, 1);
  });

  it("já votado (existingFromKv presente): 'já votou' síncrono, NADA agendado em background", async () => {
    const env = makeEnv({
      "correct:260601": "A",
      "vote:260601:d@x.com": JSON.stringify({ choice: "A", ts: "2026-06-01T00:00:00.000Z", correct: true }),
    });
    const { ctx, scheduled } = makeRealCtx();
    const res = await handleVote(voteUrl("d@x.com", "260601", "B"), env, "diaria", env, ctx);
    const html = await res.text();
    assert.match(html, /Você já votou na edição de/);
    assert.equal(scheduled.length, 0, "voto já conhecido via KV não deve agendar nenhuma contabilidade de background");
  });

  it("?test=1 com ctx real: curto-circuita ANTES de qualquer escrita, nada agendado", async () => {
    const env = makeEnv({ "correct:260601": "A" });
    const { ctx, scheduled } = makeRealCtx();
    const u = voteUrl("e@x.com", "260601", "A");
    u.searchParams.set("test", "1");
    const res = await handleVote(u, env, "diaria", env, ctx);
    const html = await res.text();
    assert.match(html, /\[TEST\]/);
    assert.equal(scheduled.length, 0, "test mode não deve agendar nenhuma contabilidade em background");
    assert.equal(await env.POLL.get("vote:260601:e@x.com"), null);
  });

  it("nickname form / result images / share card (brand=web) continuam presentes na resposta rápida (não dependem da escrita desta rodada)", async () => {
    const env = makeEnv({ "correct:260601": "A" });
    const { ctx } = makeRealCtx();
    // #3976 (achado 260724, PR #3997): "web-user@x.com" NÃO é um token UUID v4
    // válido sob o domínio reservado — o guard `isValidWebToken` (lib.ts,
    // PR #3989/#3976, já mergeado ANTES deste teste existir com essa fixture)
    // rejeita qualquer local-part não-UUID pra brand="web", produzindo a MESMA
    // mensagem "Link inválido — parâmetros ausentes." de um request com
    // parâmetro ausente — por isso o bug ficou invisível até o CI pegar (a
    // asserção abaixo falhava silenciosamente contra a página de ERRO, não a
    // de sucesso). Corrigido pra um pseudo-email que É a forma exata que
    // `anonEmailForToken` (jogar.ts) produz — mesmo padrão de fixture usado
    // em todos os outros testes brand="web" deste arquivo/repo.
    const res = await handleVote(voteUrl("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa@web.eia.diaria.local", "260601", "A", "web"), env, "web", env, ctx);
    const html = await res.text();
    assert.match(html, /class="nick-form"/, "nicknameForm deve aparecer (jogador ainda sem nickname)");
    assert.match(html, /class="result-images"/, "destaque de imagens deve aparecer (gabarito já conhecido)");
    assert.match(html, /id="jogar-share-card"/, "share card deve aparecer (brand=web)");
  });

  it("guard é typeof ctx?.waitUntil === function, não só truthy — {} sem waitUntil real cai no caminho síncrono legado", async () => {
    const env = makeEnv({ "correct:260601": "A" });
    const fakeCtxSemMetodo = {} as ExecutionContext; // mesmo padrão usado em dezenas de testes pré-existentes
    const res = await handleVote(voteUrl("f@x.com", "260601", "A"), env, "diaria", env, fakeCtxSemMetodo);
    assert.equal(res.status, 200);
    // Caminho síncrono legado: a escrita já aconteceu ANTES da resposta voltar.
    const voteRaw = await env.POLL.get("vote:260601:f@x.com");
    assert.ok(voteRaw, "sem waitUntil real, a escrita deve ser síncrona (comportamento pré-#3983 preservado)");
  });

  it("sem ctx nenhum (2 args de handleVote, default): caminho síncrono legado, zero regressão", async () => {
    const env = makeEnv({ "correct:260601": "A" });
    const res = await handleVote(voteUrl("g@x.com", "260601", "A"), env);
    assert.equal(res.status, 200);
    const voteRaw = await env.POLL.get("vote:260601:g@x.com");
    assert.ok(voteRaw, "chamada sem ctx (assinatura antiga) deve continuar 100% síncrona");
  });

  it("falha na contabilidade de background é logada (console.error), não perdida silenciosamente sem visibilidade", async () => {
    const env = makeEnv({ "correct:260601": "A" });
    // Força put() a lançar DEPOIS que a resposta rápida já foi montada —
    // simula uma falha de KV durante a fase de background.
    const originalPut = env.POLL.put.bind(env.POLL);
    let putCalls = 0;
    env.POLL.put = (async (key: string, value: string, opts?: { expirationTtl?: number }) => {
      putCalls++;
      if (key.startsWith("counted:")) throw new Error("kv put falhou (simulado)");
      return originalPut(key, value, opts);
    }) as typeof env.POLL.put;

    const { ctx, scheduled } = makeRealCtx();
    const originalConsoleError = console.error;
    const errors: string[] = [];
    console.error = (msg: string) => { errors.push(msg); };
    try {
      const res = await handleVote(voteUrl("h@x.com", "260601", "A"), env, "diaria", env, ctx);
      assert.equal(res.status, 200, "a resposta ao jogador NUNCA falha por causa de um erro de background");
      await flush(scheduled).catch(() => {});
    } finally {
      console.error = originalConsoleError;
    }
    assert.ok(putCalls > 0, "sanity: o put mockado deve ter sido chamado");
    assert.ok(
      errors.some((e) => e.includes("vote_bookkeeping_failed")),
      "deve logar vote_bookkeeping_failed quando a contabilidade de background falha — " + JSON.stringify(errors),
    );
  });

  it("corrida otimista (cuidado (a) da issue): 2 requests que ambos veem existingFromKv=null respondem o veredito, mas só 1 conta pro score — dedup real acontece em background", async () => {
    const env = makeEnv({ "correct:260601": "A" });
    (env as Env).VOTE_DEDUP = makeMockVoteDedupNs();

    const req1 = makeRealCtx();
    const req2 = makeRealCtx();

    // Ambos chamados ANTES de qualquer background rodar — os dois veem
    // existingFromKv===null (nenhum voteKey ainda gravado) e respondem
    // otimisticamente. Isso é EXATAMENTE a janela de corrida que o DO
    // resolve em background (não na resposta síncrona).
    const res1 = await handleVote(voteUrl("race@x.com", "260601", "A"), env, "diaria", env, req1.ctx);
    const res2 = await handleVote(voteUrl("race@x.com", "260601", "A"), env, "diaria", env, req2.ctx);

    assert.match(await res1.text(), /✅ Acertou!/);
    assert.match(await res2.text(), /✅ Acertou!/, "veredito otimista mostrado a AMBOS — ele realmente acertou aquela rodada (#3983 cuidado (a))");

    // 1º background: autoriza no DO, grava score/stats/voteKey, confirma.
    await flush(req1.scheduled);
    // 2º background: DO já está voted=true (voteKey do 1º) — descartado
    // silenciosamente, sem duplicar o score.
    await flush(req2.scheduled);

    const score = JSON.parse((await env.POLL.get("score:race@x.com"))!);
    assert.equal(score.total, 1, "só 1 dos 2 votos otimistas deve contar pro score (dedup em background evita double-count)");
  });

  // Self-review #3990: os testes acima chamam `handleVote` diretamente com um
  // ctx — cobrem a LÓGICA do fast-path, mas não a FIAÇÃO real de produção
  // (index.ts `fetch(request, env, ctx)` → `routeRequest(..., ctx)` →
  // `handleVote(url, bEnv, brand, env, ctx)`). Este teste fecha esse gap:
  // passa pelo `worker.fetch` exportado de verdade (o mesmo entry point que o
  // Workers runtime chama em produção) com um ExecutionContext real.
  it("fiação de produção: worker.fetch(request, env, ctx) com ctx real também aciona o fast-path (não só handleVote chamado direto)", async () => {
    const env = makeEnv({ "correct:260601": "A" }) as unknown as Env;
    const { ctx, scheduled } = makeRealCtx();
    const res = await worker.fetch(
      new Request(voteUrl("wiring@x.com", "260601", "A").toString()),
      env,
      ctx,
    );
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /✅ Acertou! Era a imagem gerada por IA\./);
    assert.ok(scheduled.length > 0, "fetch() -> routeRequest() -> handleVote() deve ter agendado a contabilidade via ctx.waitUntil()");
    assert.equal(
      await (env as unknown as { POLL: ReturnType<typeof makeTrackedKv> }).POLL.get("vote:260601:wiring@x.com"),
      null,
      "a escrita ainda não deve ter acontecido antes do waitUntil resolver, mesmo passando pelo fetch() real",
    );
    await flush(scheduled);
    const voteRaw = await (env as unknown as { POLL: ReturnType<typeof makeTrackedKv> }).POLL.get("vote:260601:wiring@x.com");
    assert.ok(voteRaw, "voteKey deve estar gravado depois do waitUntil resolver, via o caminho real de produção");
  });
});

// ── 2. Frontend — par único (renderJogarPageHtml) ───────────────────────────

describe("renderJogarPageHtml (#3983) — reveal imediato com feedback de 'conferindo' + destaque de imagem", () => {
  it("indicador 'Conferindo…' presente (hidden por padrão) e revelado/escondido no fluxo de voto", () => {
    const html = renderJogarPageHtml({ edition: "260101", revealed: true });
    assert.match(html, /<p class="checking-msg" id="jogar-checking" hidden>Conferindo…<\/p>/);
    assert.match(html, /var checkingEl = document\.getElementById\("jogar-checking"\);/);
    assert.match(html, /if \(checkingEl\) checkingEl\.hidden = false;/, "revelado no clique");
    assert.match(html, /if \(checkingEl\) checkingEl\.hidden = true;/, "escondido de volta quando o resultado chega");
  });

  it("desabilita os botões de escolha no clique (evita duplo-voto/duplo-clique)", () => {
    const html = renderJogarPageHtml({ edition: "260101", revealed: true });
    assert.match(html, /var choiceButtons = form\.querySelectorAll\('button\[type="submit"\]'\);/);
    assert.match(html, /choiceButtons\[bi\]\.disabled = true;/);
  });

  it("extrai .result-images da resposta do /vote (destaque visual da imagem correta)", () => {
    const html = renderJogarPageHtml({ edition: "260101", revealed: true });
    assert.match(html, /var imagesEl = parsed\.querySelector\("\.result-images"\);/);
    assert.match(html, /if \(imagesEl\) out \+= imagesEl\.outerHTML;/);
  });

  it("CSS de .result-images/.result-image presente (mesmas classes de votePageHtml)", () => {
    const html = renderJogarPageHtml({ edition: "260101", revealed: true });
    assert.match(html, /\.result-images \{ display: flex;/);
    assert.match(html, /\.result-image\.clicked \{/);
  });

  it("regressão: resultSlot/share-card/CTA continuam intactos (#3516/#3517/#3518)", () => {
    const html = renderJogarPageHtml({ edition: "260101", revealed: false });
    assert.match(html, /<div id="jogar-result-slot" hidden><\/div>/);
    assert.match(html, /querySelector\("#jogar-share-card"\)/);
    assert.match(html, /id="jogar-subscribe-cta"/);
  });

  it("anti-cheat: gabarito NUNCA embutido no HTML pré-voto, mesmo com revealed:true", () => {
    const html = renderJogarPageHtml({ edition: "260101", revealed: true });
    assert.doesNotMatch(html, /class="result-images"/, "o bloco .result-images só existe na RESPOSTA do /vote, nunca no markup estático pré-voto");
    assert.doesNotMatch(html, /"correct"\s*:\s*"[AB]"/);
  });
});

// ── 3. Frontend — sequência (renderJogarSequencePageHtml) ───────────────────

describe("renderJogarSequencePageHtml (#3983) — reveal por rodada, reverte o Suspense #3595", () => {
  it("onChoice desabilita os botões e mostra 'conferindo…' ANTES de chamar o /vote", () => {
    const html = renderJogarSequencePageHtml(["260601"]);
    assert.match(html, /function setChoicesDisabled\(disabled\)/);
    assert.match(html, /setChoicesDisabled\(true\);/);
    assert.match(html, /" — conferindo…";/);
  });

  it("renderRoundResult tem botão 'Próxima rodada' — SEM auto-avanço (pedido do editor 260724: só passa clicando)", () => {
    const html = renderJogarSequencePageHtml(["260601"]);
    assert.match(html, /class="seq-next-btn">Próxima rodada →<\/button>/);
    assert.doesNotMatch(html, /setTimeout\(goNext/);
  });

  // Self-review #3990: a 1ª versão desta PR tinha um `setChoicesDisabled(false)`
  // logo antes de `advance()` em goNext() — código morto, porque advance()/
  // renderRound() sempre substitui choicesEl.innerHTML por um par de botões
  // NOVO (já habilitado) ou esconde o play inteiro (showFinal(), última
  // rodada). Removido; este teste agora trava a ausência do no-op em vez de
  // exigi-lo.
  it("goNext esconde o resultado e chama advance() — sem reabilitar botões que a troca de rodada já substitui (no-op removido, self-review #3990)", () => {
    const html = renderJogarSequencePageHtml(["260601"]);
    assert.match(html, /resultEl\.hidden = true;\s*\n\s*resultEl\.innerHTML = "";/);
    assert.doesNotMatch(html, /setChoicesDisabled\(false\)/, "advance()/renderRound() já substitui os botões — reabilitar aqui seria sempre um no-op");
  });

  it("fallback de rede: 2ª falha do /vote cai pra navegação nativa (nunca perde o voto silenciosamente)", () => {
    const html = renderJogarSequencePageHtml(["260601"]);
    assert.match(html, /if \(result === null\) \{/);
    assert.match(html, /window\.location\.href = voteUrl;/);
  });

  it("já votado por corrida (seq-state desatualizado): pula a rodada silenciosamente em vez de mostrar a frase crua 'já votou'", () => {
    // Achado do editor (260724): seq-state pode divergir do estado real do
    // servidor entre o load da sequência e o clique (voto pelo mesmo
    // token/e-mail por outro caminho no intervalo) — /vote responde com a
    // frase "Você já votou..." (sem ✅/❌, `correct` fica null em
    // voteAndReveal) em vez de um resultado revelado. Mostrar essa frase
    // crua no meio do jogo é confuso pro jogador, que não pediu revotar.
    const html = renderJogarSequencePageHtml(["260601"]);
    assert.match(html, /if \(result\.correct === null\) \{/);
    // O bloco de skip precisa chamar advance() e NUNCA renderRoundResult()
    // pra esse ramo — senão a frase "já votou" apareceria no card de resultado.
    assert.match(html, /if \(result\.correct === null\) \{[\s\S]{0,1200}?advance\(\);\s*\n\s*return;\s*\n\s*\}/);
  });

  it("anti-cheat: edições embutidas no script são só AAMMDD (nunca o gabarito A/B) — mesma garantia do #3589, preservada pelo #3983", () => {
    const html = renderJogarSequencePageHtml(["260601", "260602"]);
    assert.match(html, /var editions = \["260601","260602"\]/);
    assert.doesNotMatch(html, /"correct"\s*:\s*"[AB]"/);
  });
});
