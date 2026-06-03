# workers/livros (#1744)

Hosting da página piloto **Livros sobre IA** da Diar.ia. Worker de *static
assets* (sem script) servindo um único HTML em
`https://livros.diaria.workers.dev/`.

## Fonte de verdade

A página é **gerada** de `seed/books/livros-ia.json` (curadoria do editor,
versionada) pelo `scripts/build-livros-page.ts`. O HTML em `public/index.html`
é um artefato derivado, committed pra que o deploy seja reprodutível.

`test/livros-asset-drift.test.ts` garante que o `public/index.html` committed
bate com um render fresco do seed — CI quebra se o seed mudar sem regenerar.

## Atualizar conteúdo

1. Editar `seed/books/livros-ia.json` (livros, links, capas).
2. Regenerar o asset:
   ```
   npx tsx scripts/build-livros-page.ts --out workers/livros/public/index.html
   ```
3. Commitar `seed/...json` + `public/index.html` juntos.
4. Deploy:
   ```
   cd workers/livros && npx wrangler deploy
   ```

## Notas

- Arch-neutra (decisão #1744): worker dedicado por ora; se no futuro virar um
  hub `/aprenda` com abas (Livros | Cursos), o HTML é portável.
- Sem KV, sem secret, sem script — só assets estáticos.
