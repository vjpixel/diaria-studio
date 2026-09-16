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
      const count = resolveSubscriberCount({ backend: "beehiiv", pubJsonPath });
      assert.equal(count, 317);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cache Beehiiv ausente → 0, sem lançar", () => {
    const count = resolveSubscriberCount({ backend: "beehiiv", pubJsonPath: "/nao/existe/publication.json" });
    assert.equal(count, 0);
  });

  it("cache Beehiiv malformado → 0 + logFileReadWarning disparado via spawnFn (#8150)", () => {
    const dir = mkdtempSync(join(tmpdir(), "sub-count-8145-"));
    try {
      const pubJsonPath = tmpFile(dir, "publication.json", "{ isso nao e json valido");
      const spawnCalls: unknown[] = [];
      const warnCalls: string[] = [];
      const count = resolveSubscriberCount({
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
    const count = resolveSubscriberCount({
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
      const count = resolveSubscriberCount({
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
      const count = resolveSubscriberCount({
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
      const count = resolveSubscriberCount({
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
