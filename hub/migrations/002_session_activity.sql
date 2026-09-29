-- What a Session (or a background agent) is doing, when it started and when it last ran.
--
--   kind         'session' for an ordinary native Session, 'background' for a Claude Code background agent
--   activity     working | needs_input | idle | completed | failed | stopped | gone | unknown
--                (one vocabulary for every harness; `status` keeps whatever the harness itself said)
--   detail       one line about what it is doing or waiting for
--   started_at   when the Session was started (the harness's creation time, else when the hub first saw it)
--   last_ran_at  when it last ran: the later of the harness's last-activity time and the last time the hub
--                observed it working, so a Session whose harness reports no timestamps is still searchable
--
-- Every column the app filters or sorts on is indexed: "what ran in the last hour", "what started this week"
-- and "everything that failed" are the questions this table exists to answer.
alter table sessions
  add column kind text not null default 'session',
  add column activity text not null default 'unknown',
  add column detail text not null default '',
  add column started_at timestamptz not null default now(),
  add column last_ran_at timestamptz;

update sessions set
  started_at = coalesce(created_at, first_seen_at),
  last_ran_at = updated_at,
  activity = case status
    when 'busy' then 'working'
    when 'retry' then 'working'
    when 'running' then 'working'
    when 'waiting' then 'needs_input'
    when 'idle' then 'idle'
    when 'gone' then 'gone'
    else 'unknown'
  end;

create index sessions_started_idx on sessions (started_at desc);
create index sessions_last_ran_idx on sessions (last_ran_at desc nulls last);
create index sessions_activity_idx on sessions (activity, last_ran_at desc nulls last);
create index sessions_kind_idx on sessions (kind) where kind <> 'session';
