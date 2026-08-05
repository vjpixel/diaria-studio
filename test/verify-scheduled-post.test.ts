/**
 * test/verify-scheduled-post.test.ts (#2074)
 *
 * Testa a lógica principal de verify-scheduled-post.ts com mocks.
 * NUNCA chama a API Beehiiv real.
 *
 * Regressão central (260611): editor confirmou "agendado" mas a API mostrou
 * `status: published` com `publish_date = now` — o clique foi Publish (envio
 * imediato), não Schedule. Este teste cobre os dois desfechos:
 *   A) scheduled corretamente (publish_date no futuro)
 *   B) publicado imediato (publish_date <= now)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { verifyScheduledPost } from "../scripts/verify-scheduled-post.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = resolve(ROOT, "scripts", "verify-scheduled-post.ts");
const NOW = new Date("2026-06-11T01:30:00Z");

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Cria um edition_dir temporário com 05-published.json de stub.
 * Limpa automaticamente após o teste via return do dir.
 */
function makeTmpEditionDir(opts?: { withPublishedJson?: boolean }): string {
  const dir = resolve(tmpdir(), `diaria-test-vspost-${Date.now()}`);
  const internalDir = resolve(dir, "_internal");
  mkdirSync(internalDir, { recursive: true });

  if (opts?.withPublishedJson !== false) {
    // _internal/05-published.json stub
    writeFileSync(
      resolve(internalDir, "05-published.json"),
      JSON.stringify({
        draft_url: "https://app.beehiiv.com/posts/post_test/edit",
        status: "draft",
        title: "Test title",
        test_email_sent_at: "2026-06-11T01:00:00Z",
      }),
      "utf8",
    );
  }
  return dir;
}

function cleanupDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors in tests
  }
}

// ── testes ────────────────────────────────────────────────────────────────────

