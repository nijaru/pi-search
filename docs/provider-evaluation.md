# Provider evaluation

`pi-search` chooses providers by capability rather than a permanent vendor
ranking. `scripts/provider-eval.ts` measures normalized observations without
making network calls or judging semantic relevance.

## Metrics

The evaluator reports, per case and provider:

- result count and unique URL count;
- inspectable HTTP URL rate and provenance coverage;
- title, excerpt, and publication-date coverage;
- hard include/exclude-domain compliance;
- social-result rate for X/Twitter hosts;
- reported usage and latency; and
- whether the case's explicit requirements passed.

These are contract and evidence metrics, not a universal quality score. Human
or task-specific relevance judgments belong in a separate corpus and should
not be inferred from result counts.

## Workflow

1. Define a small task corpus by role: native general search, keyword/fresh
   search, semantic retrieval, objective/context retrieval, hard filters, and
   social/X retrieval.
2. Run one explicit provider smoke at a time with dedicated credentials using
   `docs/live-smoke.md`. Save the structured observation outside the runtime
   package; never add automatic provider fan-out to collect comparisons.
3. Evaluate saved observations:

   ```bash
   bun scripts/provider-eval.ts observations.json
   ```

   The input is an array of `{ "case": ..., "response": ... }` records using
   the normalized `SearchResponse` shape.
4. Compare providers within the same role using evidence quality, freshness,
   hard constraints, context efficiency, latency, cost, quota behavior, and
   failure behavior. Add an adapter only when a required gap is demonstrated.

The evaluator intentionally does not select a default provider, synthesize an
answer, or treat paid and free providers as directly interchangeable. Keep
browser, remote extraction, media, and repository evaluations separate from
this search corpus.
