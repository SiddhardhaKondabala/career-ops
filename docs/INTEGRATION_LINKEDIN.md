# LinkedIn bot integration

career-ops is the **system of record**: it discovers, deduplicates, scores
(1–5), checks liveness, tailors the resume/cover letter, and owns the final
application status. The [LinkedIn-AI-Job-Applier-Ultimate](https://github.com/beatwad/LinkedIn-AI-Job-Applier-Ultimate)
bot is the **execution engine**: it logs into LinkedIn and submits applications
for explicitly approved jobs, then reports results back.

Neither side changes behaviour in standalone mode. The bridge is opt-in and
file-based — there is no live coupling between the two processes.

## Data flow

```
career-ops evaluate/tailor
        │  export-approved-jobs.mjs  (schema: approved-jobs.v1)
        ▼
$CAREER_OPS_INTEGRATION_DIR/linkedin-approved.json
        │  LinkedIn bot: queue mode (no search, no re-scoring)
        ▼
$CAREER_OPS_INTEGRATION_DIR/linkedin-results.jsonl  (schema: application-result.v1)
        │  import-application-results.mjs
        ▼
career-ops tracker (data/applications.md) status updated
```

## Contracts

Versioned JSON Schemas live in [`schemas/`](../schemas):

- `approved-jobs.v1.schema.json` — the approved-job queue.
- `application-result.v1.schema.json` — one result record per job attempt.

career-ops validates against them with the dependency-free validator in
[`lib/integration-schema.mjs`](../lib/integration-schema.mjs). The bot carries
vendored copies and validates with its own `jsonschema` dependency. **When a
schema changes, bump the version and update both copies.**

Job and result identity (canonical URL + `integration_id`) is derived by
[`lib/integration-identity.mjs`](../lib/integration-identity.mjs), which reuses
the existing `lib/linkedin-url.mjs` parser so the bridge never re-implements URL
handling.

## Where personal data lives

Queues and results are **personal data** and are never committed. They live
outside both git repositories:

```bash
export CAREER_OPS_ROOT="$PWD/career-data"
export LINKEDIN_EXECUTOR_ROOT="$PWD/LinkedIn-AI-Job-Applier-Ultimate"
export CAREER_OPS_INTEGRATION_DIR="$PWD/career-data/data/integrations"
```

The in-repo `data/integrations/` directory is only a resolvable default and is
`.gitignore`d except for its placeholder.

## Safety posture

- Export selects only jobs scoring `>= 4.0/5` with at least `medium` confidence.
- The bot processes only explicit approved URLs; it never re-scores or searches.
- Dry-run and test mode never click the final submit.
- CAPTCHA, MFA, legal/demographic questions, and unknown required fields stop
  for manual review rather than being submitted.
- `submitted` is only emitted after a confirmed submission.
