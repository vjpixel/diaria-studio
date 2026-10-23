/**
 * test/social-slot-planner-collab-worker-10819.test.ts
 *
 * Resíduo da #10819 (decisões do editor em /diaria-desbloqueia 261023):
 *   1. o Reels do Instagram que sai na @vjpixel com a @diar.ia.br em collab
 *      CONTA como post da @diar.ia.br no espaçamento mínimo de 2 h (antes a
 *      premissa era "não conta" e o Reels alinhava colado num post dela);
 *   2. a grade passa a incluir a fila do Worker (`GET /list`), onde ficam os
 *      posts que as skills de divulgação agendam e nenhum store da edição
 *      registra.
 *
 * Nenhum teste toca rede nem lê `platform.config.json`: horário do vertical
 * (`time`/`timeAt`) e `fetch` são injetados.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  brtDayWindow,
  gridFromShortsPublished,
  gridFromWorkerQueue,
  instagramCollabAccountKey,
  instagramCollabAccounts,
  mergeGrids,
  planSlot,
  planSlots,
  type ScheduledSlot,
} from "../scripts/lib/social-slot-planner.ts";
import { planShortSlots, shortDestinationAlsoAccounts, type ShortDestination } from "../scripts/lib/diaria/short-video.ts";
import { loadScheduledGrid, loadWorkerQueueForGrid, WORKER_QUEUE_LIST_TIMEOUT_MS } from "../scripts/publish-shorts.ts";

const at = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00-03:00`).toISOString();
const hhmm = (iso: string | null) => (iso ? new Date(Date.parse(iso) - 3 * 3_600_000).toISOString().slice(11, 16) : null);
const DAY = "2026-10-22";
const window = brtDayWindow("261022");
/** Grade real de 261022 (corpo da issue): diar.ia.br com posts às 07, 11, 15 e 19. */
const diariaIg: ScheduledSlot[] = ["07:00", "11:00", "15:00", "19:00"].map((h) => ({ account: "instagram:diaria", at: at(DAY, h) }));

