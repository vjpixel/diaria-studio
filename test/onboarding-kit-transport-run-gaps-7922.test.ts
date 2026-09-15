/**
 * test/onboarding-kit-transport-run-gaps-7922.test.ts (#7922, audit pós-merge
 * da fatia 1/N — PR #8136)
 *
 * Regressão de 2 gaps residuais achados numa auditoria pós-merge de
 * `scripts/onboarding-kit-transport-run.ts` — mesma técnica de subprocesso
 * real (`npx tsx`) de `test/onboarding-kit-transport-enabled-7922.test.ts`,
 * nunca `data/onboarding/store.json` real:
 *
 *   - **Gap #2**: `main()` chamava `readStore(storePath)` destructurando só
 *     `{ store }` — o `corrupted: true` que `readStore` devolve em SILÊNCIO
 *     pra um JSON ilegível (vira `emptyStore()`) nunca era checado. Um store
 *     corrompido virava, pro resto do script, indistinguível de "nenhum
 *     lote ainda" — `--cancel-lot`/`--approve-email3-lot` reportariam "lote
 *     não encontrado" em vez de "store corrompido", mascarando a causa real
 *     (mesma classe de risco de `claimLot`/`persistLotUpdate`, cobertos em
 *     `test/onboarding-kit-transport-run-lock-7922.test.ts`).
 *   - **Gap #3**: `plan.skips` (candidatos barrados por elegibilidade/guard
 *     de conteúdo) nunca aparecia no `summary` impresso — diferente do
 *     irmão `onboarding-welcome-run.ts`, que ganhou `summary.skips` depois
 *     do #7670 (skip silencioso fez o e-mail 3 nunca disparar pra ninguém,
 *     por meses, com o script saindo exit 0 o tempo todo).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REAL_STORE_PATH = resolve(__ROOT, "data/onboarding/store.json");

/** Mesma técnica de `onboarding-kit-transport-enabled-7922.test.ts` —
 *  compara conteúdo antes/depois em vez de só existência. */
function fingerprintRealStore(): string | null {
  if (!existsSync(REAL_STORE_PATH)) return null;
  const { size } = statSync(REAL_STORE_PATH);
  const hash = createHash("sha256").update(readFileSync(REAL_STORE_PATH)).digest("hex");
  return `${size}:${hash}`;
}

let realStoreBaseline: string | null | undefined;

function assertRealStoreUntouched(): void {
  if (realStoreBaseline === undefined) realStoreBaseline = fingerprintRealStore();
  assert.equal(fingerprintRealStore(), realStoreBaseline, "store real de produção não deve ser tocado");
}

function runScript(configPath: string, storePath: string, extraArgs: string[] = []) {
  const env = { ...process.env, KIT_API_KEY: "fixture_fake_kit_key_do_not_use" };
  const args = ["tsx", resolve(__ROOT, "scripts/onboarding-kit-transport-run.ts"), "--config", configPath, "--store", storePath, ...extraArgs];
  if (realStoreBaseline === undefined) realStoreBaseline = fingerprintRealStore();
  return spawnSync("npx", args, { cwd: __ROOT, encoding: "utf8", env, shell: process.platform === "win32" });
}

function writeIsolatedConfig(dir: string, kitTransportEnabled: boolean | undefined = true): string {
  const configPath = join(dir, "platform.config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      publishing: { newsletter: { subscriber_backend: "kit" } },
      onboarding: kitTransportEnabled === undefined ? {} : { kit_transport: { enabled: kitTransportEnabled } },
    }),
  );
  return configPath;
}

