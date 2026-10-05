# P0-02 Media Provider Mainline

The current product workflow uses different authenticated execution channels for image and video generation.

## Primary image path: ChatGPT Web

Image generation is driven through an authenticated ChatGPT web session, not through an API key in this repository.

Boundary rules:

- browser/session credentials stay inside the browser profile;
- cookies, browser storage, passwords, and session tokens are never copied into Git, logs, MCP responses, or Media Core;
- the browser bridge is responsible for submitting the image request and collecting generated output;
- generated media must still pass through the common Asset Ingest path before the internal Job can become `succeeded`;
- browser automation is an adapter boundary, not business logic.

Company workstation verification:

- primary browser is Google Chrome, not Tabbit;
- the bridge reuses the authenticated Chrome Default profile without reading cookies, Local Storage, passwords, or session tokens;
- every image Job opens a dedicated Chrome window and stores only its window handle / conversation URL in local runtime state;
- prompt content is read back before Send is allowed, preventing accidental submission when Chrome focus is wrong;
- generated images are recovered through ChatGPT's Copy Image control into the Windows clipboard and saved as PNG using System.Drawing;
- a real ChatGPT Web image generation E2E has passed through TrustedLocalFileFetcher and AssetIngestService into the private ObjectStore path.

## Primary video path: Dreamina CLI

Video generation uses the official `dreamina` CLI and its local OAuth Device Flow state.

Verified company workstation state:

- executable: `C:\Users\Administrator\bin\dreamina.exe`
- OAuth account is active;
- `user_credit` succeeds;
- async tasks use `submit_id`;
- status/result lookup uses `query_result --submit_id=<id>`.

Implemented adapter:

- `@xiaoshuren/provider-dreamina-cli`
- text-to-video
- image-to-video
- multimodal-to-video
- multi-frame-to-video
- first/last-frames-to-video
- submit timeout -> UNKNOWN / reconciliation
- query status mapping
- deterministic failure mapping
- HTTPS result URL extraction
- argv-only process execution with `shell: false` to avoid prompt/path shell injection

OAuth tokens are owned by the Dreamina CLI and are not read or persisted by the Media MCP code.

### Real video E2E verification

A real Seedance video task was reconciled through the production adapter path without resubmission:

- model: `seedance2.0mini`
- resolution: 1280x720 / 720p
- duration: 4.042 seconds
- frame rate: 24 fps
- output: MP4
- Dreamina task state: `success`
- Dreamina reported credit cost: 24 credits

The returned HTTPS video was then processed through:

`DreaminaCliProvider -> SafeHttpFetcher -> media signature/MIME validation -> SHA-256 -> AssetIngestService -> ObjectStore -> PostgreSQL Asset + Job succeeded`

This live E2E passed. The test reused the already-submitted provider task and did not blindly resubmit it after connection interruptions.

## Optional fallback Provider: Replicate

The Replicate adapter remains available as a pluggable fallback/reference Provider implementation, but it is not the current primary production media path.

## AIHubMix

AIHubMix is not the primary image/video generation Provider for the current product workflow. It may still be used for LLM/text/model-routing use cases outside this P0-02 media execution mainline.