describe("#10819 collab do Instagram conta como post da conta em collab", () => {
  it("username → conta: @diar.ia.br é a conta `diaria`; outro username vira o próprio slug", () => {
    assert.equal(instagramCollabAccountKey("diar.ia.br"), "instagram:diaria");
    assert.equal(instagramCollabAccountKey("@VJPixel"), "instagram:vjpixel");
    assert.deepEqual(instagramCollabAccounts(["diar.ia.br", "diar.ia.br", "vjpixel", ""], "instagram:vjpixel"), ["instagram:diaria"]);
    assert.deepEqual(instagramCollabAccounts(undefined, "instagram:vjpixel"), []);
  });

  it("Reels da @vjpixel com a diar.ia.br em collab: espalha entre os posts da diar.ia.br, não cola às 11:00 dela", () => {
    const req = { account: "instagram:vjpixel", window, preferredAt: at(DAY, "12:00") };
    // Sem o collab (premissa antiga): regra 1, alinha ao post das 11:00 da diar.ia.br — a 0 min dela.
    const old = planSlot(diariaIg, req);
    assert.equal(old.rule, "align-other-account");
    assert.equal(hhmm(old.at), "11:00");
    // Com o collab: regra 2 sobre os posts da diar.ia.br, ≥ 2 h de todos.
    const d = planSlot(diariaIg, { ...req, alsoAccounts: ["instagram:diaria"] });
    assert.equal(d.rule, "spread-same-account");
    assert.deepEqual(d.alsoAccounts, ["instagram:diaria"]);
    assert.equal(d.warning, undefined);
    for (const s of diariaIg) assert.ok(Math.abs(Date.parse(d.at!) - Date.parse(s.at)) >= 120 * 60_000, `${hhmm(d.at)} cola em ${hhmm(s.at)}`);
    assert.match(d.premise, /instagram:diaria, em collab/);
  });

  it("Reels em collab já na grade ocupa também a conta da diar.ia.br: post novo dela não cola nele", () => {
    const grid: ScheduledSlot[] = [{ account: "instagram:vjpixel", at: at(DAY, "12:00"), alsoAccounts: ["instagram:diaria"] }];
    const d = planSlot(grid, { account: "instagram:diaria", window, preferredAt: at(DAY, "12:00") });
    assert.equal(d.rule, "spread-same-account");
    assert.ok(Math.abs(Date.parse(d.at!) - Date.parse(at(DAY, "12:00"))) >= 120 * 60_000);
    // Sem o alsoAccounts no slot, a regra 1 alinharia exatamente em cima do Reels.
    const old = planSlot([{ account: "instagram:vjpixel", at: at(DAY, "12:00") }], { account: "instagram:diaria", window, preferredAt: at(DAY, "12:00") });
    assert.equal(hhmm(old.at), "12:00");
  });

  it("planSlots leva o alsoAccounts do slot planejado pro próximo pedido", () => {
    const [ig, fb] = planSlots([], [
      { account: "instagram:vjpixel", alsoAccounts: ["instagram:diaria"], window, preferredAt: at(DAY, "12:00") },
      { account: "instagram:diaria", window, preferredAt: at(DAY, "12:00") },
    ]);
    assert.equal(hhmm(ig.at), "12:00");
    assert.equal(fb.rule, "spread-same-account");
    assert.ok(Math.abs(Date.parse(fb.at!) - Date.parse(ig.at!)) >= 120 * 60_000);
  });

  it("gridFromShortsPublished: o Reels registrado ganha os collabs da config", () => {
    const data = { entries: [{ destination: "instagram", status: "published", id: "1", at: at(DAY, "12:00") }, { destination: "facebook:diaria", status: "scheduled", id: "2", scheduled_at: at(DAY, "13:00"), at: at(DAY, "01:00") }] };
    const g = gridFromShortsPublished(data, "vjpixel", ["diar.ia.br"]);
    assert.deepEqual(g.map((s) => [s.account, s.alsoAccounts ?? null]), [
      ["instagram:vjpixel", ["instagram:diaria"]],
      ["facebook:diaria", null],
    ]);
    // Autora = a própria diar.ia.br: o collab dela mesma não duplica a conta.
    assert.equal(gridFromShortsPublished(data, "diaria", ["diar.ia.br"])[0].alsoAccounts, undefined);
  });

  it("shortDestinationAlsoAccounts: só o Instagram tem collab", () => {
    const cfg = { instagramAuthorPage: "vjpixel", instagramCollaborators: ["diar.ia.br"] };
    assert.deepEqual(shortDestinationAlsoAccounts({ id: "instagram", kind: "instagram", mode: "api" }, cfg), ["instagram:diaria"]);
    assert.deepEqual(shortDestinationAlsoAccounts({ id: "facebook:vjpixel", kind: "facebook_page", mode: "api", slug: "vjpixel" }, cfg), []);
    assert.deepEqual(shortDestinationAlsoAccounts({ id: "instagram", kind: "instagram", mode: "api" }, { instagramAuthorPage: "vjpixel" }), []);
  });
});

