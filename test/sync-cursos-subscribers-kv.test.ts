/**
 * test/sync-cursos-subscribers-kv.test.ts (#4381)
 *
 * Regressão: `scripts/sync-cursos-subscribers-kv.ts` só fazia `put` das
 * chaves `subscriber:{sha256}` ATIVAS — nunca apagava a chave de quem
 * cancelou desde o sync anterior. Com o sync agendado DIARIAMENTE (#4320),
 * essa defasagem deixou de ser um gap pontual e virou acúmulo permanente
 * (assinante cancelado continua passando pelo gate `?email=`/cookie
 * indefinidamente).
 *
 * `diffStaleSubscriberKeys` é a peça pura testável aqui — é ela que decide
 * QUAIS chaves `wrangler kv bulk delete` apaga de verdade. Cobertura central
 * (#4381, deleção real de produção — tolerância zero a falso-positivo):
 *   (a) chave stale (no KV, fora do conjunto ativo) entra na lista de delete.
 *   (b) chave ainda ativa NUNCA entra na lista de delete.
 *   (c) assinante novo (no conjunto ativo, ainda não no KV) não afeta o diff
 *       — path de `put` já cobre a entrada dele, inalterado por este fix.
 *
 * Este arquivo nunca invoca `wrangler` de verdade (sem `spawnSync`, sem rede,
 * sem credenciais) — só exercita a função pura de diff + os builders de
 * entradas já existentes.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  diffStaleSubscriberKeys,
  buildKvBulkEntries,
  type KvBulkEntry,
} from "../scripts/sync-cursos-subscribers-kv.ts";
import { subscriberKvKey } from "../scripts/lib/shared/subscriber-verify.ts";

describe("diffStaleSubscriberKeys (#4381)", () => {
  it("(a) chave presente no KV mas AUSENTE do conjunto ativo atual entra na lista de delete", async () => {
    const cancelou = await subscriberKvKey("cancelou@example.com");
    const aindaAtivo = await subscriberKvKey("ativo@example.com");
    const existingKeys = [cancelou, aindaAtivo];
    const currentEntries: KvBulkEntry[] = [{ key: aindaAtivo, value: "1" }];

    const stale = diffStaleSubscriberKeys(existingKeys, currentEntries);

    assert.deepEqual(stale, [cancelou]);
  });

  it("(b) chave que continua no conjunto ativo NUNCA aparece na lista de delete, mesmo com múltiplas chaves stale ao redor", async () => {
    const ativo1 = await subscriberKvKey("ativo1@example.com");
    const ativo2 = await subscriberKvKey("ativo2@example.com");
    const cancelou1 = await subscriberKvKey("cancelou1@example.com");
    const cancelou2 = await subscriberKvKey("cancelou2@example.com");
    const existingKeys = [ativo1, cancelou1, ativo2, cancelou2];
    const currentEntries: KvBulkEntry[] = [
      { key: ativo1, value: "1" },
      { key: ativo2, value: "1" },
    ];

    const stale = diffStaleSubscriberKeys(existingKeys, currentEntries);

    assert.equal(stale.includes(ativo1), false, "assinante ativo 1 nunca pode entrar na lista de delete");
    assert.equal(stale.includes(ativo2), false, "assinante ativo 2 nunca pode entrar na lista de delete");
    assert.deepEqual(new Set(stale), new Set([cancelou1, cancelou2]));
  });

  it("(c) assinante NOVO (no conjunto ativo, ainda não sincronizado no KV) não aparece na lista de delete nem é afetado pelo diff", async () => {
    const jaNoKv = await subscriberKvKey("ja-no-kv@example.com");
    const novoAssinante = await subscriberKvKey("novo-assinante@example.com");
    // KV só tem quem já estava lá antes — o novo assinante ainda não foi
    // sincronizado (é exatamente o caso que o `put` cobre, sem relação com
    // este diff).
    const existingKeys = [jaNoKv];
    const currentEntries: KvBulkEntry[] = [
      { key: jaNoKv, value: "1" },
      { key: novoAssinante, value: "1" },
    ];

    const stale = diffStaleSubscriberKeys(existingKeys, currentEntries);

    assert.deepEqual(stale, [], "nada deveria ser apagado: o único existente ainda está ativo, o novo nem está no KV ainda");
  });

  it("nenhuma chave stale quando o conjunto ativo é IDÊNTICO ao KV (sync sem mudança nenhuma)", async () => {
    const a = await subscriberKvKey("a@example.com");
    const b = await subscriberKvKey("b@example.com");
    const existingKeys = [a, b];
    const currentEntries: KvBulkEntry[] = [
      { key: a, value: "1" },
      { key: b, value: "1" },
    ];

    assert.deepEqual(diffStaleSubscriberKeys(existingKeys, currentEntries), []);
  });

  it("todas as chaves são stale quando o conjunto ativo fica vazio (ex: API da Beehiiv devolveu lista vazia por engano)", async () => {
    // Cenário de maior risco de dano: se `fetchActiveSubscriberEmails` algum
    // dia devolver [] por um bug/API quebrada, o diff apagaria TODO o KV.
    // Este teste documenta o comportamento atual (sem guard adicional) — não
    // é uma afirmação de que é seguro, é um registro do que a função faz hoje
    // pra qualquer mudança futura ter que decidir conscientemente se quer
    // adicionar um guard de "não esvaziar tudo de uma vez".
    const a = await subscriberKvKey("a@example.com");
    const b = await subscriberKvKey("b@example.com");
    const existingKeys = [a, b];
    const currentEntries: KvBulkEntry[] = [];

    assert.deepEqual(new Set(diffStaleSubscriberKeys(existingKeys, currentEntries)), new Set([a, b]));
  });

  it("defesa em profundidade: chave sem o prefixo subscriber: nunca aparece na lista de delete, mesmo que apareça em existingKeys por engano", () => {
    // #4381: o namespace CURSOS_SUBSCRIBERS também guarda chaves de cooldown
    // (`cooldown:cursos-pending-promo:*`, gate.ts #4387/#4390) e rate-limit
    // (`rl:cursos-gate:*`, gate.ts). O caller (main()) já lista só com
    // `--prefix "subscriber:"` — mas esta função nunca deve confiar SÓ nisso.
    const cooldownKey = "cooldown:cursos-pending-promo:deadbeef";
    const rateLimitKey = "rl:cursos-gate:1.2.3.4";
    const staleSubscriberKey = "subscriber:cafebabe";
    const existingKeys = [cooldownKey, rateLimitKey, staleSubscriberKey];
    const currentEntries: KvBulkEntry[] = [];

    const stale = diffStaleSubscriberKeys(existingKeys, currentEntries);

    assert.deepEqual(stale, [staleSubscriberKey]);
    assert.equal(stale.includes(cooldownKey), false, "chave de cooldown do gate nunca pode ser apagada por este script");
    assert.equal(stale.includes(rateLimitKey), false, "chave de rate-limit do gate nunca pode ser apagada por este script");
  });
});

describe("buildKvBulkEntries (regressão de baseline, não tocado pelo #4381)", () => {
  it("continua produzindo 1 entrada por e-mail ativo — comportamento do `put` é inalterado por este fix", async () => {
    const entries = await buildKvBulkEntries(["um@example.com", "dois@example.com"]);
    assert.equal(entries.length, 2);
    const expectedKeys = new Set([
      await subscriberKvKey("um@example.com"),
      await subscriberKvKey("dois@example.com"),
    ]);
    assert.deepEqual(new Set(entries.map((e) => e.key)), expectedKeys);
  });
});
