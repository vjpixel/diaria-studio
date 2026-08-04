/**
 * test/vote-unsubstituted-merge-tag-log-4520.test.ts (#4520)
 *
 * O guard `isUnsubstitutedMergeTag` em `workers/poll/src/vote.ts` (#2262)
 * rejeita `?email=` quando ainda contém uma merge tag literal
 * não-substituída (ex: `{{ subscriber.email }}`, `{{poll_token}}`) — mas
 * até o #4520 retornava 400 sem logar NADA, nem `console.log`. É justamente
 * o cenário que `scripts/lint-test-email-link-tracking.ts` (`stage:
 * "delivered"`) tenta pegar fora de banda via HEAD real em `/vote` — o
 * sinal IN-BAND (o próprio Worker recebendo o request de verdade) ficava
 * mudo sobre o mesmo evento.
 *
 * Fix: `console.log` (não `console.error`) com `event:
 * "poll_vote_unsubstituted_merge_tag"` — nível INFO porque merge tag
 * não-substituída é tipicamente sintoma de config/outage do lado da
 * plataforma de envio (test send, preview, atributo ausente), não um bug
 * deste Worker — mesmo nível de `poll_vote_403` (sig ausente/inválido).
 *
 * #4578 (achado desta issue): o retorno deste guard deixou de ser 400 —
 * agora é 302 pro jogo anônimo em `/jogar?...&from=post-web` (o log
 * estruturado abaixo, único motivo pelo qual o 400 tinha valor diagnóstico,
 * PERMANECE 100% intacto no novo caminho). Os testes abaixo foram
 * atualizados pra refletir o status 302 — a cobertura completa do redirect
 * (Location, validação de edition, paridade com o 400 quando edition também
 * é inválida) mora em test/poll-vote-postweb-redirect-4578.test.ts.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import worker from "../workers/poll/src/index.ts";
import { makeTrackedKv } from "./_helpers/make-tracked-kv.ts";
import { makePollEnv } from "./_helpers/make-poll-env.ts";

const EDITION = "260801";

describe("#4520 — guard isUnsubstitutedMergeTag loga poll_vote_unsubstituted_merge_tag", () => {
  it("email com merge tag não-substituída ({{ subscriber.email }}) → 302 (#4578) + console.log estruturado", async () => {
    const kv = makeTrackedKv();
    const env = makePollEnv(kv);

    const originalConsoleLog = console.log;
    const logs: string[] = [];
    console.log = (msg: string) => { logs.push(msg); };
    let res: Response;
    try {
      res = await worker.fetch(
        new Request(
          `https://poll.test/vote?email=${encodeURIComponent("{{ subscriber.email }}")}&edition=${EDITION}&choice=A`,
        ),
        env,
        {} as ExecutionContext,
      );
    } finally {
      console.log = originalConsoleLog;
    }

    // #4578: o guard não rejeita mais com 400 — redireciona (302) pro jogo
    // anônimo em /jogar. Cobertura completa do redirect em
    // test/poll-vote-postweb-redirect-4578.test.ts; aqui só confirma que o
    // log #4520 (o motivo original deste arquivo) sobrevive intacto.
    assert.equal(res.status, 302, "merge tag não-substituída agora redireciona pro /jogar (#4578), não mais 400");
    const parsed = logs.map((l) => { try { return JSON.parse(l); } catch { return null; } });
    const found = parsed.find((p) => p?.event === "poll_vote_unsubstituted_merge_tag");
    assert.ok(
      found,
      `REGRESSÃO #4520: guard não logou nada — antes do fix era 100% silencioso. logs: ${JSON.stringify(logs)}`,
    );
    assert.equal(found.edition, EDITION);
    assert.match(found.raw, /subscriber\.email/, "log deve carregar o literal cru pra diagnosticar QUAL merge tag ficou sem substituir");
  });

  it("outra variante de merge tag ({{poll_token}}) também loga o evento", async () => {
    const kv = makeTrackedKv();
    const env = makePollEnv(kv);

    const originalConsoleLog = console.log;
    const logs: string[] = [];
    console.log = (msg: string) => { logs.push(msg); };
    let res: Response;
    try {
      res = await worker.fetch(
        new Request(`https://poll.test/vote?email=${encodeURIComponent("{{poll_token}}")}&edition=${EDITION}&choice=A`),
        env,
        {} as ExecutionContext,
      );
    } finally {
      console.log = originalConsoleLog;
    }

    assert.equal(res.status, 302, "#4578: redireciona pro /jogar, não mais 400");
    const parsed = logs.map((l) => { try { return JSON.parse(l); } catch { return null; } });
    assert.ok(parsed.some((p) => p?.event === "poll_vote_unsubstituted_merge_tag"));
  });

  it("email válido (sem merge tag) NÃO loga poll_vote_unsubstituted_merge_tag", async () => {
    const kv = makeTrackedKv();
    const env = makePollEnv(kv);

    const originalConsoleLog = console.log;
    const logs: string[] = [];
    console.log = (msg: string) => { logs.push(msg); };
    try {
      await worker.fetch(
        new Request(`https://poll.test/vote?email=leitor@example.com&edition=${EDITION}&choice=A`),
        env,
        {} as ExecutionContext,
      );
    } finally {
      console.log = originalConsoleLog;
    }

    const parsed = logs.map((l) => { try { return JSON.parse(l); } catch { return null; } });
    assert.ok(
      !parsed.some((p) => p?.event === "poll_vote_unsubstituted_merge_tag"),
      "e-mail normal nunca deve disparar o evento de merge tag não-substituída",
    );
  });
});