describe("#10819 planShortSlots com o collab (horário injetado, sem config viva)", () => {
  const dests: ShortDestination[] = [
    { id: "facebook:vjpixel", kind: "facebook_page", mode: "api", slug: "vjpixel" },
    { id: "instagram", kind: "instagram", mode: "api" },
  ];
  const cfg = { instagramAuthorPage: "vjpixel", instagramCollaborators: ["diar.ia.br"] };

  it("fora do teste: o Instagram espalha entre os posts da diar.ia.br; a página VJ pixel (sem collab) alinha", () => {
    const slots = planShortSlots({
      aammdd: "261022",
      time: { hhmm: "12:00", source: "default", reason: "injetado" },
      timeAt: at(DAY, "12:00"),
      destinations: dests,
      cfg,
      grid: diariaIg,
    });
    const by = Object.fromEntries(slots.map((s) => [s.destination, s]));
    assert.equal(by["facebook:vjpixel"].rule, "align-other-account");
    assert.equal(by["instagram"].rule, "spread-same-account");
    assert.deepEqual(by["instagram"].alsoAccounts, ["instagram:diaria"]);
    for (const s of diariaIg) assert.ok(Math.abs(Date.parse(by["instagram"].at) - Date.parse(s.at)) >= 120 * 60_000);
  });

  it("durante o teste do vertical: o horário do teste fica, mas avisa quando cola num post da conta em collab", () => {
    const slots = planShortSlots({
      aammdd: "261022",
      time: { hhmm: "06:30", source: "rotation", reason: "injetado" },
      timeAt: at(DAY, "06:30"),
      destinations: dests,
      cfg,
      grid: diariaIg,
    });
    const ig = slots.find((s) => s.destination === "instagram")!;
    assert.equal(ig.rule, "test-schedule");
    assert.equal(ig.hhmm, "06:30");
    assert.match(ig.warning ?? "", /07:00 BRT/);
    assert.match(ig.warning ?? "", /em collab/);
    assert.equal(slots.find((s) => s.destination === "facebook:vjpixel")!.warning, undefined);
  });
});

