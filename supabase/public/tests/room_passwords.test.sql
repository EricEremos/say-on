-- Run only via scripts/test-balance-catalog-db.py in its disposable database.
-- Room lobby passwords: the hash and the failure log are unreachable by clients, every join
-- path honors the password, wrong tries are throttled per person and per room (and the record
-- of a wrong try survives, because the wrong try is returned rather than raised), and only the
-- host changes or clears the password. Applying the migration twice must be a no-op.
\ir ../migrations/20260926090000_room_lobby_passwords.sql
\ir ../migrations/20260926090000_room_lobby_passwords.sql
\ir ../migrations/20260926100000_room_password_hardening.sql
\ir ../migrations/20260926100000_room_password_hardening.sql

begin;

insert into auth.users (id) values
  ('00000000-0000-0000-0000-000000000031'),
  ('00000000-0000-0000-0000-000000000032'),
  ('00000000-0000-0000-0000-000000000033'),
  ('00000000-0000-0000-0000-000000000034'),
  ('00000000-0000-0000-0000-000000000035');

insert into public.events (id, public_code, title)
values ('30000000-0000-0000-0000-000000000001', 'password-smoke', 'Password smoke');

-- Privileges: no client role reads password material or reaches a join that skips the check.
do $$
begin
  if has_table_privilege('authenticated', 'public.group_room_invites', 'select')
    or has_table_privilege('anon', 'public.group_room_invites', 'select')
    or has_table_privilege('authenticated', 'public.group_room_password_failures', 'select')
    or has_table_privilege('anon', 'public.group_room_password_failures', 'select')
  then
    raise exception 'password material is readable by a client role';
  end if;

  if has_function_privilege('authenticated', 'public.join_group_session(uuid, smallint, text)', 'execute')
    or has_function_privilege('authenticated', 'public.join_group_session(uuid, smallint)', 'execute')
    or has_function_privilege('authenticated', 'public.join_group_room_by_code(uuid, text)', 'execute')
    or has_function_privilege('authenticated', 'public.join_group_room_by_number(uuid, smallint)', 'execute')
    or has_function_privilege('authenticated', 'public.check_group_room_password(uuid, smallint, text)', 'execute')
    or has_function_privilege('anon', 'public.join_group_room_by_code(uuid, text, text, text)', 'execute')
    or has_function_privilege('anon', 'public.list_group_rooms(uuid)', 'execute')
  then
    raise exception 'a join path that skips the password is callable by a client role';
  end if;

  if not has_function_privilege('authenticated', 'public.join_group_room_by_code(uuid, text, text, text)', 'execute')
    or not has_function_privilege('authenticated', 'public.join_group_room_by_number(uuid, smallint, text, text)', 'execute')
    or not has_function_privilege('authenticated', 'public.create_group_room(uuid, text, smallint, text)', 'execute')
    or not has_function_privilege('authenticated', 'public.verify_group_room_password(uuid, smallint, text)', 'execute')
    or not has_function_privilege('authenticated', 'public.set_group_room_password(uuid, smallint, text)', 'execute')
    or not has_function_privilege('authenticated', 'public.get_group_room_lock(uuid, smallint)', 'execute')
    or not has_function_privilege('authenticated', 'public.list_group_rooms(uuid)', 'execute')
  then
    raise exception 'a public room function is not callable by signed-in clients';
  end if;

  if exists (
    select 1 from pg_proc as proc
    join pg_namespace as namespace on namespace.oid = proc.pronamespace
    where namespace.nspname = 'public' and has_function_privilege('anon', proc.oid, 'execute')
  ) then
    raise exception 'a public function is executable by signed-out callers';
  end if;

  if pg_get_function_result('public.list_group_rooms(uuid)'::regprocedure) ilike '%hash%'
    or pg_get_function_result('public.list_group_rooms(uuid)'::regprocedure) not ilike '%has_password boolean%'
  then
    raise exception 'the lobby list must expose has_password and nothing secret';
  end if;
