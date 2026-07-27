/**
 * test/poll-stats-anti-spoiler-4125.test.ts (#4125 item 5)
 *
 * `GET /stats?edition=X` entregava `correct_answer` em claro, sem auth, assim
 * que `close-poll.ts` rodava — spoiler trivial pra quem montasse a URL antes
 * de votar. Decisão do editor (sessão /diaria-develop 260727): omitir
 * `correct_answer` enquanto `edition >= hoje` (BRT), alinhando com o 403 que
 * `handleQuizAnswer` (jogar.ts) já aplica ao mesmo fato.
 *
 * ACHADO DURANTE A IMPLEMENTAÇÃO (não coberto pelo texto da decisão): esse
 * mesmo omitir quebraria o sanity check de `close-poll.ts` (#1367) — ele
 * FECHA a edição no MESMO dia em que ela é publicada (convenção D+1: a
 * edição É o dia do envio), então o `GET /stats` que ele faz logo depois do
 * `POST /admin/correct` sempre consulta `edition === hoje`. Sem um bypass,
 * `close-poll.ts` passaria a abortar com FATAL toda vez, mesmo com o
 * gabarito corretamente gravado.
 *
 * FIX: `handleStats` aceita um `sig` opcional — HMAC-SHA256(ADMIN_SECRET,
 * `stats:{brand}:{edition}`), mesma chave já usada por `handleAdminCorrect`
 * (#3118 item 8). `close-poll.ts` computa esse sig (via `node:crypto`
 * `createHmac`) e o Worker verifica com `hmacVerify` (Web Crypto,
 * `crypto.subtle`) — os testes abaixo cobrem o INTEROP entre as duas
 * implementações, não só o comportamento de omissão.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { handleStats } from "../workers/poll/src/vote.ts";
import { hmacSign, hmacVerify, type Env } from "../workers/poll/src/index.ts";
import { todayAammddBrt } from "../workers/poll/src/lib.ts";
import { makeTrackedKv } from "./_helpers/make-tracked-kv.ts";
import { makePollEnv } from "./_helpers/make-poll-env.ts";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function offsetAammdd(days: number): string {
  return todayAammddBrt(new Date(Date.now() + days * ONE_DAY_MS));
}

/** Mesmo algoritmo que `statsSig` em scripts/close-poll.ts (node:crypto). */
function nodeStatsSig(secret: string, brand: string, edition: string): string {
  return createHmac("sha256", secret).update(`stats:${brand}:${edition}`).digest("hex");
}

describe("close-poll.ts statsSig × Worker hmacVerify — interop node:crypto × Web Crypto (#4125 item 5)", () => {
  it("HMAC-SHA256 de node:crypto (createHmac) é byte-idêntico ao de Web Crypto (hmacSign)", async () => {
    const secret = "shared-secret-interop";
    const message = "stats:diaria:260727";
    const nodeDigest = createHmac("sha256", secret).update(message).digest("hex");
    const webCryptoDigest = await hmacSign(secret, message);
    assert.equal(nodeDigest, webCryptoDigest, "as duas implementações de HMAC-SHA256 devem produzir o MESMO hex — é o que garante que o sig de close-poll.ts (node:crypto) é aceito pelo Worker (Web Crypto)");
  });

  it("sig gerado no estilo close-poll.ts valida via hmacVerify do Worker", async () => {
    const secret = "admin-secret-test";
    const sig = nodeStatsSig(secret, "clarice", "2605-06");
    const valid = await hmacVerify(secret, "stats:clarice:2605-06", sig);
    assert.equal(valid, true);
  });
});

