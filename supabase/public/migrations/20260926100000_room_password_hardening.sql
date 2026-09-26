-- Room password hardening after the 2026-09-26 independent review.
--
-- 1. Password checks for one room run one at a time (the same per-room advisory lock that
--    join_group_session takes), so parallel wrong guesses cannot slip past the limits.
-- 2. The room-wide cap (20 wrong tries per minute) pauses only callers who have guessed wrong
--    themselves, so strangers flooding a room cannot keep invitees with the right password out.
-- 3. The creator's free entry lasts only while no one else hosts the room.
-- 4. An index serves the failure-log cleanup, which now touches only the checked room.
--    Safe to apply more than once.

create index if not exists group_room_password_failures_failed_at_idx
  on public.group_room_password_failures (failed_at);

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

  if stored_hash is null then
    return null;
  end if;

  if room_creator = auth.uid() and not exists (
    select 1 from public.group_sessions as session
    where session.event_id = p_event_id
      and session.group_number = p_group_number
      and session.host_user_id <> auth.uid()
  ) then
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

  perform pg_advisory_xact_lock(hashtextextended(p_event_id::text || ':' || p_group_number::text, 0));

  -- Only this room's expired rows: touching other rooms' rows under this lock could deadlock with a
  -- room expiry that cascades into them.
  delete from public.group_room_password_failures as failure
  where failure.event_id = p_event_id
    and failure.group_number = p_group_number
    and failure.failed_at < now() - interval '10 minutes';

  select count(*) filter (where failure.user_id = auth.uid()), count(*)
  into user_failures, room_failures
  from public.group_room_password_failures as failure
  where failure.event_id = p_event_id
    and failure.group_number = p_group_number
    and failure.failed_at > now() - window_length;

  if user_failures >= user_limit or (room_failures >= room_limit and user_failures > 0) then
    select max(failure.failed_at) into latest_failure
    from public.group_room_password_failures as failure
    where failure.event_id = p_event_id
      and failure.group_number = p_group_number
      and failure.failed_at > now() - window_length
      and (user_failures < user_limit or failure.user_id = auth.uid());
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