end $$;

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000031', true);

-- Host: creation validates the password, the creator enters freely, the lobby shows the lock.
do $$
declare
  event_id constant uuid := '30000000-0000-0000-0000-000000000001';
  created jsonb;
  joined jsonb;
  room_group smallint;
  invite_code text;
begin
  begin
    perform public.create_group_room(event_id, '짧은 비번', 4::smallint, '12');
    raise exception 'a two-digit password was accepted';
  exception when others then
    if sqlerrm <> 'room password must be 4 to 12 digits' then raise; end if;
  end;

  begin
    perform public.create_group_room(event_id, '글자 비번', 4::smallint, 'abcd');
    raise exception 'a non-digit password was accepted';
  exception when others then
    if sqlerrm <> 'room password must be 4 to 12 digits' then raise; end if;
  end;

  created := public.create_group_room(event_id, '비밀 모임', 4::smallint, '4821');
  room_group := (created->>'groupNumber')::smallint;
  invite_code := created->>'inviteCode';
  if room_group is null or invite_code !~ '^[A-F0-9]{8}$' or (created->>'hasPassword')::boolean is distinct from true then
    raise exception 'locked room creation failed: %', created;
  end if;

  joined := public.join_group_room_by_code(event_id, invite_code, '방장', null);
  if joined ? 'passwordGate' or joined->'room' is null then
    raise exception 'the creator was asked for the room password: %', joined;
  end if;

  if not exists (
    select 1 from public.list_group_rooms(event_id) as listed
    where listed.group_number = room_group and listed.has_password and listed.joined_count = 1
  ) then
    raise exception 'the lobby does not show the locked room';
  end if;

  if (public.get_group_room_lock(event_id, room_group)->>'hasPassword')::boolean is distinct from true
    or (public.get_group_room_lock(event_id, room_group)->>'isHost')::boolean is distinct from true
  then
    raise exception 'the host cannot read the lock state';
  end if;

  perform set_config('test.room_group', room_group::text, false);
  perform set_config('test.invite_code', invite_code, false);
end $$;

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000032', true);

-- Guest: asked for the password, a wrong try counts, the right one joins, a refresh passes.
do $$
declare
  event_id constant uuid := '30000000-0000-0000-0000-000000000001';
  room_group constant smallint := current_setting('test.room_group')::smallint;
  invite_code constant text := current_setting('test.invite_code');
  result jsonb;
begin
  result := public.join_group_room_by_code(event_id, invite_code, '손님', null);
  if result->'passwordGate'->>'status' is distinct from 'password_required' or result ? 'room' then
    raise exception 'a locked room let a guest in without a password: %', result;
  end if;

  begin
    perform public.get_group_room_lock(event_id, room_group);
    raise exception 'a non-member read the lock state';
  exception when others then
    if sqlerrm <> 'group is unavailable' then raise; end if;
  end;

  result := public.join_group_room_by_code(event_id, invite_code, '손님', '0000');
  if result->'passwordGate'->>'status' is distinct from 'invalid_password'
    or (result->'passwordGate'->>'attemptsLeft')::integer is distinct from 4
  then
    raise exception 'a wrong password was not reported with four tries left: %', result;
  end if;

  result := public.verify_group_room_password(event_id, room_group, '4821');
  if result->>'status' is distinct from 'ok' then
    raise exception 'the right password did not verify: %', result;
  end if;

  result := public.join_group_room_by_number(event_id, room_group, '손님', '4821');
  if result ? 'passwordGate' or result->'room' is null then
    raise exception 'the right password did not admit the guest: %', result;
  end if;

  result := public.join_group_room_by_code(event_id, invite_code, '손님', null);
  if result ? 'passwordGate' or result->'room' is null then
    raise exception 'a member was asked for the password again on refresh: %', result;
  end if;
end $$;

