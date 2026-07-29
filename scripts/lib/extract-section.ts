/**
 * extract-section.ts (#2834 — EPIC #2808, enxugar scripts/lib/)
 *
 * `extractSection` estava duplicada byte-a-byte (a menos de comentários) em
 * `lint-social-md.ts`, `publish-instagram.ts` e `publish-threads.ts` — todas
 * extraindo a seção genérica `# {Título}` de `03-social.md`, normalizando
 * CRLF → LF (#2486: sem isso, arquivos Windows com CRLF não casam o `\n` da
 * regex e a seção não é encontrada).
 *
 * #4309 (regressão do #3991): `extractDestaqueBlock` adicionado abaixo — o
 * mesmo padrão de duplicação existia um nível abaixo (`## d{N}` dentro de uma
 * seção `# {Título}` já isolada), só que com o terminador ERRADO em 4 dos 5
 * pontos de extração (`publish-instagram.ts` ×2, `publish-facebook.ts`,
 * `publish-threads.ts`, `prep-twitter-posts.ts`): `(?=\n## d\d+\b|\n# |$)` só
 * para em outro `## dN`, então o ÚLTIMO destaque (tipicamente `## d3`) absorve
 * qualquer seção irmã seguinte que não comece com `## d` — `## eia` e
 * `## post_pixel`, injetadas dentro de `# Social` por `merge-social-md.ts`
 * desde o #3471/#3991. Isso vazou pro Facebook e Instagram publicados ao vivo
 * em 260727-260729 (placeholders `{edition_url}`/`{outros_count}` literais +
 * caminho de arquivo `01-eia-A.jpg`). `publish-linkedin.ts` já tinha o
 * terminador CORRETO (`\n## ` — qualquer sibling `## `, #1690) porque o bug
 * fica latente até uma seção irmã não-`## dN` aparecer depois do último
 * destaque; o #3991 colapsou LinkedIn/Facebook/Instagram na mesma seção
 * `# Social`, ativando o bug pros 2 consumidores com o terminador errado.
 */

/** Extrai a seção `# {sectionTitle}` de um markdown multi-seção (ex: 03-social.md). */
export function extractSection(md: string, sectionTitle: string): string | null {
  const normalized = md.replace(/\r\n/g, "\n");
  const re = new RegExp(`(?:^|\\n)# ${sectionTitle}\\n([\\s\\S]*?)(?=\\n# |$)`, "i");
  const m = normalized.match(re);
  return m ? m[1] : null;
}

/**
 * Padrões de scaffolding interno que NUNCA devem sobreviver na saída do
 * extractor (#4309): outro cabeçalho `## ` (sinal de que o bloco absorveu uma
 * seção irmã por engano), ou um placeholder `{edition_url}`/`{outros_count}`
 * que deveria ter sido resolvido antes (esses só existem, por design, dentro
 * de `## post_pixel`/`### comment_diaria` — nunca no corpo de um `## d{N}`).
 */
const SCAFFOLDING_PATTERNS: ReadonlyArray<{ re: RegExp; label: string }> = [
  { re: /\n## /, label: "cabeçalho de seção interno ('## ...') vazado no corpo do destaque" },
  { re: /\{edition_url\}/, label: "placeholder {edition_url} não substituído" },
  { re: /\{outros_count\}/, label: "placeholder {outros_count} não substituído" },
];

/**
 * Recusa (lança) texto FINAL — pronto pra publicar — que ainda carregue
 * scaffolding interno. Guard de saída do EXTRATOR DO TEXTO PUBLICÁVEL (#4309),
 * não do lint (`lint-social-md.ts` só vê o `03-social.md` correto; o
 * vazamento acontece DEPOIS, na extração por publisher) — chamar no ponto em
 * que o texto já é o que seria enviado à API (ex: `extractPostText` de cada
 * publisher), NUNCA em `extractDestaqueBlock` abaixo: o bloco `## d{N}` bruto
 * do LinkedIn é reusado por `extractCommentDiaria`/`extractCommentPixel`, que
 * têm contrato PRÓPRIO e testado de placeholder ainda-não-resolvido
 * (`{outros_count}` permanece literal quando o caller não passa o valor —
 * backward-compat intencional, não um bug). `context` entra na mensagem de
 * erro (ex: "destaque 'd3' (facebook)").
 */
export function assertNoScaffolding(text: string, context: string): void {
  for (const { re, label } of SCAFFOLDING_PATTERNS) {
    if (re.test(text)) {
      throw new Error(
        `[extract-destaque-block] ${context}: ${label} (regressão #4309). ` +
          `Trecho: ${JSON.stringify(text.slice(0, 200))}`,
      );
    }
  }
}

/**
 * Extrai o bloco `## {destaque}` de dentro de um corpo de seção JÁ ISOLADO
 * (ex: o corpo retornado por `extractSection(md, "Social")`). Termina em
 * QUALQUER sibling `## ` — não só em outro `## d{N}` — pra nunca absorver
 * `## eia`/`## post_pixel` (#4309, mesmo terminador já usado por
 * `publish-linkedin.ts` desde #1690). Remove comentários HTML (`<!-- ... -->`).
 * Retorna `null` quando o destaque não é encontrado (caller decide se isso é
 * erro fatal ou fallback silencioso — contratos diferem entre publishers).
 *
 * Primitivo de baixo nível — NÃO aplica `assertNoScaffolding` aqui: o bloco
 * cru pode legitimamente conter `### comment_diaria`/`### comment_pixel` (com
 * `{edition_url}`/`{outros_count}` ainda não resolvidos) quando o caller é
 * `publish-linkedin.ts` extraindo o bloco inteiro antes de subdividir. Cada
 * caller aplica o guard no PRÓPRIO ponto de saída (texto final, pós-corte de
 * subseções e pós-substituição de placeholders).
 */
export function extractDestaqueBlock(sectionBody: string, destaque: string): string | null {
  const re = new RegExp(`(?:^|\\n)## ${destaque}\\n([\\s\\S]*?)(?=\\n## |\\n# |$)`, "i");
  const m = sectionBody.match(re);
  if (!m) return null;
  return m[1].replace(/<!--[\s\S]*?-->/g, "");
}