describe("handleStats — omite correct_answer enquanto edition >= hoje, exceto com sig autenticado (#4125 item 5)", () => {
  const ADMIN_SECRET = "test-admin-4125";

  function makeEnv(seed: Record<string, string> = {}): Env & { POLL: ReturnType<typeof makeTrackedKv> } {
    return makePollEnv(makeTrackedKv(seed), { adminSecret: ADMIN_SECRET }) as Env & { POLL: ReturnType<typeof makeTrackedKv> };
  }

  it("edição de HOJE, sem sig: correct_answer omitido (null), mesmo com gabarito gravado", async () => {
    const today = offsetAammdd(0);
    const env = makeEnv({ [`correct:${today}`]: "B", [`stats:${today}`]: JSON.stringify({ total: 10, voted_a: 4, voted_b: 6, correct_count: 6 }) });
    const res = await handleStats(new URL(`https://poll.test/stats?edition=${today}`), env, "diaria", env);
    const body = await res.json() as { correct_answer: string | null; total: number };
    assert.equal(body.correct_answer, null, "REGRESSÃO #4125 item 5: /stats não pode entregar o gabarito do dia sem auth");
    assert.equal(body.total, 10, "totais continuam visíveis — só correct_answer é omitido");
  });

  it("edição de HOJE, com sig VÁLIDO (estilo close-poll.ts): correct_answer revelado — sanity check #1367 não quebra", async () => {
    const today = offsetAammdd(0);
    const env = makeEnv({ [`correct:${today}`]: "B" });
    const sig = nodeStatsSig(ADMIN_SECRET, "diaria", today);
    const res = await handleStats(new URL(`https://poll.test/stats?edition=${today}&sig=${sig}`), env, "diaria", env);
    const body = await res.json() as { correct_answer: string | null };
    assert.equal(body.correct_answer, "B", "close-poll.ts precisa reler o gabarito que acabou de gravar, no MESMO dia");
  });

  it("edição de HOJE, com sig INVÁLIDO: continua omitido (fail-closed, não '' nem crash)", async () => {
    const today = offsetAammdd(0);
    const env = makeEnv({ [`correct:${today}`]: "B" });
    const res = await handleStats(new URL(`https://poll.test/stats?edition=${today}&sig=lixo-nao-hmac`), env, "diaria", env);
    const body = await res.json() as { correct_answer: string | null };
    assert.equal(body.correct_answer, null);
  });

  it("sig assinado pra um brand DIFERENTE não bypassa a omissão (mesma disciplina cross-brand do #3118 item 8)", async () => {
    const today = offsetAammdd(0);
    const env = makeEnv({ [`correct:${today}`]: "B" });
    const sigForClarice = nodeStatsSig(ADMIN_SECRET, "clarice", today); // assinado pro brand ERRADO
    const res = await handleStats(new URL(`https://poll.test/stats?edition=${today}&sig=${sigForClarice}&brand=diaria`), env, "diaria", env);
    const body = await res.json() as { correct_answer: string | null };
    assert.equal(body.correct_answer, null, "sig de outro brand não deve autorizar a leitura");
  });

  it("edição FUTURA, sem sig: também omitido (>= hoje, não só ===)", async () => {
    const tomorrow = offsetAammdd(1);
    const env = makeEnv({ [`correct:${tomorrow}`]: "A" });
    const res = await handleStats(new URL(`https://poll.test/stats?edition=${tomorrow}`), env, "diaria", env);
    const body = await res.json() as { correct_answer: string | null };
    assert.equal(body.correct_answer, null);
  });

  it("edição PASSADA (ontem), sem sig: correct_answer revelado normalmente — comportamento pré-existente preservado", async () => {
    const yesterday = offsetAammdd(-1);
    const env = makeEnv({ [`correct:${yesterday}`]: "A" });
    const res = await handleStats(new URL(`https://poll.test/stats?edition=${yesterday}`), env, "diaria", env);
    const body = await res.json() as { correct_answer: string | null };
    assert.equal(body.correct_answer, "A", "edição já fechada há tempo não deve ser afetada pelo guard novo");
  });

  it("edição em formato de CICLO (mensal, YYMM-MM) NUNCA é omitida — guard só se aplica a AAMMDD", async () => {
    // #4125 item 5 (escopo deliberado): comparação lexical de string contra
    // todayAammddBrt não faz sentido pro formato de ciclo — não há um "hoje"
    // comparável pra YYMM-MM. Usa um ciclo com mês de conteúdo FUTURO (99) só
    // pra provar que mesmo um valor "absurdamente futuro" no formato errado
    // não aciona o guard (o formato, não o valor, decide o escopo).
    const env = makeEnv({ "correct:9905-06": "B" });
    const res = await handleStats(new URL("https://poll.test/stats?edition=9905-06&brand=clarice"), env, "clarice", env);
    const body = await res.json() as { correct_answer: string | null };
    assert.equal(body.correct_answer, "B", "ciclo mensal está fora do escopo desta decisão — nunca omitido por este guard");
  });
});
