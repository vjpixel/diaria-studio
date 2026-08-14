/**
 * test/snippet-loader.test.ts (#5227)
 *
 * Cobre `scripts/lib/shared/snippet-loader.ts` (`readSnippetFile`) — helper
 * de baixo nível reusado por `loadDivulgacaoSnippet`/`loadAgradecimentoSnippet`
 * (stitch-newsletter.ts) e `loadEncerramentoSocialApoioTemplate`
 * (encerramento-snippet.ts). Não tinha teste dedicado antes do #5227 — só
 * cobertura indireta via os callers.
 *
 * #5227: `context/snippets/` (git-tracked) migrou pra `data/snippets/`
 * (gitignored, junction OneDrive) — ausente em clone fresco/CI/worktree
 * isolado. `readSnippetFile` PERMANECE fail-soft (nunca lança, `null` em vez
 * de exceção) — é o caminho de publicação (`loadDivulgacaoSnippet`, ver
 * test/stitch-newsletter.test.ts) que passou a tratar "slot configurado mas
 * arquivo ausente" como erro duro, não este helper.
 *
 * Todo teste aqui usa `rootDir` de override (`mkdtempSync`) — NUNCA aponta
 * pra `data/snippets/` real (não pode assumir que existe nem que não existe
 * nesta máquina, ver checklist de dispatch overnight/develop).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readSnippetFile } from "../scripts/lib/shared/snippet-loader.ts";

describe("readSnippetFile (#5227) — fail-soft quando data/snippets/ não existe", () => {
  it("rootDir sem data/ nenhum (simula clone fresco/sessão cloud) -> null, nunca lança", () => {
    const root = mkdtempSync(join(tmpdir(), "snippet-loader-nodata-"));
    try {
      assert.doesNotThrow(() => readSnippetFile("qualquer-coisa.md", root));
      assert.equal(readSnippetFile("qualquer-coisa.md", root), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rootDir com data/ mas SEM data/snippets/ -> null, nunca lança", () => {
    const root = mkdtempSync(join(tmpdir(), "snippet-loader-nosnippets-"));
    mkdirSync(join(root, "data"), { recursive: true });
    try {
      assert.doesNotThrow(() => readSnippetFile("qualquer-coisa.md", root));
      assert.equal(readSnippetFile("qualquer-coisa.md", root), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("data/snippets/ existe mas o arquivo específico não -> null, nunca lança", () => {
    const root = mkdtempSync(join(tmpdir(), "snippet-loader-missingfile-"));
    mkdirSync(join(root, "data", "snippets"), { recursive: true });
    try {
      assert.equal(readSnippetFile("nao-existe.md", root), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("readSnippetFile (#5227) — leitura normal via rootDir de fixture", () => {
  it("lê o corpo, removendo o comentário HTML de header, trimado", () => {
    const root = mkdtempSync(join(tmpdir(), "snippet-loader-read-"));
    mkdirSync(join(root, "data", "snippets"), { recursive: true });
    try {
      writeFileSync(
        join(root, "data", "snippets", "exemplo.md"),
        "<!--\nnome: Exemplo\n-->\n\n  **Corpo real**\n\ntexto\n  ",
      );
      assert.equal(readSnippetFile("exemplo.md", root), "**Corpo real**\n\ntexto");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("arquivo só com comentário HTML (sem corpo) -> null (vazio após strip)", () => {
    const root = mkdtempSync(join(tmpdir(), "snippet-loader-onlycomment-"));
    mkdirSync(join(root, "data", "snippets"), { recursive: true });
    try {
      writeFileSync(join(root, "data", "snippets", "so-comentario.md"), "<!--\nsó documentação, sem conteúdo\n-->\n");
      assert.equal(readSnippetFile("so-comentario.md", root), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("2 chamadas com o MESMO rootDir/filename são idempotentes (sem efeito colateral de leitura)", () => {
    const root = mkdtempSync(join(tmpdir(), "snippet-loader-idempotent-"));
    mkdirSync(join(root, "data", "snippets"), { recursive: true });
    try {
      writeFileSync(join(root, "data", "snippets", "x.md"), "conteúdo estável");
      assert.equal(readSnippetFile("x.md", root), readSnippetFile("x.md", root));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("sem rootDir (produção — resolve a raiz real do repo) continua funcionando: null se o arquivo não existir nesta sessão, sem lançar", () => {
    // Não afirma nada sobre o CONTEÚDO (não sabemos se data/snippets/ existe
    // nesta máquina) — só que a chamada default (sem override) nunca lança,
    // preservando o contrato fail-soft de produção.
    assert.doesNotThrow(() => readSnippetFile("arquivo-que-quase-certamente-nao-existe-5227.md"));
  });
});
