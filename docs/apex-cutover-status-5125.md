# Verificação do cutover do apex — #5125

Gerado em 2026-08-28T13:40:36.100Z por `npx tsx scripts/apex-cutover-verify-5125.ts`. Fotografia do dia — re-rodar antes de citar os números (disciplina do #1172).

Checa a decisão do editor de 28/08/2026 ("sim — construir superfície própria, com a canônica apontando para ela") contra o estado real do apex `diar.ia.br`, já cutovado via #467 em 26/08/2026.

## Home (`/`)

- ✅ `<html lang>`: `pt-BR`

## Página de post amostrada (`/p/{slug}`)

- URL amostrada: `https://diar.ia.br/p/empresas-recontratam-quem-demitiu-por-ia`
- ✅ `<html lang="pt-BR">`
- ✅ canonical autorreferente: `https://diar.ia.br/p/empresas-recontratam-quem-demitiu-por-ia`
- ✅ meta description própria (não-genérica): "Empresas recontratam quem demitiu por IA. Infraestrutura trava 1 em cada 3 start…"

## Sitemap (`/sitemap.xml`)

- URLs listadas: **254**
- ✅ inclui a página de post amostrada acima

## Robots (`/robots.txt`)

- ✅ libera crawlers de IA (Content-Signal)
- ✅ declara `Sitemap:`

## Host legado (`diaria.beehiiv.com`) — risco de duplicidade

- ❌ redireciona pro host novo (status 200)
