/**
 * test/publica-video-b5b-buffer-11471.test.ts (#11471)
 *
 * O Passo B5b de `/diaria-publica-video` mandava chamar o `create_post` da
 * Buffer só com `mode: "customScheduled"` e `dueAt`. Na execução real de
 * 261028 a 1ª chamada falhou na validação (`schedulingType` é obrigatório),
 * com `dueAt` null o modo certo foi `shareNow`, e o post voltou `sending` sem
 * a skill dizer como confirmar o X. Trava a prosa corrigida e o caminho de
 * registro que ela promete (`--mark x=URL` substitui a entrada `buffer:`).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildMarkEntry, parseMarkArg } from "../scripts/publish-shorts.ts";
import { upsertShortEntry, type ShortsPublishedFile } from "../scripts/lib/diaria/short-video.ts";

const SKILL = readFileSync(join(import.meta.dirname, "..", ".claude", "skills", "diaria-publica-video", "SKILL.md"), "utf8");

function section(start: string, end: string): string {
  const i = SKILL.indexOf(start);
  assert.ok(i >= 0, `seção ${start} não encontrada`);
  const j = SKILL.indexOf(end, i + start.length);
  return SKILL.slice(i, j < 0 ? undefined : j);
}

const B5B = section("### Passo B5b", "\n### ");

describe("#11471: Passo B5b — create_post da Buffer para o X", () => {
  it("exige schedulingType e nomeia os dois valores aceitos", () => {
    assert.match(B5B, /schedulingType: "automatic"/);
    assert.match(B5B, /`automatic` ou `notification`/);
  });

  it("dueAt null usa shareNow, não customScheduled", () => {
    assert.match(B5B, /`dueAt` null[^.]*`mode: "shareNow"`/);
  });

  it("assets vai como array JSON", () => {
    assert.match(B5B, /`assets` vai como \*\*array JSON\*\*/);
    assert.match(B5B, /assets: \[\{ video: \{ url: videoUrl, metadata: \{ thumbnailOffset \} \} \}\]/);
  });

  it("repassa o offset da capa inclusive zero e omite metadata sem offset (#11547)", () => {
    assert.match(B5B, /`thumbnailOffset` de `results\[\]\.buffer` quando presente, inclusive zero, em milissegundos/);
    assert.match(B5B, /omitir `metadata` quando ausente/);
  });

  it("o formato do asset de vídeo deixou de ser premissa não verificada", () => {
    assert.doesNotMatch(B5B, /premissa não verificada/);
    assert.match(B5B, /Formato verificado na execução real de 261028/);
  });

  it("diz como confirmar o X depois de status sending", () => {
    assert.match(B5B, /status: "sending"/);
    assert.match(B5B, /`get_post`/);
    assert.match(B5B, /status: "sent"/);
    assert.match(B5B, /--mark x=\{URL do tweet\}/);
  });
});

describe("#11471: duração do vertical nas observações do Instagram", () => {
  it("não cita mais o vertical de ~50 s; registra os 75 s medidos", () => {
    const igRow = SKILL.split("\n").find((l) => l.startsWith("| `instagram` |"));
    assert.ok(igRow, "linha do instagram na tabela de destinos");
    assert.doesNotMatch(igRow, /vertical da diar\.ia\.br \(~50 s\)/);
    assert.match(igRow, /75 s/);
  });
});

describe("#11471: --mark x=URL substitui o registro buffer:{id}", () => {
  it("buffer:{id} grava scheduled; a URL do tweet troca por published", () => {
    const at = "2026-10-28T12:00:00.000Z";
    const scheduled = buildMarkEntry(parseMarkArg("x=buffer:abc123"), undefined, at);
    assert.ok(scheduled.ok);
    assert.equal(scheduled.entry.status, "scheduled");

    let file: ShortsPublishedFile = { aammdd: "261028", entries: [] };
    file = upsertShortEntry(file, scheduled.entry);

    const published = buildMarkEntry(parseMarkArg("x=https://x.com/diariabr/status/1"), undefined, at);
    assert.ok(published.ok);
    file = upsertShortEntry(file, published.entry);

    const xs = file.entries.filter((e) => e.destination === "x");
    assert.equal(xs.length, 1);
    assert.equal(xs[0].status, "published");
    assert.equal(xs[0].url, "https://x.com/diariabr/status/1");
  });
});
