/**
 * test/claude-semanal-review-14353.test.ts (#14329, review do PR #14353)
 *
 * Regressões dos achados da review do PR #14353 no e-mail semanal "Claude na
 * semana": volume nunca bloqueia o `--send` (a semana não é pulada), janela
 * ancorada no último envio, cobertura do feed, `--merge` sem coleta anterior,
 * `--force` preservando o dedup, avisos de semanas puladas pelo dedup, e os
 * caminhos de incidente (cancel-failed, pending, registro ambíguo). Kit
 * MOCKADO: nenhum teste chama a API de verdade.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ClaudeSemanalGuardError,
  ClaudeSemanalIncidentError,
  feedCoverageGap,
  normalizeClaudeSemanalUrl,
  sentUrlsFromRecords,
  type ClaudeSemanalDraft,
} from "../scripts/lib/claude-semanal.ts";
import { claudeSemanalPaths } from "../scripts/lib/claude-semanal-store.ts";
import { claudeSemanalExitCode, runClaudeSemanal, type ClaudeSemanalDeps } from "../scripts/publish-claude-semanal-kit.ts";
import { runClaudeSemanalCollect } from "../scripts/claude-semanal-collect.ts";
import { KitApiError } from "../scripts/lib/kit-client.ts";
import type { CreateBroadcastInput } from "../scripts/lib/kit-broadcasts.ts";

const WEEK = "261129"; // domingo
const NOW = new Date("2026-11-28T15:00:00.000Z");

const BASE_CONFIG = {
  audience_tag: "claude-semanal",
  audience_niveis: ["patrono"],
  send_weekday: 0,
  send_time_brt: "08:00",
  min_items: 8,
  max_items: 15,
  sources: [{ name: "Blog do Claude", url: "https://claude.com/resources/articles/rss.xml", kind: "rss" }],
};

function draft(n = 10, prefix = "item"): ClaudeSemanalDraft {
  const items = Array.from({ length: n }, (_, i) => ({
    title: `Recurso novo ${i + 1}`,
    resumo: "O app ganhou um recurso. Vale para os planos Pro e Max.",
    como_usar: "No app, abra um projeto e ative o recurso em Configurações.",
    url: `https://claude.com/blog/${prefix}-${i + 1}`,
  }));
  return {
    week: WEEK,
    subject: "Claude ganha memória nos projetos",
    intro: "A semana trouxe memória nos projetos.",
    sections: [
      { id: "lancamentos", items: items.slice(0, 3) },
      { id: "dia-a-dia", items: items.slice(3, 6) },
      { id: "claude-code", items: items.slice(6, 8) },
      { id: "aprenda", items: items.slice(8) },
    ],
  };
}

interface Calls {
  created: CreateBroadcastInput[];
  deleted: number[];
}

function mockDeps(calls: Calls, reread?: Record<string, unknown>): Partial<ClaudeSemanalDeps> {
  let deleted = false;
  return {
    findTagId: async () => 42,
    countTagMembers: async () => 7,
    createBroadcast: async (input) => {
      calls.created.push(input);
      return { id: 9001 };
    },
    getBroadcast: async () => {
      if (deleted) throw new KitApiError("not found", 404, "");
      return (
        reread ?? {
          subscriber_filter: calls.created.at(-1)?.subscriber_filter,
          status: "scheduled",
          send_at: calls.created.at(-1)?.send_at,
          public: false,
        }
      );
    },
    deleteBroadcast: async (id) => {
      calls.deleted.push(id);
      deleted = true;
    },
    resolveKitConfig: () => ({ ok: true, config: { apiKey: "test", baseUrl: "https://kit.invalid" } }) as never,
    sleep: async () => {},
  };
}

describe("publicador (#14353)", () => {
  let dir: string;
  const logs: string[] = [];
  const log = (m: string) => logs.push(m);

  function setup(d: ClaudeSemanalDraft = draft()) {
    writeFileSync(join(dir, "platform.config.json"), JSON.stringify({ kit_claude_semanal: BASE_CONFIG }));
    const p = claudeSemanalPaths(dir, d.week);
    mkdirSync(p.internalDir, { recursive: true });
    writeFileSync(p.draftPath, JSON.stringify(d));
    return p;
  }
  const send = (deps: Partial<ClaudeSemanalDeps>, force = false) =>
    runClaudeSemanal({ rootDir: dir, dataRoot: dir, week: WEEK, mode: { kind: "send", force }, log, now: () => NOW, deps });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claude-semanal-14353-"));
    logs.length = 0;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("BLOQUEADOR: --send com 5 itens (abaixo do mínimo) CRIA o broadcast; volume no registro e no log", async () => {
    const p = setup(draft(5));
    const calls: Calls = { created: [], deleted: [] };
    const res = await send(mockDeps(calls));
    assert.equal(res.kind, "enviado");
    assert.equal(calls.created.length, 1, "a semana não pode terminar sem broadcast por volume");
    const rec = JSON.parse(readFileSync(p.publishedPath, "utf8"));
    assert.deepEqual(rec.volume, { kind: "abaixo", count: 5, faltam: 3 });
    assert.deepEqual(rec.audienceVerification, { status: "confirmed" });
    assert.ok(logs.some((l) => /AVISO de volume/.test(l)), logs.join("\n"));
  });

  it("acima do teto também sai, com volume 'acima'; o dry-run devolve o volume sem problema bloqueante", async () => {
    const p = setup(draft(17));
    const dry = await runClaudeSemanal({ rootDir: dir, dataRoot: dir, week: WEEK, mode: { kind: "dry-run", checkAudience: false }, log, now: () => NOW });
    assert.equal(dry.kind === "dry-run" && dry.volume.kind, "acima");
    assert.equal(dry.kind === "dry-run" && dry.problems.length, 0);
    await send(mockDeps({ created: [], deleted: [] }));
    assert.equal(JSON.parse(readFileSync(p.publishedPath, "utf8")).volume.kind, "acima");
  });

  it("--force por cima de um sent guarda os itens anteriores em previousItems, e o dedup seguinte os lê", async () => {
    setup(draft(10));
    await send(mockDeps({ created: [], deleted: [] }));
    const p = setup(draft(10, "novo"));
    await send(mockDeps({ created: [], deleted: [] }), true);
    const rec = JSON.parse(readFileSync(p.publishedPath, "utf8"));
    assert.equal(rec.items[0].url, "https://claude.com/blog/novo-1");
    assert.equal(rec.previousItems.length, 10);
    const { sent } = sentUrlsFromRecords([{ week: WEEK, raw: rec }], "261206");
    assert.equal(sent.get(normalizeClaudeSemanalUrl("https://claude.com/blog/item-1")), WEEK, "item do 1º envio continua no dedup");
    assert.equal(sent.get(normalizeClaudeSemanalUrl("https://claude.com/blog/novo-1")), WEEK);
  });

  it("avisa no log as semanas pending/cancel-failed que o dedup pula", async () => {
    setup();
    const old = claudeSemanalPaths(dir, "261122");
    mkdirSync(old.internalDir, { recursive: true });
    writeFileSync(old.publishedPath, JSON.stringify({ status: "pending", week: "261122", attemptedAt: "x" }));
    await runClaudeSemanal({ rootDir: dir, dataRoot: dir, week: WEEK, mode: { kind: "dry-run", checkAudience: false }, log, now: () => NOW });
    assert.ok(logs.some((l) => /dedup não considera.*261122 \(pending\)/.test(l)), logs.join("\n"));
  });

  it("cancel-failed (DELETE falha): não cancelado, broadcastId no erro, registro cancel-failed, próxima execução recusada", async () => {
    const p = setup();
    const deps = mockDeps({ created: [], deleted: [] }, { subscriber_filter: [], status: "scheduled", send_at: "2026-11-29T11:00:00.000Z" });
    deps.deleteBroadcast = async () => {
      throw new Error("500 do Kit");
    };
    await assert.rejects(send(deps), (e: Error) => {
      assert.ok(e instanceof ClaudeSemanalIncidentError);
      assert.equal((e as ClaudeSemanalIncidentError).cancelled, false);
      assert.equal((e as ClaudeSemanalIncidentError).broadcastId, 9001);
      assert.match(e.message, /Cancele AGORA/);
      return true;
    });
    const rec = JSON.parse(readFileSync(p.publishedPath, "utf8"));
    assert.equal(rec.status, "cancel-failed");
    assert.equal(rec.broadcastId, 9001);
    const again: Calls = { created: [], deleted: [] };
    await assert.rejects(send(mockDeps(again)), ClaudeSemanalIncidentError);
    assert.equal(again.created.length, 0);
  });

  it("cancel-failed (DELETE ok mas o broadcast continua existindo na releitura)", async () => {
    const p = setup();
    const calls: Calls = { created: [], deleted: [] };
    const deps = mockDeps(calls);
    deps.getBroadcast = async () => ({ subscriber_filter: [], status: "scheduled", send_at: "2026-11-29T11:00:00.000Z" });
    deps.deleteBroadcast = async (id) => {
      calls.deleted.push(id);
    };
    await assert.rejects(send(deps), (e: Error) => {
      assert.ok(e instanceof ClaudeSemanalIncidentError);
      assert.equal((e as ClaudeSemanalIncidentError).cancelled, false);
      assert.match(e.message, /continua existindo/);
      return true;
    });
    assert.deepEqual(calls.deleted, [9001]);
    assert.equal(JSON.parse(readFileSync(p.publishedPath, "utf8")).status, "cancel-failed");
  });

  it("throw no createBroadcast deixa o pending no disco (a próxima execução não duplica)", async () => {
    const p = setup();
    const deps = mockDeps({ created: [], deleted: [] });
    deps.createBroadcast = async () => {
      throw new Error("timeout");
    };
    await assert.rejects(send(deps), (e: Error) => e instanceof ClaudeSemanalIncidentError && /PODE tê-lo aceitado/.test(e.message));
    assert.equal(JSON.parse(readFileSync(p.publishedPath, "utf8")).status, "pending");
    const again: Calls = { created: [], deleted: [] };
    await assert.rejects(send(mockDeps(again)), ClaudeSemanalIncidentError);
    assert.equal(again.created.length, 0);
  });

  it("registro ilegível e 'sent' sem broadcastId são ambíguos (nunca 'já enviado' nem 'nunca enviado')", async () => {
    for (const body of ["{ isto não é json", JSON.stringify({ status: "sent", week: WEEK, sendAt: "2026-11-29T11:00:00.000Z" })]) {
      const p = setup();
      writeFileSync(p.publishedPath, body);
      const calls: Calls = { created: [], deleted: [] };
      await assert.rejects(send(mockDeps(calls)), (e: Error) => e instanceof ClaudeSemanalIncidentError && /estado ambíguo/.test(e.message));
      assert.equal(calls.created.length, 0);
    }
  });
});

describe("exit codes (#14353)", () => {
  it("cancelado com exclusão conferida sai 3 (nada saiu); incidente sem cancelamento sai 1; guard sai 2", () => {
    assert.equal(claudeSemanalExitCode(new ClaudeSemanalIncidentError("x", 1, true)), 3);
    assert.equal(claudeSemanalExitCode(new ClaudeSemanalIncidentError("x", 1, false)), 1);
    assert.equal(claudeSemanalExitCode(new ClaudeSemanalGuardError("x")), 2);
    assert.equal(claudeSemanalExitCode(new Error("x")), 1);
  });
});

describe("dedup puro (#14353)", () => {
  it("pending/cancel-failed com um sent em previous mantém os itens dele, e as semanas vão para skipped", () => {
    const prev = JSON.stringify({ status: "sent", items: [{ url: "https://claude.com/blog/a", title: "A", section: "dia-a-dia" }] });
    const r = sentUrlsFromRecords(
      [
        { week: "261122", raw: { status: "pending", previous: prev } },
        { week: "261115", raw: { status: "cancel-failed", broadcastId: 1 } },
      ],
      WEEK,
    );
    assert.equal(r.sent.get(normalizeClaudeSemanalUrl("https://claude.com/blog/a")), "261122");
    assert.deepEqual(r.skipped, ["261122 (pending)", "261115 (cancel-failed)"]);
  });
});

describe("coleta (#14353)", () => {
  let dir: string;
  const logs: string[] = [];
  const log = (m: string) => logs.push(m);
  const CONFIG = {
    ...BASE_CONFIG,
    sources: [
      {
        name: "Claude Code (releases)",
        url: "https://github.com/anthropics/claude-code/releases.atom",
        kind: "rss",
        coverage_page: "https://code.claude.com/docs/en/changelog",
      },
      { name: "Anthropic News", url: "https://www.anthropic.com/news", kind: "page" },
    ],
  };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claude-semanal-14353c-"));
    logs.length = 0;
    writeFileSync(join(dir, "platform.config.json"), JSON.stringify({ kit_claude_semanal: CONFIG }));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const feed = (articles: { url: string; published_at: string }[], truncated = 0) => ({
    fetchFeed: async (o: { url: string; sourceName: string }) => ({
      source: o.sourceName,
      method: "rss" as const,
      feed_url: o.url,
      articles: articles.map((a) => ({ ...a, title: a.url.split("/").pop() ?? "x", summary: "" })),
      ...(truncated ? { truncated_by_cap: truncated } : {}),
    }),
  });
  const REL = (v: string) => `https://github.com/anthropics/claude-code/releases/tag/${v}`;
  const collect = (extra: Partial<Parameters<typeof runClaudeSemanalCollect>[0]>) =>
    runClaudeSemanalCollect({ rootDir: dir, dataRoot: dir, week: WEEK, log, now: () => NOW, ...extra });

  it("feedCoverageGap: entrada mais antiga após o início da janela é buraco; teto com a mais antiga anterior não é", () => {
    const start = "2026-11-15T03:00:00.000Z";
    assert.match(feedCoverageGap([{ published_at: "2026-11-20T00:00:00Z" }], 0, start) ?? "", /não alcança a janela/);
    assert.match(feedCoverageGap([{ published_at: "2026-11-20T00:00:00Z" }], 5, start) ?? "", /cortado pelo teto/);
    assert.equal(feedCoverageGap([{ published_at: "2026-11-01T00:00:00Z" }, { published_at: "2026-11-20T00:00:00Z" }], 5, start), null);
    assert.equal(feedCoverageGap([], 0, start), null);
  });

  it("feed que não alcança a janela vira feed_errors e a página de cobertura entra em pages_to_fetch", async () => {
    const out = await collect({ deps: feed([{ url: REL("v3"), published_at: "2026-11-25T00:00:00Z" }], 12) });
    assert.equal(out.feed_errors.length, 1);
    assert.match(out.feed_errors[0].error, /cobertura incompleta/);
    assert.ok(out.pages_to_fetch.some((p) => p.url === "https://code.claude.com/docs/en/changelog"), JSON.stringify(out.pages_to_fetch));
    assert.ok(out.pages_to_fetch.some((p) => p.url === "https://www.anthropic.com/news"));
    assert.equal(out.candidates.length, 1, "o que o feed trouxe dentro da janela continua valendo");
  });

  it("feed que alcança a janela não gera erro nem página de cobertura; o antigo só conta em out_of_window_count", async () => {
    const out = await collect({
      deps: feed([
        { url: REL("v1"), published_at: "2026-11-01T00:00:00Z" },
        { url: REL("v3"), published_at: "2026-11-25T00:00:00Z" },
      ]),
    });
    assert.deepEqual(out.feed_errors, []);
    assert.deepEqual(out.pages_to_fetch.map((p) => p.name), ["Anthropic News"]);
    assert.equal(out.out_of_window_count, 1);
  });

  it("--merge sem 01-candidates.json busca os feeds de novo antes de mesclar", async () => {
    const mergePath = join(dir, "merge-14353.json");
    writeFileSync(mergePath, JSON.stringify([{ url: "https://www.anthropic.com/news/x", title: "X", published_at: "2026-11-26T12:00:00Z" }]));
    let fetched = 0;
    const f = feed([{ url: REL("v3"), published_at: "2026-11-25T00:00:00Z" }]);
    const out = await collect({ mergePath, deps: { fetchFeed: async (o) => (fetched++, f.fetchFeed(o)) } });
    assert.equal(fetched, 1);
    assert.equal(out.candidates.length, 2, "páginas + feed, nunca só as páginas");
    assert.ok(logs.some((l) => /buscando os feeds de novo/.test(l)));
  });

  it("--merge sobre 01-candidates.json ilegível também rebusca os feeds", async () => {
    const p = claudeSemanalPaths(dir, WEEK);
    mkdirSync(p.internalDir, { recursive: true });
    writeFileSync(p.candidatesPath, "{ quebrado");
    const mergePath = join(dir, "merge-14353.json");
    writeFileSync(mergePath, "[]");
    let fetched = 0;
    const f = feed([]);
    await collect({ mergePath, deps: { fetchFeed: async (o) => (fetched++, f.fetchFeed(o)) } });
    assert.equal(fetched, 1);
  });

  it("--merge sobre coleta legível herda os feed_errors gravados, e pages_to_fetch sai deles", async () => {
    await collect({ deps: feed([{ url: REL("v3"), published_at: "2026-11-25T00:00:00Z" }], 3) });
    const mergePath = join(dir, "merge-14353.json");
    writeFileSync(mergePath, "[]");
    const out = await collect({
      mergePath,
      deps: { fetchFeed: async () => assert.fail("merge sobre coleta legível não rebusca os feeds") },
    });
    assert.equal(out.feed_errors.length, 1);
    assert.ok(out.pages_to_fetch.some((p) => p.url === "https://code.claude.com/docs/en/changelog"));
  });

  it("banner quando o domingo anterior não tem sent", async () => {
    const out = await collect({ deps: feed([]) });
    assert.match(out.banner ?? "", /semana anterior não tem envio registrado/);
    assert.ok(logs.some((l) => /AVISO: a semana anterior/.test(l)));
  });
});
