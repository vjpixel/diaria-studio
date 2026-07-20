# workers/cursos (#1745)

Hosting da página **Cursos sobre IA** da Diar.ia. Worker de *static assets*
(sem script) servindo um único HTML em `https://cursos.diar.ia.br/` (domínio
de marca, #3698) — também acessível via `https://cursos.diaria.workers.dev/`
(mantido por compat de links já enviados em edições passadas).

Gêmea da `workers/livros` (#1744) — mesmo padrão e design editorial.

## Fonte de verdade

A página é **gerada** de `seed/courses/cursos-ia.json` (curadoria do editor,
versionada) pelo `scripts/build-cursos-page.ts`. O HTML em `public/index.html`
é um artefato derivado, committed pra que o deploy seja reprodutível.

`test/cursos-asset-drift.test.ts` garante que o `public/index.html` committed
bate com um render fresco do seed — CI quebra se o seed mudar sem regenerar.

## Atualizar conteúdo

1. Editar `seed/courses/cursos-ia.json` (cursos, links, filtros).
2. Regenerar o asset:
   ```
   npx tsx scripts/build-cursos-page.ts --out workers/cursos/public/index.html
   ```
3. Commitar seed + HTML juntos.
4. Deploy: `cd workers/cursos && npx wrangler deploy`.

## Filtros

Idioma · Nível · Custo · Formato · Duração · Plataforma · Certificado · Tema.
Cada dropdown só aparece se houver ≥2 valores distintos no seed (ex: se todos
os cursos forem gratuitos, o filtro de Custo é omitido). Filtros 100%
client-side (lista pequena, sem backend de busca).
