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
  buildKvKeyListCommand,
  buildKvBulkDeleteCommand,
  syncKvKeys,
  type KvBulkEntry,
  type KvSyncOps,
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

/**
 * #4381 self-review finding 1 (segunda rodada, pedido do coordenador): a
 * wiring que de fato invoca `wrangler` (`wranglerKvKeyListSubscribers`,
 * `wranglerKvBulkDelete`, e a ORDEM em que `main()` as chama) não tinha
 * cobertura nenhuma além de `diffStaleSubscriberKeys` — só a peça pura. Os
 * dois blocos abaixo fecham essa lacuna SEM nunca invocar `spawnSync`/wrangler
 * de verdade:
 *
 *   1. `buildKvKeyListCommand`/`buildKvBulkDeleteCommand` são funções PURAS
 *      que constroem o command string — testadas diretamente (mesmo padrão
 *      de `buildKvPutCommand` em `scripts/lib/poll-kv.ts`, #1245), provando
 *      que `--prefix "subscriber:"` e `--force` estão no comando sem precisar
 *      mockar nada.
 *   2. `syncKvKeys` recebe um `ops` injetável (`put`/`listSubscribers`/`bulkDelete`)
 *      — os testes substituem os 3 por spies e verificam (a) a ORDEM real de
 *      chamada é put → list → delete, nunca list/delete antes do put ter
 *      retornado, (b) `bulkDelete` recebe EXATAMENTE as chaves stale que
 *      `diffStaleSubscriberKeys` computaria a partir do que `listSubscribers`
 *      devolveu — nem a lista completa, nem a lista de ativos — e (c) se
 *      `put` lança, `listSubscribers`/`bulkDelete` NUNCA são chamados (prova
 *      direta de que uma falha no put não pode ser seguida de uma deleção).
 */
describe("buildKvKeyListCommand / buildKvBulkDeleteCommand (comando puro, #4381 finding 1)", () => {
  it("buildKvKeyListCommand sempre inclui --prefix \"subscriber:\" e --remote, com o namespaceId certo", () => {
    const cmd = buildKvKeyListCommand({ namespaceId: "ns-abc-123" });
    assert.match(cmd, /wrangler kv key list/);
    assert.match(cmd, /--namespace-id=ns-abc-123/);
    assert.match(cmd, /--remote/);
    assert.match(cmd, /--prefix "subscriber:"/, "sem este prefixo, o list enxergaria chaves de cooldown/rate-limit do MESMO namespace");
  });

  it("buildKvBulkDeleteCommand sempre inclui --force e --remote, com o tmpFile e namespaceId certos", () => {
    const cmd = buildKvBulkDeleteCommand({ tmpFile: "/tmp/foo/bulk-delete.json", namespaceId: "ns-xyz-789" });
    assert.match(cmd, /wrangler kv bulk delete/);
    assert.match(cmd, /"\/tmp\/foo\/bulk-delete\.json"/);
    assert.match(cmd, /--namespace-id=ns-xyz-789/);
    assert.match(cmd, /--remote/);
    assert.match(cmd, /--force/, "sem --force, o spawnSync ficaria esperando confirmação interativa que nunca chega (script roda desassistido)");
  });
});

