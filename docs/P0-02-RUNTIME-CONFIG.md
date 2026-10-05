# P0-02 Runtime Configuration

All credentials are server-side only. Do not expose these values in MCP tool schemas, tool results, logs, browser code, or client configuration.

## Current real Provider adapter

### Replicate

Logical secret names:

- `REPLICATE_API_TOKEN`
- `REPLICATE_WEBHOOK_SECRET`

The adapter uses Replicate's asynchronous prediction flow. A submission returns a provider prediction id; status is observed later through polling or a completed webhook. Network failure or provider 5xx during submission is treated as an unknown submission outcome and moves the internal Job to reconciliation instead of blind retry.

The webhook verifier checks:

- `webhook-id`
- `webhook-timestamp`
- `webhook-signature`
- HMAC-SHA256 signature
- timestamp tolerance

## Queue

BullMQ runtime expects a server-side Redis URL:

- `REDIS_URL`

Queue defaults:

- at-least-once delivery
- 8 attempts
- exponential backoff
- delayed jobs
- failed jobs retained
- configurable worker concurrency
- queue counts for waiting / active / delayed / failed / completed

## Private object storage

The S3-compatible adapter supports AWS S3 and Cloudflare R2-compatible endpoints.

Configuration placeholders:

- `S3_ENDPOINT`
- `S3_REGION`
- `S3_BUCKET`
- `S3_ACCESS_KEY_ID`
- `S3_SECRET_ACCESS_KEY`

The current ObjectStore supports:

- server-side private put
- presigned PUT upload
- short-lived signed read URL
- HEAD verification before upload confirmation

No production bucket credentials are configured in this repository.

## Upload sessions

Upload session confirmation verifies the object in private storage before marking an Asset ready:

- object exists
- byte size equals the declared upload size
- content type equals the upload session MIME
- optional stored SHA-256 metadata is persisted when available

Upload sessions are bound to tenant, subject, workspace, and Asset.

## URL import

URL import must use the safe HTTP fetcher. It requires HTTPS and revalidates each redirect target. Private, loopback, link-local, metadata, multicast, documentation, and reserved networks are rejected.

Workspace authorization occurs before any external fetch.

## Secret providers

Development:

- `EnvironmentSecretProvider`

Production option implemented:

- `AwsSecretsManagerProvider`

The AWS adapter maps logical secret names to Secret Manager ids / JSON keys, caches values for a bounded TTL, and does not log secret values.

## Current external E2E blockers

The following are intentionally not claimed as complete until credentials/services are supplied:

- real Replicate image generation
- real Replicate video generation
- live Redis/BullMQ execution
- live S3/R2 presigned upload and Asset archive
- real PostgreSQL rollback/concurrency suite via `POSTGRES_URL`
