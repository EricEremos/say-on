-- Room lobby and optional room passwords (owner request, 2026-09-26).
--
-- A host may lock a room with a 4-12 digit password. The server keeps only a bcrypt hash in the
-- client-unreachable invite table and checks it on every join path. Wrong tries are throttled per
-- person (5 per minute) and per room (20 per minute). A wrong try is returned as a result rather
-- than raised, so its failure record commits and the throttle holds.
--
-- The lobby list gains has_password and shows each room's current expected attendance. The
-- internal join_group_session and the name-less join wrappers are no longer callable by clients,
-- so no path skips the password. Safe to apply more than once.

alter table public.group_room_invites add column if not exists password_hash text;
alter table public.group_room_invites add column if not exists created_by uuid;
alter table public.group_room_invites drop constraint if exists group_room_invites_password_hash_check;
alter table public.group_room_invites add constraint group_room_invites_password_hash_check
  check (password_hash is null or password_hash ~ '^\$2[abxy]\$[0-9]{2}\$');
revoke all on table public.group_room_invites from public, anon, authenticated;

create table if not exists public.group_room_password_failures (
  id bigint generated always as identity primary key,
  event_id uuid not null,
  group_number smallint not null,
  user_id uuid not null,
  failed_at timestamptz not null default now(),
  constraint group_room_password_failures_room_fkey foreign key (event_id, group_number)
    references public.event_groups (event_id, group_number) on delete cascade
);
create index if not exists group_room_password_failures_window_idx
  on public.group_room_password_failures (event_id, group_number, failed_at);
alter table public.group_room_password_failures enable row level security;
revoke all on table public.group_room_password_failures from public, anon, authenticated;

-- Internal joins are reachable only through the password-aware wrappers below.
revoke all on function public.join_group_session(uuid, smallint) from public, anon, authenticated;
revoke all on function public.join_group_session(uuid, smallint, text) from public, anon, authenticated;
revoke all on function public.join_group_room_by_code(uuid, text) from public, anon, authenticated;
revoke all on function public.join_group_room_by_number(uuid, smallint) from public, anon, authenticated;

