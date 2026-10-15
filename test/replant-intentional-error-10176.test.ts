/**
 * #10176: replantar o erro intencional quando o item que o carregava saiu do
 * 02-reviewed.md no gate (edição 261014) — grava MD + JSON + JSONL de forma
 * consistente e valida present-in-final / not-recent-repeat.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { main, baselineOccurrences, countWholeWord, findOldErrorStillPresent, sectionKeyFromLocation } from "../scripts/replant-intentional-error.ts";

const MD = `**DESTAQUE 1 | 🤖 MODELOS**

**[Claude ganha memória](https://www.anthropic.com/news/claude-memory)**

A Anthropic lançou memória no Claude.

---

**📡 RADAR**

**[Cursor vs. Claude Code](https://exame.com/tecnologia/cursor-claude-code)**
Claude Code, Cursor e GitHub Copilot disputam o mercado.

---

**ERRO INTENCIONAL**

Nessa edição, uma marca saiu grafada errada na seção LANÇAMENTOS.
`;

function setup(jsonl?: string) {
  const root = mkdtempSync(join(tmpdir(), "replant-10176-"));
  const dir = join(root, "editions", "261014");
  mkdirSync(join(dir, "_internal"), { recursive: true });
  writeFileSync(join(dir, "02-reviewed.md"), MD, "utf8");
  writeFileSync(
    join(dir, "_internal", "intentional-error.json"),
    JSON.stringify({ description: "velho", location: "LANÇAMENTOS", category: "ortografico", correct_value: "Foo", wrong_value: "Fooo", reveal: "Na última edição, escrevi Fooo onde o correto é Foo." }),
    "utf8",
  );
  const jsonlPath = join(root, "intentional-errors.jsonl");
  if (jsonl) writeFileSync(jsonlPath, jsonl, "utf8");
  return { root, dir, jsonlPath };
}

function quiet<T>(fn: () => T): T {
  return captured(fn).result;
}

/** Roda `fn` capturando o stdout (console.log) — JSON de saída do script. */
function captured<T>(fn: () => T): { result: T; stdout: string } {
  const [l, e] = [console.log, console.error];
  const out: string[] = [];
  console.log = (...a: unknown[]) => void out.push(a.join(" "));
  console.error = () => {};
  try {
    return { result: fn(), stdout: out.join("\n") };
  } finally {
    console.log = l;
    console.error = e;
  }
}

/** Grava um baseline pós-Stage 2 confiável (`stage2-post-gate` + `.capture.json` dentro da tolerância). */
function writeBaseline(dir: string, md: string) {
  const snap = join(dir, "_internal", "editor-request-snapshots", "stage2-post-gate");
  mkdirSync(snap, { recursive: true });
  writeFileSync(join(snap, "02-reviewed.md"), md, "utf8");
  writeFileSync(join(dir, "_internal", ".step-2-done.json"), JSON.stringify({ completed_at: "2026-10-13T20:00:00Z" }), "utf8");
  writeFileSync(join(snap, ".capture.json"), JSON.stringify({ captured_at: "2026-10-13T20:00:30Z", trigger: "pipeline-sentinel-step-2" }), "utf8");
}

