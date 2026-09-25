begin;

insert into auth.users (id) values
  ('00000000-0000-0000-0000-000000000011'),
  ('00000000-0000-0000-0000-000000000012'),
  ('00000000-0000-0000-0000-000000000013');

insert into public.events (id, public_code, title)
values ('20000000-0000-0000-0000-000000000001', 'lifecycle-smoke', 'Lifecycle smoke');

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);

do $$
declare
  event_id constant uuid := '20000000-0000-0000-0000-000000000001';
  host_id constant uuid := '00000000-0000-0000-0000-000000000011';
  guest_id constant uuid := '00000000-0000-0000-0000-000000000012';
  stale_owner_id constant uuid := '00000000-0000-0000-0000-000000000013';
  created_room jsonb;
  host_room jsonb;
  guest_room jsonb;
  room_state jsonb;
  stale_room jsonb;
  invite_code text;
  active_group smallint;
  stale_group smallint;
  chosen public.group_draws;
  vote jsonb;
begin
  created_room := public.create_group_room(event_id, '저녁 산책', 2::smallint);
  active_group := (created_room->>'groupNumber')::smallint;
  invite_code := created_room->>'inviteCode';
  if active_group is null or created_room->>'roomName' is distinct from '저녁 산책'
    or invite_code !~ '^[A-F0-9]{8}$'
  then
    raise exception 'named room creation failed';
  end if;

  host_room := public.join_group_room_by_code(event_id, invite_code, '진행자');
  if host_room->>'groupNumber' is distinct from active_group::text
    or host_room #>> '{room,displayName}' is distinct from '진행자'
    or host_room #>> '{room,isHost}' is distinct from 'true'
    or host_room #>> '{room,joinedCount}' is distinct from '1'
    or host_room #>> '{room,phase}' is distinct from 'waiting'
  then
    raise exception 'host did not join the named room';
  end if;

  room_state := public.set_my_group_ready(event_id, active_group, true);
  if room_state->>'isReady' is distinct from 'true' or room_state->>'readyCount' is distinct from '1' then
    raise exception 'host ready state failed';
  end if;

  perform set_config('request.jwt.claim.sub', guest_id::text, true);
  guest_room := public.join_group_room_by_code(event_id, invite_code, '참여자');
  if guest_room->>'groupNumber' is distinct from active_group::text
    or guest_room #>> '{room,displayName}' is distinct from '참여자'
    or guest_room #>> '{room,isHost}' is distinct from 'false'
    or guest_room #>> '{room,joinedCount}' is distinct from '2'
  then
    raise exception 'guest did not join the named room';
  end if;

  room_state := public.set_my_group_ready(event_id, active_group, true);
  if room_state->>'isReady' is distinct from 'true'
    or room_state->>'readyCount' is distinct from '2'
    or room_state->>'joinedCount' is distinct from '2'
  then
    raise exception 'guest ready state failed';
  end if;

  perform set_config('request.jwt.claim.sub', host_id::text, true);
  room_state := public.select_group_game(event_id, active_group, 'balance-ko-2026-09');
  if room_state->>'selectedGame' is distinct from 'balance-ko-2026-09'
    or room_state->>'phase' is distinct from 'waiting'
  then
    raise exception 'Balance selection failed';
  end if;

  room_state := public.start_group_session(event_id, active_group);
  if room_state->>'phase' is distinct from 'live'
    or room_state->>'roundNumber' is distinct from '1'
    or room_state->>'participantCount' is distinct from '2'
  then
    raise exception 'room start failed';
  end if;

  chosen := public.choose_group_card(event_id, active_group, 0::smallint, 0::smallint);
  if chosen.round_number is distinct from 1::smallint
    or chosen.draw_index is distinct from 0::smallint
    or chosen.chosen_card is distinct from 0::smallint
    or chosen.question_index not between 0 and 19
  then
    raise exception 'shared card activity failed';
  end if;

  perform set_config('request.jwt.claim.sub', guest_id::text, true);
  vote := public.cast_group_balance_vote(event_id, active_group, 'b');
  if vote #>> '{vote,myChoice}' is distinct from 'b'
    or vote #>> '{vote,bCount}' is distinct from '1'
  then
    raise exception 'guest vote failed';
  end if;

  if public.leave_group_room(event_id, active_group) is distinct from true then
    raise exception 'guest leave failed';
  end if;

  perform set_config('request.jwt.claim.sub', stale_owner_id::text, true);
  stale_room := public.create_group_room(event_id, '새벽 산책', 2::smallint);
  stale_group := (stale_room->>'groupNumber')::smallint;
  if stale_group is null or stale_group = active_group then
    raise exception 'stale room setup failed';
  end if;
