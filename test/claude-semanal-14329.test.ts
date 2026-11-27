/**
 * test/claude-semanal-14329.test.ts (#14329)
 *
 * E-mail semanal "Claude na semana": miolo puro (`scripts/lib/claude-semanal.ts`),
 * coleta (`scripts/claude-semanal-collect.ts`) e envio
 * (`scripts/publish-claude-semanal-kit.ts`) com o Kit MOCKADO — nenhum teste
 * chama a API de verdade.
 *
 * Critérios de pronto da issue cobertos aqui: tag vazia/inexistente recusa o
 * envio (nunca cai na base inteira), `public: false` no payload, dedup entre
 * semanas, e a semana nunca é pulada por falta de itens.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ClaudeSemanalGuardError,
  ClaudeSemanalIncidentError,
  claudeSemanalCopyProblems,
  claudeSemanalDraftProblems,
  defaultClaudeSemanalWeek,
  evaluateClaudeSemanalVolume,
  isOfficialClaudeUrl,
  normalizeClaudeSemanalUrl,
  parseClaudeSemanalDraft,
  renderClaudeSemanalEmail,
  resolveClaudeSemanalConfig,
  resolveClaudeSemanalSendAt,
  resolveClaudeSemanalWeek,
  selectWeekCandidates,
  sentUrlsFromRecords,
  type ClaudeSemanalDraft,
} from "../scripts/lib/claude-semanal.ts";
import { claudeSemanalPaths } from "../scripts/lib/claude-semanal-store.ts";
import {
  buildClaudeSemanalBroadcastInput,
  runClaudeSemanal,
  verifyClaudeSemanalReread,
  type ClaudeSemanalDeps,
} from "../scripts/publish-claude-semanal-kit.ts";
import { runClaudeSemanalCollect } from "../scripts/claude-semanal-collect.ts";
import { KitApiError } from "../scripts/lib/kit-client.ts";
import type { CreateBroadcastInput } from "../scripts/lib/kit-broadcasts.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WEEK = "261129"; // domingo
const NOW = new Date("2026-11-28T15:00:00.000Z"); // sábado, antes do envio

const BASE_CONFIG = {
  audience_tag: "claude-semanal",
  audience_niveis: ["patrono"],
  send_weekday: 0,
  send_time_brt: "08:00",
  min_items: 8,
  max_items: 15,
  preview_text: "Exclusivo para apoiadores",
  footer_note: "Você recebe este e-mail porque apoia a diar.ia.br.",
  sources: [{ name: "Blog do Claude", url: "https://claude.com/resources/articles/rss.xml", kind: "rss" }],
};

function item(n: number, url = `https://claude.com/blog/item-${n}`) {
  return {
    title: `Recurso novo ${n}`,
    resumo: "O app ganhou um recurso. Vale para os planos Pro e Max.",
    como_usar: "No app, abra um projeto e ative o recurso em Configurações.",
    url,
  };
}

function draft(n = 10, week = WEEK): ClaudeSemanalDraft {
  const items = Array.from({ length: n }, (_, i) => item(i + 1));
  return {
    week,
    subject: "Claude ganha memória nos projetos",
    subject_options: ["Claude ganha memória nos projetos"],
    intro: "A semana trouxe memória nos projetos e um comando novo no Claude Code.",
    sections: [
      { id: "lancamentos", items: items.slice(0, 3) },
      { id: "dia-a-dia", items: items.slice(3, 6) },
      { id: "claude-code", items: items.slice(6, 8) },
      { id: "aprenda", items: items.slice(8) },
    ],
  };
}

// ── config ────────────────────────────────────────────────────────────────

describe("resolveClaudeSemanalConfig (#14329)", () => {
  it("aceita o bloco do platform.config.json real", () => {
    const cfg = JSON.parse(readFileSync(join(ROOT, "platform.config.json"), "utf8"));
    const r = resolveClaudeSemanalConfig(cfg.kit_claude_semanal);
    assert.equal(r.ok, true, r.ok ? "" : r.reason);
    if (!r.ok) return;
    assert.deepEqual(r.config.audienceNiveis, ["patrono"], "fase de teste: só o Núcleo");
    assert.equal(r.config.sendWeekday, 0);
    assert.equal(r.config.sendTimeBrt, "08:00");
    assert.equal(r.config.minItems, 8);
    assert.equal(r.config.maxItems, 15);
    assert.ok(r.config.sources.every((s) => isOfficialClaudeUrl(s.url)), "toda fonte configurada é oficial");
  });

  it("tag ausente ou vazia recusa — nunca default silencioso (base inteira, #6126)", () => {
    for (const audience_tag of [undefined, "", "   "]) {
      const r = resolveClaudeSemanalConfig({ ...BASE_CONFIG, audience_tag });
      assert.equal(r.ok, false);
      if (!r.ok) assert.match(r.reason, /BASE INTEIRA/);
    }
  });

  it("níveis ausentes, vazios ou inválidos recusam (o público é config, nunca suposto)", () => {
    assert.equal(resolveClaudeSemanalConfig({ ...BASE_CONFIG, audience_niveis: undefined }).ok, false);
    assert.equal(resolveClaudeSemanalConfig({ ...BASE_CONFIG, audience_niveis: [] }).ok, false);
    assert.equal(resolveClaudeSemanalConfig({ ...BASE_CONFIG, audience_niveis: ["vip"] }).ok, false);
  });

  it("trocar o público é só config: outros níveis passam sem mudar código", () => {
    const r = resolveClaudeSemanalConfig({ ...BASE_CONFIG, audience_niveis: ["mantenedor", "Patrono "] });
    assert.equal(r.ok, true);
    if (r.ok) assert.deepEqual(r.config.audienceNiveis, ["mantenedor", "patrono"]);
  });

  it("fonte de terceiro no config é recusada", () => {
    const r = resolveClaudeSemanalConfig({
      ...BASE_CONFIG,
      sources: [{ name: "Blog de terceiro", url: "https://example.com/claude-tips", kind: "page" }],
    });
    assert.equal(r.ok, false);
  });
});

// ── semana e horário ──────────────────────────────────────────────────────

describe("semana e horário (#14329)", () => {
  it("janela de 8 dias, de domingo a domingo, em BRT", () => {
    const w = resolveClaudeSemanalWeek(WEEK, 0);
    assert.equal(w.firstDay, "2026-11-22");
    assert.equal(w.lastDay, "2026-11-29");
    assert.equal(w.windowStart, "2026-11-22T03:00:00.000Z");
    assert.equal(w.windowEnd, "2026-11-30T03:00:00.000Z");
  });

  it("data fora do dia de envio configurado é recusada", () => {
    assert.throws(() => resolveClaudeSemanalWeek("261128", 0), ClaudeSemanalGuardError);
    assert.throws(() => resolveClaudeSemanalWeek("261340", 0), ClaudeSemanalGuardError);
  });

  it("semana default é o próximo domingo, hoje incluído", () => {
    assert.equal(defaultClaudeSemanalWeek(NOW, 0), WEEK);
    assert.equal(defaultClaudeSemanalWeek(new Date("2026-11-29T10:00:00.000Z"), 0), WEEK);
    assert.equal(defaultClaudeSemanalWeek(new Date("2026-11-30T12:00:00.000Z"), 0), "261206");
  });

  it("domingo 08:00 BRT = 11:00 UTC", () => {
    assert.deepEqual(resolveClaudeSemanalSendAt(WEEK, "08:00", NOW), { sendAt: "2026-11-29T11:00:00.000Z", late: false });
  });

  it("horário já passado não pula a semana: agenda para daqui a pouco e marca late", () => {
    const late = resolveClaudeSemanalSendAt(WEEK, "08:00", new Date("2026-11-29T12:00:00.000Z"));
    assert.equal(late.late, true);
    assert.equal(late.sendAt, "2026-11-29T12:10:00.000Z");
  });
});

// ── fonte oficial e dedup ─────────────────────────────────────────────────

describe("fonte oficial e dedup entre semanas (#14329)", () => {
  it("só Anthropic/Claude (e o GitHub da anthropics) contam como oficiais", () => {
    for (const u of [
      "https://www.anthropic.com/news/claude-x",
      "https://claude.com/blog/x",
      "https://support.claude.com/en/articles/1",
      "https://code.claude.com/docs/en/changelog",
      "https://academy.claude.com/",
      "https://github.com/anthropics/claude-code/releases/tag/v2.0.0",
    ]) {
      assert.equal(isOfficialClaudeUrl(u), true, u);
    }
    for (const u of [
      "https://github.com/someone/claude-tips",
      "https://anthropic.com.evil.example/x",
      "https://www.reddit.com/r/ClaudeAI/",
      "http://www.anthropic.com/news",
      "nota",
    ]) {
      assert.equal(isOfficialClaudeUrl(u), false, u);
    }
  });

  it("normalização casa www, barra final, fragmento e utm", () => {
    assert.equal(
      normalizeClaudeSemanalUrl("https://WWW.anthropic.com/news/x/?utm_source=a#top"),
      normalizeClaudeSemanalUrl("https://anthropic.com/news/x"),
    );
  });

  it("registros sent de outras semanas viram o conjunto de dedup; pending e a própria semana não contam", () => {
    const { sent, unreadable } = sentUrlsFromRecords(
      [
        { week: "261122", raw: { status: "sent", items: [{ url: "https://claude.com/blog/a/", title: "A", section: "dia-a-dia" }] } },
        { week: "261115", raw: { status: "pending" } },
        { week: WEEK, raw: { status: "sent", items: [{ url: "https://claude.com/blog/b", title: "B", section: "dia-a-dia" }] } },
        { week: "261108", raw: null },
      ],
      WEEK,
    );
    assert.equal(sent.get(normalizeClaudeSemanalUrl("https://claude.com/blog/a")), "261122");
    assert.equal(sent.has(normalizeClaudeSemanalUrl("https://claude.com/blog/b")), false);
    assert.deepEqual(unreadable, ["261108"]);
  });

  it("selectWeekCandidates: já enviado, fora da janela, sem data e terceiro ficam de fora", () => {
    const week = resolveClaudeSemanalWeek(WEEK, 0);
    const sent = new Map([[normalizeClaudeSemanalUrl("https://claude.com/blog/velho"), "261122"]]);
    const sel = selectWeekCandidates(
      [
        { url: "https://claude.com/blog/novo", title: "Novo", published_at: "2026-11-25T12:00:00Z" },
        { url: "https://claude.com/blog/novo/", title: "Novo de novo", published_at: "2026-11-25T12:00:00Z" },
        { url: "https://claude.com/blog/velho", title: "Velho", published_at: "2026-11-25T12:00:00Z" },
        { url: "https://claude.com/blog/antigo", title: "Antigo", published_at: "2026-11-10T12:00:00Z" },
        { url: "https://claude.com/blog/sem-data", title: "Sem data", published_at: null },
        { url: "https://example.com/dica", title: "Dica", published_at: "2026-11-25T12:00:00Z" },
      ],
      week,
      sent,
    );
    assert.deepEqual(sel.candidates.map((c) => c.url), ["https://claude.com/blog/novo"]);
    assert.deepEqual(sel.alreadySent.map((c) => c.week), ["261122"]);
    assert.equal(sel.outOfWindow.length, 1);
    assert.equal(sel.rejected.length, 2);
  });

  it("rascunho com item já enviado em outra semana é recusado", () => {
    const d = draft();
    const sent = new Map([[normalizeClaudeSemanalUrl(d.sections[0].items[0].url), "261122"]]);
    const problems = claudeSemanalDraftProblems(d, { minItems: 8, maxItems: 15, sent });
    assert.ok(problems.some((p) => /já enviado na semana 261122/.test(p)), problems.join("\n"));
  });
});

// ── volume: nunca pula semana ─────────────────────────────────────────────

describe("volume — a semana nunca é pulada (#14329)", () => {
  it("nenhuma contagem produz uma saída de pular/não enviar", () => {
    for (let n = 0; n <= 20; n++) {
      const v = evaluateClaudeSemanalVolume(n, 8, 15);
      assert.ok(["ok", "abaixo", "acima"].includes(v.kind), `kind inesperado: ${v.kind}`);
      if (v.kind === "abaixo") {
        assert.match(v.instrucao, /ampliar a coleta/);
        assert.match(v.instrucao, /nunca é pulada/);
      }
    }
  });

  it("o gate da skill não oferece pular a semana", () => {
    const skill = readFileSync(join(ROOT, ".claude/skills/diaria-claude-semanal/SKILL.md"), "utf8");
    const gate = skill.slice(skill.indexOf("## Passo 6"), skill.indexOf("## Passo 7"));
    assert.ok(gate.length > 0, "Passo 6 (gate) ausente");
    const options = gate.split("\n").filter((l) => /^- \*\*/.test(l));
    assert.ok(options.length >= 2, "gate sem opções listadas");
    for (const o of options) assert.doesNotMatch(o, /pular|não enviar|cancelar|sem e-mail/i, o);
  });
});