-- Superuser: the wrong try was recorded (not rolled back) and only a bcrypt hash is stored.
reset role;
do $$
declare
  room_group constant smallint := current_setting('test.room_group')::smallint;
begin
  if (select count(*) from public.group_room_password_failures
      where group_number = room_group and user_id = '00000000-0000-0000-0000-000000000032') <> 1 then
    raise exception 'the wrong try was not recorded';
  end if;
  if not exists (
    select 1 from public.group_room_invites
    where group_number = room_group and password_hash ~ '^\$2[abxy]\$' and password_hash <> '4821'
  ) then
    raise exception 'the password is not stored as a bcrypt hash';
  end if;
end $$;

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000033', true);

-- Intruder: five wrong tries lock even the right password out.
do $$
declare
  event_id constant uuid := '30000000-0000-0000-0000-000000000001';
  room_group constant smallint := current_setting('test.room_group')::smallint;
  result jsonb;
begin
  for attempt in 1..5 loop
    result := public.join_group_room_by_number(event_id, room_group, '엿보기', '1111');
    if result->'passwordGate'->>'status' is distinct from 'invalid_password'
      or (result->'passwordGate'->>'attemptsLeft')::integer is distinct from 5 - attempt
    then
      raise exception 'wrong try % was not counted down: %', attempt, result;
    end if;
  end loop;

  result := public.join_group_room_by_number(event_id, room_group, '엿보기', '4821');
  if result->'passwordGate'->>'status' is distinct from 'locked'
    or (result->'passwordGate'->>'retryAfterSeconds')::integer not between 1 and 60
    or result ? 'room'
  then
    raise exception 'five wrong tries did not lock the intruder out: %', result;
  end if;
end $$;

-- The window passes: age the intruder's failures by two minutes.
reset role;
update public.group_room_password_failures
set failed_at = failed_at - interval '2 minutes'
where user_id = '00000000-0000-0000-0000-000000000033';

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000033', true);

do $$
declare
  result jsonb;
begin
  result := public.join_group_room_by_number(
    '30000000-0000-0000-0000-000000000001', current_setting('test.room_group')::smallint, '엿보기', '4821');
  if result ? 'passwordGate' or result->'room' is null then
    raise exception 'the lock did not lift after the window: %', result;
  end if;
end $$;

-- Room-wide cap: twenty recent failures from other sessions lock the room for everyone.
reset role;
insert into public.group_room_password_failures (event_id, group_number, user_id)
select '30000000-0000-0000-0000-000000000001', current_setting('test.room_group')::smallint, gen_random_uuid()
from generate_series(1, 20);

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000034', true);

do $$
declare
  result jsonb;
begin
  -- A stranger who already guessed wrong is paused by the room-wide cap.
  result := public.join_group_room_by_number(
    '30000000-0000-0000-0000-000000000001', current_setting('test.room_group')::smallint, '늦은 손님', '9999');
  if result->'passwordGate'->>'status' is distinct from 'invalid_password' then
    raise exception 'a first wrong try during a room-wide flood was not counted as wrong: %', result;
  end if;
  result := public.join_group_room_by_number(
    '30000000-0000-0000-0000-000000000001', current_setting('test.room_group')::smallint, '늦은 손님', '4821');
  if result->'passwordGate'->>'status' is distinct from 'locked' then
    raise exception 'twenty room-wide failures did not pause someone who had guessed wrong: %', result;
  end if;
end $$;

-- An invitee with no wrong tries still enters during the flood.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000035', true);
do $$
declare
  result jsonb;
begin
  result := public.verify_group_room_password(
    '30000000-0000-0000-0000-000000000001', current_setting('test.room_group')::smallint, '4821');
  if result->>'status' is distinct from 'ok' then
    raise exception 'a room-wide flood turned away an invitee with the right password: %', result;
  end if;
end $$;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000034', true);

reset role;
delete from public.group_room_password_failures
where group_number = current_setting('test.room_group')::smallint
  and user_id not in (
    '00000000-0000-0000-0000-000000000032', '00000000-0000-0000-0000-000000000033',
    '00000000-0000-0000-0000-000000000035');

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000034', true);

