/**
 * overnight-prose-track-map.test.ts (#6204 item 3)
 *
 * Trava a tabela de correspondência entre o vocabulário em prosa do
 * overnight/continuo e os 6 valores de `ExecTrack`. Dois níveis de
 * garantia:
 *
 *   1. Cobertura — todo `OvernightProseStatus` tem uma entrada, e nenhum
 *      `ExecTrack` fica de fora do union declarado nas entradas (round-trip
 *      contra `EXEC_TRACK_UI`, a mesma fonte que os gates de cobertura do
 *      develop usam).
 *   2. Round-trip real — pra cada entrada com `tracks` não-vazio, monta um
 *      estado de issue mínimo (labels) que produz aquele status na prosa e
 *      confirma que `classifyExecTrack` sobre esse MESMO estado devolve um
 *      track dentre os listados. Isso é o que garante que a tabela não é
 *      só uma lista de nomes bonitos — é verificável contra o classificador
 *      real, então divergir os dois vocabulários no futuro quebra aqui
 *      antes de qualquer sessão relatar (falsamente) "sem divergência".
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyExecTrack,
  EXEC_TRACK_UI,
  type ExecTrack,
} from "../scripts/lib/issue-exec-track.ts";
import {
  OVERNIGHT_PROSE_TRACK_MAP,
  expectedTracksForProseStatus,
  isProseTrackConsistent,
  type OvernightProseStatus,
} from "../scripts/lib/overnight-prose-track-map.ts";

const NOW = new Date("2026-08-26T12:00:00Z");

const ALL_PROSE_STATUSES: OvernightProseStatus[] = [
  "elegivel",
  "precisa-resposta",
  "bloqueada-externa",
  "requer-sessao-local",
  "not-this-week",
  "sem-direcao-acionavel",
  "ambigua-trade-off-real",
  // #6438
  "mesmo-tema-sessao-ativa",
  "session-finding-deferida",
  "stale-aguarda-reexecucao",
  // #6437
  "escopo-residual",
];

describe("OVERNIGHT_PROSE_TRACK_MAP — cobertura", () => {
  it("tem exatamente uma entrada por status em prosa, sem duplicata", () => {
    const statuses = OVERNIGHT_PROSE_TRACK_MAP.map((m) => m.status);
    assert.deepEqual([...statuses].sort(), [...ALL_PROSE_STATUSES].sort());
    assert.equal(new Set(statuses).size, statuses.length);
  });

  it("todo ExecTrack do union aparece em ao menos uma entrada (nenhum órfão)", () => {
    const allTracks = new Set<ExecTrack>();
    for (const m of OVERNIGHT_PROSE_TRACK_MAP) for (const t of m.tracks) allTracks.add(t);
    // epica não tem status em prosa equivalente hoje — o overnight não
    // decompõe issues em épicas na Fase 0; documentado, não um bug de
    // cobertura. Os demais 5 precisam aparecer.
    const expectedCovered: ExecTrack[] = ["overnight", "bloqueada", "develop", "agendada", "fora-de-rodada"];
    for (const t of expectedCovered) {
      assert.ok(allTracks.has(t), `ExecTrack "${t}" não aparece em nenhuma entrada da tabela`);
    }
    // Nenhum valor fora do union declarado por EXEC_TRACK_UI.
    const validTracks = new Set(EXEC_TRACK_UI.map((e) => e.track));
    for (const t of allTracks) {
      assert.ok(validTracks.has(t), `"${t}" não é um ExecTrack válido (EXEC_TRACK_UI)`);
    }
  });

  it("precisa-resposta é o único status sem ExecTrack correspondente (efêmero)", () => {
    const empties = OVERNIGHT_PROSE_TRACK_MAP.filter((m) => m.tracks.length === 0);
    assert.deepEqual(empties.map((m) => m.status), ["precisa-resposta"]);
  });
});

describe("expectedTracksForProseStatus / isProseTrackConsistent", () => {
  it("lança em status desconhecido (typo é bug, não degrada em silêncio)", () => {
    assert.throws(() => expectedTracksForProseStatus("nao-existe" as OvernightProseStatus));
  });

  it("isProseTrackConsistent nunca é true pra precisa-resposta", () => {
    for (const t of EXEC_TRACK_UI.map((e) => e.track)) {
      assert.equal(isProseTrackConsistent("precisa-resposta", t), false);
    }
  });

  it("elegivel só é consistente com overnight", () => {
    assert.equal(isProseTrackConsistent("elegivel", "overnight"), true);
    assert.equal(isProseTrackConsistent("elegivel", "develop"), false);
  });

  it("not-this-week aceita agendada OU bloqueada, nada mais", () => {
    assert.equal(isProseTrackConsistent("not-this-week", "agendada"), true);
    assert.equal(isProseTrackConsistent("not-this-week", "bloqueada"), true);
    assert.equal(isProseTrackConsistent("not-this-week", "overnight"), false);
    assert.equal(isProseTrackConsistent("not-this-week", "epica"), false);
  });
});

describe("round-trip contra classifyExecTrack real", () => {
  it("elegivel: issue sem labels de bloqueio → overnight", () => {
    const track = classifyExecTrack({ labels: [], body: "direção clara", state: "OPEN", now: NOW });
    assert.ok(isProseTrackConsistent("elegivel", track));
  });

  it("bloqueada-externa: label external-blocker → bloqueada", () => {
    const track = classifyExecTrack({ labels: ["external-blocker"], body: "", state: "OPEN", now: NOW });
    assert.ok(isProseTrackConsistent("bloqueada-externa", track));
  });

  it("requer-sessao-local: label windows → develop", () => {
    const track = classifyExecTrack({ labels: ["windows"], body: "", state: "OPEN", now: NOW });
    assert.ok(isProseTrackConsistent("requer-sessao-local", track));
  });

  it("not-this-week SEM marcador de data: label not-this-week → bloqueada", () => {
    const track = classifyExecTrack({ labels: ["not-this-week"], body: "", state: "OPEN", now: NOW });
    assert.ok(isProseTrackConsistent("not-this-week", track));
  });

  it("not-this-week COM marcador de data futura: → agendada", () => {
    const track = classifyExecTrack({
      labels: ["not-this-week"],
      body: "<!-- aguardando-ate: 2026-09-01 -->",
      state: "OPEN",
      now: NOW,
    });
    assert.ok(isProseTrackConsistent("not-this-week", track));
  });

  it("sem-direcao-acionavel: label sem-direcao-acionavel → fora-de-rodada", () => {
    const track = classifyExecTrack({ labels: ["sem-direcao-acionavel"], body: "", state: "OPEN", now: NOW });
    assert.ok(isProseTrackConsistent("sem-direcao-acionavel", track));
  });

  it("ambigua-trade-off-real: label trade-off-real → develop", () => {
    const track = classifyExecTrack({ labels: ["trade-off-real"], body: "", state: "OPEN", now: NOW });
    assert.ok(isProseTrackConsistent("ambigua-trade-off-real", track));
  });

  // #6438
  it("mesmo-tema-sessao-ativa: sem claim registrado → continua overnight", () => {
    const track = classifyExecTrack({ labels: [], body: "mesmo tema de sessão peer ativa, sem claim", state: "OPEN", now: NOW });
    assert.ok(isProseTrackConsistent("mesmo-tema-sessao-ativa", track));
  });

  it("session-finding-deferida: marcador aguardando-ate futuro → agendada", () => {
    const track = classifyExecTrack({
      labels: ["session-finding"],
      body: "<!-- aguardando-ate: 2026-09-01 -->",
      state: "OPEN",
      now: NOW,
    });
    assert.ok(isProseTrackConsistent("session-finding-deferida", track));
  });

  it("stale-aguarda-reexecucao: marcador aguardando-ate futuro → agendada", () => {
    const track = classifyExecTrack({
      labels: [],
      body: "<!-- aguardando-ate: 2026-09-01 -->",
      state: "OPEN",
      now: NOW,
    });
    assert.ok(isProseTrackConsistent("stale-aguarda-reexecucao", track));
  });

  // #6437
  it("escopo-residual: label windows → develop (um dos 4 tracks aceitos)", () => {
    const track = classifyExecTrack({ labels: ["windows"], body: "", state: "OPEN", now: NOW });
    assert.ok(isProseTrackConsistent("escopo-residual", track));
  });
});
