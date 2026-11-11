/**
 * test/short-bio-utm-kv-12786.test.ts (#12786)
 *
 * Achados do self-review da PR #12742 (#12735):
 *   1. os UTMs do link da bio (`diar.ia.br/video`) moram no registry
 *      (`UTM_EMITTERS`), não como constantes soltas do módulo;
 *   2. só a rodada principal do `--publish` grava o KV do `/video` (nunca o
 *      corte nem as rodadas dos timers do 300);
 *   3. destino com link na legenda saindo antes do `05-video-url.txt` gera
 *      aviso no plano, com o caminho de correção (`--update-scheduled`).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  LATEST_VIDEO_BIO_UTM,
  LATEST_VIDEO_BIO_UTM_SOURCES,
  UTM_EMITTERS,
  findUtmEmitterCollisions,
} from "../scripts/lib/shared/utm-registry.ts";
import {
  LATEST_VIDEO_BIO_NETWORKS,
  LATEST_VIDEO_BIO_UTM_CAMPAIGN,
  LATEST_VIDEO_BIO_UTM_MEDIUM,
  latestVideoBioLink,
} from "../scripts/lib/shared/latest-video-redirect.ts";
import { applyMetadata, computeDrift } from "../scripts/studio-ui/studio-utms.ts";
import {
  missingHorizontalLinkWarning,
  planShortHorizontalLinks,
  shouldUpdateLatestVideoOnPublish,
  type ShortsPlanItem,
} from "../scripts/publish-shorts.ts";

describe("#12786 item 1: UTMs da bio no registry", () => {
  it("cada rede da bio tem entrada em UTM_EMITTERS com o triplo emitido pelo link", () => {
    for (const net of LATEST_VIDEO_BIO_NETWORKS) {
      const e = UTM_EMITTERS.find((x) => x.id === `${net}-bio-video-horizontal-12735`);
      assert.ok(e, `${net}: entrada ausente em UTM_EMITTERS`);
      const u = new URL(latestVideoBioLink(net));
      assert.equal(u.searchParams.get("utm_source"), e.source);
      assert.equal(u.searchParams.get("utm_medium"), e.medium);
      assert.equal(u.searchParams.get("utm_campaign"), e.campaignPattern);
      assert.equal(e.originFile, "scripts/lib/shared/latest-video-redirect.ts");
    }
  });

  it("o módulo do redirect reexporta os valores do registry, sem literal próprio", () => {
    assert.equal(LATEST_VIDEO_BIO_UTM_MEDIUM, LATEST_VIDEO_BIO_UTM.medium);
    assert.equal(LATEST_VIDEO_BIO_UTM_CAMPAIGN, LATEST_VIDEO_BIO_UTM.campaign);
    assert.deepEqual([...LATEST_VIDEO_BIO_NETWORKS], [...LATEST_VIDEO_BIO_UTM_SOURCES]);
    const src = readFileSync(new URL("../scripts/lib/shared/latest-video-redirect.ts", import.meta.url), "utf8");
    assert.ok(!/=\s*"video-horizontal"/.test(src), "literal video-horizontal voltou ao módulo do redirect");
    assert.ok(!/=\s*"bio"/.test(src), "literal bio voltou ao módulo do redirect");
  });

  it("o /utms não acusa sem_conversao no link da bio (leva ao YouTube, não ao cadastro)", () => {
    const findings = computeDrift(UTM_EMITTERS.map((e) => applyMetadata(e, undefined)), {});
    const keys = new Set(findings.map((f) => f.key));
    for (const s of LATEST_VIDEO_BIO_UTM_SOURCES) assert.ok(!keys.has(`${s}-bio-video-horizontal-12735`), s);
    // Controle: emissor comum sem conversão continua acusado.
    assert.ok(findings.some((f) => f.kind === "sem_conversao"));
  });

  it("as entradas novas não colidem com outro emissor", () => {
    const mine = new Set(LATEST_VIDEO_BIO_UTM_SOURCES.map((s) => `${s}-bio-video-horizontal-12735`));
    for (const group of findUtmEmitterCollisions()) {
      assert.ok(!group.some((id) => mine.has(id)), `colisão: ${group.join(", ")}`);
    }
  });
});

describe("#12786 item 2: KV do /video só na rodada principal", () => {
  it("rodada principal da edição grava", () => {
    assert.equal(shouldUpdateLatestVideoOnPublish({ corte: false, writer: "main" }), true);
  });
  it("rodadas dos timers do 300 não gravam", () => {
    for (const writer of ["linkedin-timer", "instagram-timer", "threads-timer"] as const) {
      assert.equal(shouldUpdateLatestVideoOnPublish({ corte: false, writer }), false, writer);
    }
  });
  it("corte avulso não grava (nem pelo timer)", () => {
    assert.equal(shouldUpdateLatestVideoOnPublish({ corte: true, writer: "main" }), false);
    assert.equal(shouldUpdateLatestVideoOnPublish({ corte: true, writer: "instagram-timer" }), false);
  });
  it("o --publish chama o helper antes de tocar o KV", () => {
    const src = readFileSync(new URL("../scripts/publish-shorts.ts", import.meta.url), "utf8");
    const call = src.indexOf("if (shouldUpdateLatestVideoOnPublish({ corte: !!corte, writer }))");
    const kv = src.indexOf("pollKvFromEnv()", call);
    assert.ok(call > 0 && kv > call && kv - call < 600, "a gravação do KV não está guardada pelo helper");
  });
});

describe("#12786 item 3: aviso de legenda sem o link do horizontal", () => {
  const dests = ["facebook:diaria", "x", "tiktok", "youtube_shorts"];
  const items = [
    { destination: "facebook:diaria", mode: "api", action: "publish", caption: "c", scheduledAt: "2026-11-12T15:00:00.000Z" },
    { destination: "tiktok", mode: "api", action: "publish", caption: "c", scheduledAt: null },
    { destination: "x", mode: "api", action: "skip_done" },
  ] as unknown as ShortsPlanItem[];

  it("sem 05-video-url.txt: avisa os destinos de legenda que saem, com o comando de correção", () => {
    const links = planShortHorizontalLinks(dests, null, false);
    const w = missingHorizontalLinkWarning("261112", links, items, false);
    assert.ok(w);
    assert.match(w, /^facebook:diaria sai\(em\) sem o link/);
    assert.ok(!w.includes("tiktok"), "tiktok é bio, não legenda");
    assert.ok(!w.startsWith("facebook:diaria, x"), "x já saiu (skip_done)");
    assert.match(w, /--update-scheduled --publish --confirm-publish 261112/);
  });

  it("com o link: nada a avisar", () => {
    const links = planShortHorizontalLinks(dests, "https://youtu.be/AbCdEfGhIjK", false);
    assert.equal(missingHorizontalLinkWarning("261112", links, items, false), null);
  });

  it("edição sem vídeo: nada a avisar", () => {
    const links = planShortHorizontalLinks(dests, null, true);
    assert.equal(missingHorizontalLinkWarning("261112", links, items, true), null);
  });

  it("corte (sem horizontalLinks): nada a avisar", () => {
    assert.equal(missingHorizontalLinkWarning("261112", undefined, items, false), null);
  });
});