describe("onboarding-kit-transport-run.ts — gap #2: store corrompido (#7922 audit pós-merge)", () => {
  it("main() aborta (exit 2, stderr cita 'corrompido') em vez de tratar JSON ilegível como store vazio", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-kit-transport-corrupted-main-"));
    try {
      const configPath = writeIsolatedConfig(dir, true);
      const storePath = join(dir, "store.json");
      const corruptedContent = "{ isto não é json válido, faltando fechar";
      writeFileSync(storePath, corruptedContent);

      // Dry-run (sem --send) já é suficiente pra exercitar a leitura de
      // main() — o guard dispara ANTES de qualquer decisão sobre lotes.
      const result = runScript(configPath, storePath);

      assert.equal(result.status, 2, `esperava exit 2, obteve ${result.status}. stdout: ${result.stdout} stderr: ${result.stderr}`);
      assert.ok((result.stderr ?? "").toLowerCase().includes("corrompido"), `stderr deveria citar o store corrompido: ${result.stderr}`);
      // O arquivo no disco continua exatamente como estava — nunca reescrito
      // com um store vazio por engano.
      assert.equal(readFileSync(storePath, "utf8"), corruptedContent);
      assertRealStoreUntouched();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--reconcile também aborta sobre store corrompido — não é só o caminho --send", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-kit-transport-corrupted-reconcile-"));
    try {
      const configPath = writeIsolatedConfig(dir, false); // kill switch nem entra em jogo aqui — corrupted vem antes
      const storePath = join(dir, "store.json");
      writeFileSync(storePath, "não é json");

      const result = runScript(configPath, storePath, ["--reconcile"]);

      assert.equal(result.status, 2, `esperava exit 2, obteve ${result.status}. stdout: ${result.stdout} stderr: ${result.stderr}`);
      assert.ok((result.stderr ?? "").toLowerCase().includes("corrompido"), `stderr deveria citar o store corrompido: ${result.stderr}`);
      assertRealStoreUntouched();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("onboarding-kit-transport-run.ts — gap #3: summary.skips (#7922 audit pós-merge)", () => {
  it("candidato barrado por snippet ausente aparece em summary.skips, nunca some em silêncio", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-kit-transport-skips-"));
    try {
      const configPath = writeIsolatedConfig(dir, true);
      const storePath = join(dir, "store.json");
      const snippetsDir = join(dir, "snippets-vazio");
      writeFileSync(
        storePath,
        JSON.stringify({
          version: 1,
          last_detection_cursor: 1,
          last_detection_backend: "kit",
          d10_brevo_list_id: null,
          entries: {
            "1": {
              subscription_id: "1",
              email: "novo@example.com",
              status_detectado: "active",
              // `created_at: null` — sem âncora, então `selectCandidatesNeedingRefresh`
              // não marca esta entrada como precisando de refresh via rede
              // (só o status importa pro e-mail 1, já está "active"): o
              // teste exercita `summary.skips` sem precisar de nenhuma
              // chamada real à API do Kit.
              created_at: null,
              detected_at: new Date().toISOString(),
              email1_sent_at: null,
              email1_brevo_id: null,
              email2_sent_at: null,
              email2_brevo_id: null,
              email3_state: "pending",
              email3_campaign_id: null,
              email3_decided_at: null,
            },
          },
          kit_transport: { lots: {} },
        }),
      );
      // `data/snippets/onboarding-1.md` propositalmente AUSENTE — dispara
      // `motivo: "snippet_ausente"` em `buildRunPlan`.
      mkdirSync(snippetsDir, { recursive: true });

      const result = runScript(configPath, storePath, ["--snippets-dir", snippetsDir]);

      assert.equal(result.status, 0, `esperava exit 0 (dry-run), obteve ${result.status}. stdout: ${result.stdout} stderr: ${result.stderr}`);
      const summary = JSON.parse(result.stdout);
      assert.ok(Array.isArray(summary.skips), `summary.skips deveria existir e ser array — summary: ${result.stdout}`);
      assert.equal(summary.skips.length, 1, `esperava 1 skip (snippet ausente) — summary: ${result.stdout}`);
      assert.equal(summary.skips[0].etapa, "email1");
      assert.equal(summary.skips[0].motivo, "snippet_ausente");
      // Mesma convenção do irmão (`onboarding-welcome-run.ts`): nunca inclui
      // a entry bruta (PII) no resumo — só etapa/motivo/detalhe.
      assert.equal(summary.skips[0].entry, undefined, "summary.skips não deve vazar a entry bruta (PII)");
      assertRealStoreUntouched();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
