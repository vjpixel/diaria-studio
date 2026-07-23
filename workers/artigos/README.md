# workers/artigos

Hosting de artigos especiais avulsos da diar.ia.br sob paths da raiz do
domínio (ex: `https://diar.ia.br/2026/o-agente`). Worker de *static assets*
(sem script).

Diferente de `livros`/`cursos` (subdomínio dedicado via
`custom_domain = true`): a raiz `diar.ia.br` é hospedada pelo Beehiiv Website
Builder v2, então este worker usa uma **Workers Route clássica** (`pattern` +
`zone_name`, sem `custom_domain`) escopada só ao path do artigo. Isso
intercepta na borda da Cloudflare só aquele path específico, sem tocar em
DNS nem no restante do domínio, que continua resolvendo normalmente pro
Beehiiv.

**Nunca usar `custom_domain = true` aqui** — reivindicaria o hostname inteiro
e quebraria o site do Beehiiv.

## Estrutura

Cada artigo é um path próprio:

```
workers/artigos/public/{ano}/{slug}/index.html
```

com uma entrada `[[routes]]` correspondente no `wrangler.toml`.

## Adicionar um artigo novo

1. Criar `public/{ano}/{slug}/index.html` (documento HTML completo e
   autocontido — sem dependências externas, CSS inline).
2. Adicionar `[[routes]] pattern = "diar.ia.br/{ano}/{slug}*" zone_name = "diar.ia.br"`
   no `wrangler.toml`.
3. Deploy:
   ```
   cd workers/artigos && npx wrangler deploy
   ```
4. Verificar ao vivo: abrir a URL publicada E a home `diar.ia.br` (confirmar
   que o Beehiiv continua servindo o resto do domínio sem interferência).

## Notas

- Sem KV, sem secret, sem script — só assets estáticos.
- Design system aplicado inline (cores/tipografia espelham
  `scripts/lib/shared/design-tokens.ts`).
