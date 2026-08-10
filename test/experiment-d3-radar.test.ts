/**
 * test/experiment-d3-radar.test.ts (#4846)
 *
 * Cobertura do mecanismo do experimento "D3 vs slot 1 do Radar":
 *
 *  (a) computeArmForEdition — mesma edição → mesmo braço sempre (#633
 *      regressão do requisito "seed determinístico"); edições diferentes →
 *      distribuição ~1:1 sobre uma amostra grande.
 *  (b) readExperimentD3RadarConfig / isExperimentD3RadarEnabled — leitura
 *      fail-soft do flag opt-in em platform.config.json (default: desligado).
 *  (c) applyExperimentArm — mutação pura de ApprovedJson (braço A no-op,
 *      braço B promove D3 pro topo do radar, edge case <3 highlights).
 *  (d) CLI — wiring determinístico: exit codes, idempotência entre
 *      invocações (resume do Stage 1 nunca re-sorteia nem re-aplica).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

import {
  computeArmForEdition,
  readExperimentD3RadarConfig,
  isExperimentD3RadarEnabled,
  applyExperimentArm,
} from "../scripts/experiment-d3-radar.ts";
import type { ApprovedJson } from "../scripts/lib/schemas/edition-state.ts";

function writeConfig(dir: string, config: unknown): string {
  const path = join(dir, "platform.config.json");
  writeFileSync(path, JSON.stringify(config), "utf8");
  return path;
}

function makeApproved(highlightCount: 2 | 3): ApprovedJson {
  const highlights = [
    { rank: 1, score: 90, bucket: "lancamento", reason: "melhor do dia", url: "https://a.example/1", article: { url: "https://a.example/1", title: "D1", score: 90 } },
    { rank: 2, score: 80, bucket: "radar", reason: "segundo melhor", url: "https://a.example/2", article: { url: "https://a.example/2", title: "D2", score: 80 } },
    { rank: 3, score: 70, bucket: "radar", reason: "terceiro melhor", url: "https://a.example/3", article: { url: "https://a.example/3", title: "D3", score: 70 } },
  ].slice(0, highlightCount);
  return {
    highlights,
    runners_up: [],
    lancamento: [{ url: "https://a.example/lanc-1", title: "Lançamento 1" }],
    radar: [
      { url: "https://a.example/radar-1", title: "Radar 1" },
      { url: "https://a.example/radar-2", title: "Radar 2" },
    ],
    use_melhor: [],
    video: [],
  };
}

// ---------------------------------------------------------------------------
// computeArmForEdition — determinístico + distribuição ~1:1
// ---------------------------------------------------------------------------

describe("computeArmForEdition (#4846)", () => {
  it("mesma edição → mesmo braço sempre (idempotência do seed)", () => {
    for (const edition of ["260810", "260811", "270101", "abc-not-a-real-date"]) {
      const first = computeArmForEdition(edition);
      for (let i = 0; i < 5; i++) {
        assert.equal(computeArmForEdition(edition), first, `edição ${edition} deveria sempre produzir ${first}`);
      }
    }
  });

  it("retorna sempre 'A' ou 'B'", () => {
    for (let i = 0; i < 50; i++) {
      const arm = computeArmForEdition(`26${String(i).padStart(4, "0")}`);
      assert.ok(arm === "A" || arm === "B", `braço inesperado: ${arm}`);
    }
  });

  it("edições diferentes se distribuem ~1:1 sobre uma amostra grande", () => {
    const N = 2000;
    let countA = 0;
    let countB = 0;
    for (let i = 0; i < N; i++) {
      const arm = computeArmForEdition(`edition-${i}`);
      if (arm === "A") countA++;
      else countB++;
    }
    const ratioA = countA / N;
    // Tolerância generosa (±10pp) — não é um teste estatístico formal, só uma
    // rede de segurança contra um hash com viés grosseiro (ex: sempre 'A').
    assert.ok(ratioA > 0.4 && ratioA < 0.6, `distribuição enviesada: A=${countA}, B=${countB} (ratio=${ratioA})`);
  });

  it("salt diferente produz série diferente pro mesmo identificador (isolamento de teste)", () => {
    // Não afirma que UM par específico sempre diverge (50% de chance de
    // colidir) — só que a função de fato consome o salt: ao menos ALGUMA
    // das combinações testadas diverge.
    const anyDiffer = ["e1", "e2", "e3", "e4", "e5", "e6", "e7", "e8"].some(
      (e) => computeArmForEdition(e, "salt-1") !== computeArmForEdition(e, "salt-2"),
    );
    assert.ok(anyDiffer, "salt deveria influenciar o resultado em ao menos uma amostra");
  });
});

// ---------------------------------------------------------------------------
// readExperimentD3RadarConfig / isExperimentD3RadarEnabled — fail-soft
// ---------------------------------------------------------------------------

describe("readExperimentD3RadarConfig / isExperimentD3RadarEnabled (#4846)", () => {
  it("enabled: true → habilitado", () => {
    const dir = mkdtempSync(join(tmpdir(), "d3-radar-cfg-"));
    try {
      const path = writeConfig(dir, { experiment_d3_radar: { enabled: true } });
      assert.equal(isExperimentD3RadarEnabled(path), true);
      assert.deepEqual(readExperimentD3RadarConfig(path), { enabled: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("enabled: false → desabilitado", () => {
    const dir = mkdtempSync(join(tmpdir(), "d3-radar-cfg-"));
    try {
      const path = writeConfig(dir, { experiment_d3_radar: { enabled: false } });
      assert.equal(isExperimentD3RadarEnabled(path), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("chave experiment_d3_radar ausente → desabilitado (default seguro)", () => {
    const dir = mkdtempSync(join(tmpdir(), "d3-radar-cfg-"));
    try {
      const path = writeConfig(dir, { newsletter: "beehiiv" });
      assert.equal(isExperimentD3RadarEnabled(path), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("arquivo de config ausente → desabilitado (fail-soft, nunca lança)", () => {
    assert.equal(
      isExperimentD3RadarEnabled(join(tmpdir(), "nao-existe-" + Date.now(), "platform.config.json")),
      false,
    );
  });

  it("JSON malformado → desabilitado (fail-soft, nunca lança)", () => {
    const dir = mkdtempSync(join(tmpdir(), "d3-radar-cfg-"));
    try {
      const path = join(dir, "platform.config.json");
      writeFileSync(path, "{ not valid json", "utf8");
      assert.equal(isExperimentD3RadarEnabled(path), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("real platform.config.json do repo NÃO tem o experimento ativado (self-review — mecanismo desligado por padrão)", () => {
    const repoConfigPath = join(import.meta.dirname, "..", "platform.config.json");
    assert.equal(
      isExperimentD3RadarEnabled(repoConfigPath),
      false,
      "esta unidade implementa só o mecanismo — ativação em produção é decisão separada (#4846)",
    );
  });
});

// ---------------------------------------------------------------------------
// applyExperimentArm — mutação pura
// ---------------------------------------------------------------------------

describe("applyExperimentArm (#4846)", () => {
  it("braço A → no-op (approved inalterado)", () => {
    const approved = makeApproved(3);
    const result = applyExperimentArm(approved, "A");
    assert.equal(result.applied, false);
    assert.equal(result.reason, "control_arm");
    assert.deepEqual(result.approved, approved);
  });

  it("braço B com 3 highlights → D3 sai de highlights, vira 1º item do radar", () => {
    const approved = makeApproved(3);
    const result = applyExperimentArm(approved, "B");

    assert.equal(result.applied, true);
    assert.equal(result.reason, "promoted_to_radar_slot_1");
    assert.equal(result.promoted_url, "https://a.example/3");

    // highlights: 2 restantes, renumerados 1/2, D1/D2 preservados na ordem.
    assert.equal(result.approved.highlights.length, 2);
    assert.equal(result.approved.highlights[0].rank, 1);
    assert.equal((result.approved.highlights[0] as { article?: { url?: string } }).article?.url, "https://a.example/1");
    assert.equal(result.approved.highlights[1].rank, 2);
    assert.equal((result.approved.highlights[1] as { article?: { url?: string } }).article?.url, "https://a.example/2");

    // radar: D3 promovido é o 1º item, marcado; radar original preservado depois.
    const radar = result.approved.radar;
    assert.equal(radar.length, 3); // 2 originais + D3 promovido
    assert.equal(radar[0].url, "https://a.example/3");
    assert.equal((radar[0] as { experiment_d3_radar_promoted?: boolean }).experiment_d3_radar_promoted, true);
    assert.equal(radar[1].url, "https://a.example/radar-1");
    assert.equal(radar[2].url, "https://a.example/radar-2");

    // Outros campos (lancamento, use_melhor, video) intocados.
    assert.deepEqual(result.approved.lancamento, approved.lancamento);
  });

  it("braço B com apenas 2 highlights (edge case editorial #2316/#2343) → no-op", () => {
    const approved = makeApproved(2);
    const result = applyExperimentArm(approved, "B");
    assert.equal(result.applied, false);
    assert.equal(result.reason, "insufficient_highlights");
    assert.deepEqual(result.approved, approved);
  });

  it("braço B: identifica D3 por rank mesmo se highlights vier fora de ordem", () => {
    const approved = makeApproved(3);
    // Embaralha a ordem física do array — rank continua sendo a fonte da verdade.
    approved.highlights = [approved.highlights[2], approved.highlights[0], approved.highlights[1]];
    const result = applyExperimentArm(approved, "B");
    assert.equal(result.applied, true);
    assert.equal(result.promoted_url, "https://a.example/3");
    const ranks = result.approved.highlights.map((h) => (h as { rank?: number }).rank).sort();
    assert.deepEqual(ranks, [1, 2]);
  });
});

// ---------------------------------------------------------------------------
// CLI — exit codes + idempotência
// ---------------------------------------------------------------------------

function runCli(cliArgs: string[]) {
  const projectRoot = join(import.meta.dirname, "..");
  const scriptPath = join(projectRoot, "scripts", "experiment-d3-radar.ts");
  return spawnSync(process.execPath, ["--import", "tsx", scriptPath, ...cliArgs], {
    cwd: projectRoot,
    encoding: "utf8",
  });
}

function makeTmpEditionInternal(): string {
  const dir = mkdtempSync(join(tmpdir(), "d3-radar-cli-"));
  const internal = join(dir, "_internal");
  mkdirSync(internal, { recursive: true });
  return internal;
}

describe("CLI experiment-d3-radar.ts (#4846)", () => {
  it("desabilitado por padrão (sem experiment_d3_radar no config) → exit 2, approved.json intocado", () => {
    const internal = makeTmpEditionInternal();
    try {
      const approvedPath = join(internal, "01-approved.json");
      const approved = makeApproved(3);
      writeFileSync(approvedPath, JSON.stringify(approved), "utf8");
      const configPath = writeConfig(internal, { newsletter: "beehiiv" });

      const res = runCli(["--edition", "260810", "--approved", approvedPath, "--config", configPath]);
      assert.equal(res.status, 2);
      assert.deepEqual(JSON.parse(readFileSync(approvedPath, "utf8")), approved);
    } finally {
      rmSync(internal, { recursive: true, force: true });
    }
  });

  it("habilitado → decide braço, grava state, aplica se braço B; 2ª invocação é idempotente (already_applied)", () => {
    const internal = makeTmpEditionInternal();
    try {
      const approvedPath = join(internal, "01-approved.json");
      const originalApproved = makeApproved(3);
      writeFileSync(approvedPath, JSON.stringify(originalApproved), "utf8");
      const configPath = writeConfig(internal, { experiment_d3_radar: { enabled: true } });
      const statePath = join(internal, ".experiment-d3.json");

      // Edição fixa cujo braço sorteado é conhecido de antemão (computado
      // com a mesma função/salt default do módulo — evita depender de sorte
      // no teste enquanto ainda exercita o caminho real de ambos os braços).
      const edition = "990101"; // qualquer identificador estável serve

      const first = runCli(["--edition", edition, "--approved", approvedPath, "--state", statePath, "--config", configPath]);
      assert.equal(first.status, 0, first.stderr);
      const firstOut = JSON.parse(first.stdout);
      assert.equal(firstOut.edition, edition);
      assert.ok(firstOut.arm === "A" || firstOut.arm === "B");

      const stateAfterFirst = JSON.parse(readFileSync(statePath, "utf8"));
      assert.equal(stateAfterFirst.edition, edition);
      assert.equal(stateAfterFirst.arm, firstOut.arm);
      assert.ok(stateAfterFirst.applied_at, "state deveria ter applied_at após a 1ª invocação resolver");

      const approvedAfterFirst = JSON.parse(readFileSync(approvedPath, "utf8"));
      if (firstOut.arm === "B") {
        assert.equal(approvedAfterFirst.highlights.length, 2);
        assert.equal(approvedAfterFirst.radar[0].experiment_d3_radar_promoted, true);
      } else {
        assert.deepEqual(approvedAfterFirst, originalApproved);
      }

      // 2ª invocação: mesmo braço, sem re-mutar (idempotência — resume do Stage 1).
      const second = runCli(["--edition", edition, "--approved", approvedPath, "--state", statePath, "--config", configPath]);
      assert.equal(second.status, 0, second.stderr);
      const secondOut = JSON.parse(second.stdout);
      assert.equal(secondOut.arm, firstOut.arm);
      assert.equal(secondOut.already_applied, true);

      const approvedAfterSecond = JSON.parse(readFileSync(approvedPath, "utf8"));
      assert.deepEqual(approvedAfterSecond, approvedAfterFirst, "2ª invocação não pode re-mutar approved.json");
    } finally {
      rmSync(internal, { recursive: true, force: true });
    }
  });

  it("state pré-existente de OUTRA edição no mesmo path → exit 1 (guard contra state stale)", () => {
    const internal = makeTmpEditionInternal();
    try {
      const approvedPath = join(internal, "01-approved.json");
      writeFileSync(approvedPath, JSON.stringify(makeApproved(3)), "utf8");
      const configPath = writeConfig(internal, { experiment_d3_radar: { enabled: true } });
      const statePath = join(internal, ".experiment-d3.json");
      writeFileSync(
        statePath,
        JSON.stringify({ edition: "260101", arm: "A", decided_at: new Date().toISOString(), applied: false, applied_at: new Date().toISOString() }),
        "utf8",
      );

      const res = runCli(["--edition", "260810", "--approved", approvedPath, "--state", statePath, "--config", configPath]);
      assert.equal(res.status, 1);
    } finally {
      rmSync(internal, { recursive: true, force: true });
    }
  });

  it("approved.json ausente → exit 1", () => {
    const internal = makeTmpEditionInternal();
    try {
      const configPath = writeConfig(internal, { experiment_d3_radar: { enabled: true } });
      const res = runCli([
        "--edition",
        "260810",
        "--approved",
        join(internal, "nao-existe.json"),
        "--config",
        configPath,
      ]);
      assert.equal(res.status, 1);
    } finally {
      rmSync(internal, { recursive: true, force: true });
    }
  });

  it("args faltando (--edition ou --approved) → exit 1", () => {
    const res = runCli(["--edition", "260810"]);
    assert.equal(res.status, 1);
  });
});
