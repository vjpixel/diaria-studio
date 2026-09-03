/**
 * test/issue-exec-track-depends-on.test.ts (#7137)
 *
 * Confere que a label `dependencia-aberta` (`DEPENDS_ON_BLOCK_LABEL`) se
 * comporta como qualquer outra `BLOCKED_LABELS` dentro de `classifyExecTrack`
 * — mesma precedência, mesmo `matched`, presente no catálogo tipado. A
 * lógica de QUANDO aplicar/remover a label vive em
 * `test/issue-depends-on.test.ts` (função pura `decideDependsOnLabelAction`)
 * — este arquivo cobre só a integração com o classificador.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyExecTrack,
  classifyExecTrackWithRule,
  EXEC_TRACK_MATCH_CATALOG,
  DEPENDS_ON_BLOCK_LABEL,
  type ExecTrack,
} from "../scripts/lib/issue-exec-track.ts";

const NOW = new Date("2026-09-02T12:00:00Z");

function track(labels: string[], body = ""): ExecTrack {
  return classifyExecTrack({ labels, body, now: NOW });
}

describe("classifyExecTrack — dependencia-aberta (#7137)", () => {
  it("label dependencia-aberta sozinha → bloqueada", () => {
    assert.equal(track([DEPENDS_ON_BLOCK_LABEL]), "bloqueada");
  });

  it("matched: label:dependencia-aberta", () => {
    const r = classifyExecTrackWithRule({ labels: [DEPENDS_ON_BLOCK_LABEL], body: "", now: NOW });
    assert.equal(r.track, "bloqueada");
    assert.equal(r.matched, `label:${DEPENDS_ON_BLOCK_LABEL}`);
  });

  it("fora-de-rodada vence dependencia-aberta", () => {
    assert.equal(track(["on-hold", DEPENDS_ON_BLOCK_LABEL]), "fora-de-rodada");
  });

  it("epica vence dependencia-aberta", () => {
    assert.equal(track(["epic-guarda-chuva", DEPENDS_ON_BLOCK_LABEL]), "epica");
  });

  it("marcador de data futura NÃO ressuscita issue bloqueada por dependência (bloqueio real vence agendada)", () => {
    assert.equal(
      track([DEPENDS_ON_BLOCK_LABEL], "<!-- aguardando-ate: 2026-09-10 -->"),
      "bloqueada",
    );
  });

  it("dependencia-aberta vence windows/trade-off-real (bloqueio real vence develop)", () => {
    assert.equal(track([DEPENDS_ON_BLOCK_LABEL, "windows"]), "bloqueada");
    assert.equal(track([DEPENDS_ON_BLOCK_LABEL, "trade-off-real"]), "bloqueada");
  });

  it("issue fechada → fora-de-rodada mesmo com dependencia-aberta (state vence tudo)", () => {
    assert.equal(
      classifyExecTrack({ labels: [DEPENDS_ON_BLOCK_LABEL], body: "", now: NOW, state: "CLOSED" }),
      "fora-de-rodada",
    );
  });

  it("sem a label, issue classifica normalmente (sem regressão)", () => {
    assert.equal(track(["bug", "P2"]), "overnight");
  });

  it("está no catálogo tipado de ExecTrackMatch", () => {
    assert.ok((EXEC_TRACK_MATCH_CATALOG as readonly string[]).includes(`label:${DEPENDS_ON_BLOCK_LABEL}`));
  });
});
