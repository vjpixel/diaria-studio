import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyReplicatedAbsence,
  isConclusiveNonExecution,
  explainReplicatedAbsenceVerdict,
} from "../scripts/lib/replicated-absence.ts";

// ─── Reprodução do incidente real (#7083) ───────────────────────────────────
//
// Duas sessões, na máquina do editor (NÃO a máquina executora `helios`),
// leram a ausência local de `data/.session-registry-safebackup-alarm-issues.json`
// e concluíram "o alarme nunca rodou". Na realidade a task rodava
// normalmente todo dia em `helios` — o arquivo só não tinha replicado ainda
// (ou, no caso mais estreito investigado depois, nunca replicaria para
// aquele arquivo específico apesar do sync geral saudável).

test("ausência observada numa máquina não-executora nunca é 'confirmada' — reproduz e corrige o erro do #7083", () => {
  const verdict = classifyReplicatedAbsence({
    isExecutingMachine: false, // sessão rodando na máquina do editor, não em helios
    fileExists: false, // .session-registry-safebackup-alarm-issues.json ausente localmente
  });

  assert.equal(verdict, "inconclusive-non-executing-machine");
  assert.equal(
    isConclusiveNonExecution(verdict),
    false,
    "ausência numa máquina não-executora nunca pode ser lida como prova de 'a task nunca rodou'",
  );
});

test("a mesma ausência, checada NA máquina executora, é conclusiva", () => {
  // Evidência real trazida pela sessão coordenadora (#7083, comentário de
  // correção): em `helios`, o arquivo existe (15714 bytes, escrito no
  // mesmo minuto da última execução do timer armado) — mas o teste aqui
  // cobre o contrafactual (arquivo ausente NA PRÓPRIA máquina executora),
  // que é o único caso em que a ausência de fato prova não-execução.
  const verdict = classifyReplicatedAbsence({
    isExecutingMachine: true, // rodando em helios, a própria máquina que executa o timer
    fileExists: false,
  });

  assert.equal(verdict, "confirmed-absent-on-executing-machine");
  assert.equal(isConclusiveNonExecution(verdict), true);
});

test("arquivo presente nunca é uma ausência a classificar, independente da máquina", () => {
  assert.equal(classifyReplicatedAbsence({ isExecutingMachine: false, fileExists: true }), "not-absent");
  assert.equal(classifyReplicatedAbsence({ isExecutingMachine: true, fileExists: true }), "not-absent");
});

// ─── O teste diferencial que produziu o erro original ───────────────────────
//
// A 1ª sessão comparou dois arquivos-irmãos em `data/sessions/` na MESMA
// máquina não-executora: `.gc.log` (presente) vs. `.safebackup-alarm.log`
// (ausente) — e concluiu, por diferença, que a 2ª task nunca rodou. O
// defeito do método (nas palavras da correção): "os dois lados do
// diferencial estavam na mesma ponta do sync". O classificador não permite
// essa promoção: a presença de UM arquivo irmão não muda o veredito do
// outro — cada arquivo é avaliado pela própria evidência, e nenhuma delas
// (numa máquina não-executora) é conclusiva sozinha.

test("presença de um arquivo-irmão na mesma máquina não promove a ausência do outro a confirmada", () => {
  const gcLogVerdict = classifyReplicatedAbsence({ isExecutingMachine: false, fileExists: true });
  const alarmLogVerdict = classifyReplicatedAbsence({ isExecutingMachine: false, fileExists: false });

  assert.equal(gcLogVerdict, "not-absent");
  assert.equal(alarmLogVerdict, "inconclusive-non-executing-machine");
  // O ponto central: mesmo com um sinal positivo de sync saudável ao lado
  // (o irmão chegou), o veredito do arquivo ausente continua inconclusivo —
  // nunca vira "a task nunca rodou".
  assert.equal(isConclusiveNonExecution(alarmLogVerdict), false);
});

// ─── Canário fresco NÃO promove o veredito (a correção da correção) ────────
//
// A 2ª leitura óbvia seria "cheque o canário de sync antes de concluir
// ausência" — mas o próprio #7083 documenta que isso teria enganado da
// mesma forma: o canário geral estava fresco (outros dotfiles de alarme
// chegaram normalmente) e AINDA ASSIM este arquivo específico não
// replicou. O classificador trata `canaryFreshness` como informativo
// apenas — nunca como o que decide o veredito.

test("canário de sync fresco não promove uma ausência não-executora a confirmada", () => {
  const verdict = classifyReplicatedAbsence({
    isExecutingMachine: false,
    fileExists: false,
    canaryFreshness: "fresh",
  });

  assert.equal(verdict, "inconclusive-non-executing-machine");
  assert.equal(isConclusiveNonExecution(verdict), false);

  const explanation = explainReplicatedAbsenceVerdict(verdict, "fresh");
  assert.match(explanation, /NÃO descarta um buraco de sync/);
});

test("canário obsoleto reforça (só na mensagem) a hipótese de sync atrasado, sem mudar o veredito", () => {
  const verdict = classifyReplicatedAbsence({
    isExecutingMachine: false,
    fileExists: false,
    canaryFreshness: "stale",
  });

  assert.equal(verdict, "inconclusive-non-executing-machine");
  const explanation = explainReplicatedAbsenceVerdict(verdict, "stale");
  assert.match(explanation, /sync atrasado\/quebrado/);
});
