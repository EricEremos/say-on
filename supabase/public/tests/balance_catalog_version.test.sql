-- Run only via scripts/test-balance-catalog-db.py in its disposable database.
insert into auth.users (id) values
  ('00000000-0000-0000-0000-000000000001'),
  ('00000000-0000-0000-0000-000000000002'),
  ('00000000-0000-0000-0000-000000000003');
insert into public.events (id, public_code, title)
values ('10000000-0000-0000-0000-000000000001', 'catalog-test', 'Catalog test');
insert into public.event_groups (event_id, group_number, leader_name, room_name, capacity, is_roster_room)
values
  ('10000000-0000-0000-0000-000000000001', 1, '새 질문', '새 질문', 2, true),
  ('10000000-0000-0000-0000-000000000001', 2, '기존 질문', '기존 질문', 2, true);
insert into public.group_sessions (event_id, group_number, host_user_id, expected_attendance, phase, selected_game_key)
values
  ('10000000-0000-0000-0000-000000000001', 1, '00000000-0000-0000-0000-000000000001', 2, 'waiting', null),
  ('10000000-0000-0000-0000-000000000001', 2, '00000000-0000-0000-0000-000000000001', 2, 'live', 'balance');
insert into public.group_participants (event_id, group_number, user_id, display_name, is_ready, joined_at)
select '10000000-0000-0000-0000-000000000001', room, person.id, person.name, true, now() + person.delta
from generate_series(1, 2) room
cross join (values
  ('00000000-0000-0000-0000-000000000001'::uuid, '진행자', interval '0 seconds'),
  ('00000000-0000-0000-0000-000000000002'::uuid, '참여자', interval '1 second')
) person(id, name, delta);
insert into public.group_draws (event_id, group_number, round_number, draw_index, chosen_card, question_index)
values ('10000000-0000-0000-0000-000000000001', 2, 1, 0, 0, 29);
insert into public.group_balance_votes (event_id, group_number, round_number, draw_index, voter_id, choice)
values ('10000000-0000-0000-0000-000000000001', 2, 1, 0, '00000000-0000-0000-0000-000000000001', 'a');
create temporary table existing_before as
select row_to_json(s)::jsonb as session, (select jsonb_agg(d) from public.group_draws d where group_number=2) as draws,
  (select jsonb_agg(v) from public.group_balance_votes v where group_number=2) as votes
from public.group_sessions s where group_number=2;

\ir ../migrations/20260908090000_version_balance_launch_catalog.sql

begin;
do $$
begin
  if not exists (
    select 1 from existing_before b join public.group_sessions s on s.group_number=2
    where b.session = row_to_json(s)::jsonb
      and b.draws = (select jsonb_agg(d) from public.group_draws d where group_number=2)
      and b.votes = (select jsonb_agg(v) from public.group_balance_votes v where group_number=2)
  ) then raise exception 'migration changed existing room data'; end if;
  if has_function_privilege('anon', 'public.select_group_game(uuid,smallint,text)', 'execute')
    or not has_function_privilege('authenticated', 'public.select_group_game(uuid,smallint,text)', 'execute')
  then raise exception 'selection grants changed'; end if;
end $$;

insert into public.group_turn_card_options (event_id, group_number, round_number, draw_index, card_index, question_index)
values
  ('10000000-0000-0000-0000-000000000001', 1, 1, 0, 0, 0),
  ('10000000-0000-0000-0000-000000000001', 1, 1, 0, 1, 18),
  ('10000000-0000-0000-0000-000000000001', 1, 1, 0, 2, 19);

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000002', true);
do $$
begin
  begin
    perform public.select_group_game('10000000-0000-0000-0000-000000000001', 1::smallint, 'balance-ko-2026-09');
    raise exception 'non-host selected a game';
  exception when others then
    if sqlerrm <> 'only the current host may select the game' then raise; end if;
  end;
