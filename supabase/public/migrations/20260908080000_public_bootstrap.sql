-- Say-On public bootstrap: final generic shared-room schema and RPC surface.
-- Generated from the private lineage's final schema only; no private event, group, or member data is included.
-- Apply in a Supabase project that provides auth, extensions, anon/authenticated/service_role, and supabase_realtime.

create extension if not exists pgcrypto with schema extensions;

--
-- PostgreSQL database dump
--


-- Dumped from database version 17.10 (Homebrew)
-- Dumped by pg_dump version 17.10 (Homebrew)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--



--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';


--
-- Name: group_room_phase; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.group_room_phase AS ENUM (
    'waiting',
    'live',
    'complete'
);


--
-- Name: accept_host_transfer(uuid, smallint, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.accept_host_transfer(p_event_id uuid, p_group_number smallint, p_code text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  transfer_row public.group_host_transfers;
  prior_host_id uuid;
  submitted_code_hash text;
begin
  perform public.assert_group_member(p_event_id, p_group_number);
  perform public.touch_group_session_activity(p_event_id, p_group_number);

  select host_user_id into prior_host_id
  from public.group_sessions
  where event_id = p_event_id and group_number = p_group_number and phase = 'waiting'
  for update;

  if not found then
    raise exception 'the group handoff window is closed';
  end if;

  if prior_host_id = auth.uid() then
    raise exception 'the current host cannot accept this transfer';
  end if;

  submitted_code_hash := pg_catalog.encode(
    extensions.digest(upper(regexp_replace(p_code, '[^A-Za-z0-9]', '', 'g')), 'sha256'),
    'hex'
  );

  select * into transfer_row
  from public.group_host_transfers
  where event_id = p_event_id
    and group_number = p_group_number
    and code_hash = submitted_code_hash
    and accepted_at is null
    and expires_at > now()
  for update;

  if not found then
    raise exception 'the handoff code is invalid or expired';
  end if;

  if transfer_row.issued_by <> prior_host_id then
    raise exception 'the handoff code is no longer valid';
  end if;

  update public.group_sessions
  set host_user_id = auth.uid(), last_activity_at = now(), updated_at = now()
  where event_id = p_event_id and group_number = p_group_number;

  update public.group_host_transfers
  set accepted_by = auth.uid(), accepted_at = now()
  where id = transfer_row.id;

  return public.group_room_payload(p_event_id, p_group_number);
end;
$$;


--
-- Name: assert_group_member(uuid, smallint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.assert_group_member(p_event_id uuid, p_group_number smallint) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if auth.uid() is null then
    raise exception 'anonymous authenticated session required';
  end if;

  if not exists (
    select 1 from public.group_participants
    where event_id = p_event_id and group_number = p_group_number and user_id = auth.uid()
  ) then
    raise exception 'you are not in this group';
  end if;
end;
$$;


--
-- Name: assert_group_session_fresh(uuid, smallint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.assert_group_session_fresh(p_event_id uuid, p_group_number smallint) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  current_session public.group_sessions;
begin
  select * into current_session
  from public.group_sessions
  where event_id = p_event_id and group_number = p_group_number
  for update;

  if not found then
    raise exception 'the group session does not exist';
  end if;

  if current_session.last_activity_at <= now() - interval '15 minutes' then
    raise exception 'the group session expired; re-enter the room to start again';
  end if;
end;
$$;


--
-- Name: can_read_group_room_status(uuid, smallint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.can_read_group_room_status(p_event_id uuid, p_group_number smallint) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select (select auth.uid()) is not null
    and exists (
      select 1
      from public.group_participants as participant
      where participant.event_id = p_event_id
        and participant.group_number = p_group_number
        and participant.user_id = (select auth.uid())
    );
$$;


--
-- Name: cast_group_balance_vote(uuid, smallint, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cast_group_balance_vote(p_event_id uuid, p_group_number smallint, p_choice text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  current_session public.group_sessions;
  current_draw public.group_draws;
begin
  perform public.assert_group_member(p_event_id, p_group_number);
  if p_choice not in ('a', 'b') then
    raise exception 'balance choice must be a or b';
  end if;

  select * into current_session
  from public.group_sessions
  where event_id = p_event_id and group_number = p_group_number
  for update;

  if not found or current_session.phase <> 'live' or current_session.selected_game_key <> 'balance' then
    raise exception 'the room is not playing Balance Game';
  end if;

  select * into current_draw
  from public.group_draws
  where event_id = p_event_id
    and group_number = p_group_number
    and round_number = current_session.current_round
  order by draw_index desc
  limit 1;

  if not found then
    raise exception 'choose a Balance card before voting';
  end if;

  insert into public.group_balance_votes (
    event_id, group_number, round_number, draw_index, voter_id, choice, updated_at
  ) values (
    p_event_id, p_group_number, current_draw.round_number, current_draw.draw_index, auth.uid(), p_choice, now()
  ) on conflict (event_id, group_number, round_number, draw_index, voter_id) do update
  set choice = excluded.choice, updated_at = now();

  return public.get_group_room_activity(p_event_id, p_group_number);
end;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: group_draws; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.group_draws (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    event_id uuid NOT NULL,
    group_number smallint NOT NULL,
    draw_index smallint NOT NULL,
    chosen_card smallint NOT NULL,
    question_index smallint NOT NULL,
    chosen_at timestamp with time zone DEFAULT now() NOT NULL,
    round_number smallint DEFAULT 1 NOT NULL,
    CONSTRAINT group_draws_chosen_card_check CHECK (((chosen_card >= 0) AND (chosen_card <= 2))),
    CONSTRAINT group_draws_draw_index_check CHECK (((draw_index >= 0) AND (draw_index <= 4))),
    CONSTRAINT group_draws_group_number_check CHECK (((group_number >= 1) AND (group_number <= 32767))),
    CONSTRAINT group_draws_question_index_check CHECK (((question_index >= 0) AND (question_index <= 29))),
    CONSTRAINT group_draws_round_number_check CHECK ((round_number >= 1))
);


--
-- Name: choose_group_card(uuid, smallint, smallint, smallint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.choose_group_card(p_event_id uuid, p_group_number smallint, p_expected_draw_index smallint, p_card_index smallint) RETURNS public.group_draws
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  selected_draw public.group_draws;
  current_session public.group_sessions;
  selected_question_index smallint;
  chooser_name text;
begin
  if p_card_index not between 0 and 2 then
    raise exception 'invalid card index';
  end if;

  select * into current_session
  from public.group_sessions
  where event_id = p_event_id and group_number = p_group_number
  for update;

  select option_row.question_index into selected_question_index
  from public.prepare_group_turn_card_options(p_event_id, p_group_number, p_expected_draw_index) as option_row
  where option_row.card_index = p_card_index;

  if selected_question_index is null then
    raise exception 'invalid card option';
  end if;

  insert into public.group_draws (event_id, group_number, round_number, draw_index, chosen_card, question_index)
  values (p_event_id, p_group_number, current_session.current_round, p_expected_draw_index, p_card_index, selected_question_index)
  returning * into selected_draw;

  if current_session.selected_game_key = 'icebreaker' then
    select display_name into chooser_name
    from public.group_participants
    where event_id = p_event_id and group_number = p_group_number and user_id = auth.uid();

    insert into public.group_turn_windows (
      event_id, group_number, round_number, draw_index, owner_id, owner_name, started_at, ends_at
    ) values (
      p_event_id, p_group_number, current_session.current_round, p_expected_draw_index, auth.uid(), chooser_name, now(), now() + interval '3 minutes'
    );
  end if;

  return selected_draw;
end;
$$;


--
-- Name: clear_selected_game_on_waiting(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.clear_selected_game_on_waiting() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
begin
  if new.phase = 'waiting' and old.phase is distinct from 'waiting' then
    new.selected_game_key = null;
  end if;

  return new;
end;
$$;


--
-- Name: close_group_turn_window(uuid, smallint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.close_group_turn_window(p_event_id uuid, p_group_number smallint) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  current_session public.group_sessions;
begin
  perform public.assert_group_member(p_event_id, p_group_number);
  select * into current_session
  from public.group_sessions
  where event_id = p_event_id and group_number = p_group_number
  for update;

  if not found or current_session.phase <> 'live' or current_session.selected_game_key <> 'icebreaker' then
    raise exception 'the room has no active Icebreaker turn';
  end if;
  if current_session.host_user_id <> auth.uid() then
    raise exception 'only the current host may close this turn';
  end if;

  update public.group_turn_windows
  set closed_at = now(), closed_by = auth.uid()
  where event_id = p_event_id
    and group_number = p_group_number
    and round_number = current_session.current_round
    and closed_at is null;

  if not found then
    raise exception 'there is no active Icebreaker turn to close';
  end if;

  update public.group_sessions
  set selected_game_key = selected_game_key
  where event_id = p_event_id and group_number = p_group_number;

  return public.get_group_room_activity(p_event_id, p_group_number);
end;
$$;


--
-- Name: continue_group_session(uuid, smallint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.continue_group_session(p_event_id uuid, p_group_number smallint) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  current_session public.group_sessions;
  current_total smallint;
begin
  perform public.assert_group_member(p_event_id, p_group_number);
  perform public.touch_group_session_activity(p_event_id, p_group_number);

  select * into current_session
  from public.group_sessions
  where event_id = p_event_id and group_number = p_group_number
  for update;

  if not found or current_session.host_user_id <> auth.uid() then
    raise exception 'only the current host may continue this group';
  end if;

  if current_session.phase <> 'live' then
    raise exception 'the group is not ready for another round';
  end if;

  select count(*)::smallint into current_total
  from public.group_draws
  where event_id = p_event_id
    and group_number = p_group_number
    and round_number = current_session.current_round;

  if current_total <> 5 then
    raise exception 'all five cards must be completed before continuing';
  end if;

  update public.group_sessions
  set current_round = current_round + 1, last_activity_at = now(), updated_at = now()
  where event_id = p_event_id and group_number = p_group_number;

  return public.group_room_payload(p_event_id, p_group_number);
end;
$$;


--
-- Name: create_group_room(uuid, smallint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_group_room(p_event_id uuid, p_expected_attendance smallint DEFAULT 4) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  next_group_number integer;
  invite_code text;
  invite_hash text;
  attempt integer;
  room_payload jsonb;
begin
  if auth.uid() is null then
    raise exception 'anonymous authenticated session required';
  end if;

  if p_expected_attendance not between 2 and 20 then
    raise exception 'expected attendance must be between 2 and 20';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_event_id::text, 0));

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

  insert into public.event_groups (event_id, group_number, leader_name, capacity)
  values (p_event_id, next_group_number::smallint, 'Room ' || next_group_number::text, p_expected_attendance);

  insert into public.group_room_invites (event_id, group_number, code_hash)
  values (p_event_id, next_group_number::smallint, invite_hash);

  room_payload := public.join_group_session(p_event_id, next_group_number::smallint);
  return jsonb_build_object(
    'groupNumber', next_group_number,
    'inviteCode', invite_code,
    'room', room_payload
  );
end;
$$;


--
-- Name: create_group_room(uuid, text, smallint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_group_room(p_event_id uuid, p_room_name text, p_expected_attendance smallint DEFAULT 4) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  next_group_number integer;
  normalized_room_name text;
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
  values (
    p_event_id,
    next_group_number::smallint,
    normalized_room_name,
    normalized_room_name,
    p_expected_attendance
  );

  insert into public.group_room_invites (event_id, group_number, code_hash)
  values (p_event_id, next_group_number::smallint, invite_hash);

  return jsonb_build_object(
    'groupNumber', next_group_number,
    'roomName', normalized_room_name,
    'inviteCode', invite_code
  );
end;
$$;


--
-- Name: create_host_transfer(uuid, smallint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_host_transfer(p_event_id uuid, p_group_number smallint) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  next_code text;
  next_code_hash text;
  expires_at_value timestamptz := now() + interval '10 minutes';
begin
  perform public.assert_group_member(p_event_id, p_group_number);
  perform public.touch_group_session_activity(p_event_id, p_group_number);

  if not exists (
    select 1 from public.group_sessions
    where event_id = p_event_id and group_number = p_group_number and host_user_id = auth.uid() and phase = 'waiting'
  ) then
    raise exception 'only the current host may create a handoff code';
  end if;

  delete from public.group_host_transfers
  where event_id = p_event_id and group_number = p_group_number and (expires_at <= now() or accepted_at is null);

  next_code := upper(pg_catalog.encode(extensions.gen_random_bytes(4), 'hex'));
  next_code_hash := pg_catalog.encode(extensions.digest(next_code, 'sha256'), 'hex');

  insert into public.group_host_transfers (event_id, group_number, code_hash, issued_by, expires_at)
  values (p_event_id, p_group_number, next_code_hash, auth.uid(), expires_at_value);

  return jsonb_build_object('code', next_code, 'expiresAt', expires_at_value);
end;
$$;


--
-- Name: expire_all_inactive_custom_group_rooms(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.expire_all_inactive_custom_group_rooms() RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  target_event_id uuid;
begin
  for target_event_id in
    select distinct event_group.event_id
    from public.event_groups as event_group
    where event_group.is_roster_room = false
  loop
    perform public.expire_inactive_custom_group_rooms(target_event_id);
  end loop;
end;
$$;


--
-- Name: expire_inactive_custom_group_rooms(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.expire_inactive_custom_group_rooms(p_event_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  delete from public.group_draws as draw
  where draw.event_id = p_event_id
    and draw.group_number in (
      select event_group.group_number
      from public.event_groups as event_group
      left join public.group_sessions as room_session
        on room_session.event_id = event_group.event_id
        and room_session.group_number = event_group.group_number
      where event_group.event_id = p_event_id
        and event_group.is_roster_room = false
        and (
          (room_session.event_id is null and event_group.created_at <= now() - interval '15 minutes')
          or room_session.last_activity_at <= now() - interval '15 minutes'
        )
    );

  delete from public.event_groups as event_group
  where event_group.event_id = p_event_id
    and event_group.is_roster_room = false
    and (
      (not exists (
        select 1 from public.group_sessions as room_session
        where room_session.event_id = event_group.event_id
          and room_session.group_number = event_group.group_number
      ) and event_group.created_at <= now() - interval '15 minutes')
      or exists (
        select 1 from public.group_sessions as room_session
        where room_session.event_id = event_group.event_id
          and room_session.group_number = event_group.group_number
          and room_session.last_activity_at <= now() - interval '15 minutes'
      )
    );
end;
$$;


--
-- Name: extend_group_turn_window(uuid, smallint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.extend_group_turn_window(p_event_id uuid, p_group_number smallint) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  current_session public.group_sessions;
  active_turn public.group_turn_windows;
begin
  perform public.assert_group_member(p_event_id, p_group_number);
  select * into current_session
  from public.group_sessions
  where event_id = p_event_id and group_number = p_group_number
  for update;

  if not found or current_session.phase <> 'live' or current_session.selected_game_key <> 'icebreaker' then
    raise exception 'the room has no active Icebreaker turn';
  end if;
  if current_session.host_user_id <> auth.uid() then
    raise exception 'only the current host may extend this turn';
  end if;

  update public.group_turn_windows
  set ends_at = greatest(ends_at, now()) + interval '1 minute'
  where event_id = p_event_id
    and group_number = p_group_number
    and round_number = current_session.current_round
    and closed_at is null
  returning * into active_turn;

  if not found then
    raise exception 'there is no active Icebreaker turn to extend';
  end if;

  update public.group_sessions
  set selected_game_key = selected_game_key
  where event_id = p_event_id and group_number = p_group_number;

  return public.get_group_room_activity(p_event_id, p_group_number);
end;
$$;


--
-- Name: finish_group_session(uuid, smallint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.finish_group_session(p_event_id uuid, p_group_number smallint) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  perform public.return_group_to_game_selection(p_event_id, p_group_number);
  return jsonb_build_object('finished', true);
end;
$$;


--
-- Name: get_group_room_activity(uuid, smallint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_group_room_activity(p_event_id uuid, p_group_number smallint) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  current_session public.group_sessions;
  messages_payload jsonb;
  active_turn public.group_turn_windows;
  active_turn_payload jsonb := 'null'::jsonb;
  current_draw public.group_draws;
  vote_payload jsonb := 'null'::jsonb;
begin
  perform public.assert_group_member(p_event_id, p_group_number);

  select * into current_session
  from public.group_sessions
  where event_id = p_event_id and group_number = p_group_number;

  if not found then
    raise exception 'group is unavailable';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', message_row.id,
    'authorName', message_row.author_name,
    'content', message_row.content,
    'createdAt', message_row.created_at
  ) order by message_row.created_at, message_row.id), '[]'::jsonb)
  into messages_payload
  from (
    select *
    from public.group_chat_messages
    where event_id = p_event_id
      and group_number = p_group_number
      and conversation_epoch = current_session.conversation_epoch
    order by created_at desc, id desc
    limit 50
  ) as message_row;

  if current_session.selected_game_key = 'icebreaker' and current_session.phase = 'live' then
    select * into active_turn
    from public.group_turn_windows
    where event_id = p_event_id
      and group_number = p_group_number
      and round_number = current_session.current_round
      and closed_at is null
    order by draw_index desc
    limit 1;

    if found then
      active_turn_payload := jsonb_build_object(
        'roundNumber', active_turn.round_number,
        'drawIndex', active_turn.draw_index,
        'ownerName', active_turn.owner_name,
        'startedAt', active_turn.started_at,
        'endsAt', active_turn.ends_at,
        'closedAt', active_turn.closed_at
      );
    end if;
  end if;

  if current_session.selected_game_key = 'balance' and current_session.phase = 'live' then
    select * into current_draw
    from public.group_draws
    where event_id = p_event_id
      and group_number = p_group_number
      and round_number = current_session.current_round
    order by draw_index desc
    limit 1;

    if found then
      select jsonb_build_object(
        'roundNumber', current_draw.round_number,
        'drawIndex', current_draw.draw_index,
        'aCount', count(*) filter (where vote.choice = 'a'),
        'bCount', count(*) filter (where vote.choice = 'b'),
        'myChoice', max(vote.choice) filter (where vote.voter_id = auth.uid())
      ) into vote_payload
      from public.group_balance_votes as vote
      where vote.event_id = p_event_id
        and vote.group_number = p_group_number
        and vote.round_number = current_draw.round_number
        and vote.draw_index = current_draw.draw_index;
    end if;
  end if;

  return jsonb_build_object(
    'messages', messages_payload,
    'turn', active_turn_payload,
    'vote', vote_payload
  );
end;
$$;


--
-- Name: get_group_room_release_status(uuid, smallint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_group_room_release_status(p_event_id uuid, p_group_number smallint) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  current_session public.group_sessions;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if p_group_number not between 1 and 32767 then
    raise exception 'invalid group number';
  end if;

  select * into current_session
  from public.group_sessions
  where event_id = p_event_id and group_number = p_group_number;

  if not found then
    raise exception 'group not found';
  end if;

  return jsonb_build_object(
    'group_number', p_group_number,
    'phase', current_session.phase,
    'event_menu_revision', current_session.event_menu_revision
  );
end;
$$;


--
-- Name: get_my_group_room(uuid, smallint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_my_group_room(p_event_id uuid, p_group_number smallint) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  perform public.assert_group_member(p_event_id, p_group_number);
  perform public.assert_group_session_fresh(p_event_id, p_group_number);
  return public.group_room_payload(p_event_id, p_group_number);
end;
$$;


--
-- Name: group_room_payload(uuid, smallint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.group_room_payload(p_event_id uuid, p_group_number smallint) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  status_row public.group_room_status;
  current_session public.group_sessions;
  own_ready boolean;
  own_display_name text;
  own_turn_position smallint;
  participant_total smallint;
  participants_payload jsonb;
begin
  perform public.assert_group_member(p_event_id, p_group_number);

  select * into status_row
  from public.group_room_status
  where event_id = p_event_id and group_number = p_group_number;

  select * into current_session
  from public.group_sessions
  where event_id = p_event_id and group_number = p_group_number;

  select is_ready, display_name into own_ready, own_display_name
  from public.group_participants
  where event_id = p_event_id and group_number = p_group_number and user_id = auth.uid();

  select count(*)::smallint into participant_total
  from public.group_participants
  where event_id = p_event_id and group_number = p_group_number;

  select ranked.turn_position into own_turn_position
  from (
    select participant.user_id,
      (row_number() over (order by participant.joined_at, participant.user_id) - 1)::smallint as turn_position
    from public.group_participants as participant
    where participant.event_id = p_event_id and participant.group_number = p_group_number
  ) as ranked
  where ranked.user_id = auth.uid();

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'displayName', ranked.display_name,
        'isReady', ranked.is_ready,
        'turnPosition', ranked.turn_position,
        'isSelf', ranked.user_id = auth.uid()
      ) order by ranked.turn_position
    ),
    '[]'::jsonb
  ) into participants_payload
  from (
    select participant.user_id,
      participant.display_name,
      participant.is_ready,
      (row_number() over (order by participant.joined_at, participant.user_id) - 1)::smallint as turn_position
    from public.group_participants as participant
    where participant.event_id = p_event_id and participant.group_number = p_group_number
  ) as ranked;

  return jsonb_build_object(
    'expectedAttendance', status_row.expected_attendance,
    'joinedCount', status_row.joined_count,
    'readyCount', status_row.ready_count,
    'phase', status_row.phase,
    'roundNumber', status_row.current_round,
    'revision', status_row.revision,
    'eventMenuRevision', status_row.event_menu_revision,
    'selectedGame', current_session.selected_game_key,
    'isHost', current_session.host_user_id = auth.uid(),
    'isReady', own_ready,
    'participantCount', participant_total,
    'turnPosition', own_turn_position,
    'displayName', own_display_name,
    'participants', participants_payload
  );
end;
$$;


--
-- Name: join_group_room_by_code(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.join_group_room_by_code(p_event_id uuid, p_invite_code text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
declare
  normalized_code text;
  invite_code_hash text;
  target_group_number smallint;
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

  room_payload := public.join_group_session(p_event_id, target_group_number);
  return jsonb_build_object('groupNumber', target_group_number, 'room', room_payload);
end;
$_$;


--
-- Name: join_group_room_by_code(uuid, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.join_group_room_by_code(p_event_id uuid, p_invite_code text, p_display_name text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
declare
  normalized_code text;
  invite_code_hash text;
  target_group_number smallint;
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

  room_payload := public.join_group_session(p_event_id, target_group_number, p_display_name);
  return jsonb_build_object('groupNumber', target_group_number, 'room', room_payload);
end;
$_$;


--
-- Name: join_group_room_by_number(uuid, smallint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.join_group_room_by_number(p_event_id uuid, p_group_number smallint) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  room_payload jsonb;
begin
  if auth.uid() is null then
    raise exception 'anonymous authenticated session required';
  end if;

  perform public.expire_inactive_custom_group_rooms(p_event_id);

  if not exists (
    select 1
    from public.event_groups
    where event_id = p_event_id and group_number = p_group_number
  ) then
    raise exception 'group is unavailable';
  end if;

  room_payload := public.join_group_session(p_event_id, p_group_number);
  return jsonb_build_object('groupNumber', p_group_number, 'room', room_payload);
end;
$$;


--
-- Name: join_group_room_by_number(uuid, smallint, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.join_group_room_by_number(p_event_id uuid, p_group_number smallint, p_display_name text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
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

  room_payload := public.join_group_session(p_event_id, p_group_number, p_display_name);
  return jsonb_build_object('groupNumber', p_group_number, 'room', room_payload);
end;
$$;


--
-- Name: join_group_session(uuid, smallint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.join_group_session(p_event_id uuid, p_group_number smallint) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  group_capacity smallint;
  joined_total smallint;
  current_session public.group_sessions;
begin
  if auth.uid() is null then
    raise exception 'anonymous authenticated session required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_event_id::text, 0));

  select capacity into group_capacity
  from public.event_groups
  where event_id = p_event_id and group_number = p_group_number;

  if group_capacity is null then
    raise exception 'group is unavailable';
  end if;

  insert into public.group_sessions (event_id, group_number, host_user_id, expected_attendance, last_activity_at)
  values (p_event_id, p_group_number, auth.uid(), group_capacity, now())
  on conflict (event_id, group_number) do nothing;

  select * into current_session
  from public.group_sessions
  where event_id = p_event_id and group_number = p_group_number
  for update;

  if current_session.last_activity_at <= now() - interval '15 minutes' then
    delete from public.group_draws
    where event_id = p_event_id and group_number = p_group_number;

    delete from public.group_host_transfers
    where event_id = p_event_id and group_number = p_group_number;

    delete from public.group_participants
    where event_id = p_event_id and group_number = p_group_number;

    update public.group_sessions
    set host_user_id = auth.uid(),
        expected_attendance = group_capacity,
        phase = 'waiting',
        current_round = 1,
        last_activity_at = now(),
        updated_at = now()
    where event_id = p_event_id and group_number = p_group_number;

    insert into public.group_participants (event_id, group_number, user_id, is_ready)
    values (p_event_id, p_group_number, auth.uid(), false);

    return public.group_room_payload(p_event_id, p_group_number);
  end if;

  if exists (
    select 1
    from public.group_participants
    where event_id = p_event_id and group_number = p_group_number and user_id = auth.uid()
  ) then
    update public.group_sessions
    set last_activity_at = now(), updated_at = now()
    where event_id = p_event_id and group_number = p_group_number;

    return public.group_room_payload(p_event_id, p_group_number);
  end if;

  if current_session.phase <> 'waiting' then
    raise exception 'the group has already started';
  end if;

  select count(*)::smallint into joined_total
  from public.group_participants
  where event_id = p_event_id and group_number = p_group_number;

  if joined_total >= current_session.expected_attendance then
    raise exception 'this group is already full';
  end if;

  insert into public.group_participants (event_id, group_number, user_id)
  values (p_event_id, p_group_number, auth.uid())
  on conflict (event_id, group_number, user_id) do nothing;

  update public.group_sessions
  set last_activity_at = now(), updated_at = now()
  where event_id = p_event_id and group_number = p_group_number;

  return public.group_room_payload(p_event_id, p_group_number);
end;
$$;


--
-- Name: join_group_session(uuid, smallint, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.join_group_session(p_event_id uuid, p_group_number smallint, p_display_name text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  group_capacity smallint;
  joined_total smallint;
  current_session public.group_sessions;
  normalized_display_name text;
begin
  if auth.uid() is null then
    raise exception 'anonymous authenticated session required';
  end if;

  normalized_display_name := regexp_replace(btrim(coalesce(p_display_name, '')), '\s+', ' ', 'g');
  if char_length(normalized_display_name) not between 2 and 12 then
    raise exception 'display name must be between 2 and 12 characters';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_event_id::text || ':' || p_group_number::text, 0));

  select capacity into group_capacity
  from public.event_groups
  where event_id = p_event_id and group_number = p_group_number;

  if group_capacity is null then
    raise exception 'group is unavailable';
  end if;

  insert into public.group_sessions (
    event_id, group_number, host_user_id, expected_attendance, last_activity_at
  )
  values (p_event_id, p_group_number, auth.uid(), group_capacity, now())
  on conflict (event_id, group_number) do nothing;

  select * into current_session
  from public.group_sessions
  where event_id = p_event_id and group_number = p_group_number
  for update;

  if current_session.last_activity_at <= now() - interval '15 minutes' then
    delete from public.group_turn_card_options
    where event_id = p_event_id and group_number = p_group_number;

    delete from public.group_draws
    where event_id = p_event_id and group_number = p_group_number;

    delete from public.group_host_transfers
    where event_id = p_event_id and group_number = p_group_number;

    delete from public.group_participants
    where event_id = p_event_id and group_number = p_group_number;

    update public.group_sessions
    set host_user_id = auth.uid(),
        expected_attendance = group_capacity,
        phase = 'waiting',
        current_round = 1,
        last_activity_at = now(),
        updated_at = now()
    where event_id = p_event_id and group_number = p_group_number;

    insert into public.group_participants (event_id, group_number, user_id, display_name, is_ready)
    values (p_event_id, p_group_number, auth.uid(), normalized_display_name, false);

    return public.group_room_payload(p_event_id, p_group_number);
  end if;

  if not exists (
    select 1 from public.group_participants
    where event_id = p_event_id and group_number = p_group_number
  ) then
    delete from public.group_turn_card_options
    where event_id = p_event_id and group_number = p_group_number;

    delete from public.group_draws
    where event_id = p_event_id and group_number = p_group_number;

    delete from public.group_host_transfers
    where event_id = p_event_id and group_number = p_group_number;

    update public.group_sessions
    set host_user_id = auth.uid(),
        expected_attendance = group_capacity,
        phase = 'waiting',
        current_round = 1,
        last_activity_at = now(),
        updated_at = now()
    where event_id = p_event_id and group_number = p_group_number;

    insert into public.group_participants (event_id, group_number, user_id, display_name, is_ready)
    values (p_event_id, p_group_number, auth.uid(), normalized_display_name, false);

    return public.group_room_payload(p_event_id, p_group_number);
  end if;

  if exists (
    select 1 from public.group_participants
    where event_id = p_event_id and group_number = p_group_number and user_id = auth.uid()
  ) then
    update public.group_participants
    set display_name = normalized_display_name,
        updated_at = now()
    where event_id = p_event_id and group_number = p_group_number and user_id = auth.uid();

    update public.group_sessions
    set last_activity_at = now(), updated_at = now()
    where event_id = p_event_id and group_number = p_group_number;

    return public.group_room_payload(p_event_id, p_group_number);
  end if;

  if current_session.phase <> 'waiting' then
    raise exception 'the group has already started';
  end if;

  select count(*)::smallint into joined_total
  from public.group_participants
  where event_id = p_event_id and group_number = p_group_number;

  if joined_total >= current_session.expected_attendance then
    raise exception 'this group is already full';
  end if;

  insert into public.group_participants (event_id, group_number, user_id, display_name, is_ready)
  values (p_event_id, p_group_number, auth.uid(), normalized_display_name, false);

  update public.group_sessions
  set last_activity_at = now(), updated_at = now()
  where event_id = p_event_id and group_number = p_group_number;

  return public.group_room_payload(p_event_id, p_group_number);
end;
$$;


--
-- Name: leave_finished_group_session(uuid, smallint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.leave_finished_group_session(p_event_id uuid, p_group_number smallint) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  current_session public.group_sessions;
begin
  perform public.assert_group_member(p_event_id, p_group_number);

  select * into current_session
  from public.group_sessions
  where event_id = p_event_id and group_number = p_group_number
  for update;

  if not found then
    raise exception 'the group session does not exist';
  end if;

  if current_session.host_user_id = auth.uid() then
    raise exception 'the current host cannot leave the group';
  end if;

  if current_session.phase <> 'waiting' then
    raise exception 'guests can leave only after the group ends';
  end if;

  delete from public.group_participants
  where event_id = p_event_id
    and group_number = p_group_number
    and user_id = auth.uid();
end;
$$;


--
-- Name: leave_group_room(uuid, smallint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.leave_group_room(p_event_id uuid, p_group_number smallint) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  current_session public.group_sessions;
  next_host_id uuid;
begin
  if auth.uid() is null then
    raise exception 'authenticated session required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_event_id::text || ':' || p_group_number::text, 0));
  perform public.assert_group_member(p_event_id, p_group_number);

  select *
  into current_session
  from public.group_sessions
  where event_id = p_event_id
    and group_number = p_group_number
  for update;

  if not found then
    raise exception 'room session not found';
  end if;

  if current_session.host_user_id = auth.uid() then
    select participant.user_id
    into next_host_id
    from public.group_participants participant
    where participant.event_id = p_event_id
      and participant.group_number = p_group_number
      and participant.user_id <> auth.uid()
    order by participant.joined_at, participant.user_id
    limit 1;
  end if;

  update public.group_sessions
  set host_user_id = coalesce(next_host_id, current_session.host_user_id),
      last_activity_at = now(),
      updated_at = now()
  where event_id = p_event_id
    and group_number = p_group_number;

  delete from public.group_participants
  where event_id = p_event_id
    and group_number = p_group_number
    and user_id = auth.uid();

  return true;
end;
$$;


--
-- Name: list_group_rooms(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.list_group_rooms(p_event_id uuid) RETURNS TABLE(group_number smallint, room_name text, capacity smallint, joined_count smallint, phase text, is_roster_room boolean)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if auth.uid() is null then
    raise exception 'anonymous authenticated session required';
  end if;

  perform public.expire_inactive_custom_group_rooms(p_event_id);

  return query
  select
    event_group.group_number,
    event_group.room_name,
    event_group.capacity,
    coalesce(room_status.joined_count, 0)::smallint,
    coalesce(room_status.phase::text, 'waiting'),
    event_group.is_roster_room
  from public.event_groups as event_group
  left join public.group_room_status as room_status
    on room_status.event_id = event_group.event_id
    and room_status.group_number = event_group.group_number
  where event_group.event_id = p_event_id
  order by event_group.group_number;
end;
$$;


--
-- Name: prepare_group_turn_card_options(uuid, smallint, smallint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.prepare_group_turn_card_options(p_event_id uuid, p_group_number smallint, p_expected_draw_index smallint) RETURNS TABLE(card_index smallint, question_index smallint)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  current_session public.group_sessions;
  current_total smallint;
  participant_total smallint;
  expected_selector uuid;
  existing_option_total smallint;
  question_count smallint;
begin
  perform public.assert_group_member(p_event_id, p_group_number);
  perform public.touch_group_session_activity(p_event_id, p_group_number);

  if p_group_number not between 1 and 32767 or p_expected_draw_index not between 0 and 4 then
    raise exception 'invalid card option request';
  end if;

  select * into current_session
  from public.group_sessions
  where event_id = p_event_id and group_number = p_group_number
  for update;

  if not found or current_session.phase <> 'live' or current_session.selected_game_key is null then
    raise exception 'the group is not ready for card drawing';
  end if;

  if current_session.selected_game_key = 'icebreaker' and exists (
    select 1
    from public.group_turn_windows as turn_window
    where turn_window.event_id = p_event_id
      and turn_window.group_number = p_group_number
      and turn_window.round_number = current_session.current_round
      and turn_window.closed_at is null
  ) then
    raise exception 'the current conversation turn must be closed before another card is prepared';
  end if;

  question_count := case current_session.selected_game_key when 'balance' then 30 else 17 end;

  select count(*)::smallint into current_total
  from public.group_draws
  where event_id = p_event_id and group_number = p_group_number and round_number = current_session.current_round;

  if current_total <> p_expected_draw_index then
    raise exception 'a different card state is already current';
  end if;

  select count(*)::smallint into participant_total
  from public.group_participants
  where event_id = p_event_id and group_number = p_group_number;

  if participant_total = 0 then
    raise exception 'the group has no confirmed participants';
  end if;

  select participant.user_id into expected_selector
  from public.group_participants as participant
  where participant.event_id = p_event_id and participant.group_number = p_group_number
  order by participant.joined_at, participant.user_id
  offset ((current_session.current_round - 1) * 5 + p_expected_draw_index) % participant_total
  limit 1;

  if expected_selector is distinct from auth.uid() then
    raise exception 'it is another confirmed participant''s turn to choose';
  end if;

  select count(*)::smallint into existing_option_total
  from public.group_turn_card_options as option_row
  where option_row.event_id = p_event_id and option_row.group_number = p_group_number
    and option_row.round_number = current_session.current_round and option_row.draw_index = p_expected_draw_index;

  if existing_option_total = 0 then
    insert into public.group_turn_card_options (event_id, group_number, round_number, draw_index, card_index, question_index)
    with unused_questions as (
      select candidate.question_index::smallint as question_index, random() as sort_order
      from generate_series(0, question_count - 1) as candidate(question_index)
      where not exists (
        select 1 from public.group_draws as existing_draw
        where existing_draw.event_id = p_event_id and existing_draw.group_number = p_group_number
          and existing_draw.round_number = current_session.current_round
          and existing_draw.question_index = candidate.question_index
      )
    )
    select p_event_id, p_group_number, current_session.current_round, p_expected_draw_index,
      (row_number() over (order by unused_question.sort_order, unused_question.question_index) - 1)::smallint,
      unused_question.question_index
    from unused_questions as unused_question
    order by unused_question.sort_order, unused_question.question_index
    limit 3;
  elsif existing_option_total <> 3 then
    raise exception 'turn card options are incomplete';
  end if;

  if (select count(*) from public.group_turn_card_options as option_row
      where option_row.event_id = p_event_id and option_row.group_number = p_group_number
        and option_row.round_number = current_session.current_round and option_row.draw_index = p_expected_draw_index) <> 3 then
    raise exception 'three unused questions are required for a turn';
  end if;

  return query
  select option_row.card_index, option_row.question_index
  from public.group_turn_card_options as option_row
  where option_row.event_id = p_event_id and option_row.group_number = p_group_number
    and option_row.round_number = current_session.current_round and option_row.draw_index = p_expected_draw_index
  order by option_row.card_index;
end;
$$;


--
-- Name: refresh_group_room_status(uuid, smallint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.refresh_group_room_status(p_event_id uuid, p_group_number smallint) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  current_session public.group_sessions;
  joined_total smallint;
  ready_total smallint;
begin
  select * into current_session
  from public.group_sessions
  where event_id = p_event_id and group_number = p_group_number;

  if not found then
    delete from public.group_room_status
    where event_id = p_event_id and group_number = p_group_number;
    return;
  end if;

  select count(*)::smallint, count(*) filter (where is_ready)::smallint
  into joined_total, ready_total
  from public.group_participants
  where event_id = p_event_id and group_number = p_group_number;

  insert into public.group_room_status (
    event_id,
    group_number,
    expected_attendance,
    joined_count,
    ready_count,
    phase,
    current_round,
    event_menu_revision,
    revision,
    updated_at
  )
  values (
    p_event_id,
    p_group_number,
    current_session.expected_attendance,
    joined_total,
    ready_total,
    current_session.phase,
    current_session.current_round,
    current_session.event_menu_revision,
    0,
    now()
  )
  on conflict (event_id, group_number) do update
  set expected_attendance = excluded.expected_attendance,
      joined_count = excluded.joined_count,
      ready_count = excluded.ready_count,
      phase = excluded.phase,
      current_round = excluded.current_round,
      event_menu_revision = excluded.event_menu_revision,
      revision = public.group_room_status.revision + 1,
      updated_at = now();
end;
$$;


--
-- Name: reset_group_activity_on_waiting(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reset_group_activity_on_waiting() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if old.phase = 'live' and new.phase = 'waiting' then
    new.conversation_epoch := old.conversation_epoch + 1;
    delete from public.group_turn_windows
    where event_id = old.event_id and group_number = old.group_number;
    delete from public.group_balance_votes
    where event_id = old.event_id and group_number = old.group_number;
  end if;
  return new;
end;
$$;


--
-- Name: return_group_to_event_menu(uuid, smallint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.return_group_to_event_menu(p_event_id uuid, p_group_number smallint) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  returned_room jsonb;
begin
  perform public.return_group_to_game_selection(p_event_id, p_group_number);

  update public.group_sessions
  set event_menu_revision = event_menu_revision + 1,
      last_activity_at = now(),
      updated_at = now()
  where event_id = p_event_id and group_number = p_group_number;

  returned_room := public.group_room_payload(p_event_id, p_group_number);

  delete from public.group_participants
  where event_id = p_event_id
    and group_number = p_group_number;

  return returned_room;
end;
$$;


--
-- Name: return_group_to_game_selection(uuid, smallint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.return_group_to_game_selection(p_event_id uuid, p_group_number smallint) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  current_session public.group_sessions;
  current_total smallint;
begin
  perform public.assert_group_member(p_event_id, p_group_number);

  select * into current_session
  from public.group_sessions
  where event_id = p_event_id and group_number = p_group_number
  for update;

  if not found or current_session.host_user_id <> auth.uid() then
    raise exception 'only the current host may finish this group';
  end if;

  if current_session.phase <> 'live' then
    raise exception 'the group is not ready to finish';
  end if;

  select count(*)::smallint into current_total
  from public.group_draws
  where event_id = p_event_id
    and group_number = p_group_number
    and round_number = current_session.current_round;

  if current_total <> 5 then
    raise exception 'all five cards must be completed before finishing';
  end if;

  delete from public.group_turn_card_options
  where event_id = p_event_id and group_number = p_group_number;

  delete from public.group_draws
  where event_id = p_event_id and group_number = p_group_number;

  delete from public.group_host_transfers
  where event_id = p_event_id and group_number = p_group_number;

  update public.group_participants
  set is_ready = false,
      updated_at = now()
  where event_id = p_event_id and group_number = p_group_number;

  update public.group_sessions
  set phase = 'waiting',
      current_round = 1,
      selected_game_key = null,
      last_activity_at = now(),
      updated_at = now()
  where event_id = p_event_id and group_number = p_group_number;

  return public.group_room_payload(p_event_id, p_group_number);
end;
$$;


--
-- Name: select_group_game(uuid, smallint, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.select_group_game(p_event_id uuid, p_group_number smallint, p_game_key text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  current_session public.group_sessions;
begin
  perform public.assert_group_member(p_event_id, p_group_number);
  perform public.touch_group_session_activity(p_event_id, p_group_number);

  if p_game_key not in ('icebreaker', 'balance') then
    raise exception 'invalid game selection';
  end if;

  select * into current_session
  from public.group_sessions
  where event_id = p_event_id and group_number = p_group_number
  for update;

  if not found or current_session.host_user_id <> auth.uid() then
    raise exception 'only the current host may select the game';
  end if;

  if current_session.phase <> 'waiting' then
    raise exception 'the game cannot change after the group starts';
  end if;

  update public.group_sessions
  set selected_game_key = p_game_key,
      last_activity_at = now(),
      updated_at = now()
  where event_id = p_event_id and group_number = p_group_number;

  return public.group_room_payload(p_event_id, p_group_number);
end;
$$;


--
-- Name: send_group_chat_message(uuid, smallint, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.send_group_chat_message(p_event_id uuid, p_group_number smallint, p_content text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  current_session public.group_sessions;
  author_display_name text;
  normalized_content text;
  sent_total smallint;
  inserted_message public.group_chat_messages;
begin
  perform public.assert_group_member(p_event_id, p_group_number);
  normalized_content := regexp_replace(
    btrim(coalesce(p_content, '')),
    E'[\\t\\f\\v ]+',
    ' ',
    'g'
  );

  if char_length(normalized_content) not between 1 and 300 then
    raise exception 'chat messages must be between 1 and 300 characters';
  end if;

  select * into current_session
  from public.group_sessions
  where event_id = p_event_id and group_number = p_group_number
  for update;

  select display_name into author_display_name
  from public.group_participants
  where event_id = p_event_id and group_number = p_group_number and user_id = auth.uid();

  select count(*)::smallint into sent_total
  from public.group_chat_messages
  where event_id = p_event_id
    and group_number = p_group_number
    and conversation_epoch = current_session.conversation_epoch
    and author_id = auth.uid()
    and created_at >= now() - interval '10 seconds';

  if sent_total >= 5 then
    raise exception 'please wait a moment before sending another chat message';
  end if;

  insert into public.group_chat_messages (
    event_id, group_number, conversation_epoch, author_id, author_name, content
  ) values (
    p_event_id, p_group_number, current_session.conversation_epoch, auth.uid(), author_display_name, normalized_content
  ) returning * into inserted_message;

  return jsonb_build_object(
    'id', inserted_message.id,
    'authorName', inserted_message.author_name,
    'content', inserted_message.content,
    'createdAt', inserted_message.created_at
  );
end;
$$;


--
-- Name: set_group_expected_attendance(uuid, smallint, smallint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_group_expected_attendance(p_event_id uuid, p_group_number smallint, p_expected_attendance smallint) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  current_session public.group_sessions;
  joined_total smallint;
begin
  perform public.assert_group_member(p_event_id, p_group_number);
  perform public.touch_group_session_activity(p_event_id, p_group_number);

  if p_expected_attendance not between 2 and 20 then
    raise exception 'expected attendance must be between 2 and 20';
  end if;

  select * into current_session
  from public.group_sessions
  where event_id = p_event_id and group_number = p_group_number
  for update;

  if current_session.host_user_id <> auth.uid() then
    raise exception 'only the current host may set expected attendance';
  end if;

  if current_session.phase <> 'waiting' then
    raise exception 'expected attendance cannot change after the group starts';
  end if;

  select count(*)::smallint into joined_total
  from public.group_participants
  where event_id = p_event_id and group_number = p_group_number;

  if p_expected_attendance < joined_total then
    raise exception 'expected attendance cannot be lower than joined attendance';
  end if;

  update public.group_sessions
  set expected_attendance = p_expected_attendance, last_activity_at = now(), updated_at = now()
  where event_id = p_event_id and group_number = p_group_number;

  return public.group_room_payload(p_event_id, p_group_number);
end;
$$;


--
-- Name: set_my_group_ready(uuid, smallint, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_my_group_ready(p_event_id uuid, p_group_number smallint, p_is_ready boolean) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  perform public.assert_group_member(p_event_id, p_group_number);
  perform public.touch_group_session_activity(p_event_id, p_group_number);

  if exists (
    select 1 from public.group_sessions
    where event_id = p_event_id and group_number = p_group_number and phase <> 'waiting'
  ) then
    raise exception 'the group has already started';
  end if;

  update public.group_participants
  set is_ready = p_is_ready, updated_at = now()
  where event_id = p_event_id and group_number = p_group_number and user_id = auth.uid();

  return public.group_room_payload(p_event_id, p_group_number);
end;
$$;


--
-- Name: start_group_session(uuid, smallint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.start_group_session(p_event_id uuid, p_group_number smallint) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  current_session public.group_sessions;
  joined_total smallint;
  ready_total smallint;
begin
  perform public.assert_group_member(p_event_id, p_group_number);
  perform public.touch_group_session_activity(p_event_id, p_group_number);

  select * into current_session
  from public.group_sessions
  where event_id = p_event_id and group_number = p_group_number and host_user_id = auth.uid() and phase = 'waiting'
  for update;

  if not found then
    raise exception 'only the current host may start this group';
  end if;

  if current_session.selected_game_key is null then
    raise exception 'a game must be selected before starting';
  end if;

  select count(*)::smallint, count(*) filter (where is_ready)::smallint
  into joined_total, ready_total
  from public.group_participants
  where event_id = p_event_id and group_number = p_group_number;

  if joined_total <> current_session.expected_attendance or ready_total <> current_session.expected_attendance then
    raise exception 'everyone must join and be ready before starting';
  end if;

  update public.group_sessions
  set phase = 'live', last_activity_at = now(), updated_at = now()
  where event_id = p_event_id and group_number = p_group_number;

  return public.group_room_payload(p_event_id, p_group_number);
end;
$$;


--
-- Name: sync_group_room_status_from_participant(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_group_room_status_from_participant() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  perform public.refresh_group_room_status(coalesce(new.event_id, old.event_id), coalesce(new.group_number, old.group_number));
  return coalesce(new, old);
end;
$$;


--
-- Name: sync_group_room_status_from_session(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_group_room_status_from_session() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  perform public.refresh_group_room_status(new.event_id, new.group_number);
  return new;
end;
$$;


--
-- Name: touch_group_session_activity(uuid, smallint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.touch_group_session_activity(p_event_id uuid, p_group_number smallint) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  perform pg_advisory_xact_lock(hashtextextended(p_event_id::text, 0));
  perform public.assert_group_member(p_event_id, p_group_number);
  perform public.assert_group_session_fresh(p_event_id, p_group_number);

  update public.group_sessions
  set last_activity_at = now(), updated_at = now()
  where event_id = p_event_id and group_number = p_group_number;

  return public.group_room_payload(p_event_id, p_group_number);
end;
$$;


--
-- Name: update_my_group_display_name(uuid, smallint, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_my_group_display_name(p_event_id uuid, p_group_number smallint, p_display_name text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  current_session public.group_sessions;
  normalized_display_name text;
begin
  perform public.assert_group_member(p_event_id, p_group_number);

  normalized_display_name := regexp_replace(btrim(coalesce(p_display_name, '')), '\s+', ' ', 'g');
  if char_length(normalized_display_name) not between 2 and 12 then
    raise exception 'display name must be between 2 and 12 characters';
  end if;

  select * into current_session
  from public.group_sessions
  where event_id = p_event_id and group_number = p_group_number
  for update;

  if not found or current_session.phase <> 'waiting' then
    raise exception 'display names can only change before the game starts';
  end if;

  update public.group_participants
  set display_name = normalized_display_name,
      updated_at = now()
  where event_id = p_event_id
    and group_number = p_group_number
    and user_id = auth.uid();

  update public.group_sessions
  set last_activity_at = now(),
      updated_at = now()
  where event_id = p_event_id and group_number = p_group_number;

  return public.group_room_payload(p_event_id, p_group_number);
end;
$$;


--
-- Name: event_groups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.event_groups (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    event_id uuid NOT NULL,
    group_number smallint NOT NULL,
    leader_name text NOT NULL,
    capacity smallint DEFAULT 14 NOT NULL,
    room_name text NOT NULL,
    is_roster_room boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT event_groups_capacity_check CHECK (((capacity >= 2) AND (capacity <= 20))),
    CONSTRAINT event_groups_group_number_check CHECK (((group_number >= 1) AND (group_number <= 32767))),
    CONSTRAINT event_groups_leader_name_check CHECK (((char_length(leader_name) >= 2) AND (char_length(leader_name) <= 40))),
    CONSTRAINT event_groups_room_name_check CHECK (((char_length(room_name) >= 2) AND (char_length(room_name) <= 40)))
);


--
-- Name: events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    public_code text NOT NULL,
    title text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT events_public_code_check CHECK ((public_code ~ '^[a-z0-9-]{4,32}$'::text)),
    CONSTRAINT events_title_check CHECK (((char_length(title) >= 1) AND (char_length(title) <= 120)))
);


--
-- Name: group_balance_votes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.group_balance_votes (
    event_id uuid NOT NULL,
    group_number smallint NOT NULL,
    round_number smallint NOT NULL,
    draw_index smallint NOT NULL,
    voter_id uuid NOT NULL,
    choice text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT group_balance_votes_choice_check CHECK ((choice = ANY (ARRAY['a'::text, 'b'::text]))),
    CONSTRAINT group_balance_votes_draw_index_check CHECK (((draw_index >= 0) AND (draw_index <= 4))),
    CONSTRAINT group_balance_votes_group_number_check CHECK (((group_number >= 1) AND (group_number <= 32767))),
    CONSTRAINT group_balance_votes_round_number_check CHECK ((round_number >= 1))
);


--
-- Name: group_chat_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.group_chat_messages (
    id bigint NOT NULL,
    event_id uuid NOT NULL,
    group_number smallint NOT NULL,
    conversation_epoch integer NOT NULL,
    author_id uuid NOT NULL,
    author_name text NOT NULL,
    content text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT group_chat_messages_author_name_check CHECK (((char_length(author_name) >= 2) AND (char_length(author_name) <= 12))),
    CONSTRAINT group_chat_messages_content_check CHECK (((char_length(btrim(content)) >= 1) AND (char_length(btrim(content)) <= 300))),
    CONSTRAINT group_chat_messages_conversation_epoch_check CHECK ((conversation_epoch >= 0)),
    CONSTRAINT group_chat_messages_group_number_check CHECK (((group_number >= 1) AND (group_number <= 32767)))
);


--
-- Name: group_chat_messages_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.group_chat_messages ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.group_chat_messages_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: group_host_transfers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.group_host_transfers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    event_id uuid NOT NULL,
    group_number smallint NOT NULL,
    code_hash text NOT NULL,
    issued_by uuid NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    accepted_by uuid,
    accepted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT group_host_transfers_check CHECK ((((accepted_by IS NULL) AND (accepted_at IS NULL)) OR ((accepted_by IS NOT NULL) AND (accepted_at IS NOT NULL)))),
    CONSTRAINT group_host_transfers_code_hash_check CHECK ((code_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT group_host_transfers_group_number_check CHECK (((group_number >= 1) AND (group_number <= 32767)))
);


--
-- Name: group_participants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.group_participants (
    event_id uuid NOT NULL,
    group_number smallint NOT NULL,
    user_id uuid NOT NULL,
    is_ready boolean DEFAULT false NOT NULL,
    joined_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    display_name text NOT NULL,
    CONSTRAINT group_participants_display_name_length_check CHECK (((char_length(regexp_replace(btrim(display_name), '\s+'::text, ' '::text, 'g'::text)) >= 2) AND (char_length(regexp_replace(btrim(display_name), '\s+'::text, ' '::text, 'g'::text)) <= 12))),
    CONSTRAINT group_participants_group_number_check CHECK (((group_number >= 1) AND (group_number <= 32767)))
);


--
-- Name: group_room_invites; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.group_room_invites (
    event_id uuid NOT NULL,
    group_number smallint NOT NULL,
    code_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT group_room_invites_code_hash_check CHECK ((code_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT group_room_invites_group_number_check CHECK (((group_number >= 1) AND (group_number <= 32767)))
);


--
-- Name: group_room_status; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.group_room_status (
    event_id uuid NOT NULL,
    group_number smallint NOT NULL,
    expected_attendance smallint NOT NULL,
    joined_count smallint NOT NULL,
    ready_count smallint NOT NULL,
    phase public.group_room_phase NOT NULL,
    revision bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    current_round smallint DEFAULT 1 NOT NULL,
    event_menu_revision integer DEFAULT 0 NOT NULL,
    CONSTRAINT group_room_status_check CHECK ((ready_count <= joined_count)),
    CONSTRAINT group_room_status_current_round_check CHECK ((current_round >= 1)),
    CONSTRAINT group_room_status_event_menu_revision_check CHECK ((event_menu_revision >= 0)),
    CONSTRAINT group_room_status_expected_attendance_check CHECK (((expected_attendance >= 2) AND (expected_attendance <= 20))),
    CONSTRAINT group_room_status_group_number_check CHECK (((group_number >= 1) AND (group_number <= 32767))),
    CONSTRAINT group_room_status_joined_count_check CHECK (((joined_count >= 0) AND (joined_count <= 20))),
    CONSTRAINT group_room_status_ready_count_check CHECK (((ready_count >= 0) AND (ready_count <= 20)))
);


--
-- Name: group_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.group_sessions (
    event_id uuid NOT NULL,
    group_number smallint NOT NULL,
    host_user_id uuid NOT NULL,
    expected_attendance smallint NOT NULL,
    phase public.group_room_phase DEFAULT 'waiting'::public.group_room_phase NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    current_round smallint DEFAULT 1 NOT NULL,
    last_activity_at timestamp with time zone DEFAULT now() NOT NULL,
    selected_game_key text,
    event_menu_revision integer DEFAULT 0 NOT NULL,
    conversation_epoch integer DEFAULT 0 NOT NULL,
    CONSTRAINT group_sessions_conversation_epoch_check CHECK ((conversation_epoch >= 0)),
    CONSTRAINT group_sessions_current_round_check CHECK ((current_round >= 1)),
    CONSTRAINT group_sessions_event_menu_revision_check CHECK ((event_menu_revision >= 0)),
    CONSTRAINT group_sessions_expected_attendance_check CHECK (((expected_attendance >= 2) AND (expected_attendance <= 20))),
    CONSTRAINT group_sessions_group_number_check CHECK (((group_number >= 1) AND (group_number <= 32767))),
    CONSTRAINT group_sessions_selected_game_key_check CHECK ((selected_game_key = ANY (ARRAY['icebreaker'::text, 'balance'::text])))
);


--
-- Name: group_turn_card_options; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.group_turn_card_options (
    event_id uuid NOT NULL,
    group_number smallint NOT NULL,
    round_number smallint NOT NULL,
    draw_index smallint NOT NULL,
    card_index smallint NOT NULL,
    question_index smallint NOT NULL,
    assigned_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT group_turn_card_options_card_index_check CHECK (((card_index >= 0) AND (card_index <= 2))),
    CONSTRAINT group_turn_card_options_draw_index_check CHECK (((draw_index >= 0) AND (draw_index <= 4))),
    CONSTRAINT group_turn_card_options_group_number_check CHECK (((group_number >= 1) AND (group_number <= 32767))),
    CONSTRAINT group_turn_card_options_question_index_check CHECK (((question_index >= 0) AND (question_index <= 29))),
    CONSTRAINT group_turn_card_options_round_number_check CHECK ((round_number >= 1))
);


--
-- Name: group_turn_windows; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.group_turn_windows (
    event_id uuid NOT NULL,
    group_number smallint NOT NULL,
    round_number smallint NOT NULL,
    draw_index smallint NOT NULL,
    owner_id uuid NOT NULL,
    owner_name text NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    ends_at timestamp with time zone NOT NULL,
    closed_at timestamp with time zone,
    closed_by uuid,
    CONSTRAINT group_turn_windows_check CHECK ((ends_at > started_at)),
    CONSTRAINT group_turn_windows_check1 CHECK ((((closed_at IS NULL) AND (closed_by IS NULL)) OR ((closed_at IS NOT NULL) AND (closed_by IS NOT NULL)))),
    CONSTRAINT group_turn_windows_draw_index_check CHECK (((draw_index >= 0) AND (draw_index <= 4))),
    CONSTRAINT group_turn_windows_group_number_check CHECK (((group_number >= 1) AND (group_number <= 32767))),
    CONSTRAINT group_turn_windows_owner_name_check CHECK (((char_length(owner_name) >= 2) AND (char_length(owner_name) <= 12))),
    CONSTRAINT group_turn_windows_round_number_check CHECK ((round_number >= 1))
);


--
-- Name: event_groups event_groups_event_id_group_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_groups
    ADD CONSTRAINT event_groups_event_id_group_number_key UNIQUE (event_id, group_number);


--
-- Name: event_groups event_groups_event_id_leader_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_groups
    ADD CONSTRAINT event_groups_event_id_leader_name_key UNIQUE (event_id, leader_name);


--
-- Name: event_groups event_groups_event_id_room_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_groups
    ADD CONSTRAINT event_groups_event_id_room_name_key UNIQUE (event_id, room_name);


--
-- Name: event_groups event_groups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_groups
    ADD CONSTRAINT event_groups_pkey PRIMARY KEY (id);


--
-- Name: events events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_pkey PRIMARY KEY (id);


--
-- Name: events events_public_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_public_code_key UNIQUE (public_code);


--
-- Name: group_balance_votes group_balance_votes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_balance_votes
    ADD CONSTRAINT group_balance_votes_pkey PRIMARY KEY (event_id, group_number, round_number, draw_index, voter_id);


--
-- Name: group_chat_messages group_chat_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_chat_messages
    ADD CONSTRAINT group_chat_messages_pkey PRIMARY KEY (id);


--
-- Name: group_draws group_draws_event_id_group_number_round_number_draw_index_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_draws
    ADD CONSTRAINT group_draws_event_id_group_number_round_number_draw_index_key UNIQUE (event_id, group_number, round_number, draw_index);


--
-- Name: group_draws group_draws_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_draws
    ADD CONSTRAINT group_draws_pkey PRIMARY KEY (id);


--
-- Name: group_host_transfers group_host_transfers_code_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_host_transfers
    ADD CONSTRAINT group_host_transfers_code_hash_key UNIQUE (code_hash);


--
-- Name: group_host_transfers group_host_transfers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_host_transfers
    ADD CONSTRAINT group_host_transfers_pkey PRIMARY KEY (id);


--
-- Name: group_participants group_participants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_participants
    ADD CONSTRAINT group_participants_pkey PRIMARY KEY (event_id, group_number, user_id);


--
-- Name: group_room_invites group_room_invites_event_id_code_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_room_invites
    ADD CONSTRAINT group_room_invites_event_id_code_hash_key UNIQUE (event_id, code_hash);


--
-- Name: group_room_invites group_room_invites_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_room_invites
    ADD CONSTRAINT group_room_invites_pkey PRIMARY KEY (event_id, group_number);


--
-- Name: group_room_status group_room_status_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_room_status
    ADD CONSTRAINT group_room_status_pkey PRIMARY KEY (event_id, group_number);


--
-- Name: group_sessions group_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_sessions
    ADD CONSTRAINT group_sessions_pkey PRIMARY KEY (event_id, group_number);


--
-- Name: group_turn_card_options group_turn_card_options_event_id_group_number_round_number__key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_turn_card_options
    ADD CONSTRAINT group_turn_card_options_event_id_group_number_round_number__key UNIQUE (event_id, group_number, round_number, draw_index, question_index);


--
-- Name: group_turn_card_options group_turn_card_options_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_turn_card_options
    ADD CONSTRAINT group_turn_card_options_pkey PRIMARY KEY (event_id, group_number, round_number, draw_index, card_index);


--
-- Name: group_turn_windows group_turn_windows_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_turn_windows
    ADD CONSTRAINT group_turn_windows_pkey PRIMARY KEY (event_id, group_number, round_number, draw_index);


--
-- Name: group_chat_messages_room_timeline_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX group_chat_messages_room_timeline_idx ON public.group_chat_messages USING btree (event_id, group_number, conversation_epoch, created_at, id);


--
-- Name: group_participants group_participants_sync_room_status; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER group_participants_sync_room_status AFTER INSERT OR DELETE OR UPDATE OF is_ready, display_name ON public.group_participants FOR EACH ROW EXECUTE FUNCTION public.sync_group_room_status_from_participant();


--
-- Name: group_sessions group_sessions_clear_selected_game_on_waiting; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER group_sessions_clear_selected_game_on_waiting BEFORE UPDATE OF phase ON public.group_sessions FOR EACH ROW EXECUTE FUNCTION public.clear_selected_game_on_waiting();


--
-- Name: group_sessions group_sessions_reset_activity_on_waiting; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER group_sessions_reset_activity_on_waiting BEFORE UPDATE OF phase ON public.group_sessions FOR EACH ROW EXECUTE FUNCTION public.reset_group_activity_on_waiting();


--
-- Name: group_sessions group_sessions_sync_room_status; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER group_sessions_sync_room_status AFTER INSERT OR UPDATE OF expected_attendance, host_user_id, phase, current_round, selected_game_key, event_menu_revision ON public.group_sessions FOR EACH ROW EXECUTE FUNCTION public.sync_group_room_status_from_session();


--
-- Name: event_groups event_groups_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_groups
    ADD CONSTRAINT event_groups_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.events(id) ON DELETE CASCADE;


--
-- Name: group_balance_votes group_balance_votes_event_id_group_number_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_balance_votes
    ADD CONSTRAINT group_balance_votes_event_id_group_number_fkey FOREIGN KEY (event_id, group_number) REFERENCES public.group_sessions(event_id, group_number) ON DELETE CASCADE;


--
-- Name: group_balance_votes group_balance_votes_voter_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_balance_votes
    ADD CONSTRAINT group_balance_votes_voter_id_fkey FOREIGN KEY (voter_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: group_chat_messages group_chat_messages_author_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_chat_messages
    ADD CONSTRAINT group_chat_messages_author_id_fkey FOREIGN KEY (author_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: group_chat_messages group_chat_messages_event_id_group_number_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_chat_messages
    ADD CONSTRAINT group_chat_messages_event_id_group_number_fkey FOREIGN KEY (event_id, group_number) REFERENCES public.group_sessions(event_id, group_number) ON DELETE CASCADE;


--
-- Name: group_draws group_draws_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_draws
    ADD CONSTRAINT group_draws_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.events(id) ON DELETE CASCADE;


--
-- Name: group_host_transfers group_host_transfers_accepted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_host_transfers
    ADD CONSTRAINT group_host_transfers_accepted_by_fkey FOREIGN KEY (accepted_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: group_host_transfers group_host_transfers_event_id_group_number_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_host_transfers
    ADD CONSTRAINT group_host_transfers_event_id_group_number_fkey FOREIGN KEY (event_id, group_number) REFERENCES public.group_sessions(event_id, group_number) ON DELETE CASCADE;


--
-- Name: group_host_transfers group_host_transfers_issued_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_host_transfers
    ADD CONSTRAINT group_host_transfers_issued_by_fkey FOREIGN KEY (issued_by) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: group_participants group_participants_event_id_group_number_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_participants
    ADD CONSTRAINT group_participants_event_id_group_number_fkey FOREIGN KEY (event_id, group_number) REFERENCES public.group_sessions(event_id, group_number) ON DELETE CASCADE;


--
-- Name: group_participants group_participants_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_participants
    ADD CONSTRAINT group_participants_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: group_room_invites group_room_invites_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_room_invites
    ADD CONSTRAINT group_room_invites_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.events(id) ON DELETE CASCADE;


--
-- Name: group_room_invites group_room_invites_event_id_group_number_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_room_invites
    ADD CONSTRAINT group_room_invites_event_id_group_number_fkey FOREIGN KEY (event_id, group_number) REFERENCES public.event_groups(event_id, group_number) ON DELETE CASCADE;


--
-- Name: group_room_status group_room_status_event_id_group_number_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_room_status
    ADD CONSTRAINT group_room_status_event_id_group_number_fkey FOREIGN KEY (event_id, group_number) REFERENCES public.group_sessions(event_id, group_number) ON DELETE CASCADE;


--
-- Name: group_sessions group_sessions_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_sessions
    ADD CONSTRAINT group_sessions_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.events(id) ON DELETE CASCADE;


--
-- Name: group_sessions group_sessions_event_id_group_number_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_sessions
    ADD CONSTRAINT group_sessions_event_id_group_number_fkey FOREIGN KEY (event_id, group_number) REFERENCES public.event_groups(event_id, group_number) ON DELETE CASCADE;


--
-- Name: group_sessions group_sessions_host_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_sessions
    ADD CONSTRAINT group_sessions_host_user_id_fkey FOREIGN KEY (host_user_id) REFERENCES auth.users(id) ON DELETE RESTRICT;


--
-- Name: group_turn_card_options group_turn_card_options_event_id_group_number_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_turn_card_options
    ADD CONSTRAINT group_turn_card_options_event_id_group_number_fkey FOREIGN KEY (event_id, group_number) REFERENCES public.group_sessions(event_id, group_number) ON DELETE CASCADE;


--
-- Name: group_turn_windows group_turn_windows_closed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_turn_windows
    ADD CONSTRAINT group_turn_windows_closed_by_fkey FOREIGN KEY (closed_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: group_turn_windows group_turn_windows_event_id_group_number_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_turn_windows
    ADD CONSTRAINT group_turn_windows_event_id_group_number_fkey FOREIGN KEY (event_id, group_number) REFERENCES public.group_sessions(event_id, group_number) ON DELETE CASCADE;


--
-- Name: group_turn_windows group_turn_windows_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_turn_windows
    ADD CONSTRAINT group_turn_windows_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE RESTRICT;


--
-- Name: events event cue is readable to guests; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "event cue is readable to guests" ON public.events FOR SELECT USING (true);


--
-- Name: event_groups; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.event_groups ENABLE ROW LEVEL SECURITY;

--
-- Name: events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.events ENABLE ROW LEVEL SECURITY;

--
-- Name: group_balance_votes group participants read their balance votes; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "group participants read their balance votes" ON public.group_balance_votes FOR SELECT TO authenticated USING (( SELECT public.can_read_group_room_status(group_balance_votes.event_id, group_balance_votes.group_number) AS can_read_group_room_status));


--
-- Name: group_chat_messages group participants read their chat; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "group participants read their chat" ON public.group_chat_messages FOR SELECT TO authenticated USING (( SELECT public.can_read_group_room_status(group_chat_messages.event_id, group_chat_messages.group_number) AS can_read_group_room_status));


--
-- Name: group_draws group participants read their own draw history; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "group participants read their own draw history" ON public.group_draws FOR SELECT TO authenticated USING (( SELECT public.can_read_group_room_status(group_draws.event_id, group_draws.group_number) AS can_read_group_room_status));


--
-- Name: group_room_status group participants read their own room status; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "group participants read their own room status" ON public.group_room_status FOR SELECT TO authenticated USING (( SELECT public.can_read_group_room_status(group_room_status.event_id, group_room_status.group_number) AS can_read_group_room_status));


--
-- Name: group_turn_card_options group participants read their turn card options; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "group participants read their turn card options" ON public.group_turn_card_options FOR SELECT TO authenticated USING (( SELECT public.can_read_group_room_status(group_turn_card_options.event_id, group_turn_card_options.group_number) AS can_read_group_room_status));


--
-- Name: group_turn_windows group participants read their turn window; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "group participants read their turn window" ON public.group_turn_windows FOR SELECT TO authenticated USING (( SELECT public.can_read_group_room_status(group_turn_windows.event_id, group_turn_windows.group_number) AS can_read_group_room_status));


--
-- Name: group_balance_votes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.group_balance_votes ENABLE ROW LEVEL SECURITY;

--
-- Name: group_chat_messages; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.group_chat_messages ENABLE ROW LEVEL SECURITY;

--
-- Name: group_draws; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.group_draws ENABLE ROW LEVEL SECURITY;

--
-- Name: group_host_transfers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.group_host_transfers ENABLE ROW LEVEL SECURITY;

--
-- Name: group_participants; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.group_participants ENABLE ROW LEVEL SECURITY;

--
-- Name: group_room_invites; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.group_room_invites ENABLE ROW LEVEL SECURITY;

--
-- Name: group_room_status; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.group_room_status ENABLE ROW LEVEL SECURITY;

--
-- Name: group_sessions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.group_sessions ENABLE ROW LEVEL SECURITY;

--
-- Name: group_turn_card_options; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.group_turn_card_options ENABLE ROW LEVEL SECURITY;

--
-- Name: group_turn_windows; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.group_turn_windows ENABLE ROW LEVEL SECURITY;

--
-- Name: event_groups sun group labels are readable to guests; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "sun group labels are readable to guests" ON public.event_groups FOR SELECT USING (true);


--
-- Name: FUNCTION accept_host_transfer(p_event_id uuid, p_group_number smallint, p_code text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.accept_host_transfer(p_event_id uuid, p_group_number smallint, p_code text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.accept_host_transfer(p_event_id uuid, p_group_number smallint, p_code text) TO authenticated;


--
-- Name: FUNCTION assert_group_member(p_event_id uuid, p_group_number smallint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.assert_group_member(p_event_id uuid, p_group_number smallint) FROM PUBLIC;


--
-- Name: FUNCTION assert_group_session_fresh(p_event_id uuid, p_group_number smallint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.assert_group_session_fresh(p_event_id uuid, p_group_number smallint) FROM PUBLIC;


--
-- Name: FUNCTION can_read_group_room_status(p_event_id uuid, p_group_number smallint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.can_read_group_room_status(p_event_id uuid, p_group_number smallint) FROM PUBLIC;
GRANT ALL ON FUNCTION public.can_read_group_room_status(p_event_id uuid, p_group_number smallint) TO authenticated;


--
-- Name: FUNCTION cast_group_balance_vote(p_event_id uuid, p_group_number smallint, p_choice text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.cast_group_balance_vote(p_event_id uuid, p_group_number smallint, p_choice text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.cast_group_balance_vote(p_event_id uuid, p_group_number smallint, p_choice text) TO authenticated;


--
-- Name: TABLE group_draws; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.group_draws TO authenticated;


--
-- Name: FUNCTION choose_group_card(p_event_id uuid, p_group_number smallint, p_expected_draw_index smallint, p_card_index smallint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.choose_group_card(p_event_id uuid, p_group_number smallint, p_expected_draw_index smallint, p_card_index smallint) FROM PUBLIC;
GRANT ALL ON FUNCTION public.choose_group_card(p_event_id uuid, p_group_number smallint, p_expected_draw_index smallint, p_card_index smallint) TO authenticated;


--
-- Name: FUNCTION close_group_turn_window(p_event_id uuid, p_group_number smallint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.close_group_turn_window(p_event_id uuid, p_group_number smallint) FROM PUBLIC;
GRANT ALL ON FUNCTION public.close_group_turn_window(p_event_id uuid, p_group_number smallint) TO authenticated;


--
-- Name: FUNCTION continue_group_session(p_event_id uuid, p_group_number smallint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.continue_group_session(p_event_id uuid, p_group_number smallint) FROM PUBLIC;
GRANT ALL ON FUNCTION public.continue_group_session(p_event_id uuid, p_group_number smallint) TO authenticated;


--
-- Name: FUNCTION create_group_room(p_event_id uuid, p_expected_attendance smallint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.create_group_room(p_event_id uuid, p_expected_attendance smallint) FROM PUBLIC;
GRANT ALL ON FUNCTION public.create_group_room(p_event_id uuid, p_expected_attendance smallint) TO authenticated;


--
-- Name: FUNCTION create_group_room(p_event_id uuid, p_room_name text, p_expected_attendance smallint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.create_group_room(p_event_id uuid, p_room_name text, p_expected_attendance smallint) FROM PUBLIC;
GRANT ALL ON FUNCTION public.create_group_room(p_event_id uuid, p_room_name text, p_expected_attendance smallint) TO authenticated;


--
-- Name: FUNCTION create_host_transfer(p_event_id uuid, p_group_number smallint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.create_host_transfer(p_event_id uuid, p_group_number smallint) FROM PUBLIC;
GRANT ALL ON FUNCTION public.create_host_transfer(p_event_id uuid, p_group_number smallint) TO authenticated;


--
-- Name: FUNCTION expire_all_inactive_custom_group_rooms(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.expire_all_inactive_custom_group_rooms() FROM PUBLIC;


--
-- Name: FUNCTION expire_inactive_custom_group_rooms(p_event_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.expire_inactive_custom_group_rooms(p_event_id uuid) FROM PUBLIC;


--
-- Name: FUNCTION extend_group_turn_window(p_event_id uuid, p_group_number smallint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.extend_group_turn_window(p_event_id uuid, p_group_number smallint) FROM PUBLIC;
GRANT ALL ON FUNCTION public.extend_group_turn_window(p_event_id uuid, p_group_number smallint) TO authenticated;


--
-- Name: FUNCTION finish_group_session(p_event_id uuid, p_group_number smallint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.finish_group_session(p_event_id uuid, p_group_number smallint) FROM PUBLIC;
GRANT ALL ON FUNCTION public.finish_group_session(p_event_id uuid, p_group_number smallint) TO authenticated;


--
-- Name: FUNCTION get_group_room_activity(p_event_id uuid, p_group_number smallint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.get_group_room_activity(p_event_id uuid, p_group_number smallint) FROM PUBLIC;
GRANT ALL ON FUNCTION public.get_group_room_activity(p_event_id uuid, p_group_number smallint) TO authenticated;


--
-- Name: FUNCTION get_group_room_release_status(p_event_id uuid, p_group_number smallint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.get_group_room_release_status(p_event_id uuid, p_group_number smallint) FROM PUBLIC;
GRANT ALL ON FUNCTION public.get_group_room_release_status(p_event_id uuid, p_group_number smallint) TO authenticated;


--
-- Name: FUNCTION get_my_group_room(p_event_id uuid, p_group_number smallint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.get_my_group_room(p_event_id uuid, p_group_number smallint) FROM PUBLIC;
GRANT ALL ON FUNCTION public.get_my_group_room(p_event_id uuid, p_group_number smallint) TO authenticated;


--
-- Name: FUNCTION group_room_payload(p_event_id uuid, p_group_number smallint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.group_room_payload(p_event_id uuid, p_group_number smallint) FROM PUBLIC;


--
-- Name: FUNCTION join_group_room_by_code(p_event_id uuid, p_invite_code text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.join_group_room_by_code(p_event_id uuid, p_invite_code text) FROM PUBLIC;


--
-- Name: FUNCTION join_group_room_by_code(p_event_id uuid, p_invite_code text, p_display_name text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.join_group_room_by_code(p_event_id uuid, p_invite_code text, p_display_name text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.join_group_room_by_code(p_event_id uuid, p_invite_code text, p_display_name text) TO authenticated;


--
-- Name: FUNCTION join_group_room_by_number(p_event_id uuid, p_group_number smallint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.join_group_room_by_number(p_event_id uuid, p_group_number smallint) FROM PUBLIC;


--
-- Name: FUNCTION join_group_room_by_number(p_event_id uuid, p_group_number smallint, p_display_name text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.join_group_room_by_number(p_event_id uuid, p_group_number smallint, p_display_name text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.join_group_room_by_number(p_event_id uuid, p_group_number smallint, p_display_name text) TO authenticated;


--
-- Name: FUNCTION join_group_session(p_event_id uuid, p_group_number smallint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.join_group_session(p_event_id uuid, p_group_number smallint) FROM PUBLIC;


--
-- Name: FUNCTION join_group_session(p_event_id uuid, p_group_number smallint, p_display_name text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.join_group_session(p_event_id uuid, p_group_number smallint, p_display_name text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.join_group_session(p_event_id uuid, p_group_number smallint, p_display_name text) TO authenticated;


--
-- Name: FUNCTION leave_finished_group_session(p_event_id uuid, p_group_number smallint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.leave_finished_group_session(p_event_id uuid, p_group_number smallint) FROM PUBLIC;


--
-- Name: FUNCTION leave_group_room(p_event_id uuid, p_group_number smallint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.leave_group_room(p_event_id uuid, p_group_number smallint) FROM PUBLIC;
GRANT ALL ON FUNCTION public.leave_group_room(p_event_id uuid, p_group_number smallint) TO authenticated;


--
-- Name: FUNCTION list_group_rooms(p_event_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.list_group_rooms(p_event_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.list_group_rooms(p_event_id uuid) TO authenticated;


--
-- Name: FUNCTION prepare_group_turn_card_options(p_event_id uuid, p_group_number smallint, p_expected_draw_index smallint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.prepare_group_turn_card_options(p_event_id uuid, p_group_number smallint, p_expected_draw_index smallint) FROM PUBLIC;
GRANT ALL ON FUNCTION public.prepare_group_turn_card_options(p_event_id uuid, p_group_number smallint, p_expected_draw_index smallint) TO authenticated;


--
-- Name: FUNCTION refresh_group_room_status(p_event_id uuid, p_group_number smallint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.refresh_group_room_status(p_event_id uuid, p_group_number smallint) FROM PUBLIC;


--
-- Name: FUNCTION return_group_to_event_menu(p_event_id uuid, p_group_number smallint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.return_group_to_event_menu(p_event_id uuid, p_group_number smallint) FROM PUBLIC;
GRANT ALL ON FUNCTION public.return_group_to_event_menu(p_event_id uuid, p_group_number smallint) TO authenticated;


--
-- Name: FUNCTION return_group_to_game_selection(p_event_id uuid, p_group_number smallint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.return_group_to_game_selection(p_event_id uuid, p_group_number smallint) FROM PUBLIC;
GRANT ALL ON FUNCTION public.return_group_to_game_selection(p_event_id uuid, p_group_number smallint) TO authenticated;


--
-- Name: FUNCTION select_group_game(p_event_id uuid, p_group_number smallint, p_game_key text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.select_group_game(p_event_id uuid, p_group_number smallint, p_game_key text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.select_group_game(p_event_id uuid, p_group_number smallint, p_game_key text) TO authenticated;


--
-- Name: FUNCTION send_group_chat_message(p_event_id uuid, p_group_number smallint, p_content text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.send_group_chat_message(p_event_id uuid, p_group_number smallint, p_content text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.send_group_chat_message(p_event_id uuid, p_group_number smallint, p_content text) TO authenticated;


--
-- Name: FUNCTION set_group_expected_attendance(p_event_id uuid, p_group_number smallint, p_expected_attendance smallint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.set_group_expected_attendance(p_event_id uuid, p_group_number smallint, p_expected_attendance smallint) FROM PUBLIC;
GRANT ALL ON FUNCTION public.set_group_expected_attendance(p_event_id uuid, p_group_number smallint, p_expected_attendance smallint) TO authenticated;


--
-- Name: FUNCTION set_my_group_ready(p_event_id uuid, p_group_number smallint, p_is_ready boolean); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.set_my_group_ready(p_event_id uuid, p_group_number smallint, p_is_ready boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION public.set_my_group_ready(p_event_id uuid, p_group_number smallint, p_is_ready boolean) TO authenticated;


--
-- Name: FUNCTION start_group_session(p_event_id uuid, p_group_number smallint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.start_group_session(p_event_id uuid, p_group_number smallint) FROM PUBLIC;
GRANT ALL ON FUNCTION public.start_group_session(p_event_id uuid, p_group_number smallint) TO authenticated;


--
-- Name: FUNCTION sync_group_room_status_from_participant(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.sync_group_room_status_from_participant() FROM PUBLIC;


--
-- Name: FUNCTION sync_group_room_status_from_session(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.sync_group_room_status_from_session() FROM PUBLIC;


--
-- Name: FUNCTION touch_group_session_activity(p_event_id uuid, p_group_number smallint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.touch_group_session_activity(p_event_id uuid, p_group_number smallint) FROM PUBLIC;
GRANT ALL ON FUNCTION public.touch_group_session_activity(p_event_id uuid, p_group_number smallint) TO authenticated;


--
-- Name: FUNCTION update_my_group_display_name(p_event_id uuid, p_group_number smallint, p_display_name text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.update_my_group_display_name(p_event_id uuid, p_group_number smallint, p_display_name text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.update_my_group_display_name(p_event_id uuid, p_group_number smallint, p_display_name text) TO authenticated;


--
-- Name: TABLE event_groups; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.event_groups TO anon;
GRANT SELECT ON TABLE public.event_groups TO authenticated;


--
-- Name: TABLE events; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.events TO anon;
GRANT SELECT ON TABLE public.events TO authenticated;


--
-- Name: TABLE group_balance_votes; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.group_balance_votes TO authenticated;


--
-- Name: TABLE group_chat_messages; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.group_chat_messages TO authenticated;


--
-- Name: TABLE group_room_status; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.group_room_status TO authenticated;


--
-- Name: TABLE group_turn_card_options; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.group_turn_card_options TO authenticated;


--
-- Name: TABLE group_turn_windows; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.group_turn_windows TO authenticated;


--
-- PostgreSQL database dump complete
--



-- The packaged application defaults to this neutral event. Operators may add their own events separately.
insert into public.events (public_code, title)
values ('say-on', 'Say-On 사연')
on conflict (public_code) do update set title = excluded.title;