// ── cópia e render ────────────────────────────────────────────────────────

describe("cópia e render (#14329)", () => {
  it("seta, markdown e URL no texto são recusados", () => {
    assert.ok(claudeSemanalCopyProblems("Abra o app → Configurações", "x").length > 0);
    assert.ok(claudeSemanalCopyProblems("Use o **modo** novo", "x").length > 0);
    assert.ok(claudeSemanalCopyProblems("- item", "x").length > 0);
    assert.ok(claudeSemanalCopyProblems("Veja em https://claude.com", "x").length > 0);
    assert.deepEqual(claudeSemanalCopyProblems("No app, abra um projeto - e siga.", "x"), []);
  });

  it("rascunho válido de 10 itens não tem problema; 5 itens acusa volume", () => {
    assert.deepEqual(claudeSemanalDraftProblems(draft(10), { minItems: 8, maxItems: 15, sent: new Map() }), []);
    const p = claudeSemanalDraftProblems(draft(5), { minItems: 8, maxItems: 15, sent: new Map() });
    assert.ok(p.some((x) => /volume: faltam 3/.test(x)), p.join("\n"));
  });

  it("parse estrito: semana errada, seção desconhecida e campo vazio lançam", () => {
    assert.throws(() => parseClaudeSemanalDraft({ ...draft(), week: "261122" }, WEEK), ClaudeSemanalGuardError);
    assert.throws(
      () => parseClaudeSemanalDraft({ ...draft(), sections: [{ id: "comunidade", items: [] }] }, WEEK),
      ClaudeSemanalGuardError,
    );
    const bad = draft();
    (bad.sections[0].items[0] as { como_usar: string }).como_usar = "";
    assert.throws(() => parseClaudeSemanalDraft(bad, WEEK), ClaudeSemanalGuardError);
  });

  it("render: seções na ordem fixa, Como usar, sem seta, chaves escapadas para o Liquid do Kit", () => {
    const d = draft(10);
    d.sections[1].items[0].resumo = "Use {{ variavel }} no prompt.";
    const r = renderClaudeSemanalEmail(d, resolveClaudeSemanalWeek(WEEK, 0), { previewText: "Exclusivo para apoiadores", footerNote: null });
    assert.equal(r.subject, "Claude na semana: Claude ganha memória nos projetos");
    assert.equal(r.previewText, "Exclusivo para apoiadores");
    const order = ["Lançamentos", "No dia a dia", "Claude Code", "Aprenda"].map((t) => r.html.indexOf(`>${t}</h2>`));
    assert.deepEqual([...order].sort((a, b) => a - b), order);
    assert.ok(order.every((i) => i > 0));
    assert.match(r.html, /<strong>Como usar:<\/strong>/);
    assert.doesNotMatch(r.html, /[→←]/);
    assert.doesNotMatch(r.html, /\{\{/);
    assert.match(r.html, /22\/nov a 29\/nov/);
  });
});

// ── envio com Kit mockado ─────────────────────────────────────────────────

interface Calls {
  created: CreateBroadcastInput[];
  deleted: number[];
}

function mockDeps(
  calls: Calls,
  opts: { tagId?: number | null; members?: number; reread?: Record<string, unknown> | null } = {},
): Partial<ClaudeSemanalDeps> {
  const tagId = opts.tagId === undefined ? 42 : opts.tagId;
  let deleted = false;
  return {
    findTagId: async () => tagId,
    countTagMembers: async () => opts.members ?? 7,
    createBroadcast: async (input) => {
      calls.created.push(input);
      return { id: 9001 };
    },
    getBroadcast: async () => {
      if (deleted) throw new KitApiError("not found", 404, "");
      return (
        opts.reread ?? {
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

describe("publish-claude-semanal-kit com Kit mockado (#14329)", () => {
  let dir: string;
  const logs: string[] = [];
  const log = (m: string) => logs.push(m);

  function setup(config: Record<string, unknown> = BASE_CONFIG, d: ClaudeSemanalDraft = draft()) {
    writeFileSync(join(dir, "platform.config.json"), JSON.stringify({ kit_claude_semanal: config }));
    const p = claudeSemanalPaths(dir, d.week);
    mkdirSync(p.internalDir, { recursive: true });
    writeFileSync(p.draftPath, JSON.stringify(d));
    return p;
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claude-semanal-14329-"));
    logs.length = 0;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const run = (mode: Parameters<typeof runClaudeSemanal>[0]["mode"], deps: Partial<ClaudeSemanalDeps>, week = WEEK) =>
    runClaudeSemanal({ rootDir: dir, dataRoot: dir, week, mode, log, now: () => NOW, deps });

  it("tag inexistente no Kit recusa o envio e não cria broadcast", async () => {
    const p = setup();
    const calls: Calls = { created: [], deleted: [] };
    await assert.rejects(run({ kind: "send", force: false }, mockDeps(calls, { tagId: null })), (e: Error) => {
      assert.ok(e instanceof ClaudeSemanalGuardError);
      assert.match(e.message, /não existe no Kit/);
      return true;
    });
    assert.equal(calls.created.length, 0);
    assert.equal(existsSync(p.publishedPath), false, "nenhum registro gravado");
  });

  it("tag VAZIA (0 membros) recusa o envio e não cria broadcast", async () => {
    setup();
    const calls: Calls = { created: [], deleted: [] };
    await assert.rejects(run({ kind: "send", force: false }, mockDeps(calls, { members: 0 })), (e: Error) => {
      assert.ok(e instanceof ClaudeSemanalGuardError);
      assert.match(e.message, /VAZIA/);
      return true;
    });
    assert.equal(calls.created.length, 0);
  });

  it("tag vazia no config recusa antes de qualquer chamada ao Kit", async () => {
    setup({ ...BASE_CONFIG, audience_tag: "" });
    const calls: Calls = { created: [], deleted: [] };
    let looked = false;
    await assert.rejects(
      run({ kind: "send", force: false }, { ...mockDeps(calls), findTagId: async () => ((looked = true), 42) }),
      ClaudeSemanalGuardError,
    );
    assert.equal(looked, false);
    assert.equal(calls.created.length, 0);
  });

  it("envio: payload com public: false, filtro da tag, agendado para domingo 08:00 BRT; registro com os itens", async () => {
    const p = setup();
    const calls: Calls = { created: [], deleted: [] };
    const res = await run({ kind: "send", force: false }, mockDeps(calls));
    assert.equal(res.kind, "enviado");
    assert.equal(calls.created.length, 1);
    const input = calls.created[0];
    assert.equal(input.public, false);
    assert.deepEqual(input.subscriber_filter, [{ all: [{ type: "tag", ids: [42] }] }]);
    assert.equal(input.send_at, "2026-11-29T11:00:00.000Z");
    const rec = JSON.parse(readFileSync(p.publishedPath, "utf8"));
    assert.equal(rec.status, "sent");
    assert.equal(rec.items.length, 10);
    assert.equal(rec.audienceMemberCount, 7);
  });

  it("dedup entre semanas: item enviado numa semana é recusado no rascunho da seguinte", async () => {
    setup();
    await run({ kind: "send", force: false }, mockDeps({ created: [], deleted: [] }));

    const next = draft(10, "261206");
    next.sections[0].items[0] = item(1); // mesma URL já enviada em 261129
    setup(BASE_CONFIG, next);
    const calls: Calls = { created: [], deleted: [] };
    await assert.rejects(
      runClaudeSemanal({
        rootDir: dir,
        dataRoot: dir,
        week: "261206",
        mode: { kind: "send", force: false },
        log,
        now: () => new Date("2026-12-05T15:00:00.000Z"),
        deps: mockDeps(calls),
      }),
      (e: Error) => {
        assert.ok(e instanceof ClaudeSemanalGuardError);
        assert.match(e.message, /já enviado na semana 261129/);
        return true;
      },
    );
    assert.equal(calls.created.length, 0);
  });

  it("dedup na coleta: o collect tira o que já saiu em outra semana", async () => {
    setup();
    await run({ kind: "send", force: false }, mockDeps({ created: [], deleted: [] }));
    setup(BASE_CONFIG, draft(10, "261206"));
    const out = await runClaudeSemanalCollect({
      rootDir: dir,
      dataRoot: dir,
      week: "261206",
      log,
      now: () => new Date("2026-12-05T15:00:00.000Z"),
      deps: {
        fetchFeed: async (o) => ({
          source: o.sourceName,
          method: "rss",
          feed_url: o.url,
          articles: [
            { url: "https://claude.com/blog/item-1", title: "Já saiu", published_at: "2026-12-01T12:00:00Z", summary: "" },
            { url: "https://claude.com/blog/novo", title: "Novo", published_at: "2026-12-02T12:00:00Z", summary: "" },
          ],
        }),
      },
    });
    assert.deepEqual(out.candidates.map((c) => c.url), ["https://claude.com/blog/novo"]);
    assert.deepEqual(out.already_sent.map((c) => c.week), ["261129"]);
    assert.equal(out.volume.kind, "abaixo", "volume baixo pede ampliar a coleta, não pular");
  });

  it("semana já enviada responde ja-enviado sem criar outro broadcast", async () => {
    setup();
    await run({ kind: "send", force: false }, mockDeps({ created: [], deleted: [] }));
    const calls: Calls = { created: [], deleted: [] };
    const res = await run({ kind: "send", force: false }, mockDeps(calls));
    assert.equal(res.kind, "ja-enviado");
    assert.equal(calls.created.length, 0);
  });

  it("releitura com public: true cancela o broadcast (exclusão conferida)", async () => {
    const p = setup();
    const calls: Calls = { created: [], deleted: [] };
    const deps = mockDeps(calls);
    const baseGet = deps.getBroadcast!;
    let first = true;
    deps.getBroadcast = async (id, c) => {
      if (first) {
        first = false;
        return { subscriber_filter: calls.created[0].subscriber_filter, status: "scheduled", send_at: calls.created[0].send_at, public: true };
      }
      return baseGet(id, c);
    };
    await assert.rejects(run({ kind: "send", force: false }, deps), (e: Error) => {
      assert.ok(e instanceof ClaudeSemanalIncidentError);
      assert.equal((e as ClaudeSemanalIncidentError).cancelled, true);
      return true;
    });
    assert.deepEqual(calls.deleted, [9001]);
    assert.equal(existsSync(p.publishedPath), false, "registro removido: nada saiu");
  });

  it("registro pending (tentativa interrompida) bloqueia o reenvio sem --force", async () => {
    const p = setup();
    writeFileSync(p.publishedPath, JSON.stringify({ status: "pending", week: WEEK, attemptedAt: "x" }));
    const calls: Calls = { created: [], deleted: [] };
    await assert.rejects(run({ kind: "send", force: false }, mockDeps(calls)), ClaudeSemanalIncidentError);
    assert.equal(calls.created.length, 0);
  });

  it("dry-run nunca chama o Kit e grava a prévia", async () => {
    const p = setup();
    const res = await run(
      { kind: "dry-run", checkAudience: false },
      {
        findTagId: async () => assert.fail("dry-run chamou o Kit"),
        createBroadcast: async () => assert.fail("dry-run criou broadcast"),
        resolveKitConfig: () => assert.fail("dry-run resolveu a config do Kit"),
      },
    );
    assert.equal(res.kind, "dry-run");
    if (res.kind === "dry-run") assert.deepEqual(res.problems, []);
    assert.ok(existsSync(p.previewHtmlPath));
    assert.ok(existsSync(p.previewTextPath));
  });

  it("--check-audience devolve a contagem da tag e recusa tag vazia", async () => {
    setup();
    const ok = await run({ kind: "dry-run", checkAudience: true }, mockDeps({ created: [], deleted: [] }, { members: 3 }));
    assert.equal(ok.kind === "dry-run" && ok.audienceMemberCount, 3);
    await assert.rejects(
      run({ kind: "dry-run", checkAudience: true }, mockDeps({ created: [], deleted: [] }, { members: 0 })),
      ClaudeSemanalGuardError,
    );
  });
});

describe("payload e releitura puros (#14329)", () => {
  it("buildClaudeSemanalBroadcastInput sempre public: false", () => {
    const d = draft();
    const email = renderClaudeSemanalEmail(d, resolveClaudeSemanalWeek(WEEK, 0), { previewText: null, footerNote: null });
    const input = buildClaudeSemanalBroadcastInput(email, WEEK, { tagName: "t", tagId: 5, memberCount: 2 } as never, "2026-11-29T11:00:00.000Z");
    assert.equal(input.public, false);
    assert.deepEqual(input.subscriber_filter, [{ all: [{ type: "tag", ids: [5] }] }]);
  });

  it("releitura: rascunho (sem agendamento) não confirma; filtro diferente diverge", () => {
    const filter = [{ all: [{ type: "tag", ids: [5] }] }];
    assert.equal(verifyClaudeSemanalReread({ subscriber_filter: filter, status: "draft", send_at: null }, 5).verified, null);
    assert.equal(verifyClaudeSemanalReread({ subscriber_filter: [], status: "scheduled", send_at: "2026-11-29T11:00:00Z" }, 5).verified, false);
    assert.equal(
      verifyClaudeSemanalReread({ subscriber_filter: filter, status: "scheduled", send_at: "2026-11-29T11:00:00Z", public: false }, 5).verified,
      true,
    );
  });
});
