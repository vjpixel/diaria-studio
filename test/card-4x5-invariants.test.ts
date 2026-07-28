/**
 * test/card-4x5-invariants.test.ts (#4090 itens 1/4, regressão #633)
 *
 * Dois invariantes novos derivados da decisão do editor de 260728 (comentário
 * na issue #4090) sobre o card social 4:5 (feed do Instagram/Facebook,
 * título embutido, #4114):
 *
 *   - Stage 3 `card-4x5-exists` (error, gate-blocking): "nenhuma edição sai
 *     sem card 4:5" — antes desta decisão a falha de geração era
 *     non-blocking e os publishers caíam pro 1:1 em silêncio (o estado que
 *     motivou a #4114 originalmente).
 *   - Stage 4 `card-4x5-upload-missing` (warning, nunca bloqueia): cobre o
 *     passo SEGUINTE — upload — que pode falhar independente da geração ter
 *     dado certo.
 *
 * Arquivo separado (não editado dentro do já-grande test/check-invariants-
 * stage.test.ts) seguindo o padrão já estabelecido pra invariantes
 * individuais no repo (test/stage-4-box-divulgacao-alt-invariant.test.ts,
 * test/stage-4-capture-failed-invariant.test.ts, etc.) — evita tocar a
 * asserção de contagem fixa de `checkAllImagesExist` (8 imagens) que um
 * describe block compartilhado arriscaria quebrar.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkCard4x5Exists,
  CARD_4X5_BASE,
  CARD_4X5_D3,
} from "../scripts/lib/invariant-checks/stage-3.ts";
import { checkCard4x5UploadMismatch } from "../scripts/lib/invariant-checks/stage-4.ts";
import { getRulesForStage } from "../scripts/lib/invariant-checks/index.ts";

function makeFixtureEdition(): string {
  const dir = mkdtempSync(join(tmpdir(), "diaria-card4x5-invariants-"));
  mkdirSync(join(dir, "_internal"), { recursive: true });
  return dir;
}

function writeApprovedCapped(dir: string, count: 2 | 3): void {
  writeFileSync(
    join(dir, "_internal", "01-approved-capped.json"),
    JSON.stringify({ highlights: Array.from({ length: count }, () => ({})) }),
  );
}

function touch(dir: string, name: string): void {
  writeFileSync(join(dir, name), Buffer.from("fake-jpg-bytes"));
}

describe("registry — card-4x5-exists (stage 3) e card-4x5-upload-missing (stage 4) (#4090)", () => {
  it("card-4x5-exists está registrada no stage 3, severity implícita error", () => {
    const rule = getRulesForStage(3).find((r) => r.id === "card-4x5-exists");
    assert.ok(rule, "esperava rule 'card-4x5-exists' no stage 3");
    assert.equal(rule!.stage, 3);
    assert.equal(rule!.source_issue, "#4090");
  });

  it("card-4x5-upload-missing está registrada no stage 4", () => {
    const rule = getRulesForStage(4).find((r) => r.id === "card-4x5-upload-missing");
    assert.ok(rule, "esperava rule 'card-4x5-upload-missing' no stage 4");
    assert.equal(rule!.stage, 4);
    assert.equal(rule!.source_issue, "#4090");
  });
});

describe("checkCard4x5Exists — Stage 3, gate-blocking (#4090, decisão 260728)", () => {
  let fixture: string;

  beforeEach(() => {
    fixture = makeFixtureEdition();
  });

  it("falha (error) pros 3 destaques quando nenhum card 4:5 existe e destaque_count=3 (default sem 01-approved-capped.json)", () => {
    const v = checkCard4x5Exists(fixture);
    assert.equal(v.length, 3, `esperava 3 violations (d1/d2/d3), achei ${JSON.stringify(v)}`);
    for (const violation of v) {
      assert.equal(violation.severity, "error", "decisão 260728: card 4:5 é MANDATÓRIO, não warning");
      assert.equal(violation.rule, "card-4x5-exists");
      assert.equal(violation.source_issue, "#4090");
    }
    rmSync(fixture, { recursive: true, force: true });
  });

  it("falha só pros 2 destaques quando destaque_count=2 (#2352 — d3 fora de escopo)", () => {
    writeApprovedCapped(fixture, 2);
    const v = checkCard4x5Exists(fixture);
    assert.equal(v.length, 2, `esperava 2 violations (d1/d2), achei ${JSON.stringify(v)}`);
    assert.ok(!v.some((x) => x.file?.includes("d3")), "d3 não deveria ser exigido com destaque_count=2");
    rmSync(fixture, { recursive: true, force: true });
  });

  it("passa (0 violations) quando todos os cards 4:5 existem", () => {
    writeApprovedCapped(fixture, 3);
    for (const name of [...CARD_4X5_BASE, ...CARD_4X5_D3]) touch(fixture, name);
    const v = checkCard4x5Exists(fixture);
    assert.equal(v.length, 0, `esperava 0 violations, achei ${JSON.stringify(v)}`);
    rmSync(fixture, { recursive: true, force: true });
  });

  it("falha só pro destaque com o card ausente (parcial — d1/d2 ok, d3 faltando)", () => {
    writeApprovedCapped(fixture, 3);
    touch(fixture, "04-d1-4x5.jpg");
    touch(fixture, "04-d2-4x5.jpg");
    const v = checkCard4x5Exists(fixture);
    assert.equal(v.length, 1);
    assert.match(v[0].message, /04-d3-4x5\.jpg/);
    rmSync(fixture, { recursive: true, force: true });
  });

  it("mensagem de erro é acionável — nomeia a fonte de marca e o comando pra reproduzir (decisão 260728)", () => {
    const v = checkCard4x5Exists(fixture);
    assert.ok(v.length > 0);
    assert.match(v[0].message, /Georgia/, "erro deve nomear a fonte de marca (causa mais comum)");
    assert.match(v[0].message, /gen-social-card-4x5\.ts/, "erro deve nomear o comando de reprodução");
    rmSync(fixture, { recursive: true, force: true });
  });
});

describe("checkCard4x5UploadMismatch — Stage 4, warning-only (#4090 item 4)", () => {
  let fixture: string;

  beforeEach(() => {
    fixture = makeFixtureEdition();
  });

  it("sem violation quando nenhum card 4:5 existe no disco (nada a cruzar)", () => {
    const v = checkCard4x5UploadMismatch(fixture);
    assert.equal(v.length, 0);
    rmSync(fixture, { recursive: true, force: true });
  });

  it("WARNING quando o card 4:5 existe mas 06-public-images.json está ausente", () => {
    touch(fixture, "04-d1-4x5.jpg");
    const v = checkCard4x5UploadMismatch(fixture);
    assert.equal(v.length, 1);
    assert.equal(v[0].severity, "warning", "item 4 da issue pede 'avisar', nunca bloquear");
    assert.equal(v[0].rule, "card-4x5-upload-missing");
    assert.match(v[0].message, /d1_4x5/);
    rmSync(fixture, { recursive: true, force: true });
  });

  it("WARNING quando 06-public-images.json existe mas sem a entry d{N}_4x5", () => {
    touch(fixture, "04-d1-4x5.jpg");
    touch(fixture, "04-d2-4x5.jpg");
    writeFileSync(
      join(fixture, "06-public-images.json"),
      JSON.stringify({
        images: {
          d1: { url: "https://poll.diaria.workers.dev/img/d1-1x1.jpg" },
          d2: { url: "https://poll.diaria.workers.dev/img/d2-1x1.jpg" },
          // d1_4x5 / d2_4x5 ausentes — upload do card não rodou/falhou
        },
      }),
    );
    writeApprovedCapped(fixture, 2);
    const v = checkCard4x5UploadMismatch(fixture);
    assert.equal(v.length, 2, `esperava warning pra d1 e d2, achei ${JSON.stringify(v)}`);
    assert.ok(v.every((x) => x.severity === "warning"));
    rmSync(fixture, { recursive: true, force: true });
  });

  it("passa (0 violations) quando o card existe e o manifest tem a entry d{N}_4x5 com URL", () => {
    touch(fixture, "04-d1-4x5.jpg");
    writeFileSync(
      join(fixture, "06-public-images.json"),
      JSON.stringify({
        images: {
          d1: { url: "https://poll.diaria.workers.dev/img/d1-1x1.jpg" },
          d1_4x5: { url: "https://poll.diaria.workers.dev/img/d1-4x5.jpg" },
        },
      }),
    );
    const v = checkCard4x5UploadMismatch(fixture);
    assert.equal(v.length, 0, `esperava 0 violations, achei ${JSON.stringify(v)}`);
    rmSync(fixture, { recursive: true, force: true });
  });

  it("respeita destaque_count=2 — não exige/cruza d3 quando a edição só tem 2 destaques", () => {
    touch(fixture, "04-d1-4x5.jpg");
    writeApprovedCapped(fixture, 2);
    writeFileSync(
      join(fixture, "06-public-images.json"),
      JSON.stringify({ images: { d1_4x5: { url: "https://x/d1-4x5.jpg" } } }),
    );
    const v = checkCard4x5UploadMismatch(fixture);
    assert.equal(v.length, 0);
    rmSync(fixture, { recursive: true, force: true });
  });

  it("06-public-images.json malformado não lança — trata como manifest vazio (public-images-parseable já cobre o erro em si)", () => {
    touch(fixture, "04-d1-4x5.jpg");
    writeFileSync(join(fixture, "06-public-images.json"), "{ not valid json");
    assert.doesNotThrow(() => checkCard4x5UploadMismatch(fixture));
    const v = checkCard4x5UploadMismatch(fixture);
    assert.equal(v.length, 1, "manifest ilegível == sem a entry — deve reportar o mesmo warning");
    rmSync(fixture, { recursive: true, force: true });
  });
});
