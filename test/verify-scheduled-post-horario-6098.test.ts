/**
 * test/verify-scheduled-post-horario-6098.test.ts (#6098)
 *
 * O guard que torna o clique AUTOMATIZADO seguro.
 *
 * Enquanto o clique em Schedule era manual, o editor lia a data no modal
 * antes de confirmar — era ele o guard. Automatizado, ninguém lê: o passo 2
 * da sequência escolhe uma OPÇÃO de horário, e escolher a errada produz um
 * agendamento **perfeitamente válido, no dia errado**.
 *
 * `state === "scheduled"` deixa de ser evidência suficiente. É a mesma
 * correção que o #6162 fez no canal Kit: comparar INSTANTES, não existência.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { divergeDoEsperado } from "../scripts/verify-scheduled-post.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Importada do SCRIPT, não reimplementada aqui. A 1ª versão deste arquivo
// copiava a regra — e a sabotagem provou o problema: desligar o guard no
// script não quebrava nenhum teste. Teste que reimplementa a lógica testa a
// si mesmo.

describe("#6098 comparação de horário — o guard do clique automatizado", () => {
  it("mesmo instante ⇒ não diverge", () => {
    assert.equal(divergeDoEsperado("2026-08-27T09:00:00Z", "2026-08-27T09:00:00Z"), false);
  });

  it("formato diferente do MESMO instante ⇒ não diverge", () => {
    // Normalização de formato é aceitável; o que não pode passar é instante
    // diferente.
    assert.equal(divergeDoEsperado("2026-08-27T09:00:00Z", "2026-08-27T06:00:00-03:00"), false);
  });

  it("REGRESSÃO: 'Next usual send time' no dia ERRADO ⇒ diverge", () => {
    // O cenário concreto: o alvo era amanhã 06:00 BRT, e a opção clicada foi
    // a de hoje. Agendamento válido, dia errado — e o exit 0 diria que
    // deu tudo certo.
    assert.equal(divergeDoEsperado("2026-08-27T09:00:00Z", "2026-08-26T09:00:00Z"), true);
  });

  it("REGRESSÃO: mesmo dia, HORA errada ⇒ diverge", () => {
    assert.equal(divergeDoEsperado("2026-08-27T09:00:00Z", "2026-08-27T13:00:00Z"), true);
  });

  it("sem --expect-scheduled-at ⇒ NUNCA diverge (back-compat)", () => {
    // O caminho manual continua funcionando como sempre: quem não passa a
    // flag mantém o comportamento anterior ao #6098.
    assert.equal(divergeDoEsperado(undefined, "2026-08-26T09:00:00Z"), false);
    assert.equal(divergeDoEsperado(undefined, null), false);
  });

  it("data inválida de qualquer lado ⇒ não diverge (não inventa falha)", () => {
    // Falhar aqui por não conseguir parsear seria trocar um agendamento bom
    // por um alarme falso. A ausência de comparação possível é silêncio, não
    // acusação.
    assert.equal(divergeDoEsperado("não é data", "2026-08-26T09:00:00Z"), false);
    assert.equal(divergeDoEsperado("2026-08-26T09:00:00Z", null), false);
  });
});

describe("#6098 o script aceita a flag nova sem quebrar o uso antigo", () => {
  function rodar(args: string[]): { code: number; err: string } {
    const dir = mkdtempSync(join(tmpdir(), "vsp-6098-"));
    mkdirSync(join(dir, "_internal"), { recursive: true });
    writeFileSync(join(dir, "_internal", "05-published.json"), JSON.stringify({ post_id: "post_x" }), "utf8");
    try {
      execFileSync("npx", ["tsx", "scripts/verify-scheduled-post.ts", ...args], {
        cwd: ROOT,
        encoding: "utf8",
        stdio: "pipe",
        env: { ...process.env, BEEHIIV_API_KEY: "", BEEHIIV_PUBLICATION_ID: "" },
      });
      return { code: 0, err: "" };
    } catch (e) {
      const err = e as { status?: number; stderr?: string };
      return { code: err.status ?? -1, err: String(err.stderr ?? "") };
    }
  }

  it("--expect-scheduled-at não é rejeitado como flag desconhecida", () => {
    // Sem credencial o script falha na API — o que importa aqui é que ele
    // NÃO falhe antes disso, por não reconhecer a flag.
    const r = rodar(["--post-id", "post_x", "--expect-scheduled-at", "2026-08-27T09:00:00Z"]);
    assert.doesNotMatch(r.err, /unknown|desconhecid|inválid[ao] flag/i);
  });
});
