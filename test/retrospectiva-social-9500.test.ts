/**
 * test/retrospectiva-social-9500.test.ts (#9500)
 *
 * Regressão da divulgação da Retrospectiva do Mês em Facebook, Instagram,
 * Threads e X (`/diaria-mensal-apoiadores`): state/`--skip`/`--force` dos 4
 * canais novos, regra de CTA (apoia.se, nunca a URL paywalled) com o teto de
 * cada rede (X/Threads 280), agenda escalonada sem colidir com a diária e o
 * adaptador `publish-retrospectiva-social.ts` (pré-voo tudo-ou-nada, store,
 * reconciliação, payload do X).
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RETROSPECTIVA_DIVULGACAO_CHANNELS,
  RETROSPECTIVA_PUBLIC_CTA,
  parseRetrospectivaSkip,
  readRetrospectivaDivulgacaoState,
  retrospectivaDivulgacaoStatePath,
  writeRetrospectivaDivulgacaoState,
} from "../scripts/lib/mensal/retrospectiva-divulgacao.ts";
import {
  RETROSPECTIVA_PUBLIC_CTA_CURTO,
  retrospectivaSocialPostProblems,
  xWeightedLength,
} from "../scripts/lib/mensal/retrospectiva-social.ts";
import {
  addMinutesIso,
  dailySlotCollisions,
  resolveRetrospectivaBaseDate,
  resolveRetrospectivaScheduledAts,
  resolveRetrospectivaSocialScheduledAts,
} from "../scripts/lib/mensal/retrospectiva-schedule.ts";
import { buildDoneChannelState, withChannelState } from "../scripts/lib/artigo-especial-state.ts";
import {
  RETROSPECTIVA_SOCIAL_DESTAQUE,
  parseSocialForce,
  runRetrospectivaSocialDispatch,
  type RunRetrospectivaSocialOptions,
  type SocialDispatchInput,
} from "../scripts/publish-retrospectiva-social.ts";
import { WORKER_DESTAQUE_RE } from "../scripts/publish-artigo-especial-linkedin.ts";
import { checkRetrospectivaDivulgacaoTexts } from "../scripts/check-retrospectiva-divulgacao.ts";
import { readSocialPublished, type PostEntry } from "../scripts/lib/social-published-store.ts";

process.env.DIARIA_QUIET_SCHEDULE_LOG = "1";

const CONFIG = {
  publishing: {
    social: {
      timezone: "America/Sao_Paulo",
      fallback_schedule: { d1_time: "10:00", d2_time: "12:30", d3_time: "17:30", day_offset: 0 },
    },
  },
};
const NOW = Date.parse("2026-10-02T12:00:00Z");

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "retro-9500-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const LONG_OK = `Setembro teve um caso que ninguém previu.\n\nA retrospectiva conta o resto.\n\n${RETROSPECTIVA_PUBLIC_CTA}\n`;
const SHORT_OK = `Setembro teve um caso que ninguém previu. A retrospectiva conta o resto.\n\n${RETROSPECTIVA_PUBLIC_CTA_CURTO}\n`;

describe("state e --skip dos canais novos", () => {
  it("os 4 canais sociais entram no state e fazem round-trip", () => {
    for (const ch of ["facebook", "instagram", "threads", "x"]) assert.ok((RETROSPECTIVA_DIVULGACAO_CHANNELS as readonly string[]).includes(ch));
    const p = retrospectivaDivulgacaoStatePath(tmp);
    let s = readRetrospectivaDivulgacaoState(p, "2609-10");
    for (const ch of ["facebook", "instagram", "threads", "x"] as const) {
      s = withChannelState(s, ch, buildDoneChannelState("2026-10-02T00:00:00Z", null));
    }
    writeRetrospectivaDivulgacaoState(p, s);
    assert.deepEqual(Object.keys(readRetrospectivaDivulgacaoState(p, "2609-10").channels).sort(), ["facebook", "instagram", "threads", "x"]);
  });
  it("--skip aceita os tokens novos; typo continua lançando", () => {
    assert.deepEqual([...parseRetrospectivaSkip("facebook, x")].sort(), ["facebook", "x"]);
    assert.throws(() => parseRetrospectivaSkip("instagran"), /instagran/);
  });
  it("--force filtra só os canais sociais (mesmos tokens do --skip)", () => {
    assert.deepEqual([...parseSocialForce("linkedin,threads")], ["threads"]);
    assert.throws(() => parseSocialForce("thread"), /^Error: --force contém.*thread/);
  });
  it("destaque do Worker é aceito pelo regex do Worker publicado", () => {
    assert.match(RETROSPECTIVA_SOCIAL_DESTAQUE, WORKER_DESTAQUE_RE);
  });
});

describe("CTA e teto de cada rede", () => {
  it("textos certos passam nos 4 canais", () => {
    assert.deepEqual(retrospectivaSocialPostProblems("facebook", LONG_OK), []);
    assert.deepEqual(retrospectivaSocialPostProblems("instagram", LONG_OK), []);
    assert.deepEqual(retrospectivaSocialPostProblems("threads", SHORT_OK), []);
    assert.deepEqual(retrospectivaSocialPostProblems("x", SHORT_OK), []);
  });
  it("URL paywalled reprova em todos os canais, mesmo com o CTA", () => {
    for (const ch of ["facebook", "instagram", "threads", "x"] as const) {
      const base = ch === "facebook" || ch === "instagram" ? LONG_OK : SHORT_OK;
      assert.match(retrospectivaSocialPostProblems(ch, `retrospectiva.diar.ia.br/2609\n${base}`).join(), /paywalled/, ch);
    }
  });
  it("Facebook/Instagram exigem a linha LONGA; X/Threads aceitam curta ou longa", () => {
    assert.match(retrospectivaSocialPostProblems("instagram", SHORT_OK).join(), /falta a linha literal/);
    assert.match(retrospectivaSocialPostProblems("facebook", "Chamada sem CTA.").join(), /falta a linha literal/);
    assert.deepEqual(retrospectivaSocialPostProblems("threads", `Curto.\n\n${RETROSPECTIVA_PUBLIC_CTA}`), []);
    assert.match(retrospectivaSocialPostProblems("x", "Curto, sem CTA nenhum.").join(), /falta a linha literal/);
  });
  it("X e Threads: acima de 280 reprova; X conta apoia.se/diaria como link (23)", () => {
    const corpo = (n: number) => "a".repeat(n);
    // 280 exatos no Threads (literal) passam; 281 não.
    const cta = `\n\n${RETROSPECTIVA_PUBLIC_CTA_CURTO}`;
    assert.deepEqual(retrospectivaSocialPostProblems("threads", corpo(280 - cta.length) + cta), []);
    assert.match(retrospectivaSocialPostProblems("threads", corpo(281 - cta.length) + cta).join(), /teto do threads é 280/);
    // No X o mesmo texto de 280 literais pesa 288 (apoia.se/diaria = 15 → 23).
    assert.equal(xWeightedLength(RETROSPECTIVA_PUBLIC_CTA_CURTO), RETROSPECTIVA_PUBLIC_CTA_CURTO.length + 8);
    assert.match(retrospectivaSocialPostProblems("x", corpo(280 - cta.length) + cta).join(), /ponderado/);
    assert.deepEqual(retrospectivaSocialPostProblems("x", corpo(272 - cta.length) + cta), []);
  });
  it("Instagram acima de 2200 reprova (recusa, nunca trunca o CTA); markdown e vazio reprovam", () => {
    assert.match(retrospectivaSocialPostProblems("instagram", `${"b".repeat(2200)}\n\n${RETROSPECTIVA_PUBLIC_CTA}`).join(), /2200/);
    assert.match(retrospectivaSocialPostProblems("facebook", `Um **destaque**.\n\n${RETROSPECTIVA_PUBLIC_CTA}`).join(), /markdown/);
    assert.deepEqual(retrospectivaSocialPostProblems("x", "  \n"), ["texto vazio"]);
  });
  it("check-retrospectiva-divulgacao cobre os 4 arquivos novos", () => {
    mkdirSync(join(tmp, "divulgacao"), { recursive: true });
    writeFileSync(join(tmp, "divulgacao", "facebook.md"), LONG_OK);
    writeFileSync(join(tmp, "divulgacao", "instagram.md"), LONG_OK);
    writeFileSync(join(tmp, "divulgacao", "threads.md"), SHORT_OK);
    writeFileSync(join(tmp, "divulgacao", "x.md"), `${"c".repeat(300)}\n${RETROSPECTIVA_PUBLIC_CTA_CURTO}`);
    const r = checkRetrospectivaDivulgacaoTexts(tmp, "linkedin");
    assert.deepEqual(
      r.map((c) => [c.file.replace(/\\/g, "/").split("/").pop(), c.problems.length > 0]),
      [["facebook.md", false], ["instagram.md", false], ["threads.md", false], ["x.md", true]],
    );
    assert.deepEqual(checkRetrospectivaDivulgacaoTexts(tmp, "linkedin,facebook,instagram,threads,x"), []);
  });
});

describe("agenda escalonada, sem colisão com a diária", () => {
  it("D+1 a partir da página LinkedIn: 09:10 / 09:20 / 09:30 / 09:40 BRT", () => {
    const ats = resolveRetrospectivaSocialScheduledAts(CONFIG, { baseDate: "2026-10-10", now: NOW });
    assert.equal(resolveRetrospectivaScheduledAts(CONFIG, { baseDate: "2026-10-10", now: NOW }).pagina, "2026-10-11T09:00:00-03:00");
    assert.deepEqual(ats, {
      facebook: "2026-10-11T09:10:00-03:00",
      instagram: "2026-10-11T09:20:00-03:00",
      threads: "2026-10-11T09:30:00-03:00",
      x: "2026-10-11T09:40:00-03:00",
    });
    assert.deepEqual(dailySlotCollisions(ats, CONFIG), []);
    // Todos distintos entre si e da página.
    assert.equal(new Set([...Object.values(ats), "2026-10-11T09:00:00-03:00"]).size, 5);
  });
  it("--at colado num slot da diária lança (nunca agenda em cima do d1/d2/d3)", () => {
    assert.throws(() => resolveRetrospectivaSocialScheduledAts(CONFIG, { at: "2026-10-11T09:55:00-03:00", now: NOW }), /colide com a diária.*d1/);
    assert.throws(() => resolveRetrospectivaSocialScheduledAts(CONFIG, { at: "2026-10-11T17:00:00-03:00", now: NOW }), /d3/);
    assert.doesNotThrow(() => resolveRetrospectivaSocialScheduledAts(CONFIG, { at: "2026-10-11T14:00:00-03:00", now: NOW }));
  });
  it("data-base no passado continua lançando (herdado do LinkedIn)", () => {
    assert.throws(() => resolveRetrospectivaSocialScheduledAts(CONFIG, { baseDate: "2026-09-01", now: NOW }), /já passaram/);
  });
  it("addMinutesIso preserva o offset e vira o dia; ISO sem offset lança", () => {
    assert.equal(addMinutesIso("2026-10-11T23:55:00-03:00", 10), "2026-10-12T00:05:00-03:00");
    assert.throws(() => addMinutesIso("2026-10-11T09:00:00", 10), /offset/);
  });
  it("âncora D: explícita > regra do 1º sábado > hoje; --at desliga a regra", () => {
    assert.deepEqual(resolveRetrospectivaBaseDate("2609-10", { baseDate: "2026-10-03" }), { baseDate: "2026-10-03", fromRule: false });
    assert.deepEqual(resolveRetrospectivaBaseDate("2609-10", { at: "2026-10-04T09:00:00-03:00" }), { baseDate: undefined, fromRule: false });
    const viaRegra = resolveRetrospectivaBaseDate("2610-11", { now: new Date("2026-10-20T12:00:00Z") });
    assert.equal(viaRegra.fromRule, true);
    assert.match(viaRegra.baseDate!, /^2026-11-0\d$/);
  });
});

describe("adaptador publish-retrospectiva-social", () => {
  const ATS = resolveRetrospectivaSocialScheduledAts(CONFIG, { baseDate: "2026-10-10", now: NOW });
  const TEXTS = { facebook: LONG_OK, instagram: LONG_OK, threads: SHORT_OK, x: SHORT_OK };

  function opts(over: Partial<RunRetrospectivaSocialOptions> = {}) {
    const calls: Array<{ ch: string; input: SocialDispatchInput }> = [];
    let squareCalls = 0;
    const o: RunRetrospectivaSocialOptions = {
      cycle: "2609-10",
      cycleDir: tmp,
      channels: ["facebook", "instagram", "threads", "x"],
      texts: TEXTS,
      scheduledAts: ATS,
      imageOverride: null,
      d1ImageUrl: "https://eia.diar.ia.br/img/img-2609-10-04-d1-2x1.jpg",
      resolveSquareImage: async () => {
        squareCalls++;
        return "https://eia.diar.ia.br/img/img-2609-10-04-d1-1x1.jpg";
      },
      force: new Set(),
      dryRun: false,
      publishedPath: join(tmp, "_internal", "divulgacao-social-published.json"),
      disabled: {},
      xChannelId: "buffer-x",
      missingCredentials: {},
      dispatchers: {
        facebook: async (input) => {
          calls.push({ ch: "facebook", input });
          return { platform: "facebook", destaque: RETROSPECTIVA_SOCIAL_DESTAQUE, url: "https://www.facebook.com/p/posts/1", status: "scheduled", scheduled_at: input.scheduledAt, fb_post_id: "1" };
        },
        worker: async (ch, input) => {
          calls.push({ ch, input });
          return { platform: ch, destaque: RETROSPECTIVA_SOCIAL_DESTAQUE, url: null, status: "scheduled", scheduled_at: input.scheduledAt, worker_queue_key: `k-${ch}` };
        },
      },
      verifyWorker: async (p) => ({ updated: p, changes: 0, inQueue: 2 }),
      now: NOW,
      ...over,
    };
    return { o, calls, squareCalls: () => squareCalls };
  }

  it("despacha Facebook/Instagram/Threads com o 1:1 do D1, grava store + state e devolve o payload do X", async () => {
    mkdirSync(join(tmp, "_internal"), { recursive: true });
    const { o, calls } = opts();
    const r = await runRetrospectivaSocialDispatch(o);
    assert.deepEqual(calls.map((c) => c.ch), ["facebook", "instagram", "threads"]);
    for (const c of calls) assert.match(c.input.imageUrl!, /04-d1-1x1\.jpg$/);
    assert.equal(calls[1].input.scheduledAt, ATS.instagram);
    const x = r.results.find((y) => y.channel === "x");
    assert.equal(x?.action, "x-payload");
    if (x?.action === "x-payload") {
      assert.equal(x.payload.dueAt, ATS.x);
      assert.equal(x.payload.channelId, "buffer-x");
      assert.match(x.payload.text, /apoia\.se\/diaria$/);
      assert.equal(x.payload.images.length, 1);
    }
    const st = readRetrospectivaDivulgacaoState(retrospectivaDivulgacaoStatePath(tmp), "2609-10").channels;
    assert.equal(st.facebook?.status, "done");
    assert.equal(st.facebook?.url, "https://www.facebook.com/p/posts/1");
    assert.equal(st.instagram?.status, "done");
    assert.equal(st.x, undefined, "x só vira done quando o top-level marca, depois da mutation do Buffer");
    assert.equal(readSocialPublished(o.publishedPath).posts.length, 3);
    assert.equal(r.verifyError, null);
  });

  it("pré-voo tudo-ou-nada: um texto ruim aborta ANTES de despachar qualquer canal", async () => {
    const { o, calls } = opts({ texts: { ...TEXTS, threads: `${"z".repeat(300)}\n${RETROSPECTIVA_PUBLIC_CTA_CURTO}` } });
    await assert.rejects(runRetrospectivaSocialDispatch(o), /ANTES de qualquer dispatch[\s\S]*threads/);
    assert.equal(calls.length, 0);
    assert.equal(existsSync(o.publishedPath), false);
    assert.equal(existsSync(retrospectivaDivulgacaoStatePath(tmp)), false);
  });

  it("Instagram sem 1:1 recusa (o 2:1 do D1 não serve); Facebook/Threads/X caem pro 2:1", async () => {
    const semQuadrado = opts({ resolveSquareImage: async () => null });
    await assert.rejects(runRetrospectivaSocialDispatch(semQuadrado.o), /instagram: sem imagem 1:1/);
    const { o, calls } = opts({ resolveSquareImage: async () => null, channels: ["facebook", "threads"] });
    await runRetrospectivaSocialDispatch(o);
    for (const c of calls) assert.match(c.input.imageUrl!, /04-d1-2x1\.jpg$/);
  });

  it("canal done pula; --force reexecuta só o canal nomeado; post vivo no store pula mesmo sem state", async () => {
    const p = retrospectivaDivulgacaoStatePath(tmp);
    writeRetrospectivaDivulgacaoState(p, withChannelState({ cycle: "2609-10", channels: {} }, "facebook", buildDoneChannelState("x", null)));
    mkdirSync(join(tmp, "_internal"), { recursive: true });
    writeFileSync(
      join(tmp, "_internal", "divulgacao-social-published.json"),
      JSON.stringify({ posts: [{ platform: "threads", destaque: RETROSPECTIVA_SOCIAL_DESTAQUE, url: null, status: "scheduled", scheduled_at: ATS.threads, worker_queue_key: "old" }] }),
    );
    const a = opts();
    const ra = await runRetrospectivaSocialDispatch(a.o);
    assert.deepEqual(a.calls.map((c) => c.ch), ["instagram"]);
    assert.equal(ra.results.find((y) => y.channel === "facebook")?.action, "skipped");
    assert.match(String((ra.results.find((y) => y.channel === "threads") as { reason?: string }).reason), /store/);

    const b = opts({ force: new Set(["facebook"]), channels: ["facebook"] });
    await runRetrospectivaSocialDispatch(b.o);
    assert.deepEqual(b.calls.map((c) => c.ch), ["facebook"]);
  });

  it("nada a fazer não sobe imagem nenhuma", async () => {
    const { o, squareCalls } = opts({ channels: [] });
    await runRetrospectivaSocialDispatch(o);
    assert.equal(squareCalls(), 0);
  });

  it("--dry-run não despacha nem grava nada, mas mostra texto/horário/payload", async () => {
    const { o, calls } = opts({ dryRun: true, missingCredentials: { facebook: "sem token" } });
    const r = await runRetrospectivaSocialDispatch(o);
    assert.equal(calls.length, 0);
    assert.deepEqual(r.results.map((y) => y.action), ["dry-run", "dry-run", "dry-run", "x-payload"]);
    assert.equal(existsSync(o.publishedPath), false);
    assert.equal(existsSync(retrospectivaDivulgacaoStatePath(tmp)), false);
  });

  it("credencial/Worker ausente aborta fora do dry-run; canal desligado no config é pulado", async () => {
    const semWorker = opts({ missingCredentials: { instagram: "Worker não configurado" } });
    await assert.rejects(runRetrospectivaSocialDispatch(semWorker.o), /instagram: Worker não configurado/);
    assert.equal(semWorker.calls.length, 0);
    const { o, calls } = opts({ disabled: { instagram: "redesenho" } });
    const r = await runRetrospectivaSocialDispatch(o);
    assert.equal(r.results.find((y) => y.channel === "instagram")?.action, "skipped");
    assert.ok(!calls.some((c) => c.ch === "instagram"));
  });

  it("falha do dispatch vira failed só naquele canal; DLQ na reconciliação também", async () => {
    const { o } = opts({
      channels: ["facebook", "instagram", "threads"],
      dispatchers: {
        facebook: async () => {
          throw new Error("Graph 500");
        },
        worker: async (ch, input) => ({ platform: ch, destaque: RETROSPECTIVA_SOCIAL_DESTAQUE, url: null, status: "scheduled", scheduled_at: input.scheduledAt, worker_queue_key: `k-${ch}` }),
      },
      verifyWorker: async (p) => ({
        updated: { posts: p.posts.map((e: PostEntry) => (e.platform === "threads" ? { ...e, status: "failed", failure_reason: "worker_dlq" } : e)) },
        changes: 1,
      }),
    });
    const r = await runRetrospectivaSocialDispatch(o);
    const st = readRetrospectivaDivulgacaoState(retrospectivaDivulgacaoStatePath(tmp), "2609-10").channels;
    assert.equal(st.facebook?.status, "failed");
    assert.match(String(st.facebook?.reason), /Graph 500/);
    assert.equal(st.instagram?.status, "done");
    assert.equal(st.threads?.status, "failed");
    assert.deepEqual(r.results.map((y) => `${y.channel}:${y.action}`), ["facebook:failed", "instagram:dispatched", "threads:failed"]);
    assert.match(readFileSync(o.publishedPath, "utf8"), /worker_dlq/);
  });

  it("reconciliação que não roda: canal fica done, mas verifyError sinaliza (caller sai != 0)", async () => {
    const { o } = opts({
      channels: ["instagram"],
      verifyWorker: async () => {
        throw new Error("ECONNRESET");
      },
    });
    const r = await runRetrospectivaSocialDispatch(o);
    assert.equal(r.verifyError, "ECONNRESET");
    assert.equal(readRetrospectivaDivulgacaoState(retrospectivaDivulgacaoStatePath(tmp), "2609-10").channels.instagram?.status, "done");
  });
});