end;
$$;

reset role;

do $$
declare
  lifecycle_event_id constant uuid := '20000000-0000-0000-0000-000000000001';
  host_id constant uuid := '00000000-0000-0000-0000-000000000011';
  guest_id constant uuid := '00000000-0000-0000-0000-000000000012';
  active_group smallint;
  stale_group smallint;
begin
  select group_number into active_group
  from public.event_groups
  where event_id = lifecycle_event_id and room_name = '저녁 산책';
  select group_number into stale_group
  from public.event_groups
  where event_id = lifecycle_event_id and room_name = '새벽 산책';
  if active_group is null or stale_group is null
    or exists (
      select 1 from public.group_participants
      where event_id = lifecycle_event_id and group_number = active_group and user_id = guest_id
    )
    or not exists (
      select 1 from public.group_participants
      where event_id = lifecycle_event_id and group_number = active_group and user_id = host_id
    )
    or not exists (
      select 1 from public.group_draws
      where event_id = lifecycle_event_id and group_number = active_group and draw_index = 0
    )
    or not exists (
      select 1 from public.group_balance_votes
      where event_id = lifecycle_event_id and group_number = active_group and voter_id = guest_id and choice = 'b'
    )
  then
    raise exception 'leave or game activity did not persist';
  end if;
  update public.event_groups
  set created_at = now() - interval '16 minutes'
  where event_id = lifecycle_event_id and group_number = stale_group;
end;
$$;

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);

do $$
declare
  lifecycle_event_id constant uuid := '20000000-0000-0000-0000-000000000001';
  active_group smallint;
  stale_group smallint;
begin
  select group_number into active_group from public.event_groups where event_id = lifecycle_event_id and room_name = '저녁 산책';
  select group_number into stale_group from public.event_groups where event_id = lifecycle_event_id and room_name = '새벽 산책';
  perform public.list_group_rooms(lifecycle_event_id);
  if not exists (
    select 1 from public.event_groups where event_id = lifecycle_event_id and group_number = active_group
  ) or exists (
    select 1 from public.event_groups where event_id = lifecycle_event_id and group_number = stale_group
  ) then
    raise exception 'custom room expiry did not keep active and remove stale rooms';
  end if;
end;
$$;

reset role;

do $$
declare
  lifecycle_event_id constant uuid := '20000000-0000-0000-0000-000000000001';
begin
  if not exists (
    select 1 from public.event_groups
    where event_id = lifecycle_event_id and room_name = '저녁 산책'
  ) or exists (
    select 1 from public.event_groups
    where event_id = lifecycle_event_id and room_name = '새벽 산책'
  ) or exists (
    select 1
    from public.group_room_invites as invite
    where invite.event_id = lifecycle_event_id
      and not exists (
        select 1 from public.event_groups as room
        where room.event_id = invite.event_id and room.group_number = invite.group_number
      )
  ) then
    raise exception 'custom room expiry did not clean physical room records';
  end if;
end;
$$;
rollback;

select 'PASS: named room lifecycle, shared Balance activity, guest leave, and stale custom-room expiry' as result;
