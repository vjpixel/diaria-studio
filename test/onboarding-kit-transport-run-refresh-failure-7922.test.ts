/**
 * test/onboarding-kit-transport-run-refresh-failure-7922.test.ts (#7922)
 *
 * Fecha um gap de teste identificado no residual da issue #7922 ("Testes
 * cobrem... falha de consulta"): a exclusão de "falha de consulta nunca
 * autoriza envio" tinha cobertura PURA (`test/onboarding-kit-transport-7922.test.ts`
 * — `selectEligibleKitRecipients` recebendo `kit_state: null` direto) e o
 * fix de `main()` que a torna real (PR #8136, fleet review
 * silent-failure-hunter/P1: um lookup falho, sem este fix, deixava
 * `status_detectado` intocado — que é o ESTADO PERSISTIDO, tipicamente
 * "active" de um refresh anterior bem-sucedido — então `kit_state` nunca
 * virava `null` numa falha e a exclusão nunca disparava DE VERDADE), mas
 * nenhum teste exercitava esse fix no NÍVEL DO EXECUTOR (subprocesso real
 * de `onboarding-kit-transport-run.ts`, não só a função pura).
 *
 * Cenário: entrada já `status_detectado: "active"` (refresh anterior bem-
 * sucedido), `email1_sent_at` no passado (âncora da régua), due para o
 * e-mail 2 (D+3 vencido). Nesta rodada, TODA chamada de rede ao Kit falha
 * (`KIT_API_URL` apontado para uma porta sem listener — connection refused
 * determinístico, sem depender de internet/mock de `fetch`). Sem o fix, o
 * lote de email2 seria criado com este destinatário (kit_state ainda lido
 * como "active" do campo persistido); com o fix, o candidato é EXCLUÍDO
 * (`status_nao_confirmado`) e nenhum lote nasce — replica exatamente o
 * requisito da issue "Falha de consulta não autoriza envio" no caminho que
 * de fato roda em produção, não só na função isolada.
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

/** Mesma técnica dos irmãos `onboarding-kit-transport-*-7922.test.ts`. */
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

describe("onboarding-kit-transport-run.ts — falha de consulta nunca autoriza envio, no nível do executor (#7922)", () => {
  it("candidato com status_detectado='active' PERSISTIDO, mas refresh desta rodada FALHA (Kit inalcançável) → excluído do lote, nenhum lote criado", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-kit-transport-refresh-failure-"));
    try {
      const configPath = join(dir, "platform.config.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          publishing: { newsletter: { subscriber_backend: "kit" } },
          onboarding: { kit_transport: { enabled: true } },
        }),
      );

      const storePath = join(dir, "store.json");
      const nowSec = Math.floor(Date.now() / 1000);
      const email1SentAtSec = nowSec - 5 * 86_400; // 5 dias atrás — D+3 já venceu
      writeFileSync(
        storePath,
        JSON.stringify({
          version: 1,
          last_detection_cursor: 1,
          last_detection_backend: "kit",
          d10_brevo_list_id: null,
          entries: {
            "9001": {
              subscription_id: "9001",
              kit_subscriber_id: 9001,
              email: "refresh-failure@example.com",
              // Persistido ACTIVE de um refresh anterior bem-sucedido — é
              // exatamente este campo que o bug (pré-fix #8136) deixava
              // intocado numa falha de rede.
              status_detectado: "active",
              created_at: email1SentAtSec,
              detected_at: new Date(email1SentAtSec * 1000).toISOString(),
              email1_sent_at: new Date(email1SentAtSec * 1000).toISOString(),
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

      const snippetsDir = join(dir, "snippets");
      mkdirSync(snippetsDir, { recursive: true });
      writeFileSync(
        join(snippetsDir, "onboarding-2.md"),
        '<!-- assunto: "assunto 2" preview_text: "preview 2" -->\nCorpo do e-mail 2 de teste.\n',
      );

      // `KIT_API_URL` inalcançável (porta 1, sem listener) — TODA chamada de
      // rede ao Kit (numérico + fallback por e-mail) falha com connection
      // refused, determinístico e sem depender de internet nem de mockar
      // `fetch` (que não seria possível através de `spawnSync` de qualquer
      // forma — subprocesso real).
      const env = {
        ...process.env,
        KIT_API_KEY: "fixture_fake_kit_key_do_not_use",
        KIT_API_URL: "http://127.0.0.1:1",
      };
      const args = [
        "tsx",
        resolve(__ROOT, "scripts/onboarding-kit-transport-run.ts"),
        "--config",
        configPath,
        "--store",
        storePath,
        "--snippets-dir",
        snippetsDir,
      ];
      if (realStoreBaseline === undefined) realStoreBaseline = fingerprintRealStore();
      const result = spawnSync("npx", args, { cwd: __ROOT, encoding: "utf8", env, shell: process.platform === "win32", timeout: 30_000 });

      assert.equal(result.status, 0, `esperava exit 0 (dry-run, sem --send), obteve ${result.status}. stdout: ${result.stdout} stderr: ${result.stderr}`);
      assert.ok(
        (result.stderr ?? "").includes("refresh falhou pra 9001"),
        `stderr deveria registrar o refresh falho: ${result.stderr}`,
      );
      const summary = JSON.parse(result.stdout);
      const email2Lot = (summary.lots as Array<Record<string, unknown>>).find((l) => l.kind === "email2");
      assert.ok(email2Lot, `esperava uma entrada de resumo para kind=email2 — summary: ${result.stdout}`);
      assert.equal(email2Lot!.eligible, 0, `refresh falho deveria zerar elegíveis — lot: ${JSON.stringify(email2Lot)}`);
      const excluded = email2Lot!.excluded as Array<{ email: string; reason: string }> | number;
      assert.ok(Array.isArray(excluded) ? excluded.length === 1 : excluded === 1, `esperava 1 excluído — lot: ${JSON.stringify(email2Lot)}`);
      if (Array.isArray(excluded)) {
        assert.equal(excluded[0].reason, "status_nao_confirmado", `motivo de exclusão deveria ser status_nao_confirmado (falha de consulta), não outro — lot: ${JSON.stringify(email2Lot)}`);
      }
      // Nenhum lote de fato materializado no store (dry-run não escreve, mas
      // reforça que a decisão de "0 elegíveis" nunca chegou perto de criar
      // um lote com este destinatário).
      assertRealStoreUntouched();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
