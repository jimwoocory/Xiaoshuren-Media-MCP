# P0-02 Foundation Status

Branch: `p0-02-provider-job-asset`

## Implemented

- Provider submit uncertainty moves the internal Job to `reconciling` and blocks blind resubmission.
- ProviderExecution persists provider job id, provider status, and submission attempts.
- Provider status polling and reconciliation use bounded backoff: 5s, 15s, 30s, 60s, 5min.
- A Provider `succeeded` observation does not mark the internal Job `succeeded`; output must be archived as an Asset first.
- Primary image Provider: authenticated ChatGPT Web through Google Chrome UI automation.
- Primary video Provider: authenticated Dreamina CLI OAuth through `DreaminaCliProvider`.
- Optional Replicate Provider remains available as a fallback/reference adapter.
- ChatGPT browser/session credentials and Dreamina OAuth tokens stay outside Media Core and Git.
- Webhook payloads can be AES-256-GCM protected before persistence.
- Webhook event dedupe uses the database `provider_id + provider_event_id` unique boundary.
- URL import policy requires HTTPS and rejects loopback, private, link-local, metadata, documentation, multicast, and reserved address ranges.
- Redirect-aware fetch validates every redirect hop and enforces timeout / maximum bytes.
- Media validation checks MIME against magic bytes for PNG, JPEG, WebP, and MP4.
- Provider output is SHA-256 hashed and written to private ObjectStore abstraction before the Job can complete.
- S3-compatible / R2-compatible ObjectStore supports server-side private put, presigned PUT, short-lived signed reads, and HEAD verification.
- Upload sessions are persisted and bound to tenant + subject + workspace + Asset.
- Upload confirmation verifies object existence, byte size, and content type before Asset `ready`.
- URL import authorizes the workspace before external fetch and persists a ready private Asset.
- PostgreSQL completion transaction inserts Asset, advances Job to `succeeded`, and writes Audit + completion Outbox.
- BullMQ / Redis production Queue adapter supports delayed jobs, retries, exponential backoff, concurrency, retained failures, and metrics.
- Secret providers include Environment for development and AWS Secrets Manager for production-style server-side secrets.

## Real media E2E verification

### ChatGPT Web image

Real image generation passed using the authenticated Google Chrome Default profile.

The completed image passed:

`ChatGPT Web -> local trusted PNG -> TrustedLocalFileFetcher -> AssetIngestService -> ObjectStore/completion path`

No ChatGPT cookie, browser token, password, or Local Storage value is read by the provider code.

### Dreamina CLI video

Real Seedance video generation/result reconciliation passed.

Observed result:

- model: `seedance2.0mini`
- duration: 4.042 seconds
- 1280x720
- 24 fps
- MP4
- provider state: `success`
- provider reported cost: 24 credits

The returned video passed:

`DreaminaCliProvider -> SafeHttpFetcher -> MIME/magic validation -> SHA-256 -> AssetIngestService -> ObjectStore -> PostgreSQL Job succeeded`

The existing provider task was reused after connection interruption; no duplicate submission was made.

## Verification

Company workstation verification before final checkpoint:

- `corepack pnpm test`: 47 passed, 3 skipped.
- `corepack pnpm typecheck`: passed.
- `corepack pnpm build`: passed.
- The 3 skipped tests are the pre-existing real-PostgreSQL suite gated by `POSTGRES_URL`.

## Remaining infrastructure E2E outside the media-provider mainline

- live Redis/BullMQ runtime exercise;
- live private S3/R2 presigned upload + archive;
- real PostgreSQL rollback/concurrency suite with `POSTGRES_URL`;
- optional deployed AWS Secrets Manager exercise;
- deeper media probing (dimensions, duration, codec/container validation) and optional malware scanning.

These remaining infrastructure checks do not invalidate the completed ChatGPT image and Dreamina video Provider E2E.