describe("verifyScheduledPost (#2074)", () => {
  it("desfecho A: scheduled corretamente — publish_date no futuro", () => {
    const dir = makeTmpEditionDir();
    try {
      const futureDate = Math.floor(NOW.getTime() / 1000) + 8 * 3600; // 8h futuro
      const post = {
        id: "post_abc",
        status: "confirmed",
        publish_date: futureDate,
      };
      const result = verifyScheduledPost(post, dir, NOW);
      assert.equal(result.state, "scheduled");
      assert.equal(result.immediate_send_detected, false);
      assert.equal(result.published_json_updated, false);
      assert.ok(result.scheduled_at, "deve ter scheduled_at no futuro");
      assert.equal(result.published_at, null);
      assert.equal(result.post_id, "post_abc");

      // 05-published.json NÃO deve ter sido modificado
      const updated = JSON.parse(readFileSync(resolve(dir, "_internal", "05-published.json"), "utf8")) as Record<string, unknown>;
      assert.equal(updated.status, "draft", "status não deve mudar para scheduled corretamente");
    } finally {
      cleanupDir(dir);
    }
  });

  it("desfecho B: publicado imediato — publish_date no passado (caso 260611)", () => {
    const dir = makeTmpEditionDir();
    try {
      // publish_date = now (envio imediato às 22:46 BRT — cenário real 260611)
      const publishedAt = Math.floor(NOW.getTime() / 1000); // = now exato
      const post = {
        id: "post_260611",
        status: "confirmed",
        publish_date: publishedAt,
      };
      const result = verifyScheduledPost(post, dir, NOW);
      assert.equal(result.state, "published");
      assert.equal(result.immediate_send_detected, true);
      assert.equal(result.published_json_updated, true);
      assert.equal(result.scheduled_at, null);
      assert.ok(result.published_at, "deve ter published_at");

      // 05-published.json deve ter sido atualizado com status: published
      const updated = JSON.parse(readFileSync(resolve(dir, "_internal", "05-published.json"), "utf8")) as Record<string, unknown>;
      assert.equal(updated.status, "published", "status deve ser atualizado para published");
      assert.ok(updated.published_at, "published_at deve estar presente");
    } finally {
      cleanupDir(dir);
    }
  });

  it("desfecho B: publicado imediato — publish_date 1min no passado", () => {
    const dir = makeTmpEditionDir();
    try {
      const justPast = Math.floor(NOW.getTime() / 1000) - 60; // 1 minuto atrás
      const post = {
        id: "post_just_past",
        status: "confirmed",
        publish_date: justPast,
      };
      const result = verifyScheduledPost(post, dir, NOW);
      assert.equal(result.state, "published");
      assert.equal(result.immediate_send_detected, true);
    } finally {
      cleanupDir(dir);
    }
  });

  it("boundary: publish_date exatamente = now → published (não scheduled)", () => {
    const dir = makeTmpEditionDir();
    try {
      const exactNow = Math.floor(NOW.getTime() / 1000);
      const post = {
        id: "post_boundary",
        status: "confirmed",
        publish_date: exactNow,
      };
      const result = verifyScheduledPost(post, dir, NOW);
      // resolveBeehiivState: publishMs > now.getTime() → strictamente maior
      // publish_date * 1000 = now.getTime() → NÃO strictamente maior → published
      assert.equal(result.state, "published");
    } finally {
      cleanupDir(dir);
    }
  });

  it("boundary: publish_date = now + 1s → scheduled (ainda no futuro)", () => {
    const dir = makeTmpEditionDir();
    try {
      const justFuture = Math.floor(NOW.getTime() / 1000) + 1;
      const post = {
        id: "post_just_future",
        status: "confirmed",
        publish_date: justFuture,
      };
      const result = verifyScheduledPost(post, dir, NOW);
      assert.equal(result.state, "scheduled");
      assert.equal(result.immediate_send_detected, false);
    } finally {
      cleanupDir(dir);
    }
  });

  it("draft sem publish_date → unknown (nenhuma ação sobre 05-published.json)", () => {
    const dir = makeTmpEditionDir();
    try {
      const post = {
        id: "post_draft",
        status: "draft",
      };
      const result = verifyScheduledPost(post, dir, NOW);
      assert.equal(result.state, "draft");
      assert.equal(result.immediate_send_detected, false);
      assert.equal(result.published_json_updated, false);
    } finally {
      cleanupDir(dir);
    }
  });

  it("sem 05-published.json: immediate_send_detected sem crash + published_json_updated=false", () => {
    const dir = makeTmpEditionDir({ withPublishedJson: false });
    try {
      const pastDate = Math.floor(NOW.getTime() / 1000) - 3600;
      const post = {
        id: "post_nojson",
        status: "confirmed",
        publish_date: pastDate,
      };
      // Não deve lançar — apenas avisar no stderr e setar published_json_updated=false
      const result = verifyScheduledPost(post, dir, NOW);
      assert.equal(result.state, "published");
      assert.equal(result.immediate_send_detected, true);
      assert.equal(result.published_json_updated, false, "sem o arquivo, não atualiza");
    } finally {
      cleanupDir(dir);
    }
  });

  it("05-published.json no root (path legado) também é atualizado", () => {
    const dir = makeTmpEditionDir({ withPublishedJson: false });
    try {
      // Colocar 05-published.json no root, não no _internal
      writeFileSync(
        resolve(dir, "05-published.json"),
        JSON.stringify({ status: "draft", title: "test" }),
        "utf8",
      );
      const pastDate = Math.floor(NOW.getTime() / 1000) - 100;
      const post = {
        id: "post_root",
        status: "confirmed",
        publish_date: pastDate,
      };
      const result = verifyScheduledPost(post, dir, NOW);
      assert.equal(result.immediate_send_detected, true);
      assert.equal(result.published_json_updated, true);

      const updated = JSON.parse(readFileSync(resolve(dir, "05-published.json"), "utf8")) as Record<string, unknown>;
      assert.equal(updated.status, "published");
    } finally {
      cleanupDir(dir);
    }
  });

  // #2104: publish_date negativo não deve gerar 'published' falso
  it("#2104 regressão: publish_date negativo → unknown (não immediate_send_detected)", () => {
    const dir = makeTmpEditionDir();
    try {
      const post = {
        id: "post_neg_date",
        status: "confirmed",
        publish_date: -1, // campo mal populado pela API
      };
      const result = verifyScheduledPost(post, dir, NOW);
      assert.equal(result.state, "unknown");
      assert.equal(result.immediate_send_detected, false, "publish_date negativo não deve disparar alerta de envio imediato");
      assert.equal(result.published_json_updated, false);
    } finally {
      cleanupDir(dir);
    }
  });

  it("D3 regressão: 05-published.json contendo null não apaga campos existentes", () => {
    // JSON.parse("null") retorna null; { ...null, status } produz {} silenciosamente.
    // O guard typeof previne isso — verifica que campos originais são preservados.
    const dir = makeTmpEditionDir({ withPublishedJson: false });
    try {
      // Arquivo corrompido com conteúdo "null"
      const internalDir = resolve(dir, "_internal");
      mkdirSync(internalDir, { recursive: true });
      writeFileSync(resolve(internalDir, "05-published.json"), "null", "utf8");

      const pastDate = Math.floor(NOW.getTime() / 1000) - 100;
      const post = {
        id: "post_corrupt",
        status: "confirmed",
        publish_date: pastDate,
      };
      // Não deve lançar, deve atualizar status mesmo com arquivo corrompido
      const result = verifyScheduledPost(post, dir, NOW);
      assert.equal(result.immediate_send_detected, true);
      assert.equal(result.published_json_updated, true);

      const updated = JSON.parse(readFileSync(resolve(internalDir, "05-published.json"), "utf8")) as Record<string, unknown>;
      assert.equal(updated.status, "published");
      assert.ok(updated.published_at, "published_at deve estar presente");
      // Campos originais eram null (arquivo corrompido) — garantir que não há
      // draft_url/title fantasmas de null espalhados
      assert.equal(Object.keys(updated).sort().join(","), "published_at,status");
    } finally {
      cleanupDir(dir);
    }
  });
});

