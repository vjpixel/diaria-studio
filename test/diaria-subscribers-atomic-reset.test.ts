/**
 * diaria-subscribers-atomic-reset.test.ts (#7187)
 *
 * Teste de regressão do reset atômico do store de assinantes. O bug: o
 * `--reset` de `diaria-subscribers-ingest-beehiiv.ts` apagava o `.db` e
 * recriava no lugar — entre máquinas (o store é sincronizado via OneDrive),
 * a deleção se propagava antes da recriação terminar, deixando a outra
 * máquina sem store nenhum, só com os sidecars `-wal`/`-shm` órfãos (estado
 * inválido; observado ao vivo em 02/09/2026 na reingestão da #7181).
 *
 * O fix (`atomicRebuildTempPath` + `atomicCommitRebuild` em
 * `scripts/lib/diaria-subscribers-db.ts`) constrói o store novo num arquivo
 * de trabalho e só o instala por `rename` atômico no fim — o consumidor da
 * outra máquina vê o store VELHO (estado válido) durante toda a janela.
 *
 * O teste que DISCRIMINA o bug é o primeiro ("store VELHO permanece
 * legível..."): no código antigo, o `.db` era `rmSync`-ado no início do
 * reset, então `existsSync` falharia e os counts seriam 0 durante o build.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  atomicCommitRebuild,
  atomicRebuildTempPath,
  ensureSubscriber,
  findSubscriberIdsByEmail,
  getStoreCounts,
  openDiariaSubscribersDb,
  recordEvent,
} from "../scripts/lib/diaria-subscribers-db.ts";

/** Store "velho" com dado real: 1 subscriber + 1 evento. Retorna os counts. */
function seedOldStore(dbPath: string): ReturnType<typeof getStoreCounts> {
  const db = openDiariaSubscribersDb(dbPath);
  const sub = ensureSubscriber(db, "beehiiv", "ext-old", "velho@x.com", "2026-01-01T00:00:00Z");
  recordEvent(db, {
    subscriberId: sub,
    platform: "beehiiv",
    type: "sent",
    externalEventId: "e-old",
    ts: "2026-01-01T00:00:00Z",
  });
  const counts = getStoreCounts(db);
  db.close();
  return counts;
}

/** Recria o estado observado no Neo (02/09/2026): sidecars soltos junto ao
 *  `.db` — resíduo de um banco que morreu sem fechar limpo. */
function seedOrphanSidecars(dbPath: string): void {
  writeFileSync(`${dbPath}-wal`, "wal-residuo-do-banco-antigo", "utf8");
  writeFileSync(`${dbPath}-shm`, "shm-residuo-do-banco-antigo", "utf8");
}

/** Build de teste: store novo no caminho de trabalho com dado DIFERENTE do
 *  velho, fechado e pronto pro commit (o que `main(--reset)` faz, em
 *  miniatura). */
function buildNewStore(tmpDbPath: string): void {
  const db = openDiariaSubscribersDb(tmpDbPath);
  const sub = ensureSubscriber(db, "brevo_diaria", "ext-new", "novo@x.com", "2026-01-02T00:00:00Z");
  recordEvent(db, {
    subscriberId: sub,
    platform: "brevo_diaria",
    type: "click",
    externalEventId: "e-new",
    ts: "2026-01-02T00:00:00Z",
  });
  db.close();
}

