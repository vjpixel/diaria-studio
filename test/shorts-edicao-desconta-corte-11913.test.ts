/**
 * test/shorts-edicao-desconta-corte-11913.test.ts
 *
 * #11913: a conferência do perfil do Threads (e da conta do Instagram) da
 * EDIÇÃO não descontava o vídeo do corte avulso do mesmo dia. O corte já
 * ignorava o da edição (#11742/#11795), mas não o contrário. Cenário real:
 * principal às 12:00, extra (corte) às 06:30. A extra sai às 06:30 no Threads
 * pessoal sem link nem `utm_campaign`; às 12:00 a rodada da edição lê o perfil
 * desde 00:00, vê o vídeo do corte sem marcador e para com `blocked`.
 *
 * Sem rede: Threads e Graph são injetados; os registros são arquivos reais
 * num diretório temporário.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  INSTAGRAM_CAPTION_FORMAT_MARKER,
  instagramTimerGate,
  readAndDecideInstagramConfirm,
  sameDayCorteRegisteredIds,
  threadsProfilePreflightInput,
} from "../scripts/publish-shorts.ts";
import { threadsProfilePreflight, type ThreadsPersonalCreds } from "../scripts/lib/threads-personal-video.ts";
import { persistShortEntry } from "../scripts/lib/diaria/shorts-published-store.ts";
import { resolveEditionScheduledAt } from "../scripts/lib/edition-scheduled-at.ts";
import { CORTE_SPEC_FILE, type CorteSpec } from "../scripts/lib/diaria/short-corte.ts";

const DAY = "261102";
const EXTRA: CorteSpec = { slug: "mentoria-agentes-261102", date: DAY, hhmm: "06:30", title: "Agentes no trabalho", hook: "O que muda quando o agente erra sozinho.", video: "corte.mp4" };
const EXTRA_AT = resolveEditionScheduledAt(DAY, EXTRA.hhmm);
const EDITION_AT = resolveEditionScheduledAt(DAY, "12:00");
const CREDS: ThreadsPersonalCreds = { accessToken: "tok", userId: "123", apiVersion: "v1.0" };
const jsonRes = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const graphTs = (iso: string) => iso.replace(/\.\d{3}Z$/, "+0000");

/** Pasta `data/cortes/` temporária com o corte já registrado no Threads e no Instagram (default: a extra das 06:30). */
function cortesWithExtra(spec: CorteSpec = EXTRA): string {
  const cortes = mkdtempSync(join(tmpdir(), "cortes-11913-"));
  const dir = join(cortes, spec.slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, CORTE_SPEC_FILE), JSON.stringify(spec));
  const at = resolveEditionScheduledAt(spec.date, spec.hhmm);
  persistShortEntry(dir, DAY, "main", { destination: "threads_profile", status: "published", id: "C-TH", at });
  persistShortEntry(dir, DAY, "main", { destination: "instagram", status: "published", id: "C-IG", at });
  return cortes;
}

describe("#11913 sameDayCorteRegisteredIds", () => {
  it("lê os ids do destino dos cortes do mesmo dia", () => {
    const cortes = cortesWithExtra();
    assert.deepEqual(sameDayCorteRegisteredIds(cortes, DAY, "threads_profile", () => assert.fail("sem aviso")), ["C-TH"]);
    assert.deepEqual(sameDayCorteRegisteredIds(cortes, DAY, "instagram", () => assert.fail("sem aviso")), ["C-IG"]);
  });

  it("corte de outro dia não entra", () => {
    const cortes = cortesWithExtra();
    assert.deepEqual(sameDayCorteRegisteredIds(cortes, "261103", "threads_profile", () => assert.fail("sem aviso")), []);
  });

  it("corte ilegível: aviso e pula só ele (mais restritivo, nunca menos)", () => {
    const cortes = cortesWithExtra();
    mkdirSync(join(cortes, "quebrado"));
    writeFileSync(join(cortes, "quebrado", CORTE_SPEC_FILE), "{ não é json");
    const warns: string[] = [];
    assert.deepEqual(sameDayCorteRegisteredIds(cortes, DAY, "threads_profile", (m) => warns.push(m)), ["C-TH"]);
    assert.equal(warns.length, 1);
    assert.match(warns[0], /quebrado ilegível/);
  });

  it("registro do corte ilegível: aviso e lista vazia para ele", () => {
    const cortes = cortesWithExtra();
    const warns: string[] = [];
    assert.deepEqual(sameDayCorteRegisteredIds(cortes, DAY, "threads_profile", (m) => warns.push(m), () => { throw new Error("JSON quebrado"); }), []);
    assert.match(warns[0], /JSON quebrado/);
  });

  it("pasta sem corte.json é ignorada; sem pasta de cortes, lista vazia", () => {
    const cortes = cortesWithExtra();
    mkdirSync(join(cortes, "sem-spec"));
    assert.deepEqual(sameDayCorteRegisteredIds(cortes, DAY, "threads_profile", () => assert.fail("sem aviso")), ["C-TH"]);
    assert.deepEqual(sameDayCorteRegisteredIds(join(cortes, "nao-existe"), DAY, "threads_profile", () => assert.fail("sem aviso")), []);
  });
});

