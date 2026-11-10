/**
 * test/short-cover-vertical-feed-12436.test.ts (#12436)
 *
 * O Passo B3a de `/diaria-publica-video` (#12254) manda o agente trocar
 * `cover.vertical_feed` para `"studio_web"` depois de aplicar a capa vertical
 * pelo Studio web, mas `ShortCoverRecord.vertical_feed` só aceitava `"manual"`:
 * o tipo não descrevia o registro real. Este teste trava os dois lados:
 *   - tipo: o registro com `studio_web` compila (falha em
 *     `npx tsc -p tsconfig.test.json --noEmit` sem o fix);
 *   - leitores: com `studio_web` o aviso do passo manual não sai, e anexar o
 *     registro à entrada preserva o valor;
 *   - doc×tipo: todo valor de `vertical_feed` citado no SKILL.md está na lista
 *     do tipo, para o B3a e o tipo não divergirem de novo.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SHORT_VERTICAL_FEED_COVER_VALUES,
  withCoverRecord,
  youtubeShortsCoverRecord,
  youtubeShortsVerticalCoverWarning,
  type ShortCoverRecord,
  type ShortVerticalFeedCover,
} from "../scripts/lib/diaria/short-cover.ts";
import type { ShortPublishedEntry } from "../scripts/lib/diaria/short-video.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("#12436 vertical_feed aceita studio_web", () => {
  it("o registro com studio_web é um ShortCoverRecord válido (tipo)", () => {
    const rec: ShortCoverRecord = { method: "thumbnails_set", ok: true, vertical_feed: "studio_web" };
    const v: ShortVerticalFeedCover = "studio_web";
    assert.equal(rec.vertical_feed, v);
    assert.deepEqual([...SHORT_VERTICAL_FEED_COVER_VALUES], ["manual", "studio_web"]);
  });

  it("com studio_web o aviso do passo manual não sai; com manual sai", () => {
    const confirmada: ShortCoverRecord = { method: "thumbnails_set", ok: true, vertical_feed: "studio_web" };
    assert.equal(youtubeShortsVerticalCoverWarning("5jX3X0sgMtg", confirmada), null);
    const pendente = youtubeShortsCoverRecord({ attempted: true, ok: true, error: null });
    assert.equal(pendente?.vertical_feed, "manual");
    assert.ok(youtubeShortsVerticalCoverWarning("5jX3X0sgMtg", pendente));
  });

  it("withCoverRecord preserva o studio_web na entrada do registro", () => {
    const entry = { destination: "youtube_shorts" } as ShortPublishedEntry;
    const out = withCoverRecord(entry, { method: "thumbnails_set", ok: true, vertical_feed: "studio_web" });
    assert.deepEqual(out.cover, { method: "thumbnails_set", ok: true, vertical_feed: "studio_web" });
  });

  it("todo valor de vertical_feed citado no SKILL.md de /diaria-publica-video está no tipo", () => {
    const skill = readFileSync(resolve(ROOT, ".claude/skills/diaria-publica/SKILL.md"), "utf8");
    const cited = new Set<string>();
    for (const m of skill.matchAll(/vertical_feed[`"]?\s*(?::|para)\s*`?"([a-z_]+)"/g)) cited.add(m[1]);
    assert.ok(cited.has("studio_web"), "o B3a cita studio_web");
    assert.ok(cited.has("manual"), "o SKILL cita manual");
    for (const v of cited) {
      assert.ok((SHORT_VERTICAL_FEED_COVER_VALUES as readonly string[]).includes(v), `vertical_feed "${v}" do SKILL.md fora do tipo`);
    }
  });
});