describe("atomicRebuildTempPath (#7187)", () => {
  it("devolve caminho de trabalho no MESMO diretório do store (rename não pode trocar de filesystem)", () => {
    const dir = mkdtempSync(join(tmpdir(), "atomic-reset-"));
    const dbPath = resolve(dir, "store.db");
    const tmpDb = atomicRebuildTempPath(dbPath);
    assert.equal(resolve(tmpDb, ".."), dir, "tmp de trabalho vive no mesmo diretório");
    assert.ok(!existsSync(tmpDb), "o helper RESERVA o caminho, não cria o arquivo — quem cria é openDiariaSubscribersDb");
  });

  it("varre lixo de builds mortos anteriores (.rebuild-tmp-*, inclusive sidecars)", () => {
    const dir = mkdtempSync(join(tmpdir(), "atomic-reset-"));
    const dbPath = resolve(dir, "store.db");
    const stem = "store.db";
    // Lixo de um build que morreu no meio: o `.db` de trabalho + a WAL dele.
    writeFileSync(resolve(dir, `.${stem}.rebuild-tmp-999-deadbeef`), "lixo", "utf8");
    writeFileSync(resolve(dir, `.${stem}.rebuild-tmp-999-deadbeef-wal`), "lixo-wal", "utf8");
    // Store VELHO e sidecars DELE ficam — a varredura é só do padrão de build.
    writeFileSync(dbPath, "store-velho", "utf8");
    writeFileSync(`${dbPath}-wal`, "wal-do-store-velho", "utf8");

    atomicRebuildTempPath(dbPath);

    const entries = readdirSync(dir);
    assert.ok(!entries.includes(`.${stem}.rebuild-tmp-999-deadbeef`), "lixo do build morto varrido");
    assert.ok(!entries.includes(`.${stem}.rebuild-tmp-999-deadbeef-wal`), "sidecar do build morto varrido");
    assert.ok(entries.includes(stem), "store VELHO intocado pela varredura");
    assert.ok(entries.includes(`${stem}-wal`), "sidecar do store VELHO intocado pela varredura");
  });

  it("cria o diretório do store se faltar (clone fresco)", () => {
    const dir = mkdtempSync(join(tmpdir(), "atomic-reset-"));
    const dbPath = resolve(dir, "diaria-subscribers", "store.db");
    assert.ok(!existsSync(resolve(dir, "diaria-subscribers")));
    const tmpDb = atomicRebuildTempPath(dbPath);
    assert.ok(existsSync(resolve(dir, "diaria-subscribers")), "diretório criado");
    assert.ok(tmpDb.startsWith(resolve(dir, "diaria-subscribers")));
  });
});