end $$;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', true);
do $$
declare result jsonb; bad_key text;
begin
  foreach bad_key in array array['balance', 'unknown', null] loop
    begin
      perform public.select_group_game('10000000-0000-0000-0000-000000000001', 1::smallint, bad_key);
      raise exception 'invalid catalog was selected';
    exception when others then
      if sqlerrm <> 'invalid game selection' then raise; end if;
    end;
  end loop;
  result := public.select_group_game('10000000-0000-0000-0000-000000000001', 1::smallint, 'balance-ko-2026-09');
  if result->>'selectedGame' <> 'balance-ko-2026-09' then raise exception 'catalog missing from room payload'; end if;
  perform public.start_group_session('10000000-0000-0000-0000-000000000001', 1::smallint);
end $$;

do $$
declare event_id uuid := '10000000-0000-0000-0000-000000000001';
  turn_number integer; chosen_index smallint; options jsonb; again jsonb; picked public.group_draws; activity jsonb;
begin
  for turn_number in 0..4 loop
    perform set_config('request.jwt.claim.sub', case when turn_number % 2=0
      then '00000000-0000-0000-0000-000000000002' else '00000000-0000-0000-0000-000000000001' end, true);
    begin
      perform public.prepare_group_turn_card_options(event_id, 1::smallint, turn_number::smallint);
      raise exception 'wrong participant prepared cards';
    exception when others then
      if sqlerrm <> 'it is another confirmed participant''s turn to choose' then raise; end if;
    end;
    perform set_config('request.jwt.claim.sub', case when turn_number % 2=0
      then '00000000-0000-0000-0000-000000000001' else '00000000-0000-0000-0000-000000000002' end, true);
    select jsonb_agg(o order by card_index) into options from public.prepare_group_turn_card_options(event_id, 1::smallint, turn_number::smallint) o;
    select jsonb_agg(o order by card_index) into again from public.prepare_group_turn_card_options(event_id, 1::smallint, turn_number::smallint) o;
    if options is distinct from again or jsonb_array_length(options) <> 3 then raise exception 'options are not stable'; end if;
    if exists(select 1 from jsonb_array_elements(options) o where (o->>'question_index')::int not between 0 and 19)
      or (select count(distinct o->>'question_index') from jsonb_array_elements(options) o) <> 3
    then raise exception 'invalid new catalog options'; end if;
    chosen_index := case when turn_number = 0 then 2 else 0 end;
    picked := public.choose_group_card(event_id, 1::smallint, turn_number::smallint, chosen_index);
    if picked.question_index <> (options->chosen_index->>'question_index')::smallint then raise exception 'draw ignored prepared option'; end if;
    activity := public.cast_group_balance_vote(event_id, 1::smallint, 'a');
    if activity->'vote'->>'myChoice' <> 'a' or (activity->'vote'->>'aCount')::int <> 1 then raise exception 'new catalog vote unavailable'; end if;
    activity := public.cast_group_balance_vote(event_id, 1::smallint, 'b');
    if (activity->'vote'->>'aCount')::int <> 0 or (activity->'vote'->>'bCount')::int <> 1 then raise exception 'vote replacement double-counted'; end if;
    if activity->'turn' <> 'null'::jsonb then raise exception 'Balance opened an Icebreaker timer'; end if;
  end loop;
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', true);
  activity := public.cast_group_balance_vote(event_id, 2::smallint, 'b');
  if activity->'vote'->>'myChoice' <> 'b' then raise exception 'legacy voting regressed'; end if;
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000003', true);
  begin
    perform public.cast_group_balance_vote(event_id, 1::smallint, 'a');
    raise exception 'non-member voted';
  exception when others then
    if sqlerrm <> 'you are not in this group' then raise; end if;
  end;
end $$;
reset role;
do $$
begin
  if (select count(distinct question_index) from public.group_draws where group_number=1) <> 5 then
    raise exception 'question repeated within a round';
  end if;
end $$;
rollback;
select 'PASS: existing-room preservation, host-only selection, catalog rejection, 5 shared draws, stable options, unique questions, voting and membership' as result;
