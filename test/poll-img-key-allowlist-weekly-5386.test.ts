/**
 * test/poll-img-key-allowlist-weekly-5386.test.ts (#5386)
 *
 * `weekly-flat-card.ts` (#5330) e `weekly-carousel-news-card.ts` (#5345)
 * inventaram um namespace de chave KV próprio (`weekly/{key}/{slot}-4x5.jpg`)
 * que não bate com a allowlist `/^img-[^:]+$/` de `handleImage`
 * (`workers/poll/src/index.ts`, fix de segurança do #4112). O upload pro KV
 * funcionava (`PUT` aceita qualquer chave), mas `GET /img/{key}` — a rota
 * que a Graph API do Instagram usa pra buscar `image_url` — devolvia 404.
 * Resultado em produção: `weekly-highlights` de 260815 falhou 5× e caiu na
 * DLQ.
 *
 * Este teste NÃO copia o regex do Worker — importa `handleImage` de verdade
 * (mesmo padrão de `poll-img-key-allowlist-4112.test.ts`) e exercita as
 * chaves REAIS produzidas pelos dois helpers via `resolveOrGenerateFlatCardUrl`/
 * `resolveOrGenerateNewsCardUrl`, fechando o laço que faltava: nada no repo
 * ligava o formato da chave gerada à regra que o Worker exige.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import worker from "../workers/poll/src/index.ts";
import { resolveOrGenerateFlatCardUrl, type FlatCardGenerator } from "../scripts/lib/weekly-flat-card.ts";
import { resolveOrGenerateNewsCardUrl, type NewsCardGenerator } from "../scripts/lib/weekly-carousel-news-card.ts";
import { cloudflareKvKey } from "../scripts/upload-images-public.ts";

function makeEnv() {
  const store = new Map<string, string>();
  return {
    POLL: {
      get: async (key: string, type?: string) => {
        const v = store.get(key);
        if (v === undefined) return null;
        if (type === "arrayBuffer") return new TextEncoder().encode(v).buffer;
        return v;
      },
      put: async (key: string, value: string) => void store.set(key, value),
      list: async () => ({ keys: [], list_complete: true, cursor: undefined }),
      delete: async () => {},
    },
    __store: store,
  } as never;
}

/** GET real contra o Worker — 200 == a chave passou na allowlist E foi servida. */
async function fetchImg(env: ReturnType<typeof makeEnv>, key: string) {
  return worker.fetch(new Request(`https://poll.test/img/${encodeURIComponent(key)}`), env);
}

describe("chaves KV do carrossel semanal batem com a allowlist real do Worker (#5386)", () => {
  it("regressão: o namespace ANTIGO `weekly/{key}/{slot}-4x5.jpg` é rejeitado (documenta o bug)", async () => {
    const env = makeEnv();
    const store = (env as unknown as { __store: Map<string, string> }).__store;
    store.set("weekly/260815-highlights/cover-4x5.jpg", "JPEGBYTES");
    const res = await fetchImg(env, "weekly/260815-highlights/cover-4x5.jpg");
    assert.equal(res.status, 404, "chave com namespace weekly/ nunca deveria ser servível — é isso que quebrava em produção");
  });

  it("weekly-flat-card: chave gerada por resolveOrGenerateFlatCardUrl é servida (200) pelo Worker real", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "diaria-flatcard-5386-"));
    const env = makeEnv();
    const store = (env as unknown as { __store: Map<string, string> }).__store;
    let capturedKvKey = "";
    const generator: FlatCardGenerator = async ({ kvKey }) => {
      capturedKvKey = kvKey;
      store.set(kvKey, "JPEGBYTES");
      return { url: `https://cdn.example.com/${kvKey}` };
    };
    try {
      await resolveOrGenerateFlatCardUrl(
        dataRoot,
        "260815-highlights",
        "cover",
        { kicker: "Resumo semanal", title: "Título", footer: "diar.ia.br" },
        generator,
      );
      assert.match(capturedKvKey, /^img-[^:]+$/, "kvKey precisa casar com a allowlist do Worker");
      const res = await fetchImg(env, capturedKvKey);
      assert.equal(res.status, 200);
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it("weekly-carousel-news-card: chave gerada por resolveOrGenerateNewsCardUrl é servida (200) pelo Worker real", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "diaria-newscard-5386-"));
    const env = makeEnv();
    const store = (env as unknown as { __store: Map<string, string> }).__store;
    let capturedKvKey = "";
    const generator: NewsCardGenerator = async ({ kvKey }) => {
      capturedKvKey = kvKey;
      store.set(kvKey, "JPEGBYTES");
      return { url: `https://cdn.example.com/${kvKey}` };
    };
    try {
      await resolveOrGenerateNewsCardUrl(
        dataRoot,
        "260815-highlights",
        {
          editionDate: "260810",
          editionDir: "/fake/edition/dir",
          destaque: "d1",
          title: "Título do destaque",
          category: "NOTÍCIAS",
          fontSize: 62,
        },
        generator,
      );
      assert.match(capturedKvKey, /^img-[^:]+$/, "kvKey precisa casar com a allowlist do Worker");
      const res = await fetchImg(env, capturedKvKey);
      assert.equal(res.status, 200);
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it("card diário (upload-images-public.ts) continua intocado — convenção `img-{AAMMDD}-{filename}` inalterada", () => {
    const key = cloudflareKvKey("data/editions/260815", "d1-4x5.jpg");
    assert.equal(key, "img-260815-d1-4x5.jpg");
    assert.match(key, /^img-[^:]+$/);
  });
});
