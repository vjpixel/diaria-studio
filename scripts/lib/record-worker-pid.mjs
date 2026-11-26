/**
 * scripts/lib/record-worker-pid.mjs (#14037)
 *
 * Preload (`node --import <este arquivo>`) que os sub-scripts do dispatch
 * Brevo da Etapa 5 recebem: grava o pid do PROCESSO QUE FAZ O TRABALHO em
 * `DIARIA_WORKER_PID_FILE`, para o join do Brevo em background não declarar o
 * lançamento morto enquanto o sub-script ainda roda (o dispatch pai pode ter
 * morrido com o filho vivo). Sem a variável, não faz nada. Falha ao gravar só
 * avisa no stderr: nunca impede o sub-script de rodar.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const target = process.env.DIARIA_WORKER_PID_FILE;
if (target) {
  try {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(
      target,
      JSON.stringify({ pid: process.pid, script: process.argv[1] ?? null, at: new Date().toISOString() }) + "\n",
    );
  } catch (e) {
    process.stderr.write(`[record-worker-pid #14037] AVISO: pid do worker não gravado (${e?.message ?? e}).\n`);
  }
}