describe("#10176 replant-intentional-error", () => {
  it("replanta nos 3 lugares de forma consistente", () => {
    const { root, dir, jsonlPath } = setup();
    try {
      assert.equal(quiet(() => main(["--edition-dir", dir, "--jsonl", jsonlPath])), 0);
      const md = readFileSync(join(dir, "02-reviewed.md"), "utf8");
      const json = JSON.parse(readFileSync(join(dir, "_internal", "intentional-error.json"), "utf8"));
      assert.notEqual(json.wrong_value, "Fooo");
      assert.ok(md.includes(json.wrong_value), "wrong_value presente no MD");
      assert.match(md, /Nessa edição, .*seção RADAR\./);
      assert.doesNotMatch(md, /LANÇAMENTOS\./);
      const entries = readFileSync(jsonlPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      assert.equal(entries.length, 1);
      assert.equal(entries[0].edition, "261014");
      assert.equal(entries[0].wrong_value, json.wrong_value);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("--dry-run não grava nada", () => {
    const { root, dir, jsonlPath } = setup();
    try {
      assert.equal(quiet(() => main(["--edition-dir", dir, "--jsonl", jsonlPath, "--dry-run"])), 0);
      assert.equal(readFileSync(join(dir, "02-reviewed.md"), "utf8"), MD);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("sem menção plantável → exit 1 e nada gravado", () => {
    const { root, dir, jsonlPath } = setup();
    try {
      const plain = MD.replace(/Claude Code, Cursor e GitHub Copilot/, "Ferramentas").replace("Cursor vs. Claude Code", "Guia");
      writeFileSync(join(dir, "02-reviewed.md"), plain, "utf8");
      assert.equal(quiet(() => main(["--edition-dir", dir, "--jsonl", jsonlPath])), 1);
      assert.equal(readFileSync(join(dir, "02-reviewed.md"), "utf8"), plain);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rollback: validação falha e JSON inexistente → nada fica gravado", () => {
    const root = mkdtempSync(join(tmpdir(), "replant-10176-rb-"));
    const dir = join(root, "editions", "261014");
    mkdirSync(join(dir, "_internal"), { recursive: true });
    try {
      // Sem 'Nessa edição' no MD → no_narrative_line; nada criado.
      writeFileSync(join(dir, "02-reviewed.md"), MD.replace(/Nessa edição,.*/, "x"), "utf8");
      assert.equal(quiet(() => main(["--edition-dir", dir, "--jsonl", join(root, "j.jsonl")])), 1);
      assert.equal(existsSync(join(dir, "_internal", "intentional-error.json")), false);
      assert.equal(existsSync(join(root, "j.jsonl")), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("#10213: --dry-run não altera conteúdo nem mtime de MD/JSON e não cria JSONL", () => {
    const { root, dir, jsonlPath } = setup();
    try {
      const mdPath = join(dir, "02-reviewed.md");
      const jsonPath = join(dir, "_internal", "intentional-error.json");
      const old = new Date("2026-01-01T00:00:00Z");
      utimesSync(mdPath, old, old);
      utimesSync(jsonPath, old, old);
      const jsonBefore = readFileSync(jsonPath, "utf8");
      assert.equal(quiet(() => main(["--edition-dir", dir, "--jsonl", jsonlPath, "--dry-run"])), 0);
      assert.equal(readFileSync(mdPath, "utf8"), MD);
      assert.equal(readFileSync(jsonPath, "utf8"), jsonBefore);
      assert.equal(statSync(mdPath).mtimeMs, old.getTime(), "MD não foi reescrito");
      assert.equal(statSync(jsonPath).mtimeMs, old.getTime(), "JSON não foi reescrito");
      assert.equal(existsSync(jsonlPath), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("#10213: JSONL com linha corrompida/sem edition preserva essas linhas", () => {
    const corrupt = '{"edition": "2609';
    const noEdition = JSON.stringify({ error_type: "x", is_feature: true });
    const other = JSON.stringify({ edition: "261001", error_type: "x", is_feature: true, source: "manual" });
    const { root, dir, jsonlPath } = setup([corrupt, noEdition, other].join("\n") + "\n");
    try {
      assert.equal(quiet(() => main(["--edition-dir", dir, "--jsonl", jsonlPath])), 0);
      const lines = readFileSync(jsonlPath, "utf8").trim().split("\n");
      assert.ok(lines.includes(corrupt), "linha corrompida preservada");
      assert.ok(lines.includes(noEdition), "linha sem edition preservada");
      assert.ok(lines.includes(other), "outra edição preservada verbatim");
      assert.equal(JSON.parse(lines[lines.length - 1]).edition, "261014");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("#10213: JSONL existente mas ilegível → exit 1, nada gravado", () => {
    const { root, dir } = setup();
    try {
      // Um diretório no lugar do arquivo: existsSync=true, readFileSync lança (EISDIR).
      const jsonlPath = join(root, "dir.jsonl");
      mkdirSync(jsonlPath);
      assert.equal(quiet(() => main(["--edition-dir", dir, "--jsonl", jsonlPath])), 1);
      assert.equal(readFileSync(join(dir, "02-reviewed.md"), "utf8"), MD);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("#10213: erro antigo ainda presente no MD → recusa (exit 1), nada gravado", () => {
    const { root, dir, jsonlPath } = setup();
    try {
      const withOld = MD.replace("A Anthropic lançou memória no Claude.", "A Fooo lançou memória no Claude.");
      writeFileSync(join(dir, "02-reviewed.md"), withOld, "utf8");
      assert.equal(quiet(() => main(["--edition-dir", dir, "--jsonl", jsonlPath])), 1);
      assert.equal(readFileSync(join(dir, "02-reviewed.md"), "utf8"), withOld);
      assert.equal(JSON.parse(readFileSync(join(dir, "_internal", "intentional-error.json"), "utf8")).wrong_value, "Fooo");
      assert.equal(existsSync(jsonlPath), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("substitui entry antiga da edição (qualquer source) sem duplicar", () => {
    const old = JSON.stringify({ edition: "261014", error_type: "x", is_feature: true, source: "manual", wrong_value: "Fooo" });
    const other = JSON.stringify({ edition: "261001", error_type: "x", is_feature: true, source: "manual" });
    const { root, dir, jsonlPath } = setup(old + "\n" + other + "\n");
    try {
      assert.equal(quiet(() => main(["--edition-dir", dir, "--jsonl", jsonlPath])), 0);
      const e = readFileSync(jsonlPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      assert.equal(e.filter((r) => r.edition === "261014").length, 1);
      assert.equal(e.filter((r) => r.edition === "261001").length, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("#10234 old_error_still_present escopado à seção do location", () => {
  const SONNET_MD = `**DESTAQUE 1 | 🤖 MODELOS**

**[Claude Haiku 5.5 fica mais barato](https://www.anthropic.com/news/haiku)**

A Anthropic cortou o preço do Haiku 5.5.

---

**📡 RADAR**

**[Cursor vs. Claude Code](https://exame.com/tecnologia/cursor-claude-code)**
Claude Code, Cursor e GitHub Copilot disputam o mercado, e o Claude Sonnet 5 lidera.

---

**ERRO INTENCIONAL**

Nessa edição, uma marca saiu grafada errada no DESTAQUE 1.
`;

  const SONNET_RECORD = { description: "trocou o nome do modelo", location: "DESTAQUE 1, parágrafo 2", category: "attribution", correct_value: "Haiku", wrong_value: "Sonnet", reveal: "Na última edição, escrevi Sonnet onde o certo era Haiku." };
  // Pré-gate: o D1 tinha o item com o erro ("Sonnet" no lugar de "Haiku") + a menção legítima no RADAR.
  const SONNET_PRE_GATE = SONNET_MD.replace(
    "A Anthropic cortou o preço do Haiku 5.5.",
    "A Anthropic cortou o preço do Haiku 5.5.\n\n**[Opus ganha contexto maior](https://www.anthropic.com/news/opus)**\n\nO Sonnet 5.5 agora lê 2M tokens.",
  );

  function setupSonnet(withBaseline: boolean) {
    const ctx = setup();
    writeFileSync(join(ctx.dir, "02-reviewed.md"), SONNET_MD, "utf8");
    writeFileSync(join(ctx.dir, "_internal", "intentional-error.json"), JSON.stringify(SONNET_RECORD), "utf8");
    if (withBaseline) writeBaseline(ctx.dir, SONNET_PRE_GATE);
    return ctx;
  }

  it("cenário real da issue (#10234): item com 'Sonnet' podado do D1, outro item cita 'Claude Sonnet 5' → replanta pela contagem do baseline, sem override", () => {
    const { root, dir, jsonlPath } = setupSonnet(true);
    try {
      const { result, stdout } = captured(() => main(["--edition-dir", dir, "--jsonl", jsonlPath]));
      assert.equal(result, 0);
      const out = JSON.parse(stdout);
      assert.equal(out.action, "replanted");
      assert.deepEqual(out.old_error_elsewhere.elsewhere, ["RADAR"], "elsewhere vai no JSON de stdout (headless)");
      assert.equal(out.old_error_elsewhere.baseline_count, 2);
      assert.equal(out.old_error_elsewhere.current_count, 1);
      assert.equal(out.old_error_elsewhere.resolved_by, "baseline_count");
      const json = JSON.parse(readFileSync(join(dir, "_internal", "intentional-error.json"), "utf8"));
      assert.notEqual(json.wrong_value, "Sonnet");
      assert.ok(readFileSync(join(dir, "02-reviewed.md"), "utf8").includes("Claude Sonnet 5"), "menção legítima intacta");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("cenário 'Sonnet' sem baseline confiável → recusa old_error_maybe_moved; com --allow-elsewhere → replanta", () => {
    const { root, dir, jsonlPath } = setupSonnet(false);
    try {
      const refused = captured(() => main(["--edition-dir", dir, "--jsonl", jsonlPath]));
      assert.equal(refused.result, 1);
      const out = JSON.parse(refused.stdout);
      assert.equal(out.action, "old_error_maybe_moved");
      assert.deepEqual(out.elsewhere, ["RADAR"]);
      assert.equal(out.baseline_count, null);
      assert.equal(out.override, "--allow-elsewhere");
      assert.equal(readFileSync(join(dir, "02-reviewed.md"), "utf8"), SONNET_MD, "nada gravado na recusa");

      const ok = captured(() => main(["--edition-dir", dir, "--jsonl", jsonlPath, "--allow-elsewhere"]));
      assert.equal(ok.result, 0);
      assert.equal(JSON.parse(ok.stdout).old_error_elsewhere.resolved_by, "allow_elsewhere");
      assert.notEqual(JSON.parse(readFileSync(join(dir, "_internal", "intentional-error.json"), "utf8")).wrong_value, "Sonnet");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("ponta a ponta: location 'RADAR (menção a \"X\")', item movido pra LANÇAMENTOS com RADAR ainda presente → recusa (mesmo com baseline)", () => {
    const preGate = `**DESTAQUE 1 | 🤖 MODELOS**

**[Claude ganha memória](https://www.anthropic.com/news/claude-memory)**

A Anthropic lançou memória no Claude.

---

**📡 RADAR**

**[Gemnini 3 chega ao Brasil](https://blog.google/gemini-3-brasil)**
O Gemnini 3 passa a falar português.

**[Cursor vs. Claude Code](https://exame.com/tecnologia/cursor-claude-code)**
Claude Code, Cursor e GitHub Copilot disputam o mercado.

---

**ERRO INTENCIONAL**

Nessa edição, uma marca saiu grafada errada na seção RADAR.
`;
    // Editor moveu o item do RADAR pra LANÇAMENTOS; o RADAR continua existindo com outro item.
    const moved = preGate
      .replace("**[Gemnini 3 chega ao Brasil](https://blog.google/gemini-3-brasil)**\nO Gemnini 3 passa a falar português.\n\n", "")
      .replace(
        "---\n\n**📡 RADAR**",
        "---\n\n**🚀 LANÇAMENTOS**\n\n**[Gemnini 3 chega ao Brasil](https://blog.google/gemini-3-brasil)**\nO Gemnini 3 passa a falar português.\n\n---\n\n**📡 RADAR**",
      );
    assert.ok(moved.includes("LANÇAMENTOS") && moved.includes("RADAR"));
    const { root, dir, jsonlPath } = setup();
    try {
      writeFileSync(join(dir, "02-reviewed.md"), moved, "utf8");
      writeFileSync(
        join(dir, "_internal", "intentional-error.json"),
        JSON.stringify({ description: "nome grafado errado", location: 'RADAR (menção a "Gemnini 3")', category: "ortografico", correct_value: "Gemini", wrong_value: "Gemnini" }),
        "utf8",
      );
      writeBaseline(dir, preGate);
      const { result, stdout } = captured(() => main(["--edition-dir", dir, "--jsonl", jsonlPath]));
      assert.equal(result, 1);
      const out = JSON.parse(stdout);
      assert.equal(out.action, "old_error_maybe_moved");
      assert.equal(out.scope, "RADAR");
      assert.deepEqual(out.elsewhere, ["LANÇAMENTOS"]);
      assert.equal(out.baseline_count, out.current_count, "contagem não caiu → item movido");
      assert.equal(readFileSync(join(dir, "02-reviewed.md"), "utf8"), moved);
      assert.equal(JSON.parse(readFileSync(join(dir, "_internal", "intentional-error.json"), "utf8")).wrong_value, "Gemnini");
      assert.equal(existsSync(jsonlPath), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("#10237: item do erro movido RADAR→LANÇAMENTOS + outro item do RADAR cortado → contagem menor NÃO autoriza replant", () => {
    const preGate = `**DESTAQUE 1 | 🤖 MODELOS**

**[Claude ganha memória](https://www.anthropic.com/news/claude-memory)**

A Anthropic lançou memória no Claude. O Gemnini 3 também foi citado.

---

**📡 RADAR**

**[Gemnini 3 chega ao Brasil](https://blog.google/gemini-3-brasil)**
O Gemnini 3 passa a falar português.

**[Outro item](https://exame.com/tecnologia/outro-item)**
Comparação com o Gemnini 3 no mercado.

---

**ERRO INTENCIONAL**

Nessa edição, uma marca saiu grafada errada na seção RADAR.
`;
    // Editor move o item do erro pra LANÇAMENTOS e corta o outro item do RADAR: total 3 → 2.
    const moved = `**DESTAQUE 1 | 🤖 MODELOS**

**[Claude ganha memória](https://www.anthropic.com/news/claude-memory)**

A Anthropic lançou memória no Claude. O Gemnini 3 também foi citado.

---

**🚀 LANÇAMENTOS**

**[Gemnini 3 chega ao Brasil](https://blog.google/gemini-3-brasil)**
O Gemnini 3 passa a falar português.

---

**📡 RADAR**

**[Item sem relação](https://exame.com/tecnologia/sem-relacao)**
Nada a ver com o assunto.

---

**ERRO INTENCIONAL**

Nessa edição, uma marca saiu grafada errada na seção RADAR.
`;
    const { root, dir, jsonlPath } = setup();
    try {
      writeFileSync(join(dir, "02-reviewed.md"), moved, "utf8");
      writeFileSync(
        join(dir, "_internal", "intentional-error.json"),
        JSON.stringify({ description: "nome grafado errado", location: 'RADAR (menção a "Gemnini 3")', category: "ortografico", correct_value: "Gemini", wrong_value: "Gemnini" }),
        "utf8",
      );
      writeBaseline(dir, preGate);
      const { result, stdout } = captured(() => main(["--edition-dir", dir, "--jsonl", jsonlPath]));
      assert.equal(result, 1);
      const out = JSON.parse(stdout);
      assert.equal(out.action, "old_error_maybe_moved");
      assert.ok(out.baseline_count > out.current_count, "total caiu, mas LANÇAMENTOS cresceu 0→1");
      assert.deepEqual(out.elsewhere.includes("LANÇAMENTOS"), true);
      assert.equal(readFileSync(join(dir, "02-reviewed.md"), "utf8"), moved);
      assert.equal(existsSync(jsonlPath), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("#10270: item do erro movido RADAR→LANÇAMENTOS + menção legítima podada de LANÇAMENTOS (contagem por seção empata) → recusa", () => {
    const preGate = `**DESTAQUE 1 | 🤖 MODELOS**

**[Claude ganha memória](https://www.anthropic.com/news/claude-memory)**

A Anthropic lançou memória no Claude.

---

**🚀 LANÇAMENTOS**

**[Comparativo legítimo](https://openai.com/index/comparativo)**
Cita o Gemnini 3 como concorrente.

---

**📡 RADAR**

**[Gemnini 3 chega ao Brasil](https://blog.google/gemini-3-brasil)**
O modelo passa a falar português.

---

**ERRO INTENCIONAL**

Nessa edição, uma marca saiu grafada errada na seção RADAR.
`;
    const moved = `**DESTAQUE 1 | 🤖 MODELOS**

**[Claude ganha memória](https://www.anthropic.com/news/claude-memory)**

A Anthropic lançou memória no Claude.

---

**🚀 LANÇAMENTOS**

**[Gemnini 3 chega ao Brasil](https://blog.google/gemini-3-brasil)**
O modelo passa a falar português.

---

**📡 RADAR**

**[Item sem relação](https://exame.com/tecnologia/sem-relacao)**
Nada a ver com o assunto.

---

**ERRO INTENCIONAL**

Nessa edição, uma marca saiu grafada errada na seção RADAR.
`;
    const { root, dir, jsonlPath } = setup();
    try {
      writeFileSync(join(dir, "02-reviewed.md"), moved, "utf8");
      writeFileSync(
        join(dir, "_internal", "intentional-error.json"),
        JSON.stringify({ description: "nome grafado errado", location: 'RADAR (menção a "Gemnini 3")', category: "ortografico", correct_value: "Gemini", wrong_value: "Gemnini" }),
        "utf8",
      );
      writeBaseline(dir, preGate);
      const { result, stdout } = captured(() => main(["--edition-dir", dir, "--jsonl", jsonlPath]));
      assert.equal(result, 1);
      const out = JSON.parse(stdout);
      assert.equal(out.action, "old_error_maybe_moved");
      assert.ok(out.baseline_count > out.current_count, "total caiu");
      assert.deepEqual(out.elsewhere, ["LANÇAMENTOS"]);
      // (#10301) Pré-condição do cenário: o item movido carrega UMA só ocorrência, então a
      // contagem de LANÇAMENTOS EMPATA (1 no baseline, 1 agora) e o `grewElsewhere` (#10237)
      // não dispara sozinho — quem recusa é o `movedItem` (identidade por URL, #10270).
      const lancamentos = (md: string) =>
        countWholeWord(md.split("**🚀 LANÇAMENTOS**")[1].split("\n---\n")[0], "Gemnini");
      assert.equal(lancamentos(preGate), 1);
      assert.equal(lancamentos(moved), lancamentos(preGate), "contagem por seção de LANÇAMENTOS empata");
      assert.equal(baselineOccurrences(dir, "Gemnini").bySection.get("LANÇAMENTOS"), lancamentos(moved));
      assert.equal(readFileSync(join(dir, "02-reviewed.md"), "utf8"), moved);
      assert.equal(existsSync(jsonlPath), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("countWholeWord conta por palavra inteira", () => {
    assert.equal(countWholeWord("Sonnet, Sonnet 5 e Sonnets", "Sonnet"), 2);
    assert.equal(countWholeWord("nada aqui", "Sonnet"), 0);
  });

  it("erro antigo ainda DENTRO da seção declarada → recusa", () => {
    const md = SONNET_MD.replace("cortou o preço do Haiku 5.5", "cortou o preço do Sonnet 5.5");
    const r = findOldErrorStillPresent(md, { wrong_value: "Sonnet", location: "DESTAQUE 1" });
    assert.equal(r.present, true);
    assert.equal(r.scope, "DESTAQUE 1");
  });

  it("ocorrência só fora da seção declarada → present=false com elsewhere preenchido (main decide: recusa salvo baseline/override)", () => {
    const r = findOldErrorStillPresent(SONNET_MD, { wrong_value: "Sonnet", location: "DESTAQUE 1" });
    assert.equal(r.present, false);
    assert.deepEqual(r.elsewhere, ["RADAR"]);
  });

  it("location não resolvível ou seção sumida do MD → conservador (texto inteiro)", () => {
    assert.equal(findOldErrorStillPresent(SONNET_MD, { wrong_value: "Sonnet", location: "item sobre preços" }).present, true);
    assert.equal(findOldErrorStillPresent(SONNET_MD, { wrong_value: "Sonnet", location: "LANÇAMENTOS" }).present, true);
    assert.equal(findOldErrorStillPresent(SONNET_MD, { wrong_value: "Sonnet", location: "DESTAQUE 1 e RADAR" }).present, true);
  });

  it("casa por palavra inteira: 'Large 3' não bate em 'Large 30'", () => {
    assert.equal(findOldErrorStillPresent("**📡 RADAR**\nMistral Large 30 saiu.\n", { wrong_value: "Large 3" }).present, false);
    assert.equal(findOldErrorStillPresent("**📡 RADAR**\nMistral Large 3 saiu.\n", { wrong_value: "Large 3" }).present, true);
  });

  it("sectionKeyFromLocation resolve os formatos livres reais", () => {
    assert.equal(sectionKeyFromLocation("DESTAQUE 2, parágrafo 3"), "DESTAQUE 2");
    assert.equal(sectionKeyFromLocation('RADAR (menção a "Claude")'), "RADAR");
    assert.equal(sectionKeyFromLocation("Lançamentos"), "LANÇAMENTOS");
    assert.equal(sectionKeyFromLocation(undefined), null);
  });
});
