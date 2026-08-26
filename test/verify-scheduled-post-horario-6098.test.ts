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
import { compararHorario } from "../scripts/verify-scheduled-post.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Importada do SCRIPT, não reimplementada aqui. A 1ª versão deste arquivo
// copiava a regra — e a sabotagem provou o problema: desligar o guard no
// script não quebrava nenhum teste. Teste que reimplementa a lógica testa a
// si mesmo.

describe("#6098 comparação de horário — o guard do clique automatizado", () => {
  it("mesmo instante ⇒ não diverge", () => {
    assert.equal(compararHorario("2026-08-27T09:00:00Z", "2026-08-27T09:00:00Z").veredicto, "confere");
  });

  it("formato diferente do MESMO instante ⇒ não diverge", () => {
    // Normalização de formato é aceitável; o que não pode passar é instante
    // diferente.
    assert.equal(compararHorario("2026-08-27T09:00:00Z", "2026-08-27T06:00:00-03:00").veredicto, "confere");
  });

  it("REGRESSÃO: 'Next usual send time' no dia ERRADO ⇒ diverge", () => {
    // O cenário concreto: o alvo era amanhã 06:00 BRT, e a opção clicada foi
    // a de hoje. Agendamento válido, dia errado — e o exit 0 diria que
    // deu tudo certo.
    assert.equal(compararHorario("2026-08-27T09:00:00Z", "2026-08-26T09:00:00Z").veredicto, "diverge");
  });

  it("REGRESSÃO: mesmo dia, HORA errada ⇒ diverge", () => {
    assert.equal(compararHorario("2026-08-27T09:00:00Z", "2026-08-27T13:00:00Z").veredicto, "diverge");
  });

  it("sem --expect-scheduled-at ⇒ NUNCA diverge (back-compat)", () => {
    // O caminho manual continua funcionando como sempre: quem não passa a
    // flag mantém o comportamento anterior ao #6098.
    assert.equal(compararHorario(undefined, "2026-08-26T09:00:00Z").veredicto, "sem-checagem");
    assert.equal(compararHorario(undefined, null).veredicto, "sem-checagem");
  });

  it("esperado inválido ACUSA; recebido inválido silencia", () => {
    // Falhar aqui por não conseguir parsear seria trocar um agendamento bom
    // por um alarme falso. A ausência de comparação possível é silêncio, não
    // acusação.
    // Esperado inválido NÃO é silêncio (achado P1): é a substituição do
    // orchestrator quebrada, e passar batido reproduz o bug que o guard
    // existe pra impedir.
    assert.equal(compararHorario("não é data", "2026-08-26T09:00:00Z").veredicto, "esperado-invalido");
    // Recebido inválido, sim: não há comparação possível, e acusar seria
    // alarme falso.
    assert.equal(compararHorario("2026-08-26T09:00:00Z", null).veredicto, "sem-checagem");
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

describe("#6241 review P1 — o guard tem de existir no COMPORTAMENTO, não só no código", () => {
  it("REGRESSÃO: string vazia (o que `getArg` devolvia) NÃO é 'sem checagem'", () => {
    // A 1ª versão lia a flag com `getArg`, que é `@deprecated` (#4573) e
    // devolve `""` quando a flag está AUSENTE — nunca `undefined`. Com isso,
    // `Date.parse("")` dava NaN e o guard devolvia "não diverge" SEMPRE.
    // O guard existia no código e não no comportamento.
    //
    // Agora `""` cai em `esperado-invalido`, que acusa. E a ausência real
    // chega como `undefined` porque o call site usa `args.values[...]`.
    assert.equal(compararHorario("", "2026-08-26T09:00:00Z").veredicto, "esperado-invalido");
  });

  it("REGRESSÃO: placeholder literal não substituído ACUSA", () => {
    // `{scheduled_at_iso}` cru significa que a substituição do orchestrator
    // quebrou — o cenário mais provável de falha silenciosa em produção.
    assert.equal(compararHorario("{scheduled_at_iso}", "2026-08-26T09:00:00Z").veredicto, "esperado-invalido");
  });

  it("só `undefined` silencia — o caminho manual, e mais nada", () => {
    for (const v of ["", "  ", "{x}", "amanhã"]) {
      assert.notEqual(compararHorario(v, "2026-08-26T09:00:00Z").veredicto, "sem-checagem", `"${v}" silenciou`);
    }
    assert.equal(compararHorario(undefined, "2026-08-26T09:00:00Z").veredicto, "sem-checagem");
  });
});
