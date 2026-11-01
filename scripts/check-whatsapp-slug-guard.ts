/**
 * check-whatsapp-slug-guard.ts (#4570)
 *
 * **Nenhum passo do pipeline chama este script desde o #11225** (a Etapa 6 só
 * agenda pelo Kit): nada bloqueia por slug depois do Stage 4. Sobra como
 * comparação avulsa para post antigo da Beehiiv. Se o slug REAL do post divergir do slug
 * que a URL do bloco WhatsApp (dentro do D1, #5152) já prevê (`seoSlug(D1)`), o link
 * já enviado no corpo do e-mail 404. Ver `scripts/lib/whatsapp-slug-guard.ts`
 * pra racional completo.
 *
 * Não chama a API/MCP Beehiiv diretamente — recebe o slug ATUAL via
 * `--actual-slug` (o orchestrator já o obtém via
 * `mcp__claude_ai_Beehiiv__get_post`, só disponível pro top-level, não pra
 * scripts). Isso mantém a comparação pura/testável
 * (`checkWhatsappSlugMatch`) e este script um wrapper fino de I/O.
 *
 * Uso:
 *   npx tsx scripts/check-whatsapp-slug-guard.ts \
 *     --post-id POST_ID --d1-title "Título do D1" [--actual-slug SLUG_ATUAL] \
 *     [--out PATH]
 *
 *   `--actual-slug` pode ser omitido (post sem slug ainda / campo ausente no
 *   `get_post`) — tratado como divergência, nunca bate com um slug esperado
 *   não-vazio.
 *
 *   `--out PATH` (opcional, #4574) grava `{ ok, expectedSlug, actualSlug,
 *   checkedAt }` em disco (cria diretórios pais se necessário). Existe pra
 *   dar ao guard um backstop DETERMINÍSTICO: sem isso, o único jeito de o
 *   Stage 6 "lembrar" que o guard rodou e passou é o agente LLM ter lido e
 *   seguido a prosa do orchestrator corretamente — nada em código verificava
 *   isso (achado do review consolidado da PR #4574, que introduziu o guard
 *   em #4570 sem esse backstop). A regra `whatsapp-slug-guard-ok`, que lia esse
 *   arquivo, saiu no #11225.
 *
 * Stdout: sempre o JSON de `WhatsappSlugCheckResult` (`ok`/`expectedSlug`/
 * `actualSlug`/`message?`) — consumível por script ou lido por um agente.
 * Stderr: a mensagem de correção manual formatada, só quando `ok === false`
 * (mesmo padrão de `fix-post-slug.ts` — instruções acionáveis no stream de
 * erro, JSON estruturado no stdout).
 *
 * Exit codes:
 *   0 = slug bate.
 *   1 = slug diverge (só relata; nada no pipeline lê este exit).
 *   2 = args inválidos (`--post-id`/`--d1-title` ausentes).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { checkWhatsappSlugMatch } from "./lib/whatsapp-slug-guard.ts";

export function main(argv: string[]): number {
  const { values } = parseArgs(argv);
  const postId = values["post-id"];
  const d1Title = values["d1-title"];
  const actualSlugRaw = values["actual-slug"];
  const outPath = values["out"];

  if (!postId || !d1Title) {
    process.stderr.write(
      "Uso: check-whatsapp-slug-guard.ts --post-id POST_ID --d1-title TITULO [--actual-slug SLUG] [--out PATH]\n" +
        "  --post-id      ID do post Beehiiv (só usado pra formatar a URL de correção manual)\n" +
        "  --d1-title     Título do D1 da edição (mesma fonte de buildWhatsappEditionUrl)\n" +
        "  --actual-slug  Slug real do post (web_settings.slug de get_post) — omitir = ausente\n" +
        "  --out          Grava { ok, expectedSlug, actualSlug, checkedAt } no path (#4574)\n",
    );
    return 2;
  }

  const actualSlug = actualSlugRaw && actualSlugRaw.length > 0 ? actualSlugRaw : null;
  const result = checkWhatsappSlugMatch(postId, actualSlug, d1Title);

  console.log(JSON.stringify(result));

  if (outPath) {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(
      outPath,
      JSON.stringify(
        {
          ok: result.ok,
          expectedSlug: result.expectedSlug,
          actualSlug: result.actualSlug,
          checkedAt: new Date().toISOString(),
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
  }

  if (!result.ok) {
    process.stderr.write(`${result.message}\n`);
    return 1;
  }
  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
