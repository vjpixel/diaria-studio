/**
 * test/update-audience-subscriber-count-8145.test.ts (#8145, #8150 item 2)
 *
 * `resolveSubscriberCount` (`scripts/update-audience.ts`) resolve a
 * contagem de assinantes ativos respeitando
 * `publishing.newsletter.subscriber_backend` em vez de ler sempre o cache
 * Beehiiv (`data/beehiiv-cache/publication.json`), que ficou zerado desde a
 * migração pro Kit (#7386/#7388). Backend "kit" lê `getKitActiveSummary` do
 * store unificado local (síncrono, `openDbFn`/`getKitActiveSummaryFn`
 * injetados aqui — nenhum teste toca `node:sqlite` real nem `data/`).
 *
 * Também cobre #8150 item 2: erro de parse do cache Beehiiv (JSON
 * malformado) dispara `logFileReadWarning` (console.warn + log-event via
 * `spawnFn` injetado) em vez de sumir num `catch` mudo.
 *
 * #8322: `docs/audience-history/2026-09-15.md`/`2026-09-16.md` gravaram
 * `**subscribers ativos:** 1` — um valor implausível (a base real está na
 * casa das centenas). `resolveSubscriberCount` agora devolve
 * `{ count, warning? }` em vez de um número cru: qualquer `count` do Kit
 * entre 1 e `MIN_PLAUSIBLE_KIT_ACTIVE_COUNT` (exclusive) nunca é aceito como
 * valor real — vira `warning` preenchido, que `main()` grava explicitamente
 * no snapshot (nunca o número implausível, nunca omissão silenciosa).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveSubscriberCount,
  logFileReadWarning,
  buildFileReadWarningLogArgs,
  buildImplausibleKitCountWarning,
  MIN_PLAUSIBLE_KIT_ACTIVE_COUNT,
} from "../scripts/update-audience.ts";

function tmpFile(dir: string, name: string, content: string): string {
  const p = join(dir, name);
  writeFileSync(p, content, "utf8");
  return p;
}

describe("resolveSubscriberCount — backend beehiiv (#8145)", () => {
  it("lê active_subscriptions do cache Beehiiv quando backend='beehiiv'", () => {
    const dir = mkdtempSync(join(tmpdir(), "sub-count-8145-"));
    try {
      const pubJsonPath = tmpFile(dir, "publication.json", JSON.stringify({ stats: { active_subscriptions: 317 } }));
      const { count } = resolveSubscriberCount({ backend: "beehiiv", pubJsonPath });
      assert.equal(count, 317);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cache Beehiiv ausente → 0, sem lançar", () => {
    const { count } = resolveSubscriberCount({ backend: "beehiiv", pubJsonPath: "/nao/existe/publication.json" });
    assert.equal(count, 0);
  });

  it("cache Beehiiv malformado → 0 + logFileReadWarning disparado via spawnFn (#8150)", () => {
    const dir = mkdtempSync(join(tmpdir(), "sub-count-8145-"));
    try {
      const pubJsonPath = tmpFile(dir, "publication.json", "{ isso nao e json valido");
      const spawnCalls: unknown[] = [];
      const warnCalls: string[] = [];
      const { count } = resolveSubscriberCount({
        backend: "beehiiv",
        pubJsonPath,
        spawnFn: ((...args: unknown[]) => {
          spawnCalls.push(args);
          return {} as ReturnType<typeof import("node:child_process").spawnSync>;
        }) as typeof import("node:child_process").spawnSync,
        warnFn: (msg: string) => warnCalls.push(msg),
      });
      assert.equal(count, 0, "arquivo ilegível vira 0, nunca lança");
      assert.equal(spawnCalls.length, 1, "log-event.ts deve ser disparado 1x");
      assert.equal(warnCalls.length, 1, "console.warn (injetado) deve ser chamado 1x");
      assert.match(warnCalls[0], /publication\.json/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("resolveSubscriberCount — backend kit (#8145)", () => {
  it("lê getKitActiveSummary do store local quando backend='kit', ignora o cache Beehiiv", () => {
    const fakeDb = { close: () => {} };
    const { count } = resolveSubscriberCount({
      backend: "kit",
      pubJsonPath: "/nunca/deveria/ser/lido.json",
      openDbFn: () => fakeDb as ReturnType<typeof import("../scripts/lib/diaria-subscribers-db.ts").openDiariaSubscribersDbSafe>,
      getKitActiveSummaryFn: () => ({ count: 626, asOf: "2026-09-15T00:00:00Z" }),
      existsFn: () => {
        throw new Error("não deveria checar o cache Beehiiv quando o store Kit respondeu com count > 0");
      },
    });
    assert.equal(count, 626);
  });

  it("store Kit indisponível (open retorna null) → cai pro cache Beehiiv (fallback fail-soft)", () => {
    const dir = mkdtempSync(join(tmpdir(), "sub-count-8145-"));
    try {
      const pubJsonPath = tmpFile(dir, "publication.json", JSON.stringify({ stats: { active_subscriptions: 1 } }));
      const { count } = resolveSubscriberCount({
        backend: "kit",
        pubJsonPath,
        openDbFn: () => null,
      });
      assert.equal(count, 1, "fallback deve ler o cache Beehiiv quando o store Kit não abre");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("store Kit abre mas count=0 (ainda não ingerido) → cai pro cache Beehiiv, e fecha o db mesmo assim", () => {
    const dir = mkdtempSync(join(tmpdir(), "sub-count-8145-"));
    try {
      const pubJsonPath = tmpFile(dir, "publication.json", JSON.stringify({ stats: { active_subscriptions: 42 } }));
      let closed = false;
      const fakeDb = { close: () => { closed = true; } };
      const { count } = resolveSubscriberCount({
        backend: "kit",
        pubJsonPath,
        openDbFn: () => fakeDb as ReturnType<typeof import("../scripts/lib/diaria-subscribers-db.ts").openDiariaSubscribersDbSafe>,
        getKitActiveSummaryFn: () => ({ count: 0, asOf: null }),
      });
      assert.equal(count, 42, "count=0 do Kit é tratado como 'ainda não ingerido', cai pro fallback");
      assert.equal(closed, true, "db precisa fechar mesmo no caminho de fallback (finally)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("store Kit abre mas a query lança (schema inesperado/corrupção) → não propaga, cai pro cache Beehiiv, db fecha mesmo assim (achado do self-review #8166)", () => {
    const dir = mkdtempSync(join(tmpdir(), "sub-count-8145-"));
    try {
      const pubJsonPath = tmpFile(dir, "publication.json", JSON.stringify({ stats: { active_subscriptions: 42 } }));
      let closed = false;
      const fakeDb = { close: () => { closed = true; } };
      let warned = false;
      const { count } = resolveSubscriberCount({
        backend: "kit",
        pubJsonPath,
        openDbFn: () => fakeDb as ReturnType<typeof import("../scripts/lib/diaria-subscribers-db.ts").openDiariaSubscribersDbSafe>,
        getKitActiveSummaryFn: () => {
          throw new Error("no such table: subscription");
        },
        warnFn: () => { warned = true; },
        spawnFn: (() => ({}) as ReturnType<typeof import("node:child_process").spawnSync>) as typeof import("node:child_process").spawnSync,
      });
      assert.equal(count, 42, "query lançando não deve derrubar o script — cai pro fallback Beehiiv");
      assert.equal(closed, true, "db precisa fechar mesmo quando a query lança (finally)");
      assert.equal(warned, true, "o erro real deve ser logado, não engolido em silêncio");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("resolveSubscriberCount — contagem Kit implausível (#8322)", () => {
  it("count=1 do Kit (a resposta real que produziu o bug em 09-15/09-16) → warning preenchido, nunca aceito como valor real", () => {
    const dir = mkdtempSync(join(tmpdir(), "sub-count-8322-"));
    try {
      const pubJsonPath = tmpFile(dir, "publication.json", JSON.stringify({ stats: { active_subscriptions: 0 } }));
      const fakeDb = { close: () => {} };
      const warnCalls: string[] = [];
      const spawnCalls: unknown[] = [];
      const result = resolveSubscriberCount({
        backend: "kit",
        pubJsonPath,
        openDbFn: () => fakeDb as ReturnType<typeof import("../scripts/lib/diaria-subscribers-db.ts").openDiariaSubscribersDbSafe>,
        // Fixture: exatamente a resposta que produziu "**subscribers ativos:** 1"
        // nos snapshots reais de 2026-09-15/16 (#8322).
        getKitActiveSummaryFn: () => ({ count: 1, asOf: "2026-09-15T00:00:00Z" }),
        warnFn: (msg: string) => warnCalls.push(msg),
        spawnFn: ((...args: unknown[]) => {
          spawnCalls.push(args);
          return {} as ReturnType<typeof import("node:child_process").spawnSync>;
        }) as typeof import("node:child_process").spawnSync,
      });
      assert.notEqual(result.count, 1, "nunca aceita o valor implausível como contagem real");
      assert.equal(result.count, 0, "cai pro fallback Beehiiv (cache zerado no fixture)");
      assert.ok(result.warning, "warning deve estar preenchido — nunca omitido em silêncio");
      assert.match(result.warning!, /implausível/);
      assert.match(result.warning!, /#8322/);
      assert.equal(warnCalls.length, 1, "console.warn (injetado) deve disparar 1x");
      assert.match(warnCalls[0], /implausível/);
      assert.equal(spawnCalls.length, 1, "log-event.ts deve ser disparado 1x (registro durável, #8322)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("count=MIN_PLAUSIBLE_KIT_ACTIVE_COUNT-1 (piso-1) ainda é implausível; count=MIN_PLAUSIBLE_KIT_ACTIVE_COUNT já é aceito", () => {
    const fakeDb = { close: () => {} };
    const noopSpawn = (() => ({}) as ReturnType<typeof import("node:child_process").spawnSync>) as typeof import("node:child_process").spawnSync;
    const belowFloor = resolveSubscriberCount({
      backend: "kit",
      pubJsonPath: "/nao/existe/publication.json",
      openDbFn: () => fakeDb as ReturnType<typeof import("../scripts/lib/diaria-subscribers-db.ts").openDiariaSubscribersDbSafe>,
      getKitActiveSummaryFn: () => ({ count: MIN_PLAUSIBLE_KIT_ACTIVE_COUNT - 1, asOf: null }),
      spawnFn: noopSpawn,
      warnFn: () => {},
    });
    assert.ok(belowFloor.warning, "piso-1 ainda deve ser tratado como implausível");
    assert.equal(belowFloor.count, 0, "sem cache Beehiiv no fixture → fallback 0");

    const atFloor = resolveSubscriberCount({
      backend: "kit",
      pubJsonPath: "/nao/existe/publication.json",
      openDbFn: () => fakeDb as ReturnType<typeof import("../scripts/lib/diaria-subscribers-db.ts").openDiariaSubscribersDbSafe>,
      getKitActiveSummaryFn: () => ({ count: MIN_PLAUSIBLE_KIT_ACTIVE_COUNT, asOf: null }),
    });
    assert.equal(atFloor.warning, undefined, "o piso em si já é aceito como plausível");
    assert.equal(atFloor.count, MIN_PLAUSIBLE_KIT_ACTIVE_COUNT);
  });

  it("count=0 continua SEM warning (comportamento pré-existente 'ainda não ingerido', #8145) — só 1..piso-1 é novo", () => {
    const fakeDb = { close: () => {} };
    const pubJsonPath2 = "/nao/existe/publication.json";
    const result = resolveSubscriberCount({
      backend: "kit",
      pubJsonPath: pubJsonPath2,
      openDbFn: () => fakeDb as ReturnType<typeof import("../scripts/lib/diaria-subscribers-db.ts").openDiariaSubscribersDbSafe>,
      getKitActiveSummaryFn: () => ({ count: 0, asOf: null }),
    });
    assert.equal(result.warning, undefined, "count=0 não é 'implausível' — é o caso já tratado de 'ainda não ingerido'");
    assert.equal(result.count, 0);
  });

  it("buildImplausibleKitCountWarning: mensagem pura cita o valor cru, o piso e #8322", () => {
    const msg = buildImplausibleKitCountWarning(1, "/data/diaria-subscribers/diaria-subscribers.db");
    assert.match(msg, /\b1\b/);
    assert.match(msg, new RegExp(String(MIN_PLAUSIBLE_KIT_ACTIVE_COUNT)));
    assert.match(msg, /#8322/);
    assert.match(msg, /diaria-subscribers\.db/);
  });
});

describe("buildFileReadWarningLogArgs (#8150)", () => {
  it("monta argv com --level warn e --details referenciando #8150 + o path do arquivo", () => {
    const args = buildFileReadWarningLogArgs("survey JSON", "/tmp/audience-raw.json", new Error("Unexpected token"));
    assert.ok(args.includes("--level"));
    assert.ok(args.includes("warn"));
    const detailsIdx = args.indexOf("--details");
    assert.ok(detailsIdx >= 0);
    const details = JSON.parse(args[detailsIdx + 1]);
    assert.equal(details.file, "/tmp/audience-raw.json");
    assert.equal(details.issue, "#8150");
    assert.match(details.error, /Unexpected token/);
  });
});

describe("logFileReadWarning (#8150)", () => {
  it("dispara warnFn e spawnFn (fire-and-forget) uma vez cada", () => {
    const warnCalls: string[] = [];
    const spawnCalls: unknown[] = [];
    logFileReadWarning(
      "cache de assinantes Beehiiv",
      "/tmp/publication.json",
      new Error("boom"),
      ((...args: unknown[]) => {
        spawnCalls.push(args);
        return {} as ReturnType<typeof import("node:child_process").spawnSync>;
      }) as typeof import("node:child_process").spawnSync,
      (msg: string) => warnCalls.push(msg),
    );
    assert.equal(warnCalls.length, 1);
    assert.equal(spawnCalls.length, 1);
  });

  it("spawnFn que lança não propaga (fire-and-forget nunca mascara/bloqueia)", () => {
    const warnCalls: string[] = [];
    assert.doesNotThrow(() => {
      logFileReadWarning(
        "survey JSON",
        "/tmp/audience-raw.json",
        new Error("boom"),
        (() => {
          throw new Error("spawn falhou");
        }) as unknown as typeof import("node:child_process").spawnSync,
        (msg: string) => warnCalls.push(msg),
      );
    });
    assert.equal(warnCalls.length, 1, "warnFn ainda deve ter disparado antes da tentativa de spawn");
  });
});
