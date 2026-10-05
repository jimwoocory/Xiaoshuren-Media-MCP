import type { ToolName } from "./schemas.js";

export const TOOL_SCOPES: Record<ToolName, string> = {
  models_list: "media.models.read",
  models_get: "media.models.read",
  asset_create_upload: "media.assets.write",
  asset_confirm: "media.assets.write",
  asset_get: "media.assets.read",
  quote_create: "media.quotes.create",
  generate_image: "media.generate.image",
  generate_video: "media.generate.video",
  job_get: "media.jobs.read",
  job_cancel: "media.jobs.cancel",
};
