/**
 * test/shorts-corte-account-gate-11795-11742.test.ts
 *
 * #11795 (resíduo da PR #11894): o Instagram do corte avulso saía sem a
 * conferência da conta que o timer da edição faz (`instagramTimerGate`,
 * #11265). Um Reels do corte postado à mão e não registrado saía duplicado.
 *
 * #11742: a rodada sem `--threads-timer` (skill, task one-shot do app desktop
 * com o config defasado) publicava `threads_profile` sem conferir o perfil e
 * corria com o timer do 300 no mesmo minuto.
 *
 * Sem rede: Graph, Threads e o registro são injetados.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  INSTAGRAM_CAPTION_FORMAT_MARKER,
  InstagramTimerGateError,
  corteInstagramConfirmContext,
  editionDayRegisteredIds,
  instagramAccountGateApplies,
  instagramTimerGate,
  readAndDecideInstagramConfirm,
  threadsProfilePreflightInput,
} from "../scripts/publish-shorts.ts";
import { decideThreadsProfileDuplicate, threadsProfilePreflight, type ThreadsPersonalCreds } from "../scripts/lib/threads-personal-video.ts";
import { buildCorteTimerAlarm, interpretCorteTimerOutput } from "../scripts/shorts-corte-timer.ts";
import { resolveEditionScheduledAt } from "../scripts/lib/edition-scheduled-at.ts";
import type { CorteSpec } from "../scripts/lib/diaria/short-corte.ts";

const SPEC: CorteSpec = { slug: "tratar-ia-como-humano", date: "261102", hhmm: "18:00", title: "Tratar IA como humano", hook: "Por que dar nome ao chatbot muda o jeito que você usa a ferramenta.", video: "corte.mp4" };
const CORTE_AT = resolveEditionScheduledAt(SPEC.date, SPEC.hhmm);
const jsonRes = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const CREDS: ThreadsPersonalCreds = { accessToken: "tok", userId: "123", apiVersion: "v1.0" };
const minutes = (iso: string, m: number) => new Date(Date.parse(iso) + m * 60_000).toISOString().replace(/\.\d{3}Z$/, "+0000");

describe("#11795 instagramAccountGateApplies", () => {
  it("vale no timer da edição e em toda rodada do corte; fora disso, não", () => {
    assert.equal(instagramAccountGateApplies("instagram-timer", false), true);
    assert.equal(instagramAccountGateApplies("main", true), true);
    assert.equal(instagramAccountGateApplies("main", false), false);
  });
});

describe("#11795 corteInstagramConfirmContext", () => {
  it("marcadores do corte (título e gancho), sem utm_campaign do dia; horário = --at", () => {
    const ctx = corteInstagramConfirmContext(SPEC);
    assert.ok(ctx.markers.includes(SPEC.title));
    assert.ok(ctx.markers.some((m) => m.startsWith("Por que dar nome ao chatbot")));
    assert.ok(!ctx.markers.some((m) => m.startsWith("utm_campaign=")), "o utm do dia é o da edição");
    assert.equal(ctx.sinceIso, resolveEditionScheduledAt(SPEC.date, "00:00"));
    assert.equal(ctx.expectedAtIso, CORTE_AT);
  });
});

describe("#11795 conferência da conta do Instagram no corte", () => {
  const ctx = corteInstagramConfirmContext(SPEC);
  const read = (data: unknown[], ignoreIds: string[] = []) => () =>
    readAndDecideInstagramConfirm(
      { fetch: async () => jsonRes({ data }) },
      { igUserId: "ig", token: "t", apiVersion: "v21.0", published: { aammdd: SPEC.date, entries: [] }, sinceIso: ctx.sinceIso, markers: ctx.markers, nowIso: CORTE_AT, expectedAtIso: ctx.expectedAtIso, ignoreIds },
    );
  const editionReel = { id: "E1", permalink: "https://ig/E1", timestamp: minutes(CORTE_AT, -30), media_product_type: "REELS", media_type: "VIDEO", caption: `Outro título\n\n${INSTAGRAM_CAPTION_FORMAT_MARKER}` };
  const corteReel = { id: "C1", permalink: "https://ig/C1", timestamp: minutes(CORTE_AT, -5), media_product_type: "REELS", media_type: "VIDEO", caption: `${SPEC.title}\n\n${INSTAGRAM_CAPTION_FORMAT_MARKER}` };

  it("Reels do corte postado à mão: registra e não publica", async () => {
    const persisted: unknown[] = [];
    const r = await instagramTimerGate({ decide: read([corteReel]), persist: (e) => persisted.push(e) });
    assert.equal(r.kind, "already");
    assert.equal((persisted[0] as any).id, "C1");
  });

  it("o Reels da edição do dia, já registrado, não bloqueia o corte", async () => {
    const r = await instagramTimerGate({ decide: read([editionReel], ["E1"]), persist: () => assert.fail("nada a gravar") });
    assert.deepEqual(r, { kind: "publish" });
  });

  it("sem descontar o Reels da edição, a janela de horário bloqueia (fail-closed) com a dica do --mark do corte", async () => {
    await assert.rejects(
      instagramTimerGate({ decide: read([editionReel]), persist: () => {}, registerHint: () => `npx tsx scripts/publish-shorts.ts --corte ${SPEC.slug} --mark instagram=URL` }),
      (e: unknown) => e instanceof InstagramTimerGateError && e.failure === "blocked" && /--corte tratar-ia-como-humano --mark instagram=URL/.test(e.message) && !/--confirm-instagram/.test(e.message),
    );
  });

  it("sem registerHint, a mensagem segue a da edição (--confirm-instagram)", async () => {
    await assert.rejects(instagramTimerGate({ decide: read([editionReel]), persist: () => {} }), /--confirm-instagram --media-id E1/);
  });
});

describe("#11742 threadsProfilePreflightInput", () => {
  it("edição: utm_campaign + título da 1ª linha; os ids dos cortes do dia não contam (#11913)", () => {
    const i = threadsProfilePreflightInput({ aammdd: "261102", caption: "Título do D1\n\nGancho.", corte: false, sameDayOtherIds: ["X"] });
    assert.deepEqual(i, { sinceIso: resolveEditionScheduledAt("261102", "00:00"), markers: ["utm_campaign=261102", "Título do D1"], ignoreIds: ["X"] });
  });
  it("corte: só o título, e o vídeo da edição do dia não conta", () => {
    const i = threadsProfilePreflightInput({ aammdd: SPEC.date, caption: `${SPEC.title}\n\nGancho.`, corte: true, sameDayOtherIds: ["E1"] });
    assert.deepEqual(i.markers, [SPEC.title]);
    assert.deepEqual(i.ignoreIds, ["E1"]);
  });
});

describe("#11742 conferência do perfil do Threads fora do timer", () => {
  const since = resolveEditionScheduledAt("261102", "00:00");
  const video = (id: string, text: string) => ({ id, media_type: "VIDEO", text, timestamp: "2026-11-02T11:01:00+0000", permalink: `https://t/${id}` });

  it("o post do timer já no perfil vira registro, não um segundo post (a corrida do #11742)", async () => {
    const pre = await threadsProfilePreflight({
      creds: CREDS,
      ...threadsProfilePreflightInput({ aammdd: "261102", caption: "Título do D1\n\nGancho.", corte: false, sameDayOtherIds: [] }),
      now: () => new Date("2026-11-02T11:05:00Z"),
      fetch: async () => jsonRes({ data: [video("9", "Título do D1\n\nGancho.")] }),
    });
    assert.equal(pre.kind, "already");
  });

  it("ignoreIds tira o vídeo da edição do dia da decisão do corte", () => {
    const posts = [{ id: "E1", mediaType: "VIDEO", text: "Outro título", timestamp: "2026-11-02T11:01:00.000Z", permalink: null }];
    assert.equal(decideThreadsProfileDuplicate(posts, { sinceIso: since, markers: [SPEC.title] }).kind, "blocked");
    assert.equal(decideThreadsProfileDuplicate(posts, { sinceIso: since, markers: [SPEC.title], ignoreIds: ["E1"] }).kind, "none");
  });

  it("wiring: a rodada que publica threads_profile confere o perfil em qualquer writer", () => {
    const src = readFileSync(new URL("../scripts/publish-shorts.ts", import.meta.url), "utf8");
    const branch = src.slice(src.indexOf("} else if (item.destination === THREADS_PROFILE_DESTINATION) {"), src.indexOf('} else if (item.destination === "instagram") {'));
    assert.ok(branch.includes("threadsProfilePreflight({"), "o ramo do threads_profile confere o perfil");
    assert.ok(!/if \(writer === "threads-timer"\)/.test(branch), "a conferência não pode depender do writer do timer");
    const ig = src.slice(src.indexOf('} else if (item.destination === "instagram") {'));
    assert.ok(ig.includes("if (instagramAccountGateApplies(writer, corte !== null)) {"), "o Instagram do corte passa pela conferência da conta");
  });
});

describe("#11795 editionDayRegisteredIds", () => {
  const dir = mkdtempSync(join(tmpdir(), "corte-edition-ids-"));
  it("lê os ids do destino no registro da edição", () => {
    const read = () => ({ aammdd: "261102", entries: [
      { destination: "instagram", status: "published", id: "E1", scheduled_at: null, at: "x" },
      { destination: "threads_profile", status: "published", id: "T1", scheduled_at: null, at: "x" },
    ] as any });
    assert.deepEqual(editionDayRegisteredIds(dir, "261102", "instagram", () => {}, read), ["E1"]);
  });
  it("registro ilegível: aviso e lista vazia (mais restritivo, nunca menos)", () => {
    const warns: string[] = [];
    assert.deepEqual(editionDayRegisteredIds(dir, "261102", "instagram", (m) => warns.push(m), () => { throw new Error("JSON quebrado"); }), []);
    assert.match(warns[0], /ilegível/);
  });
  it("sem pasta da edição: lista vazia", () => {
    assert.deepEqual(editionDayRegisteredIds(join(dir, "nao-existe"), "261102", "instagram", () => assert.fail("sem aviso")), []);
  });
});

describe("#11795 timer do corte: conferência que não deixou publicar", () => {
  const out = (preflight: string) => JSON.stringify({ results: [{ destination: "instagram", ok: false, error: "a conta pode já ter o Reels", cause: "preflight", preflight }] });
  it("bloqueio vira account-check (acao, nunca manda postar de novo); leitura que falha vira account-read-failed", () => {
    assert.equal((interpretCorteTimerOutput(1, out("blocked"), ["instagram"])[0] as any).key, "account-check");
    assert.equal((interpretCorteTimerOutput(1, out("author-unchecked"), ["instagram"])[0] as any).key, "account-check");
    assert.equal((interpretCorteTimerOutput(1, out("read-failed"), ["instagram"])[0] as any).key, "account-read-failed");
  });
  it("corpo do account-check manda conferir a conta e registrar, sem 'Publicar agora'", () => {
    const a = buildCorteTimerAlarm({ spec: SPEC, destination: "instagram", key: "account-check", reason: "r" });
    assert.match(a.subject, /conferir a conta/);
    assert.match(a.body, /NÃO poste de novo sem conferir/);
    assert.match(a.body, /--mark instagram=URL/);
    assert.doesNotMatch(a.body, /Publicar agora/);
  });
});
