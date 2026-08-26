import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveDevelopPlanPath,
  type DevelopPlanProbeResult,
} from "../scripts/lib/develop-plan-collision.ts";

/** "Disco" fake em memória — path → { session_id }. Simula
 * `data/develop/{AAMMDD}{suffix}/plan.json` sem tocar o filesystem. */
function fakeDisk(initial: Record<string, string | null> = {}) {
  const files = new Map<string, string | null>(Object.entries(initial));
  return {
    probe(path: string): DevelopPlanProbeResult {
      if (!files.has(path)) return { exists: false };
      return { exists: true, sessionId: files.get(path) ?? null };
    },
    write(path: string, sessionId: string) {
      files.set(path, sessionId);
    },
  };
}

test("primeira sessão do dia: nenhum plan.json existe → path sem sufixo, mode fresh", () => {
  const disk = fakeDisk();
  const resolved = resolveDevelopPlanPath("data/develop", "260826", "session-A", disk.probe);
  assert.deepEqual(resolved, {
    path: "data/develop/260826/plan.json",
    suffix: "",
    mode: "fresh",
  });
});

test("resume: mesmo session_id já gravado no arquivo → mesmo path, mode resume", () => {
  const disk = fakeDisk({ "data/develop/260826/plan.json": "session-A" });
  const resolved = resolveDevelopPlanPath("data/develop", "260826", "session-A", disk.probe);
  assert.deepEqual(resolved, {
    path: "data/develop/260826/plan.json",
    suffix: "",
    mode: "resume",
  });
});

// --- reprodução direta do incidente #6265 -------------------------------

test("reproduz a colisão do #6265: Sessão B nunca sobrescreve o path da Sessão A", () => {
  const disk = fakeDisk();

  // Sessão A escreve primeiro (Fase 0 passo 9).
  const resolvedA = resolveDevelopPlanPath("data/develop", "260826", "session-A", disk.probe);
  assert.equal(resolvedA.mode, "fresh");
  assert.equal(resolvedA.path, "data/develop/260826/plan.json");
  disk.write(resolvedA.path, "session-A");

  // Sessão A trabalha a manhã inteira, plan.json continua no mesmo path
  // com session_id "session-A" (simulado — o probe já reflete isso).

  // Sessão B chega depois (mesma máquina, mesmo dia) e pula o passo 0 —
  // exatamente o que aconteceu ao vivo. Mesmo assim, o passo 9 dela chama
  // o resolver ANTES de escrever.
  const resolvedB = resolveDevelopPlanPath("data/develop", "260826", "session-B", disk.probe);

  // A Sessão B NUNCA recebe o path da Sessão A de volta.
  assert.notEqual(resolvedB.path, resolvedA.path);
  assert.equal(resolvedB.mode, "derived-after-collision");
  assert.equal(resolvedB.path, "data/develop/260826b/plan.json");
  assert.deepEqual(resolvedB.collisions, [
    { path: "data/develop/260826/plan.json", sessionId: "session-A" },
  ]);
  disk.write(resolvedB.path, "session-B");

  // O trabalho da Sessão A, no path original, continua intacto — a "prova"
  // de que a sobrescrita do #6265 não pode mais acontecer: o probe do path
  // de A ainda devolve "session-A", nunca foi tocado pela escrita de B.
  const probedA = disk.probe(resolvedA.path);
  assert.deepEqual(probedA, { exists: true, sessionId: "session-A" });
});

test("plano legado sem session_id é tratado como potencialmente alheio (nunca 'livre pra tomar')", () => {
  const disk = fakeDisk({ "data/develop/260826/plan.json": null });
  const resolved = resolveDevelopPlanPath("data/develop", "260826", "session-B", disk.probe);
  assert.equal(resolved.mode, "derived-after-collision");
  assert.equal(resolved.path, "data/develop/260826b/plan.json");
  assert.deepEqual(resolved.collisions, [
    { path: "data/develop/260826/plan.json", sessionId: null },
  ]);
});

