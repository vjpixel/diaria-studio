/**
 * no-committed-make-webhook.test.ts (#3903)
 *
 * Regressão dedicada pro incidente #3903: a URL real do webhook Make.com
 * (`https://hook.us2.make.com/dmikx9ktrmee9woy1synf5vvgo5qhx2t`) ficou
 * commitada em `platform.config.json` desde 1d7051ee (#850) — bots que
 * monitoram commits do GitHub já a encontraram e visitam periodicamente com
 * GET vazio; um POST bem-formado postaria na company page real do LinkedIn,
 * sem passar pelo token `X-Diaria-Token` do Worker (que só protege o caminho
 * `worker_queue`, não o webhook Make em si).
 *
 * Este teste garante que:
 *   1. o regex de detecção usado abaixo casa a URL histórica vazada, mas NÃO
 *      os inúmeros fixtures de teste do repo (`https://hook.eu2.make.com/test`
 *      em test/publish-linkedin.test.ts, `https://make.test/...` em
 *      workers/linkedin-cron/test/*.test.ts) — sem essa distinção, o teste
 *      falharia sempre, mascarando regressões reais;
 *   2. `platform.config.json` tem `make_webhook_url` e `make_webhook_pixel_url`
 *      vazios;
 *   3. nenhum arquivo TRACKED pelo git no repo inteiro contém uma URL
 *      Make.com que pareça um webhook real (não apenas platform.config.json —
 *      "varredura de outros segredos" do #3903 achou um 2º valor real-looking
 *      em docs/linkedin-cron-worker-setup.md, mesma commit 1d7051ee, redigido
 *      neste mesmo PR).
 *
 * Self-review (#2038): rodado manualmente com a URL antiga temporariamente
 * reintroduzida em platform.config.json — o teste 2 (make_webhook_url vazio)
 * e o teste 3 (varredura repo-wide) falharam como esperado; depois revertido.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Casa domínio real do Make.com (`hook.<região>.make.com`) seguido de um path
 * que PARECE um scenario ID real: 10+ chars alfanuméricos contíguos. Fixtures
 * de teste do repo usam placeholders curtos ("test", "diaria") ou domínios
 * fake ("make.test") que não casam — só um token longo, sem underscore/
 * reticências/ângulos, dispara o match (ver docstring acima pros exemplos
 * concretos que precisam ficar de fora).
 */
export const REAL_MAKE_WEBHOOK_RE = /hook\.[a-z0-9]+\.make\.com\/[a-zA-Z0-9]{10,}/;

describe("#3903 REAL_MAKE_WEBHOOK_RE: sanity do próprio regex de detecção", () => {
  it("casa a URL histórica vazada (#3903, commit 1d7051ee)", () => {
    // URL já pública no histórico do git antes deste PR (citada na própria
    // issue #3903) — não é um segredo novo sendo introduzido aqui.
    const leakedHistoricalUrl = "https://hook.us2.make.com/dmikx9ktrmee9woy1synf5vvgo5qhx2t";
    assert.match(leakedHistoricalUrl, REAL_MAKE_WEBHOOK_RE);
  });

  it("casa o 2º valor real-looking achado na varredura (docs/linkedin-cron-worker-setup.md, mesma commit)", () => {
    const secondValue = "https://hook.us2.make.com/2alvu89nbn9uo5tpvnjnhpbu22uf1sb6";
    assert.match(secondValue, REAL_MAKE_WEBHOOK_RE);
  });

  it("NÃO casa fixtures de teste do repo (hook.eu2.make.com/test)", () => {
    assert.doesNotMatch("https://hook.eu2.make.com/test", REAL_MAKE_WEBHOOK_RE);
  });

  it("NÃO casa domínio fake usado nos testes do Worker (make.test)", () => {
    assert.doesNotMatch("https://make.test/diaria", REAL_MAKE_WEBHOOK_RE);
  });

  it("NÃO casa placeholders documentais (SEU_WEBHOOK_ID, <NEW>, abc123...)", () => {
    assert.doesNotMatch("https://hook.eu2.make.com/SEU_WEBHOOK_ID", REAL_MAKE_WEBHOOK_RE);
    assert.doesNotMatch("https://hook.us2.make.com/<NEW>", REAL_MAKE_WEBHOOK_RE);
    assert.doesNotMatch("https://hook.eu2.make.com/abc123...", REAL_MAKE_WEBHOOK_RE);
  });
});

describe("#3903 platform.config.json: nenhuma URL real de webhook Make commitada", () => {
  it("make_webhook_url e make_webhook_pixel_url ficam vazios em código versionado", () => {
    const raw = readFileSync(resolve(ROOT, "platform.config.json"), "utf8");
    const config = JSON.parse(raw) as {
      publishing?: { social?: { linkedin?: { make_webhook_url?: string; make_webhook_pixel_url?: string } } };
    };
    assert.equal(
      config.publishing?.social?.linkedin?.make_webhook_url,
      "",
      "make_webhook_url não deve ter URL real commitada (#3903) — usar MAKE_LINKEDIN_WEBHOOK_URL (env) ou Worker secret",
    );
    assert.equal(
      config.publishing?.social?.linkedin?.make_webhook_pixel_url,
      "",
      "make_webhook_pixel_url deve continuar vazio (#3903 item 5 — nunca precisou de valor local)",
    );
  });

  it("o arquivo bruto não contém nenhuma URL que case REAL_MAKE_WEBHOOK_RE", () => {
    const raw = readFileSync(resolve(ROOT, "platform.config.json"), "utf8");
    assert.doesNotMatch(raw, REAL_MAKE_WEBHOOK_RE);
  });
});

describe("#3903 varredura repo-wide: nenhum arquivo tracked pelo git contém URL real de webhook Make", () => {
  it("git ls-files (HEAD/working tree) — 0 ocorrências fora dos fixtures de teste conhecidos", () => {
    const tracked = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" })
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    const BINARY_EXT_RE = /\.(png|jpe?g|gif|ico|woff2?|ttf|eot)$/i;
    // Este PRÓPRIO arquivo é auto-excluído: ele documenta a URL histórica vazada
    // (#3903) e o 2º valor achado na varredura como fixtures literais pro teste
    // de sanity do regex acima — sem essa exclusão, o scan se acusaria a si
    // mesmo assim que este arquivo virasse tracked pelo git (git add/commit).
    const SELF_PATH = "test/no-committed-make-webhook.test.ts";
    const offenders: string[] = [];

    for (const relPath of tracked) {
      const normalized = relPath.replace(/\\/g, "/");
      if (normalized === SELF_PATH) continue;
      if (BINARY_EXT_RE.test(relPath)) continue;
      const absPath = resolve(ROOT, relPath);
      let content: string;
      try {
        content = readFileSync(absPath, "utf8");
      } catch {
        continue; // arquivo removido no working tree ou ilegível — não é o alvo deste teste
      }
      if (REAL_MAKE_WEBHOOK_RE.test(content)) {
        offenders.push(relPath);
      }
    }

    assert.deepEqual(
      offenders,
      [],
      `arquivo(s) com URL real de webhook Make commitada (#3903): ${offenders.join(", ")}`,
    );
  });
});
