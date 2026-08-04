/**
 * check-whatsapp-slug-guard.ts (#4570)
 *
 * Guard determinístico que o orchestrator (Stage 6, §6d) chama depois do
 * Schedule ser confirmado — se o slug REAL do post Beehiiv divergir do slug
 * que a URL do bloco WhatsApp (entre D1/D2) já prevê (`seoSlug(D1)`), o link
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
 *     --post-id POST_ID --d1-title "Título do D1" [--actual-slug SLUG_ATUAL]
 *
 *   `--actual-slug` pode ser omitido (post sem slug ainda / campo ausente no
 *   `get_post`) — tratado como divergência, nunca bate com um slug esperado
 *   não-vazio.
 *
 * Stdout: sempre o JSON de `WhatsappSlugCheckResult` (`ok`/`expectedSlug`/
 * `actualSlug`/`message?`) — consumível por script ou lido por um agente.
 * Stderr: a mensagem de correção manual formatada, só quando `ok === false`
 * (mesmo padrão de `fix-post-slug.ts` — instruções acionáveis no stream de
 * erro, JSON estruturado no stdout).
 *
 * Exit codes:
 *   0 = slug bate — nada a fazer, Stage 6 pode prosseguir.
 *   1 = slug diverge — GATE-BLOCKING no orchestrator (ver
 *       `.claude/agents/orchestrator-stage-6.md` §6d e
 *       `context/publishers/beehiiv-playbook.md` §9): não marcar
 *       `05-published.json`/sentinel do Stage 6 enquanto isso não sair 0.
 *   2 = args inválidos (`--post-id`/`--d1-title` ausentes).
 */

import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { checkWhatsappSlugMatch } from "./lib/whatsapp-slug-guard.ts";

export function main(argv: string[]): number {
  const { values } = parseArgs(argv);
  const postId = values["post-id"];
  const d1Title = values["d1-title"];
  const actualSlugRaw = values["actual-slug"];

  if (!postId || !d1Title) {
    process.stderr.write(
      "Uso: check-whatsapp-slug-guard.ts --post-id POST_ID --d1-title TITULO [--actual-slug SLUG]\n" +
        "  --post-id      ID do post Beehiiv (só usado pra formatar a URL de correção manual)\n" +
        "  --d1-title     Título do D1 da edição (mesma fonte de buildWhatsappEditionUrl)\n" +
        "  --actual-slug  Slug real do post (web_settings.slug de get_post) — omitir = ausente\n",
    );
    return 2;
  }

  const actualSlug = actualSlugRaw && actualSlugRaw.length > 0 ? actualSlugRaw : null;
  const result = checkWhatsappSlugMatch(postId, actualSlug, d1Title);

  console.log(JSON.stringify(result));

  if (!result.ok) {
    process.stderr.write(`${result.message}\n`);
    return 1;
  }
  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