do $$
declare
  result jsonb;
begin
  result := public.join_group_room_by_number(
    '30000000-0000-0000-0000-000000000001', current_setting('test.room_group')::smallint, '늦은 손님', '4821');
  if result ? 'passwordGate' or result->'room' is null then
    raise exception 'the room stayed locked after the room-wide window: %', result;
  end if;
end $$;

-- Only the host changes the password; a change takes effect; clearing unlocks the room.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000032', true);
do $$
begin
  perform public.set_group_room_password(
    '30000000-0000-0000-0000-000000000001', current_setting('test.room_group')::smallint, '9999');
  raise exception 'a guest changed the room password';
exception when others then
  if sqlerrm <> 'only the host can change the room password' then raise; end if;
end $$;

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000031', true);
do $$
declare
  event_id constant uuid := '30000000-0000-0000-0000-000000000001';
  room_group constant smallint := current_setting('test.room_group')::smallint;
begin
  begin
    perform public.set_group_room_password(event_id, room_group, '12a4');
    raise exception 'the host set a malformed password';
  exception when others then
    if sqlerrm <> 'room password must be 4 to 12 digits' then raise; end if;
  end;
  if (public.set_group_room_password(event_id, room_group, '777777')->>'hasPassword')::boolean is distinct from true then
    raise exception 'the host could not change the password';
  end if;
end $$;

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000035', true);
do $$
declare
  event_id constant uuid := '30000000-0000-0000-0000-000000000001';
  room_group constant smallint := current_setting('test.room_group')::smallint;
begin
  if public.verify_group_room_password(event_id, room_group, '4821')->>'status' is distinct from 'invalid_password' then
    raise exception 'the old password still verifies after a change';
  end if;
  if public.verify_group_room_password(event_id, room_group, '777777')->>'status' is distinct from 'ok' then
    raise exception 'the new password does not verify';
  end if;
end $$;

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000031', true);
do $$
declare
  event_id constant uuid := '30000000-0000-0000-0000-000000000001';
  room_group constant smallint := current_setting('test.room_group')::smallint;
begin
  if (public.set_group_room_password(event_id, room_group, null)->>'hasPassword')::boolean is distinct from false then
    raise exception 'the host could not clear the password';
  end if;
  if exists (select 1 from public.list_group_rooms(event_id) as listed where listed.group_number = room_group and listed.has_password) then
    raise exception 'the lobby still shows a cleared room as locked';
  end if;
end $$;

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000035', true);
do $$
begin
  if public.verify_group_room_password(
    '30000000-0000-0000-0000-000000000001', current_setting('test.room_group')::smallint, null)->>'status' is distinct from 'ok'
  then
    raise exception 'a cleared room still asks for a password';
  end if;
end $$;

-- The creator's free entry ends once someone else hosts and the creator has left.
reset role;
update public.group_sessions set host_user_id = '00000000-0000-0000-0000-000000000032'
where group_number = current_setting('test.room_group')::smallint;
delete from public.group_participants
where group_number = current_setting('test.room_group')::smallint and user_id = '00000000-0000-0000-0000-000000000031';
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000032', true);
do $$
begin
  perform public.set_group_room_password('30000000-0000-0000-0000-000000000001', current_setting('test.room_group')::smallint, '5555');
end $$;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000031', true);
do $$
declare
  result jsonb;
begin
  result := public.verify_group_room_password('30000000-0000-0000-0000-000000000001', current_setting('test.room_group')::smallint, null);
  if result->>'status' is distinct from 'password_required' then
    raise exception 'the creator kept free entry after handing off the room: %', result;
  end if;
end $$;

rollback;

select 'PASS room passwords: privileges, creator entry, required/wrong/right paths, per-person and per-room throttle, invitees pass a flood, creator entry ends at hand-off, host change and clear' as result;