describe("syncKvKeys: ordem put→list→delete + argumentos corretos (#4381 finding 1)", () => {
  /** Constrói um `KvSyncOps` de spy: registra a ORDEM de chamada em `calls` e
   * os argumentos recebidos por cada operação, sem nunca tocar spawnSync. */
  function makeSpyOps(overrides: Partial<{
    existingKeys: string[];
    putThrows: boolean;
  }> = {}) {
    const calls: string[] = [];
    const putArgs: { entries: KvBulkEntry[]; namespaceId: string; accountId: string }[] = [];
    const listArgs: { namespaceId: string; accountId: string }[] = [];
    const deleteArgs: { keys: string[]; namespaceId: string; accountId: string }[] = [];

    const ops: KvSyncOps = {
      put: (entries, namespaceId, accountId) => {
        calls.push("put");
        putArgs.push({ entries, namespaceId, accountId });
        if (overrides.putThrows) throw new Error("wrangler kv bulk put falhou (simulado)");
      },
      listSubscribers: (namespaceId, accountId) => {
        calls.push("list");
        listArgs.push({ namespaceId, accountId });
        return overrides.existingKeys ?? [];
      },
      bulkDelete: (keys, namespaceId, accountId) => {
        calls.push("delete");
        deleteArgs.push({ keys, namespaceId, accountId });
      },
    };
    return { ops, calls, putArgs, listArgs, deleteArgs };
  }

  it("(a) chama put → list → delete NESTA ORDEM, nunca list/delete antes do put", async () => {
    const ativo = await subscriberKvKey("ativo@example.com");
    const cancelou = await subscriberKvKey("cancelou@example.com");
    const entries: KvBulkEntry[] = [{ key: ativo, value: "1" }];
    const { ops, calls } = makeSpyOps({ existingKeys: [ativo, cancelou] });

    syncKvKeys(entries, "ns-1", "acc-1", ops);

    assert.deepEqual(calls, ["put", "list", "delete"], `ordem errada: ${JSON.stringify(calls)}`);
  });

  it("(b) bulkDelete recebe EXATAMENTE as chaves stale computadas por diffStaleSubscriberKeys — nem a lista completa, nem a lista de ativos", async () => {
    const ativo1 = await subscriberKvKey("ativo1@example.com");
    const ativo2 = await subscriberKvKey("ativo2@example.com");
    const cancelou1 = await subscriberKvKey("cancelou1@example.com");
    const cancelou2 = await subscriberKvKey("cancelou2@example.com");
    const entries: KvBulkEntry[] = [
      { key: ativo1, value: "1" },
      { key: ativo2, value: "1" },
    ];
    const existingKeys = [ativo1, cancelou1, ativo2, cancelou2];
    const { ops, deleteArgs } = makeSpyOps({ existingKeys });

    const result = syncKvKeys(entries, "ns-2", "acc-2", ops);

    assert.equal(deleteArgs.length, 1, "bulkDelete deveria ter sido chamado exatamente 1 vez");
    const receivedKeys = new Set(deleteArgs[0].keys);
    assert.deepEqual(receivedKeys, new Set([cancelou1, cancelou2]), "deveria receber só as chaves stale");
    assert.equal(receivedKeys.has(ativo1), false, "NUNCA pode incluir uma chave ainda ativa");
    assert.equal(receivedKeys.has(ativo2), false, "NUNCA pode incluir uma chave ainda ativa");
    // não é a lista completa (4 chaves) nem a lista de ativos (2 chaves) — é
    // exatamente o diff (2 chaves stale).
    assert.notEqual(deleteArgs[0].keys.length, existingKeys.length);
    assert.notEqual(new Set(deleteArgs[0].keys), new Set(entries.map((e) => e.key)));
    assert.deepEqual(result.staleKeys.sort(), [cancelou1, cancelou2].sort());
  });

  it("(c) se put lança, listSubscribers/bulkDelete NUNCA são chamados — falha no put não pode ser seguida de uma deleção", async () => {
    const ativo = await subscriberKvKey("ativo@example.com");
    const entries: KvBulkEntry[] = [{ key: ativo, value: "1" }];
    const { ops, calls } = makeSpyOps({ putThrows: true, existingKeys: ["subscriber:qualquer"] });

    assert.throws(() => syncKvKeys(entries, "ns-3", "acc-3", ops), /wrangler kv bulk put falhou/);
    assert.deepEqual(calls, ["put"], "list/delete não podem ter rodado depois de um put que lançou");
  });

  it("put e listSubscribers recebem o namespaceId/accountId corretos (não trocados/invertidos)", async () => {
    const ativo = await subscriberKvKey("ativo@example.com");
    const entries: KvBulkEntry[] = [{ key: ativo, value: "1" }];
    const { ops, putArgs, listArgs, deleteArgs } = makeSpyOps({ existingKeys: [] });

    syncKvKeys(entries, "namespace-correto", "conta-correta", ops);

    assert.equal(putArgs[0].namespaceId, "namespace-correto");
    assert.equal(putArgs[0].accountId, "conta-correta");
    assert.deepEqual(putArgs[0].entries, entries);
    assert.equal(listArgs[0].namespaceId, "namespace-correto");
    assert.equal(listArgs[0].accountId, "conta-correta");
    assert.equal(deleteArgs[0].namespaceId, "namespace-correto");
    assert.equal(deleteArgs[0].accountId, "conta-correta");
  });

  it("default ops (produção): syncKvKeys sem 4º argumento usa a implementação real — não quebra a assinatura pública", () => {
    // Não executa (chamaria wrangler de verdade) — só garante que a
    // assinatura com default continua válida e não exige `ops` no call site
    // de `main()`.
    assert.equal(syncKvKeys.length, 3, "namespaceId/accountId/entries são obrigatórios; ops é opcional (default param, não conta em .length)");
  });
});
