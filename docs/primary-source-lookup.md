# Primary-source lookup (#5664)

After the Stage 1 approval gate, the orchestrator may try to replace a secondary article URL with the cited company's official source. The search is scoped to the cited company's domain:

```text
site:{official-domain} {approved article title}
```

Search results are collected by `discovery-searcher` and passed to `scripts/resolve-primary-source.ts`. The script is deliberately deterministic and does not fetch or invent URLs.

A result is eligible only when:

1. it has an HTTP(S) URL and title;
2. it is on the detected official domain or a subdomain;
3. it is not the existing secondary URL;
4. it is not marked `accessible: false`; and
5. `subjectSimilarity` with the approved title is at least `0.60`.

The winner is the highest score; equal scores use lexicographically smallest URL. If no candidate passes, the secondary link is preserved. Every attempted lookup is recorded on the article as `primary_source_lookup`; replacements additionally record `from`, `to`, query, and score. The article remains in its approved bucket: this step changes only the source link and never promotes or demotes an item.

When search fails or returns no candidate, preserving the secondary link is the safe default. This avoids turning an editorial source choice into an unverified URL substitution.