describe("atomicCommitRebuild — fluxo completo do reset (#7187)", () => {
  it("store VELHO permanece legível com dado intacto DURANTE todo o build — a janela sem arquivo não existe mais", () => {
    const dir = mkdtempSync(join(tmpdir(), "atomic-reset-"));
    const dbPath = resolve(dir, "store.db");
    const oldCounts = seedOldStore(dbPath);

    // ---- reset começa: caminho de trabalho reservado, store novo buildado
    const tmpDb = atomicRebuildTempPath(dbPath);

    // O ASSERT DE REGRESSÃO: no código antigo (rmSync(.db) primeiro), o
    // store já não existiria neste ponto — a outra máquina via só sidecars
    // órfãos. Com o fix, o store VELHO segue no lugar e legível.
    assert.ok(existsSync(dbPath), "store VELHO ainda presente durante o build");
    const dbDuring = openDiariaSubscribersDb(dbPath);
    assert.deepEqual(getStoreCounts(dbDuring), oldCounts, "dado VELHO intacto durante o build");
    dbDuring.close();

    buildNewStore(tmpDb);

    // Ainda no meio do reset: velho continua no lugar.
    assert.ok(existsSync(dbPath), "store VELHO presente até o commit");

    // ---- commit: swap atômico
    atomicCommitRebuild(tmpDb, dbPath);

    // O que foi instalado é o store NOVO — discrimina por identidade, não por
    // contagem (counts velho/novo podem coincidir; o dado não).
    const dbAfter = openDiariaSubscribersDb(dbPath);
    assert.deepEqual(
      getStoreCounts(dbAfter),
      {
        subscribers: 1,
        identity_aliases: 1,
        subscriptions: 0,
        events: 1,
        attributes: 0,
        subscriptions_coverage_low: true,
      },
      "store novo instalado",
    );
    assert.deepEqual(findSubscriberIdsByEmail(dbAfter, "novo@x.com").length, 1, "dado do build novo presente");
    assert.deepEqual(findSubscriberIdsByEmail(dbAfter, "velho@x.com"), [], "dado VELHO não sobrou no instalado");
    dbAfter.close();
  });

  it("não deixa NENHUM sidecar órfão no diretório depois do swap (o estado inválido observado no Neo)", () => {
    const dir = mkdtempSync(join(tmpdir(), "atomic-reset-"));
    const dbPath = resolve(dir, "store.db");
    seedOldStore(dbPath);
    seedOrphanSidecars(dbPath); // exatamente o resíduo observado na issue

    const tmpDb = atomicRebuildTempPath(dbPath);
    buildNewStore(tmpDb);
    atomicCommitRebuild(tmpDb, dbPath);

    const orphans = ["store.db-wal", "store.db-shm", "store.db-journal"]
      .map((s) => resolve(dir, s))
      .filter((p) => existsSync(p));
    assert.deepEqual(orphans, [], "sidecars da geração substituída removidos pelo commit");
    // E nenhum tmp de trabalho sobrou.
    const litter = readdirSync(dir).filter((e) => e.includes(".rebuild-tmp-"));
    assert.deepEqual(litter, [], "nenhum arquivo de trabalho sobrou");
  });

  it("store resultante é funcional — abre, aceita escrita e lê depois do reset", () => {
    const dir = mkdtempSync(join(tmpdir(), "atomic-reset-"));
    const dbPath = resolve(dir, "store.db");
    seedOldStore(dbPath);

    const tmpDb = atomicRebuildTempPath(dbPath);
    buildNewStore(tmpDb);
    atomicCommitRebuild(tmpDb, dbPath);

    const db = openDiariaSubscribersDb(dbPath);
    const sub = ensureSubscriber(db, "kit", "ext-post", "post@x.com", "2026-01-03T00:00:00Z");
    recordEvent(db, {
      subscriberId: sub,
      platform: "kit",
      type: "open",
      externalEventId: "e-post",
      ts: "2026-01-03T00:00:00Z",
    });
    const counts = getStoreCounts(db);
    db.close();
    assert.equal(counts.subscribers, 2, "1 do build novo + 1 pós-reset");
    assert.equal(counts.events, 2);
  });

  it("instala sobre store inexistente (1º reset num clone fresco, data/ recém-criado)", () => {
    const dir = mkdtempSync(join(tmpdir(), "atomic-reset-"));
    const dbPath = resolve(dir, "store.db");
    assert.ok(!existsSync(dbPath));

    const tmpDb = atomicRebuildTempPath(dbPath);
    buildNewStore(tmpDb);
    atomicCommitRebuild(tmpDb, dbPath);

    assert.ok(existsSync(dbPath), "store criado pelo rename");
    const db = openDiariaSubscribersDb(dbPath);
    const counts = getStoreCounts(db);
    db.close();
    assert.equal(counts.subscribers, 1);
  });

  it("commit sem store de trabalho lança (build não concluído) — store VELHO intocado", () => {
    const dir = mkdtempSync(join(tmpdir(), "atomic-reset-"));
    const dbPath = resolve(dir, "store.db");
    seedOldStore(dbPath);

    assert.throws(
      () => atomicCommitRebuild(resolve(dir, ".store.db.rebuild-tmp-inexistente"), dbPath),
      /não encontrado/,
    );
    assert.ok(existsSync(dbPath), "store VELHO intacto quando o commit falha");
  });
});

// Nota de cobertura: o caso "rename falha (EPERM/EBUSY de OneDrive no
// Windows) e retry resolve" é coberto pelos testes de `renameWithRetry`
// (test/atomic-write.test.ts), que este módulo reusa via `atomicCommitRebuild`
// — não duplicado aqui.
