-- Inventory of every install that has enrolled with this hub.
--
-- Time-series data (logs, session lifecycle events, proxy audit lines) lives in Loki, not here. This
-- schema holds only current state plus the small amount of history that has to be queried
-- relationally (configuration changes).

create table machines (
  -- The daemon's own stable identity (`machine_<uuid>` from its state directory's machine.json).
  id text primary key,
  name text not null,
  -- Operator override shown instead of `name` (which follows the machine's hostname).
  display_name text,
  hostname text,
  platform text,
  arch text,
  node_version text,
  client_version text,

  -- Candidate URLs the machine advertised (LAN addresses, Tailscale name, ...), and the one the
  -- prober last proved to be *this* machine by matching its /v1/machine identity.
  endpoints jsonb not null default '[]'::jsonb,
  verified_endpoint text,

  -- Whether the machine shared its gateway credentials so the hub can proxy the web UI to it.
  proxy_enabled boolean not null default false,
  -- AES-256-GCM sealed {"username","password"}. Never returned by any API.
  credentials_enc bytea,

  -- Last reported non-secret configuration, agent snapshot and runtime stats.
  config jsonb not null default '{}'::jsonb,
  agents jsonb not null default '[]'::jsonb,
  stats jsonb not null default '{}'::jsonb,

  -- sha256 of the per-machine bearer token issued at enrollment. Revoke by deleting the machine.
  token_hash text not null unique,
  enrolled_via text,

  first_seen_at timestamptz not null default now(),
  last_heartbeat_at timestamptz,
  last_probe_at timestamptz,
  last_probe_ok boolean,
  last_probe_ms integer,
  last_probe_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table machine_config_history (
  id bigserial primary key,
  machine_id text not null references machines (id) on delete cascade,
  config jsonb not null,
  changed_at timestamptz not null default now()
);
create index machine_config_history_machine_idx on machine_config_history (machine_id, changed_at desc);

-- Latest known state of each native Session, as reported by the machine that owns it.
create table sessions (
  machine_id text not null references machines (id) on delete cascade,
  agent_id text not null,
  session_id text not null,
  title text not null default '',
  directory text not null default '',
  status text not null default 'unknown',
  created_at timestamptz,
  updated_at timestamptz,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  primary key (machine_id, agent_id, session_id)
);
create index sessions_updated_idx on sessions (updated_at desc nulls last);
create index sessions_status_idx on sessions (status);

-- Secrets a new install presents once, to obtain its own per-machine token.
create table enrollment_tokens (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz,
  use_count integer not null default 0
);