describe("verify-scheduled-post exit semantics (#4638)", () => {
  // Regression test pro crash Windows libuv. O bug: process.exit(N) dentro
  // de main() forçava shutdown do libuv enquanto o fetch agent ainda tinha
  // sockets keep-alive abertos, disparando a assertion UV_HANDLE_CLOSING
  // (exit 127/134) mesmo com o JSON de resultado já impresso corretamente
  // no stdout. Mesma classe já corrigida em validate-gemini-config.ts (#1401)
  // e check-google-token.ts. Fix: process.exitCode + return, deixando o
  // event loop drenar naturalmente.
  //
  // O check estático abaixo garante que main() não chama process.exit()
  // diretamente — single source of truth pra detectar a regressão.
  // Portável em Linux/Mac (CI) e Windows (onde o bug original aparecia).

  it("main() usa process.exitCode em vez de process.exit() (#4638)", () => {
    const source = readFileSync(SCRIPT, "utf8");
    // Strip line comments pra não matchar referências em // process.exit() ...
    const sourceNoComments = source.replace(/\/\/.*$/gm, "");
    // Pega só o corpo da função main()
    const mainMatch = sourceNoComments.match(/async function main\(\)[\s\S]*?\n\}\n/);
    assert.ok(mainMatch, "main() function não encontrada no script");
    const mainBody = mainMatch[0];
    // Bug original: process.exit(N) dentro de main()
    // Fix: deve usar process.exitCode pra evitar UV_HANDLE_CLOSING no Windows
    assert.equal(
      /process\.exit\s*\(/.test(mainBody),
      false,
      "main() não pode chamar process.exit() — usar process.exitCode (#4638 Windows crash)",
    );
    // E deve setar exitCode em todos os branches
    assert.match(mainBody, /process\.exitCode/, "main() deve setar process.exitCode");
  });

  it("catch handler do isMainModule() também usa process.exitCode (#4638)", () => {
    const source = readFileSync(SCRIPT, "utf8");
    const sourceNoComments = source.replace(/\/\/.*$/gm, "");
    const catchMatch = sourceNoComments.match(/if \(isMainModule\(import\.meta\.url\)\) \{[\s\S]*?\n\}\n?$/);
    assert.ok(catchMatch, "bloco isMainModule() não encontrado no script");
    const catchBody = catchMatch[0];
    assert.equal(
      /process\.exit\s*\(/.test(catchBody),
      false,
      "catch de main() não pode chamar process.exit() — usar process.exitCode (#4638 Windows crash)",
    );
    assert.match(catchBody, /process\.exitCode/, "catch de main() deve setar process.exitCode");
  });

  it("script sem --post-id sai limpo com exit 2 (cross-platform smoke)", () => {
    // Smoke test: spawnSync sem args obrigatórios cai no branch de uso
    // (exit 2) sem chamar a API Beehiiv. O ponto não é testar a lógica de
    // validação — é provar que o script SAI LIMPO sem disparar
    // UV_HANDLE_CLOSING. Antes do fix, Windows podia retornar 127 (crash)
    // em vez de 2 nesse mesmo branch pós-fetch (aqui nem chega a haver
    // fetch, mas o smoke cobre o caminho isMainModule()/exitCode ponta-a-ponta).
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", SCRIPT],
      { encoding: "utf8", env: process.env, timeout: 30_000 },
    );
    assert.equal(result.status, 2, `exit code esperado 2, veio ${result.status} (stderr: ${result.stderr?.slice(0, 200)})`);
  });
});
