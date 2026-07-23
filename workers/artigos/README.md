# workers/artigos

Hosting de artigos especiais avulsos da diar.ia.br em
`https://especial.diar.ia.br/{ano}/{slug}/`. Worker de *static assets*
(sem script), servindo no subdomínio dedicado `especial.diar.ia.br` via
`custom_domain = true` — o mesmo mecanismo comprovado de
`livros.diar.ia.br` e `cursos.diar.ia.br`.

A raiz `diar.ia.br` continua 100% hospedada pelo Beehiiv Website Builder
v2, sem interferência. (A 1ª tentativa usou Workers Route clássica em
path da raiz; a rota nunca interceptou tráfego na zona de produção — ver
histórico no `wrangler.toml`. Não repetir esse caminho.)

## Estrutura

Cada artigo é um path dentro do subdomínio:

```
workers/artigos/public/{ano}/{slug}/index.html
```

Não precisa de rota nova por artigo — o roteador de assets resolve
sub-paths dentro do mesmo `custom_domain`.

## Adicionar um artigo novo

1. Criar `public/{ano}/{slug}/index.html` (documento HTML completo e
   autocontido — sem dependências externas, CSS inline).
2. Deploy:
   ```
   cd workers/artigos && npx wrangler deploy
   ```
3. Verificar ao vivo: abrir a URL publicada E a home `diar.ia.br`
   (confirmar que o Beehiiv continua servindo o resto do domínio sem
   interferência).

## Notas

- Sem KV, sem secret, sem script — só assets estáticos.
- Design system aplicado inline (cores/tipografia espelham
  `scripts/lib/shared/design-tokens.ts`).
- Nunca fazer deploy de arquivos de rascunho/preview dentro de `public/`
  — tudo ali é servido publicamente.