describe("#11913 cenário da issue: extra às 06:30, principal às 12:00", () => {
  const caption = "Título do D1\n\nGancho do D1.";
  const extraPost = { id: "C-TH", media_type: "VIDEO", text: `${EXTRA.title}\n\n${EXTRA.hook}`, timestamp: graphTs(EXTRA_AT), permalink: "https://t/C-TH" };
  const preflight = (ignore: string[]) =>
    threadsProfilePreflight({
      creds: CREDS,
      ...threadsProfilePreflightInput({ aammdd: DAY, caption, corte: false, sameDayOtherIds: ignore }),
      now: () => new Date(EDITION_AT),
      fetch: async () => jsonRes({ data: [extraPost] }),
    });

  it("Threads: sem descontar a extra a edição bloqueia (o bug)", async () => {
    await assert.rejects(preflight([]), /sem o marcador/);
  });

  it("Threads: com os ids dos cortes do dia, a edição publica", async () => {
    const ids = sameDayCorteRegisteredIds(cortesWithExtra(), DAY, "threads_profile", () => {});
    assert.deepEqual(await preflight(ids), { kind: "publish" });
  });

  it("Instagram (simetria): o Reels de um corte do dia perto do horário da edição, já registrado, não bloqueia", async () => {
    // A extra das 06:30 fica fora da janela de horário (90 min) da principal das 12:00; um corte avulso às
    // 11:00 cai dentro dela e, sem desconto, bloqueia a conferência da conta da edição (fail-closed).
    const near: CorteSpec = { ...EXTRA, slug: "corte-avulso-1100", hhmm: "11:00" };
    const nearAt = resolveEditionScheduledAt(DAY, near.hhmm);
    const reel = { id: "C-IG", permalink: "https://ig/C-IG", timestamp: graphTs(nearAt), media_product_type: "REELS", media_type: "VIDEO", caption: `${near.title}\n\n${INSTAGRAM_CAPTION_FORMAT_MARKER}` };
    const decide = (ignoreIds: string[]) => () =>
      readAndDecideInstagramConfirm(
        { fetch: async () => jsonRes({ data: [reel] }) },
        { igUserId: "ig", token: "t", apiVersion: "v21.0", published: { aammdd: DAY, entries: [] }, sinceIso: resolveEditionScheduledAt(DAY, "00:00"), markers: ["Título do D1", `utm_campaign=${DAY}`], nowIso: EDITION_AT, expectedAtIso: EDITION_AT, ignoreIds },
      );
    await assert.rejects(instagramTimerGate({ decide: decide([]), persist: () => {} }), "sem descontar, bloqueia");
    const ids = sameDayCorteRegisteredIds(cortesWithExtra(near), DAY, "instagram", () => {});
    assert.deepEqual(ids, ["C-IG"]);
    assert.deepEqual(await instagramTimerGate({ decide: decide(ids), persist: () => assert.fail("nada a gravar") }), { kind: "publish" });
  });

  it("wiring: as duas conferências da rodada passam os ids do outro lado do dia, na edição também", () => {
    const src = readFileSync(new URL("../scripts/publish-shorts.ts", import.meta.url), "utf8");
    const branch = src.slice(src.indexOf("} else if (item.destination === THREADS_PROFILE_DESTINATION) {"), src.indexOf('} else if (item.destination === "instagram") {'));
    assert.ok(branch.includes("sameDayOtherIds: sameDayOtherRegisteredIds(corte?.slug ?? null, aammdd, THREADS_PROFILE_DESTINATION)"), "Threads");
    const ig = src.slice(src.indexOf('} else if (item.destination === "instagram") {'));
    assert.ok(ig.includes('const ignoreIds = sameDayOtherRegisteredIds(corte?.slug ?? null, aammdd, "instagram");'), "Instagram");
    const helper = src.slice(src.indexOf("export function sameDayOtherRegisteredIdsFor("), src.indexOf("export function sameDayOtherRegisteredIdsFor(") + 800); // #11965: miolo testável
    assert.ok(helper.includes("sameDayCorteRegisteredIds("), "a edição desconta os cortes do dia");
  });
});