describe("#10819 fila do Worker como fonte da grade", () => {
  const queue = {
    count: 7,
    items: [
      { key: "queue:a", scheduled_at: at(DAY, "09:45"), destaque: "d1", text: "x" }, // sem channel = linkedin, página
      { key: "queue:b", scheduled_at: at(DAY, "10:00"), destaque: "especial", webhook_target: "pixel" }, // perfil pessoal
      { key: "queue:c", scheduled_at: at(DAY, "13:00"), channel: "instagram", media_type: "REELS", ig_account: "vjpixel", collaborators: ["diar.ia.br"] },
      { key: "queue:d", scheduled_at: at(DAY, "14:00"), channel: "threads", destaque: "weekly" },
      { key: "queue:e", scheduled_at: at(DAY, "09:50"), action: "comment", parent_destaque: "d1" },
      { key: "queue:f", scheduled_at: "não é data", channel: "instagram" },
      { key: "queue:g", scheduled_at: at(DAY, "15:00"), channel: "mastodon" },
      { key: "queue:h", scheduled_at: at(DAY, "16:00"), channel: "instagram" }, // ig_account ausente = diaria
    ],
  };

  it("mapeia canal/conta como o Worker; comentário, data inválida e canal desconhecido ficam de fora", () => {
    const g = gridFromWorkerQueue(queue);
    assert.deepEqual(
      g.map((s) => [s.account, hhmm(s.at), s.alsoAccounts ?? null]),
      [
        ["linkedin:diaria", "09:45", null],
        ["linkedin:pessoal", "10:00", null],
        ["instagram:vjpixel", "13:00", ["instagram:diaria"]],
        ["threads:diaria", "14:00", null],
        ["instagram:diaria", "16:00", null],
      ],
    );
    assert.deepEqual(gridFromWorkerQueue({}), []);
    assert.deepEqual(gridFromWorkerQueue(null), []);
  });

  it("mergeGrids não conta duas vezes o post que está no store E na fila (mesmo instante, ISO diferente)", () => {
    const store: ScheduledSlot[] = [{ account: "linkedin:diaria", at: at(DAY, "09:45") }];
    const fila: ScheduledSlot[] = [
      { account: "linkedin:diaria", at: "2026-10-22T12:45:00Z" },
      { account: "instagram:vjpixel", at: at(DAY, "13:00"), alsoAccounts: ["instagram:diaria"] },
    ];
    const m = mergeGrids(store, fila, [{ account: "instagram:vjpixel", at: at(DAY, "13:00") }]);
    assert.equal(m.length, 2);
    assert.deepEqual(m.find((s) => s.account === "instagram:vjpixel")!.alsoAccounts, ["instagram:diaria"]);
  });

  it("post de divulgação só na fila desloca o Reels: sem a fila o planner escolheria colado nele", () => {
    // A página diar.ia.br no Facebook tem os 4 posts do dia; o Instagram dela só tem um post de
    // divulgação agendado pelo Worker às 13:00 (nenhum store da edição sabe dele).
    const fila = gridFromWorkerQueue({ items: [{ key: "q", scheduled_at: at(DAY, "13:00"), channel: "instagram" }] });
    const req = { account: "instagram:diaria", window, preferredAt: at(DAY, "13:00") };
    assert.equal(hhmm(planSlot([], req).at), "13:00");
    const d = planSlot(fila, req);
    assert.ok(Math.abs(Date.parse(d.at!) - Date.parse(at(DAY, "13:00"))) >= 120 * 60_000);
  });

  it("loadScheduledGrid junta stores da edição + fila, sem duplicar o post diário", () => {
    const dir = mkdtempSync(join(tmpdir(), "shorts-grid-worker-10819-"));
    try {
      mkdirSync(join(dir, "_internal"));
      writeFileSync(
        join(dir, "_internal", "06-social-published.json"),
        JSON.stringify({ posts: [{ platform: "linkedin", destaque: "d1", status: "scheduled", scheduled_at: at(DAY, "09:45") }] }),
      );
      const published = { aammdd: "261022", entries: [{ destination: "instagram", status: "published" as const, id: "9", at: at(DAY, "12:00") }] };
      const warns: string[] = [];
      const grid = loadScheduledGrid(dir, published, "vjpixel", (m) => warns.push(m), { instagramCollaborators: ["diar.ia.br"], workerQueue: queue });
      assert.equal(grid.filter((s) => s.account === "linkedin:diaria").length, 1);
      assert.deepEqual(grid.find((s) => s.account === "instagram:vjpixel" && hhmm(s.at) === "12:00")!.alsoAccounts, ["instagram:diaria"]);
      assert.ok(grid.some((s) => s.account === "threads:diaria"));
      assert.deepEqual(warns, []);
      // Sem workerQueue: só os stores (comportamento de antes).
      assert.ok(!loadScheduledGrid(dir, published, "vjpixel", () => {}).some((s) => s.account === "threads:diaria"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("loadWorkerQueueForGrid (fetch mockado, só leitura)", () => {
    const okFetch = (body: unknown, status = 200) => {
      const calls: Array<{ url: string; init?: RequestInit }> = [];
      const fn = (async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return new Response(JSON.stringify(body), { status });
      }) as unknown as typeof fetch;
      return { fn, calls };
    };

    it("GET /list com o token no header; devolve a resposta", async () => {
      const f = okFetch(queue);
      const warns: string[] = [];
      const r = await loadWorkerQueueForGrid("https://w.example/", "tok", f.fn, (m) => warns.push(m));
      assert.deepEqual(r, queue);
      assert.equal(f.calls.length, 1);
      assert.equal(f.calls[0].url, "https://w.example/list");
      assert.equal((f.calls[0].init?.headers as Record<string, string>)["X-Diaria-Token"], "tok");
      assert.equal(f.calls[0].init?.method, undefined); // GET
      assert.deepEqual(warns, []);
    });

    it("sem URL/token: não chama nada, avisa e segue sem a fila", async () => {
      const f = okFetch(queue);
      const warns: string[] = [];
      assert.equal(await loadWorkerQueueForGrid("", "tok", f.fn, (m) => warns.push(m)), undefined);
      assert.equal(await loadWorkerQueueForGrid("https://w.example", "", f.fn, (m) => warns.push(m)), undefined);
      assert.equal(f.calls.length, 0);
      assert.equal(warns.length, 2);
    });

    it("HTTP de erro, resposta sem items ou fetch que lança: aviso e undefined, nunca lança", async () => {
      const warns: string[] = [];
      assert.equal(await loadWorkerQueueForGrid("https://w", "t", okFetch({ error: "unauthorized" }, 401).fn, (m) => warns.push(m)), undefined);
      assert.equal(await loadWorkerQueueForGrid("https://w", "t", okFetch({ count: 0 }).fn, (m) => warns.push(m)), undefined);
      const boom = (async () => {
        throw new Error("rede fora");
      }) as unknown as typeof fetch;
      assert.equal(await loadWorkerQueueForGrid("https://w", "t", boom, (m) => warns.push(m)), undefined);
      assert.equal(warns.length, 3);
      assert.match(warns[0], /HTTP 401/);
      assert.match(warns[1], /sem items/);
      assert.match(warns[2], /rede fora/);
    });

    // #11001: Worker pendurado não pode prender o script (nem o dry-run).
    describe("timeout do GET /list (#11001)", () => {
      /** Timer injetado: guarda o callback e o prazo; o teste dispara à mão. */
      const manualTimer = () => {
        const state: { fire?: () => void; ms?: number; cleared: number } = { cleared: 0 };
        return {
          state,
          setTimer: (fn: () => void, ms: number) => {
            state.fire = fn;
            state.ms = ms;
            return 1;
          },
          clearTimer: () => {
            state.cleared++;
          },
        };
      };

      it("teto padrão é a constante nomeada de 10 s", () => {
        assert.equal(WORKER_QUEUE_LIST_TIMEOUT_MS, 10_000);
      });

      it("fetch que nunca resolve E ignora o abort: o timer vence, aviso e undefined", async () => {
        const t = manualTimer();
        let signal: AbortSignal | undefined;
        const hang = ((_url: string, init?: RequestInit) => {
          signal = init?.signal ?? undefined;
          return new Promise<Response>(() => {});
        }) as unknown as typeof fetch;
        const warns: string[] = [];
        const pending = loadWorkerQueueForGrid("https://w", "t", hang, (m) => warns.push(m), t);
        assert.equal(t.state.ms, WORKER_QUEUE_LIST_TIMEOUT_MS);
        t.state.fire!();
        assert.equal(await pending, undefined);
        assert.equal(signal?.aborted, true);
        assert.equal(warns.length, 1);
        assert.match(warns[0], /timeout de 10000 ms/);
      });

      it("fetch que respeita o abort: rejeita no abort, aviso e undefined", async () => {
        const t = manualTimer();
        const abortable = ((_url: string, init?: RequestInit) =>
          new Promise<Response>((_, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted pelo signal")));
          })) as unknown as typeof fetch;
        const warns: string[] = [];
        const pending = loadWorkerQueueForGrid("https://w", "t", abortable, (m) => warns.push(m), { ...t, timeoutMs: 50 });
        assert.equal(t.state.ms, 50);
        t.state.fire!();
        assert.equal(await pending, undefined);
        assert.equal(warns.length, 1);
        assert.match(warns[0], /sem a fila do Worker/);
      });

      it("resposta a tempo: limpa o timer e não avisa", async () => {
        const t = manualTimer();
        const warns: string[] = [];
        assert.deepEqual(await loadWorkerQueueForGrid("https://w", "t", okFetch(queue).fn, (m) => warns.push(m), t), queue);
        assert.equal(t.state.cleared, 1);
        assert.deepEqual(warns, []);
      });

      it("timer real: um fetch pendurado retorna dentro do timeoutMs curto", async () => {
        const hang = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
        const warns: string[] = [];
        const t0 = Date.now();
        assert.equal(await loadWorkerQueueForGrid("https://w", "t", hang, (m) => warns.push(m), { timeoutMs: 20 }), undefined);
        assert.ok(Date.now() - t0 < 2_000);
        assert.match(warns[0], /timeout/);
      });
    });
  });
});
