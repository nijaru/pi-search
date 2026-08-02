# Provider comparison corpus

This is a small, repeatable corpus for comparing Brave, Exa, Parallel, and
Gemini. It is intentionally small: run each case at most once per provider
when account cost is a concern. Do not turn the corpus into automatic
fan-out in the runtime extension.

## Cases

| ID | Role | Query | Constraints | Evidence requirement |
| --- | --- | --- | --- | --- |
| `official-api-docs` | semantic/official | `OpenAI Responses API web search tool documentation` | include `openai.com` | At least 3 results, useful excerpts, and official OpenAI pages where available |
| `fresh-release` | freshness | `latest TypeScript release` | none | At least 3 results, publication dates when supplied, and current release information |
| `objective-pricing` | objective/context | `compare current web search API pricing for Brave Exa Parallel and Gemini` | none | Excerpts must identify provider, price or allowance, and source date; do not score an opaque answer as evidence |
| `rfc-reference` | keyword/reference | `RFC 9110 HTTP Semantics` | include `rfc-editor.org` | At least 2 results, stable HTTP URLs, and excerpts or titles that identify RFC 9110 |
| `hard-domain-filter` | hard constraint | `web search API documentation` | include `openai.com`, exclude `github.com` | Every returned URL must satisfy both constraints; run only for providers that advertise domain filtering |

The same query text and result limit should be used for every provider in a
case. Use `maxResults: 5` for the paid comparison to keep result and excerpt
cost bounded. The `hard-domain-filter` case is not a valid Gemini or Parallel
request under the current contracts: record that as an unsupported constraint,
not as a failed quality result.

## Human relevance labels

The normalized evaluator measures evidence and constraint quality, but it does
not infer semantic relevance. For each returned result, record these labels in
an external worksheet or local, ignored observation file:

- `relevant`: directly helps answer the case question;
- `authoritative`: primary or otherwise appropriate source for the case;
- `current`: supports the freshness requirement when the case has one;
- `useful_excerpt`: the excerpt is enough to decide whether to fetch the page;
- `duplicate`: substantially repeats another returned URL; and
- `irrelevant`: not useful for the case.

Report precision among the top 3 results, authoritative-result rate, useful
excerpt rate, and duplicates separately for each case. Do not collapse these
into a permanent provider ranking: the winner can differ by role.

## Cost worksheet

For every explicit live call, record the provider, mode, result limit, request
ID, reported search cost, token usage (if any), response status, and observed
quota headers. Record free-credit eligibility separately from published
marketing claims. Gemini grounding must record search-query charges and model
input/output token charges as separate fields. Do not repeat a call only to
measure latency; retain the one observed latency as context.

## Running the normalized checks

Save only intentionally collected observations outside the package or in an
ignored file using the `{ "case": ..., "response": ... }` shape, then run:

```bash
bun scripts/provider-eval.ts /path/to/observations.json
```

Use the output for inspectability, excerpts, dates, provenance, constraints,
and usage. Apply the human labels above before deciding whether automatic
routing should change. A single smoke query is evidence that an adapter works;
it is not evidence that one provider is generally better.
