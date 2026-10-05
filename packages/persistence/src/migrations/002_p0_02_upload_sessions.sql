CREATE TABLE upload_sessions (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  subject_id text NOT NULL,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  asset_id text NOT NULL REFERENCES assets(id),
  storage_key text NOT NULL,
  mime_type text NOT NULL,
  expected_byte_size bigint NOT NULL,
  status text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  completed_at timestamptz,
  UNIQUE (asset_id)
);
CREATE INDEX upload_sessions_owner_lookup ON upload_sessions (tenant_id, subject_id, workspace_id, status);
