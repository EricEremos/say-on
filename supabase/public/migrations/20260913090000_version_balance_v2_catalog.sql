-- Add the 60-question Say-On catalog while keeping all earlier room selections valid.
-- No existing session, draw, vote, or participant is rewritten.
begin;

alter table public.group_sessions
  drop constraint if exists group_sessions_selected_game_key_check;
alter table public.group_sessions
  add constraint group_sessions_selected_game_key_check
  check (selected_game_key in ('icebreaker', 'balance', 'balance-ko-2026-09', 'balance-ko-2026-10'));

create or replace function public.select_group_game(
  p_event_id uuid,
  p_group_number smallint,
  p_game_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  current_session public.group_sessions;
begin
  perform public.assert_group_member(p_event_id, p_group_number);
  perform public.touch_group_session_activity(p_event_id, p_group_number);

  if p_game_key is null or p_game_key not in ('icebreaker', 'balance-ko-2026-09', 'balance-ko-2026-10') then
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

create or replace function public.prepare_group_turn_card_options(
  p_event_id uuid,
  p_group_number smallint,
  p_expected_draw_index smallint
)
returns table(card_index smallint, question_index smallint)
language plpgsql
security definer
set search_path = public
as $$
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

  question_count := case current_session.selected_game_key when 'balance' then 30 when 'balance-ko-2026-09' then 20 when 'balance-ko-2026-10' then 60 else 17 end;

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

create or replace function public.get_group_room_activity(p_event_id uuid, p_group_number smallint)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
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

  if current_session.selected_game_key in ('balance', 'balance-ko-2026-09', 'balance-ko-2026-10') and current_session.phase = 'live' then
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

create or replace function public.cast_group_balance_vote(
  p_event_id uuid,
  p_group_number smallint,
  p_choice text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
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

  if not found or current_session.phase <> 'live' or current_session.selected_game_key is null or current_session.selected_game_key not in ('balance', 'balance-ko-2026-09', 'balance-ko-2026-10') then
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

commit;