test("3 sessões concorrentes no mesmo dia derivam 3 paths distintos, em ordem", () => {
  const disk = fakeDisk();

  const a = resolveDevelopPlanPath("data/develop", "260826", "session-A", disk.probe);
  disk.write(a.path, "session-A");

  const b = resolveDevelopPlanPath("data/develop", "260826", "session-B", disk.probe);
  disk.write(b.path, "session-B");

  const c = resolveDevelopPlanPath("data/develop", "260826", "session-C", disk.probe);
  disk.write(c.path, "session-C");

  assert.deepEqual(
    [a.path, b.path, c.path],
    [
      "data/develop/260826/plan.json",
      "data/develop/260826b/plan.json",
      "data/develop/260826c/plan.json",
    ],
  );

  // Cada uma, ao consultar de novo (ex: 2º write da mesma sessão), recebe
  // seu PRÓPRIO path de volta em modo resume — nunca pisa nas outras.
  const aAgain = resolveDevelopPlanPath("data/develop", "260826", "session-A", disk.probe);
  assert.deepEqual(aAgain, { path: a.path, suffix: "", mode: "resume" });
  const bAgain = resolveDevelopPlanPath("data/develop", "260826", "session-B", disk.probe);
  assert.deepEqual(bAgain, { path: b.path, suffix: "b", mode: "resume" });
});

// --- reprodução do #6309: Sessão B entra pelo PASSO 0, nunca pelo 9 -----

test("#6309: Sessão B chamando o resolver no passo 0 (antes de qualquer write) nunca lê mode 'resume' do plano alheio", () => {
  const disk = fakeDisk();

  // Sessão A processa a manhã inteira e já escreveu seu plan.json (passo 9
  // dela, há muito no passado) — é o estado que a Sessão B encontra ao
  // iniciar.
  const resolvedA = resolveDevelopPlanPath("data/develop", "260826", "session-A", disk.probe);
  disk.write(resolvedA.path, "session-A");

  // Sessão B inicia. ANTES do #6309, a prosa do passo 0 só olhava
  // `existsSync(plan.json)` e concluía "é resume" sem nunca chamar o
  // resolver — o cenário que este teste teria deixado passar. Com o fix, o
  // passo 0 chama resolveDevelopPlanPath já na ENTRADA da sessão, antes de
  // decidir se é retomada.
  const stepZero = resolveDevelopPlanPath("data/develop", "260826", "session-B", disk.probe);

  // A Sessão B NUNCA pode ler "resume" aqui — não é ela quem escreveu
  // aquele plano. É exatamente esta distinção que faltava na prosa antiga.
  assert.notEqual(stepZero.mode, "resume");
  assert.equal(stepZero.mode, "derived-after-collision");
  assert.notEqual(stepZero.path, resolvedA.path);

  // O passo 0 não escreve nada (é só leitura) — a Sessão B segue para o
  // passo 9, que resolve de novo antes do 1º write real. Chamado sobre o
  // MESMO estado de disco (nada mudou entre os dois passos), o resultado é
  // idêntico — confirma que rodar a checagem duas vezes (passo 0 e passo 9)
  // é seguro e determinístico, nunca alterna de resposta entre as duas.
  const stepNine = resolveDevelopPlanPath("data/develop", "260826", "session-B", disk.probe);
  assert.deepEqual(stepNine, stepZero);

  disk.write(stepNine.path, "session-B");

  // O plano da Sessão A permanece intacto — em nenhum momento a Sessão B
  // (nem no passo 0, nem no passo 9) escreveu nele.
  assert.deepEqual(disk.probe(resolvedA.path), { exists: true, sessionId: "session-A" });
});

test("session_id com espaços em branco é normalizado antes de comparar", () => {
  const disk = fakeDisk({ "data/develop/260826/plan.json": "  session-A  " });
  const resolved = resolveDevelopPlanPath("data/develop", "260826", "session-A", disk.probe);
  assert.equal(resolved.mode, "resume");
});
