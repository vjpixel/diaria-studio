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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter, dirname } from "node:path";

import {
  diffStaleSubscriberKeys,
  buildKvBulkEntries,
  buildKvKeyListCommand,
  buildKvBulkDeleteCommand,
  syncKvKeys,
  wranglerSpawnEnv,
  readKvSyncState,
  writeKvSyncState,
  evaluateKvEmptyGuard,
  fetchActiveSubscriberEmailsForBackend,
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
 *      — os testes substituem os 3 por spies e verificam a ORDEM real de
 *      chamada e os argumentos recebidos por cada operação.
 *
 * #4442 mudou a ORDEM: antes era put→list→delete (o put recebia SEMPRE o
 * conjunto completo); agora é list→put(só as novas)→delete — o `list`
 * precisa rodar ANTES pra saber quais chaves já existem e podar o `put`.
 * A garantia crítica do #4381 (put SEMPRE antes de delete; put que lança
 * impede o delete) foi preservada — só migrou de posição relativa ao list,
 * nunca ao delete.
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

describe("syncKvKeys: ordem list→put→delete + write-amplification (#4442, era put→list→delete no #4381)", () => {
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

  it("(a) com chave NOVA: chama list → put → delete NESTA ORDEM (#4442 — list agora roda ANTES do put, pra saber o que é novo)", async () => {
    const ativo = await subscriberKvKey("ativo@example.com");
    const novo = await subscriberKvKey("novo@example.com");
    const cancelou = await subscriberKvKey("cancelou@example.com");
    const entries: KvBulkEntry[] = [{ key: ativo, value: "1" }, { key: novo, value: "1" }];
    // `ativo` já está no KV; `novo` não — só `novo` deveria disparar o put.
    const { ops, calls } = makeSpyOps({ existingKeys: [ativo, cancelou] });

    syncKvKeys(entries, "ns-1", "acc-1", ops);

    assert.deepEqual(calls, ["list", "put", "delete"], `ordem errada: ${JSON.stringify(calls)}`);
  });

  it("#4442 — write-amplification: ops.put recebe SÓ as chaves ausentes do KV (base com 551 existentes + 3 novas ⇒ put com 3, não com 554)", async () => {
    // Simula a escala real da issue: 551 assinantes já sincronizados, 3 novos
    // desde o último sync.
    const existingEmails = Array.from({ length: 551 }, (_, i) => `existente${i}@example.com`);
    const existingKeys = await Promise.all(existingEmails.map((e) => subscriberKvKey(e)));
    const newEmails = ["novo1@example.com", "novo2@example.com", "novo3@example.com"];
    const newKeys = await Promise.all(newEmails.map((e) => subscriberKvKey(e)));

    const entries: KvBulkEntry[] = [...existingKeys, ...newKeys].map((key) => ({ key, value: "1" }));
    const { ops, putArgs } = makeSpyOps({ existingKeys });

    const result = syncKvKeys(entries, "ns-scale", "acc-scale", ops);

    assert.equal(putArgs.length, 1, "put deveria ter sido chamado exatamente 1 vez");
    assert.equal(putArgs[0].entries.length, 3, "put deveria receber só as 3 chaves NOVAS, não as 554 do conjunto ativo inteiro");
    assert.deepEqual(new Set(putArgs[0].entries.map((e) => e.key)), new Set(newKeys));
    assert.deepEqual(result.addedKeys.sort(), newKeys.sort());
  });

  it("#4442 — ops.put NÃO é chamado quando não há chave nova (dia comum: 0 assinantes novos)", async () => {
    const ativo1 = await subscriberKvKey("ativo1@example.com");
    const ativo2 = await subscriberKvKey("ativo2@example.com");
    const entries: KvBulkEntry[] = [{ key: ativo1, value: "1" }, { key: ativo2, value: "1" }];
    // TODAS as entradas já existem no KV — nada novo pra gravar.
    const { ops, calls, putArgs } = makeSpyOps({ existingKeys: [ativo1, ativo2] });

    const result = syncKvKeys(entries, "ns-noop", "acc-noop", ops);

    assert.equal(putArgs.length, 0, "put não deveria ter sido chamado — nenhuma chave nova");
    assert.deepEqual(calls, ["list", "delete"], "sem chave nova, a ordem observável vira list → delete direto (put pulado)");
    assert.deepEqual(result.addedKeys, []);
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
    // exatamente o diff (2 chaves stale). diffStaleSubscriberKeys segue
    // deletando quem cancelou — nenhuma regressão no lado da deleção (#4442
    // critério de aceite).
    assert.notEqual(deleteArgs[0].keys.length, existingKeys.length);
    assert.notEqual(new Set(deleteArgs[0].keys), new Set(entries.map((e) => e.key)));
    assert.deepEqual(result.staleKeys.sort(), [cancelou1, cancelou2].sort());
  });

  it("(c) se put lança (havia chave nova pra gravar), bulkDelete NUNCA é chamado — falha no put não pode ser seguida de uma deleção", async () => {
    const novo = await subscriberKvKey("novo@example.com");
    const entries: KvBulkEntry[] = [{ key: novo, value: "1" }];
    // `novo` não está em existingKeys — put SERÁ chamado (e vai lançar).
    const { ops, calls } = makeSpyOps({ putThrows: true, existingKeys: ["subscriber:qualquer"] });

    assert.throws(() => syncKvKeys(entries, "ns-3", "acc-3", ops), /wrangler kv bulk put falhou/);
    // list já rodou (precisa rodar ANTES pra saber que `novo` é novo) — a
    // garantia do #4381 preservada é sobre DELETE, não sobre LIST: bulkDelete
    // nunca pode rodar depois de um put que lançou.
    assert.deepEqual(calls, ["list", "put"], "bulkDelete não pode ter rodado depois de um put que lançou");
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

describe("wranglerSpawnEnv (#7338 — reprodução ao vivo em helios 05/09/2026)", () => {
  it("prepende dirname(process.execPath) ao PATH herdado — npx/wrangler resolvem o Node deste processo, não o do PATH do caller", () => {
    const env = wranglerSpawnEnv("conta-123");
    const nodeBinDir = env.PATH?.split(delimiter)[0];
    assert.equal(nodeBinDir, dirname(process.execPath));
  });

  it("preserva o resto do PATH herdado atrás do prefixo", () => {
    const originalPath = process.env.PATH;
    try {
      process.env.PATH = "/usr/bin:/bin";
      const env = wranglerSpawnEnv("conta-123");
      assert.ok(env.PATH?.includes("/usr/bin"), `PATH devia conter o valor herdado: ${env.PATH}`);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("propaga CLOUDFLARE_ACCOUNT_ID pro env retornado", () => {
    const env = wranglerSpawnEnv("conta-xyz");
    assert.equal(env.CLOUDFLARE_ACCOUNT_ID, "conta-xyz");
  });

  it("PATH nunca fica vazio mesmo se process.env.PATH estiver ausente", () => {
    const originalPath = process.env.PATH;
    try {
      delete process.env.PATH;
      const env = wranglerSpawnEnv("conta-123");
      assert.ok(env.PATH && env.PATH.length > 0);
    } finally {
      process.env.PATH = originalPath;
    }
  });
});

describe("readKvSyncState / writeKvSyncState (#7338, mesmo shape de sync-beehiiv-subscribers-kit.ts #6092)", () => {
  it("round-trip: escreve e lê de volta", () => {
    const dir = mkdtempSync(join(tmpdir(), "cursos-kv-sync-state-"));
    try {
      const state = { last_run_at: "2026-09-05T00:00:00Z", active_subscriber_count: 551 };
      writeKvSyncState(dir, state);
      assert.deepEqual(readKvSyncState(dir), state);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sem arquivo — devolve null (sem baseline, 1ª rodada)", () => {
    const dir = mkdtempSync(join(tmpdir(), "cursos-kv-sync-state-"));
    try {
      assert.equal(readKvSyncState(dir), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("#7485: round-trip com `backend` presente", () => {
    const dir = mkdtempSync(join(tmpdir(), "cursos-kv-sync-state-"));
    try {
      const state = { last_run_at: "2026-09-05T00:00:00Z", active_subscriber_count: 551, backend: "kit" as const };
      writeKvSyncState(dir, state);
      assert.deepEqual(readKvSyncState(dir), state);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("#7485: estado legado sem `backend` (gravado antes desta PR) é aceito por isValidKvSyncState — não lança", () => {
    const dir = mkdtempSync(join(tmpdir(), "cursos-kv-sync-state-"));
    try {
      // Simula um arquivo gravado ANTES desta PR — sem o campo `backend`.
      const legacyState = { last_run_at: "2026-09-01T00:00:00Z", active_subscriber_count: 500 };
      writeKvSyncState(dir, legacyState);
      assert.doesNotThrow(() => readKvSyncState(dir));
      assert.deepEqual(readKvSyncState(dir), legacyState);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("evaluateKvEmptyGuard (#7338)", () => {
  it("SEM baseline anterior E currentCount === 0 — RECUSA (piso absoluto, achado P0 do #7463)", () => {
    // Achado do self-review na PR #7463: SEM baseline (1ª rodada desde que
    // este guard existe — o estado REAL de produção hoje, já que o state
    // file nasce com esta mesma PR) `!previousState` cairia no {ok:true}
    // de "sem histórico pra comparar" — mas a Beehiiv está ATUALMENTE com 0
    // assinantes ativos (migração #7388/#7395). Sem este piso absoluto, a
    // 1ª rodada bem-sucedida após o fix do PATH leria 0, passaria o guard
    // por falta de baseline, e apagaria o KV inteiro.
    const result = evaluateKvEmptyGuard(0, null);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.reason, /piso absoluto/);
    }
  });

  it("sem baseline anterior, currentCount > 0 — passa (nada suspeito pra comparar)", () => {
    assert.deepEqual(evaluateKvEmptyGuard(551, null), { ok: true });
  });

  it("baseline anterior era 0, currentCount > 0 — passa (nada pra comparar)", () => {
    const prev = { last_run_at: "2026-09-04T00:00:00Z", active_subscriber_count: 0 };
    assert.deepEqual(evaluateKvEmptyGuard(551, prev), { ok: true });
  });

  it("queda dentro da tolerância (≥50% do baseline) — passa", () => {
    const prev = { last_run_at: "2026-09-04T00:00:00Z", active_subscriber_count: 500 };
    assert.deepEqual(evaluateKvEmptyGuard(300, prev), { ok: true }); // 60%
  });

  it("caso real #7338: baseline 551, atual 0 (Beehiiv zerada pela migração #7388/#7395) — RECUSA pelo piso absoluto", () => {
    const prev = { last_run_at: "2026-09-03T09:15:00Z", active_subscriber_count: 551 };
    const result = evaluateKvEmptyGuard(0, prev);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.reason, /piso absoluto/);
    }
  });

  it("queda abrupta abaixo do limiar (menos de 50% do baseline, mas NÃO zero) — recusa pela razão, não pelo piso", () => {
    const prev = { last_run_at: "2026-09-04T00:00:00Z", active_subscriber_count: 500 };
    const result = evaluateKvEmptyGuard(100, prev); // 20%
    assert.equal(result.ok, false);
  });

  it("review do #7477: backendLabel nomeia o backend certo na mensagem — nunca fica hardcoded \"Beehiiv\" quando quem falhou foi o Kit", () => {
    const result = evaluateKvEmptyGuard(0, null, "kit", "Kit");
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.reason, /^Kit devolveu 0 assinantes ativos/);
      assert.doesNotMatch(result.reason, /Beehiiv/);
    }
  });

  it("backendLabel default (não passado) continua com texto genérico, não afirma Beehiiv quando o caller não informou o backend", () => {
    const result = evaluateKvEmptyGuard(0, null);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.doesNotMatch(result.reason, /Beehiiv/);
    }
  });

  describe("#7485: baseline registra backend — flip beehiiv→kit não trava a task de forma persistente", () => {
    it("backend do baseline DIFERE do atual — sem baseline comparável, passa mesmo com razão < 50%", () => {
      const prev = { last_run_at: "2026-09-04T00:00:00Z", active_subscriber_count: 1000, backend: "beehiiv" as const };
      // 400/1000 = 40% do baseline — reprovaria se fosse a MESMA fonte, mas
      // o baseline é de um backend diferente (migração beehiiv→kit): a razão
      // não é comparável, então o guard trata como "sem baseline".
      assert.deepEqual(evaluateKvEmptyGuard(400, prev, "kit"), { ok: true });
    });

    it("backend do baseline é o MESMO do atual — guard continua disparando normalmente pela razão", () => {
      const prev = { last_run_at: "2026-09-04T00:00:00Z", active_subscriber_count: 1000, backend: "kit" as const };
      const result = evaluateKvEmptyGuard(400, prev, "kit");
      assert.equal(result.ok, false);
    });

    it("baseline legado sem campo `backend` (estado gravado antes desta PR) — tratado como backend desconhecido, sem baseline comparável", () => {
      const prev = { last_run_at: "2026-09-04T00:00:00Z", active_subscriber_count: 1000 };
      assert.deepEqual(evaluateKvEmptyGuard(400, prev, "kit"), { ok: true });
    });

    it("piso absoluto de currentCount === 0 continua valendo mesmo com backend diferente do baseline", () => {
      const prev = { last_run_at: "2026-09-04T00:00:00Z", active_subscriber_count: 1000, backend: "beehiiv" as const };
      const result = evaluateKvEmptyGuard(0, prev, "kit");
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.reason, /piso absoluto/);
    });

    it("caller que não informa currentBackend preserva o comportamento anterior a esta PR (compara a razão direto, ignorando `backend` do baseline)", () => {
      const prev = { last_run_at: "2026-09-04T00:00:00Z", active_subscriber_count: 1000, backend: "beehiiv" as const };
      const result = evaluateKvEmptyGuard(400, prev); // sem 3º arg
      assert.equal(result.ok, false); // 40% < 50%, dispara pela razão como antes
    });
  });
});

describe("fetchActiveSubscriberEmailsForBackend (#7338 follow-up — reprodução ao vivo pós-#7463, 05/09/2026)", () => {
  it("backend=beehiiv chama só o fetcher Beehiiv, nunca o Kit", async () => {
    let beehiivCalls = 0;
    let kitCalls = 0;
    const emails = await fetchActiveSubscriberEmailsForBackend("beehiiv", {
      fetchBeehiiv: async () => {
        beehiivCalls++;
        return ["a@example.com"];
      },
      fetchKit: async () => {
        kitCalls++;
        return ["b@example.com"];
      },
    });
    assert.deepEqual(emails, ["a@example.com"]);
    assert.equal(beehiivCalls, 1);
    assert.equal(kitCalls, 0);
  });

  it("backend=kit chama só o fetcher Kit, nunca o Beehiiv — é exatamente o caso real #7338: Beehiiv zerada (0 ativos) pela migração #7386/#7388, subscriber_backend virou \"kit\" no #7395, e o script ANTES deste fix ignorava essa chave e continuava lendo a Beehiiv vazia", async () => {
    let beehiivCalls = 0;
    let kitCalls = 0;
    const emails = await fetchActiveSubscriberEmailsForBackend("kit", {
      fetchBeehiiv: async () => {
        beehiivCalls++;
        return [];
      },
      fetchKit: async () => {
        kitCalls++;
        return ["c@example.com", "d@example.com"];
      },
    });
    assert.deepEqual(emails, ["c@example.com", "d@example.com"]);
    assert.equal(kitCalls, 1);
    assert.equal(beehiivCalls, 0);
  });
});