-- Returns null when the caller may enter; otherwise a gate object for the client.
create or replace function public.check_group_room_password(p_event_id uuid, p_group_number smallint, p_password text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  user_limit constant integer := 5;
  room_limit constant integer := 20;
  window_length constant interval := interval '1 minute';
  stored_hash text;
  room_creator uuid;
  user_failures integer;
  room_failures integer;
  latest_failure timestamptz;
  candidate text := btrim(coalesce(p_password, ''));
begin
  if auth.uid() is null then
    raise exception 'anonymous authenticated session required';
  end if;

  select invite.password_hash, invite.created_by into stored_hash, room_creator
  from public.group_room_invites as invite
  where invite.event_id = p_event_id and invite.group_number = p_group_number;

  if stored_hash is null or room_creator = auth.uid() then
    return null;
  end if;

  if exists (
    select 1 from public.group_participants as participant
    where participant.event_id = p_event_id
      and participant.group_number = p_group_number
      and participant.user_id = auth.uid()
  ) then
    return null;
  end if;

  delete from public.group_room_password_failures where failed_at < now() - interval '10 minutes';

  select count(*) filter (where failure.user_id = auth.uid()), count(*)
  into user_failures, room_failures
  from public.group_room_password_failures as failure
  where failure.event_id = p_event_id
    and failure.group_number = p_group_number
    and failure.failed_at > now() - window_length;

  if user_failures >= user_limit or room_failures >= room_limit then
    select max(failure.failed_at) into latest_failure
    from public.group_room_password_failures as failure
    where failure.event_id = p_event_id
      and failure.group_number = p_group_number
      and failure.failed_at > now() - window_length
      and (room_failures >= room_limit or failure.user_id = auth.uid());
    return jsonb_build_object(
      'status', 'locked',
      'attemptsLeft', 0,
      'retryAfterSeconds', greatest(1, ceil(extract(epoch from (latest_failure + window_length - now())))::integer)
    );
  end if;

  if candidate = '' then
    return jsonb_build_object('status', 'password_required', 'attemptsLeft', user_limit - user_failures);
  end if;

  if candidate !~ '^[0-9]{4,12}$' or extensions.crypt(candidate, stored_hash) <> stored_hash then
    insert into public.group_room_password_failures (event_id, group_number, user_id)
    values (p_event_id, p_group_number, auth.uid());
    return jsonb_build_object('status', 'invalid_password', 'attemptsLeft', greatest(0, user_limit - user_failures - 1));
  end if;

  return null;
end;
$$;
revoke all on function public.check_group_room_password(uuid, smallint, text) from public, anon, authenticated;

create or replace function public.verify_group_room_password(p_event_id uuid, p_group_number smallint, p_password text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  gate jsonb;
begin
  if auth.uid() is null then
    raise exception 'anonymous authenticated session required';
  end if;
  if not exists (
    select 1 from public.event_groups
    where event_id = p_event_id and group_number = p_group_number
  ) then
    raise exception 'group is unavailable';
  end if;
  gate := public.check_group_room_password(p_event_id, p_group_number, p_password);
  return coalesce(gate, jsonb_build_object('status', 'ok'));
end;
$$;
revoke all on function public.verify_group_room_password(uuid, smallint, text) from public, anon;
grant execute on function public.verify_group_room_password(uuid, smallint, text) to authenticated;

drop function if exists public.create_group_room(uuid, text, smallint);
create or replace function public.create_group_room(
  p_event_id uuid,
  p_room_name text,
  p_expected_attendance smallint default 4,
  p_password text default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  next_group_number integer;
  normalized_room_name text;
  normalized_password text := nullif(btrim(coalesce(p_password, '')), '');
  invite_code text;
  invite_hash text;
begin
  if auth.uid() is null then
    raise exception 'anonymous authenticated session required';
  end if;

  normalized_room_name := regexp_replace(btrim(coalesce(p_room_name, '')), '\s+', ' ', 'g');
  if char_length(normalized_room_name) not between 2 and 40 then
    raise exception 'room name must be between 2 and 40 characters';
  end if;

  if p_expected_attendance not between 2 and 20 then
    raise exception 'expected attendance must be between 2 and 20';
  end if;

  if normalized_password is not null and normalized_password !~ '^[0-9]{4,12}$' then
    raise exception 'room password must be 4 to 12 digits';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_event_id::text, 0));
  perform public.expire_inactive_custom_group_rooms(p_event_id);

  if exists (
    select 1 from public.event_groups
    where event_id = p_event_id and room_name = normalized_room_name
  ) then
    raise exception 'room name is already in use';
  end if;

  select coalesce(max(group_number), 0) + 1 into next_group_number
  from public.event_groups
  where event_id = p_event_id;

  if next_group_number > 32767 then
    raise exception 'room limit reached for this event';
  end if;

  for attempt in 1..8 loop
    invite_code := upper(encode(extensions.gen_random_bytes(4), 'hex'));
    invite_hash := encode(extensions.digest(invite_code, 'sha256'), 'hex');
    exit when not exists (
      select 1 from public.group_room_invites
      where event_id = p_event_id and code_hash = invite_hash
    );
  end loop;

  if invite_code is null or exists (
    select 1 from public.group_room_invites
    where event_id = p_event_id and code_hash = invite_hash
  ) then
    raise exception 'could not create a unique invite code';
  end if;

  insert into public.event_groups (event_id, group_number, leader_name, room_name, capacity)
  values (p_event_id, next_group_number::smallint, normalized_room_name, normalized_room_name, p_expected_attendance);

  insert into public.group_room_invites (event_id, group_number, code_hash, password_hash, created_by)
  values (
    p_event_id,
    next_group_number::smallint,
    invite_hash,
    case when normalized_password is null then null else extensions.crypt(normalized_password, extensions.gen_salt('bf', 8)) end,
    auth.uid()
  );

  return jsonb_build_object(
    'groupNumber', next_group_number,
    'roomName', normalized_room_name,
    'inviteCode', invite_code,
    'hasPassword', normalized_password is not null
  );
end;
$$;
revoke all on function public.create_group_room(uuid, text, smallint, text) from public, anon;
grant execute on function public.create_group_room(uuid, text, smallint, text) to authenticated;

drop function if exists public.join_group_room_by_code(uuid, text, text);
create or replace function public.join_group_room_by_code(
  p_event_id uuid,
  p_invite_code text,
  p_display_name text,
  p_password text default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  normalized_code text;
  invite_code_hash text;
  target_group_number smallint;
  gate jsonb;
  room_payload jsonb;
begin
  if auth.uid() is null then
    raise exception 'anonymous authenticated session required';
  end if;

  perform public.expire_inactive_custom_group_rooms(p_event_id);

  normalized_code := upper(regexp_replace(coalesce(p_invite_code, ''), '[^A-Za-z0-9]', '', 'g'));
  if normalized_code !~ '^[A-F0-9]{8}$' then
    raise exception 'invite code is invalid';
  end if;

  invite_code_hash := encode(extensions.digest(normalized_code, 'sha256'), 'hex');
  select group_number into target_group_number
  from public.group_room_invites as invite
  where invite.event_id = p_event_id and invite.code_hash = invite_code_hash;

  if target_group_number is null then
    raise exception 'invite code is invalid';
  end if;

  gate := public.check_group_room_password(p_event_id, target_group_number, p_password);
  if gate is not null then
    return jsonb_build_object('groupNumber', target_group_number, 'passwordGate', gate);
  end if;

  room_payload := public.join_group_session(p_event_id, target_group_number, p_display_name);
  return jsonb_build_object('groupNumber', target_group_number, 'room', room_payload);
end;
$$;
revoke all on function public.join_group_room_by_code(uuid, text, text, text) from public, anon;
grant execute on function public.join_group_room_by_code(uuid, text, text, text) to authenticated;

drop function if exists public.join_group_room_by_number(uuid, smallint, text);
create or replace function public.join_group_room_by_number(
  p_event_id uuid,
  p_group_number smallint,
  p_display_name text,
  p_password text default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  gate jsonb;
  room_payload jsonb;
begin
  if auth.uid() is null then
    raise exception 'anonymous authenticated session required';
  end if;

  perform public.expire_inactive_custom_group_rooms(p_event_id);

  if not exists (
    select 1 from public.event_groups
    where event_id = p_event_id and group_number = p_group_number
  ) then
    raise exception 'group is unavailable';
  end if;

  gate := public.check_group_room_password(p_event_id, p_group_number, p_password);
  if gate is not null then
    return jsonb_build_object('groupNumber', p_group_number, 'passwordGate', gate);
  end if;

  room_payload := public.join_group_session(p_event_id, p_group_number, p_display_name);
  return jsonb_build_object('groupNumber', p_group_number, 'room', room_payload);
end;
$$;
revoke all on function public.join_group_room_by_number(uuid, smallint, text, text) from public, anon;
grant execute on function public.join_group_room_by_number(uuid, smallint, text, text) to authenticated;

drop function if exists public.list_group_rooms(uuid);
create function public.list_group_rooms(p_event_id uuid)
returns table (
  group_number smallint,
  room_name text,
  capacity smallint,
  joined_count smallint,
  phase text,
  is_roster_room boolean,
  has_password boolean
)
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if auth.uid() is null then
    raise exception 'anonymous authenticated session required';
  end if;

  perform public.expire_inactive_custom_group_rooms(p_event_id);

  return query
  select
    event_group.group_number,
    event_group.room_name,
    coalesce(session.expected_attendance, event_group.capacity)::smallint,
    coalesce(room_status.joined_count, 0)::smallint,
    coalesce(room_status.phase::text, 'waiting'),
    event_group.is_roster_room,
    coalesce(invite.password_hash is not null, false)
  from public.event_groups as event_group
  left join public.group_room_status as room_status
    on room_status.event_id = event_group.event_id
    and room_status.group_number = event_group.group_number
  left join public.group_sessions as session
    on session.event_id = event_group.event_id
    and session.group_number = event_group.group_number
  left join public.group_room_invites as invite
    on invite.event_id = event_group.event_id
    and invite.group_number = event_group.group_number
  where event_group.event_id = p_event_id
  order by event_group.group_number;
end;
$$;
revoke all on function public.list_group_rooms(uuid) from public, anon;
grant execute on function public.list_group_rooms(uuid) to authenticated;

create or replace function public.set_group_room_password(p_event_id uuid, p_group_number smallint, p_password text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  normalized_password text := nullif(btrim(coalesce(p_password, '')), '');
begin
  if auth.uid() is null then
    raise exception 'anonymous authenticated session required';
  end if;

  if not exists (
    select 1 from public.group_sessions as session
    where session.event_id = p_event_id
      and session.group_number = p_group_number
      and session.host_user_id = auth.uid()
  ) then
    raise exception 'only the host can change the room password';
  end if;

  if normalized_password is not null and normalized_password !~ '^[0-9]{4,12}$' then
    raise exception 'room password must be 4 to 12 digits';
  end if;

  update public.group_room_invites
  set password_hash = case
    when normalized_password is null then null
    else extensions.crypt(normalized_password, extensions.gen_salt('bf', 8))
  end
  where event_id = p_event_id and group_number = p_group_number;

  if not found then
    raise exception 'group is unavailable';
  end if;

  delete from public.group_room_password_failures
  where event_id = p_event_id and group_number = p_group_number;

  return jsonb_build_object('hasPassword', normalized_password is not null);
end;
$$;
revoke all on function public.set_group_room_password(uuid, smallint, text) from public, anon;
grant execute on function public.set_group_room_password(uuid, smallint, text) to authenticated;

create or replace function public.get_group_room_lock(p_event_id uuid, p_group_number smallint)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if auth.uid() is null then
    raise exception 'anonymous authenticated session required';
  end if;

  if not public.can_read_group_room_status(p_event_id, p_group_number) then
    raise exception 'group is unavailable';
  end if;

  return jsonb_build_object(
    'hasPassword', exists (
      select 1 from public.group_room_invites as invite
      where invite.event_id = p_event_id
        and invite.group_number = p_group_number
        and invite.password_hash is not null
    ),
    'isHost', exists (
      select 1 from public.group_sessions as session
      where session.event_id = p_event_id
        and session.group_number = p_group_number
        and session.host_user_id = auth.uid()
    )
  );
end;
$$;
revoke all on function public.get_group_room_lock(uuid, smallint) from public, anon;
grant execute on function public.get_group_room_lock(uuid, smallint) to authenticated;

-- Hosted Supabase grants every public function to anon by default. Every room function requires a
-- signed-in (anonymous-auth) session, so signed-out callers need none of them.
revoke execute on all functions in schema public from public, anon;
