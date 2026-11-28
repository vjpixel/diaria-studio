/**
 * #14381 — `--apoio` em `onboarding-form-conversas.ts` casava por trecho:
 * `--apoio não` trazia também quem respondeu "Não lembro", sem como isolar só
 * "Não". Agora o filtro de `apoio_independente` é por valor exato (sem
 * diferença de maiúscula/acento), e o `--help` documenta isso. Os filtros de
 * texto seguem por trecho.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FORM_CONVERSA_SIM, type FormResponse } from "../scripts/lib/onboarding-form-contract.ts";
import { CONVERSA_USAGE, conversaRows, parseConversaArgs } from "../scripts/onboarding-form-conversas.ts";

const R = (email: string, at: string, answers: Record<string, string>): FormResponse => ({ email, submitted_at: at, answers });

describe("#14381 --apoio casa por valor exato", () => {
  const sim = R("sim@x.com", "2026-11-28T00:00:00Z", { conversa: FORM_CONVERSA_SIM, apoio_independente: "Sim" });
  const nao = R("nao@x.com", "2026-11-27T00:00:00Z", { conversa: FORM_CONVERSA_SIM, apoio_independente: "Não" });
  const naoLembro = R("lembro@x.com", "2026-11-26T00:00:00Z", { conversa: FORM_CONVERSA_SIM, apoio_independente: "Não lembro" });
  const all = [sim, nao, naoLembro];
  const emails = (f: string) => conversaRows(all, { apoio_independente: f }).map((r) => r.email);

  it("--apoio não traz só quem respondeu 'Não', não 'Não lembro'", () => {
    assert.deepEqual(emails("não"), ["nao@x.com"]);
    assert.deepEqual(emails("nao"), ["nao@x.com"]);
    assert.deepEqual(emails("NÃO"), ["nao@x.com"]);
  });

  it("--apoio 'não lembro' isola 'Não lembro' (com espaço sobrando)", () => {
    assert.deepEqual(emails("não lembro"), ["lembro@x.com"]);
    assert.deepEqual(emails("  nao lembro "), ["lembro@x.com"]);
  });

  it("trecho não casa mais: 'lembro' e 'n' não trazem ninguém", () => {
    assert.deepEqual(emails("lembro"), []);
    assert.deepEqual(emails("n"), []);
  });

  it("filtro de texto segue por trecho", () => {
    const a = R("t@x.com", "2026-11-25T00:00:00Z", { conversa: FORM_CONVERSA_SIM, situacao: "Tenho próprio negócio" });
    assert.deepEqual(conversaRows([a], { situacao: "proprio" }).map((r) => r.email), ["t@x.com"]);
  });

  it("--help devolve help e o uso documenta o valor exato de --apoio", () => {
    assert.equal(parseConversaArgs(["--help"]).help, true);
    assert.equal(parseConversaArgs(["-h"]).help, true);
    assert.match(CONVERSA_USAGE, /--apoio <valor>/);
    assert.match(CONVERSA_USAGE, /EXATO/);
    assert.match(CONVERSA_USAGE, /não lembro/);
  });
});
