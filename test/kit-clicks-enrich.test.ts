/**
 * kit-clicks-enrich.test.ts (#7600)
 *
 * Cobre o script REST que substitui o agent `kit-clicks-enricher` (MCP,
 * aposentado por causa do gate de plano pago do #7365). Injeta
 * `fetchClicks`/`applyFn`/`sleepFn` fake — sem rede, sem backoff real.
 * Regressão principal: uma vez que o REST volta a funcionar no plano free,
 * o script drena um lote de broadcast ids e grava no MESMO formato que
 * `apply-mcp-kit-clicks.ts` já persistia via MCP.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import {
  enrichOneBroadcast,
  enrichBatch,
  deriveBroadcastIdsFromCycle,
} from "../scripts/kit-clicks-enrich.ts";
import { applyKitClicks } from "../scripts/apply-mcp-kit-clicks.ts";
import type { KitBroadcastClick, KitPagination } from "../scripts/lib/kit-client.ts";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "kit-clicks-enrich-"));
  const postsDir = resolve(dir, "posts");
  mkdirSync(postsDir, { recursive: true });
  return { dir, postsDir };
}

function fakeClick(url: string, uniqueClicks: number): KitBroadcastClick {
  return { id: 0, url, unique_clicks: uniqueClicks, click_to_delivery_rate: 0, click_to_open_rate: 0 };
}

function fakePage(clicks: KitBroadcastClick[], pagination: Partial<KitPagination> = {}) {
  return { clicks, pagination: { has_next_page: false, end_cursor: null, ...pagination } as KitPagination };
}

describe("enrichOneBroadcast — fetch REST + apply", () => {
  it("busca 1 página e aplica no cache (formato idêntico ao caminho MCP)", async () => {
    const { postsDir } = setup();
    let callCount = 0;
    const result = await enrichOneBroadcast("25654292", {
      append: false,
      postsDir,
      fetchClicks: async (id) => {
        callCount++;
        assert.equal(id, 25654292);
        return fakePage([
          fakeClick("https://a.com/", 7),
          fakeClick("https://b.com/", 2),
        ]);
      },
      sleepFn: async () => {},
    });

    assert.equal(callCount, 1);
    assert.equal(result.ok, true);
    assert.equal(result.links_applied, 2);

    const cachePath = resolve(postsDir, "kit_25654292.json");
    const written = JSON.parse(readFileSync(cachePath, "utf8"));
    assert.equal(written.stats.clicks.length, 2);
    assert.equal(written.stats.clicks[0].unique_clicks, 7);
  });

  it("pagina até o fim (has_next_page) sem descartar excedentes", async () => {
    const { postsDir } = setup();
    let call = 0;
    const result = await enrichOneBroadcast("25654293", {
      append: false,
      postsDir,
      fetchClicks: async (_id, opts) => {
        call++;
        if (call === 1) {
          assert.equal(opts?.after, undefined);
          return fakePage([fakeClick("https://a.com/", 1)], {
            has_next_page: true,
            end_cursor: "cursor-2",
          });
        }
        assert.equal(opts?.after, "cursor-2");
        return fakePage([fakeClick("https://b.com/", 3)]);
      },
      sleepFn: async () => {},
    });

    assert.equal(call, 2);
    assert.equal(result.ok, true);
    assert.equal(result.links_applied, 2);
  });

  it("fail-soft: erro de fetch vira fail_reason fetch-error, não lança", async () => {
    const { postsDir } = setup();
    const result = await enrichOneBroadcast("25654294", {
      append: false,
      postsDir,
      fetchClicks: async () => {
        throw new Error("network down");
      },
      sleepFn: async () => {},
    });
    assert.equal(result.ok, false);
    assert.equal(result.fail_reason, "fetch-error");
    assert.equal(existsSync(resolve(postsDir, "kit_25654294.json")), false);
  });

  it("guard de replace-vazio propaga como fail_reason guard-empty-replace, nunca --allow-empty-replace sozinho", async () => {
    const { postsDir } = setup();
    // Cache pré-existente NÃO-vazio.
    writeFileSync(
      resolve(postsDir, "kit_25654295.json"),
      JSON.stringify({ id8: "25654295", stats: { clicks: [{ url: "https://old.com/", unique_clicks: 5 }] } }),
    );

    const result = await enrichOneBroadcast("25654295", {
      append: false,
      postsDir,
      fetchClicks: async () => fakePage([]),
      sleepFn: async () => {},
    });

    assert.equal(result.ok, false);
    assert.equal(result.fail_reason, "guard-empty-replace");
    // Cache antigo preservado — o guard recusou sobrescrever.
    const written = JSON.parse(readFileSync(resolve(postsDir, "kit_25654295.json"), "utf8"));
    assert.equal(written.stats.clicks.length, 1);
  });

  it("rejeta erro inesperado de applyFn (não EmptyReplaceGuardError) em vez de engolir", async () => {
    const { postsDir } = setup();
    await assert.rejects(
      () =>
        enrichOneBroadcast("25654296", {
          append: false,
          postsDir,
          fetchClicks: async () => fakePage([fakeClick("https://a.com/", 1)]),
          applyFn: () => {
            throw new Error("disco cheio");
          },
          sleepFn: async () => {},
        }),
      /disco cheio/,
    );
  });
});

describe("enrichBatch — lote fail-soft por item", () => {
  it("processa vários broadcasts, 1 falha não aborta o lote", async () => {
    const { postsDir } = setup();
    const progress: string[] = [];
    const result = await enrichBatch(["1", "2", "3"], {
      postsDir,
      append: false,
      sleepFn: async () => {},
      onProgress: (line) => progress.push(line),
      fetchClicks: async (id) => {
        if (id === 2) throw new Error("boom");
        return fakePage([fakeClick(`https://x.com/${id}`, 1)]);
      },
    });

    assert.equal(result.processed, 3);
    assert.equal(result.ok, 2);
    assert.equal(result.fail, 1);
    assert.deepEqual(result.failed_broadcasts, ["2"]);
    assert.equal(result.total_links_applied, 2);
    assert.equal(progress.length, 3);
    assert.match(progress[1], /^fail 2\/3 kit_2 → fetch-error$/);
  });

  it("lote vazio devolve zeros sem chamar nada", async () => {
    const result = await enrichBatch([], {
      append: false,
      sleepFn: async () => {},
      fetchClicks: async () => {
        throw new Error("não devia ser chamado");
      },
    });
    assert.deepEqual(result, { processed: 0, ok: 0, fail: 0, total_links_applied: 0, failed_broadcasts: [] });
  });
});

describe("deriveBroadcastIdsFromCycle — deriva ids de raw-posts/", () => {
  it("extrai id8 dos nomes post_{id8}_{AAMMDD}.txt", () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-clicks-enrich-cycle-"));
    writeFileSync(resolve(dir, "post_25654292_260601.txt"), "conteudo");
    writeFileSync(resolve(dir, "post_25623204_260602.txt"), "conteudo");
    writeFileSync(resolve(dir, "notas.md"), "ignorar");

    const ids = deriveBroadcastIdsFromCycle("2605-06", dir);
    assert.deepEqual(ids, ["25623204", "25654292"]);
  });

  it("devolve [] quando o diretório não existe", () => {
    const ids = deriveBroadcastIdsFromCycle("2605-06", resolve(tmpdir(), "kit-clicks-enrich-inexistente"));
    assert.deepEqual(ids, []);
  });
});

describe("integração real com applyKitClicks (não fake) — confirma o contrato compartilhado", () => {
  it("enrichOneBroadcast sem applyFn override usa applyKitClicks de verdade", async () => {
    const { postsDir } = setup();
    const result = await enrichOneBroadcast("99999999", {
      append: false,
      postsDir,
      fetchClicks: async () => fakePage([fakeClick("https://real.com/", 4)]),
      sleepFn: async () => {},
    });
    assert.equal(result.ok, true);
    // Reler via applyKitClicks com stdin vazio de clicks + append pra confirmar
    // que o cache no disco é o mesmo formato que apply-mcp-kit-clicks.ts entende.
    const reapplied = applyKitClicks(JSON.stringify({ clicks: [] }), {
      id8: "99999999",
      append: true,
      postsDir,
    });
    assert.equal(reapplied.before_count, 1);
    assert.equal(reapplied.after_count, 1); // append com [] não remove nada
  });
});
