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
import { verifyScheduledPost } from "../scripts/verify-scheduled-post.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
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
