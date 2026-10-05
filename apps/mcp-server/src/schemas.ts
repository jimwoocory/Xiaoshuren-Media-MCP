export const TOOL_NAMES = [
  "models_list",
  "models_get",
  "asset_create_upload",
  "asset_confirm",
  "asset_get",
  "quote_create",
  "generate_image",
  "generate_video",
  "job_get",
  "job_cancel",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

const writeBase = {
  idempotency_key: { type: "string", minLength: 16, maxLength: 128 },
  workspace_id: { type: "string", minLength: 1 },
} as const;

const objectSchema = (
  properties: Record<string, unknown>,
  required: string[] = [],
) => ({
  type: "object",
  additionalProperties: false,
  properties,
  required,
});

export const TOOL_DEFINITIONS = [
  {
    name: "models_list",
    description: "List media generation models available to the authenticated subject.",
    inputSchema: objectSchema({
      capability: { type: "string", enum: ["image_generation", "video_generation"] },
      cursor: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: 100 },
    }),
  },
  {
    name: "models_get",
    description: "Get one public media model and its limits/input schema.",
    inputSchema: objectSchema(
      { public_model_id: { type: "string", minLength: 1 } },
      ["public_model_id"],
    ),
  },
  {
    name: "asset_create_upload",
    description: "Create an input Asset from a controlled URL, inline base64, or upload session.",
    inputSchema: objectSchema(
      {
        ...writeBase,
        source: {
          oneOf: [
            objectSchema(
              {
                kind: { const: "controlled_url_import" },
                url: { type: "string", format: "uri" },
              },
              ["kind", "url"],
            ),
            objectSchema(
              {
                kind: { const: "inline_base64" },
                filename: { type: "string", minLength: 1 },
                mime_type: { type: "string", minLength: 1 },
                base64: { type: "string", minLength: 1 },
              },
              ["kind", "filename", "mime_type", "base64"],
            ),
            objectSchema(
              {
                kind: { const: "upload_session" },
                filename: { type: "string", minLength: 1 },
                mime_type: { type: "string", minLength: 1 },
                byte_size: { type: "integer", minimum: 1 },
              },
              ["kind", "filename", "mime_type", "byte_size"],
            ),
          ],
        },
      },
      ["idempotency_key", "source"],
    ),
  },
  {
    name: "asset_confirm",
    description: "Confirm a pending Asset upload and begin server-side validation/processing.",
    inputSchema: objectSchema(
      {
        ...writeBase,
        asset_id: { type: "string", minLength: 1 },
        upload_receipt: {
          type: "object",
          additionalProperties: false,
          properties: {
            etags: {
              type: "array",
              items: objectSchema(
                {
                  part_number: { type: "integer", minimum: 1 },
                  etag: { type: "string", minLength: 1 },
                },
                ["part_number", "etag"],
              ),
            },
          },
        },
      },
      ["idempotency_key", "asset_id"],
    ),
  },
  {
    name: "asset_get",
    description: "Read Asset metadata and optionally obtain a short-lived access URL.",
    inputSchema: objectSchema(
      {
        workspace_id: { type: "string", minLength: 1 },
        asset_id: { type: "string", minLength: 1 },
        include_access_url: { type: "boolean" },
      },
      ["asset_id"],
    ),
  },
  {
    name: "quote_create",
    description: "Reserve workspace budget and freeze a normalized media generation request.",
    inputSchema: objectSchema(
      {
        ...writeBase,
        public_model_id: { type: "string", minLength: 1 },
        request: { type: "object" },
      },
      ["idempotency_key", "public_model_id", "request"],
    ),
  },
  {
    name: "generate_image",
    description: "Create an asynchronous image generation Job from a confirmed Quote.",
    inputSchema: objectSchema(
      {
        ...writeBase,
        quote_id: { type: "string", minLength: 1 },
        request_hash: { type: "string", minLength: 1 },
        confirm_quote: { const: true },
        request: { type: "object" },
      },
      ["idempotency_key", "quote_id", "request_hash", "confirm_quote", "request"],
    ),
  },
  {
    name: "generate_video",
    description: "Create an asynchronous video generation Job from a confirmed Quote.",
    inputSchema: objectSchema(
      {
        ...writeBase,
        quote_id: { type: "string", minLength: 1 },
        request_hash: { type: "string", minLength: 1 },
        confirm_quote: { const: true },
        request: { type: "object" },
      },
      ["idempotency_key", "quote_id", "request_hash", "confirm_quote", "request"],
    ),
  },
  {
    name: "job_get",
    description: "Read one asynchronous media Job and its output Asset ids.",
    inputSchema: objectSchema(
      {
        workspace_id: { type: "string", minLength: 1 },
        job_id: { type: "string", minLength: 1 },
      },
      ["job_id"],
    ),
  },
  {
    name: "job_cancel",
    description: "Request cancellation of a cancellable media Job.",
    inputSchema: objectSchema(
      {
        ...writeBase,
        job_id: { type: "string", minLength: 1 },
      },
      ["idempotency_key", "job_id"],
    ),
  },
] as const;
