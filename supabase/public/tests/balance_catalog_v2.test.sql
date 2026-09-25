-- Run only via scripts/test-balance-catalog-db.py in its disposable database, after
-- balance_catalog_version.test.sql, which leaves its fixture rooms and the launch catalog in place.
\ir ../migrations/20260913090000_version_balance_v2_catalog.sql
\ir ../migrations/20260925100000_balance_v2_question_range.sql

begin;
-- Pin the first turn's options so the last question of the 60-question catalog must be drawable.
insert into public.group_turn_card_options (event_id, group_number, round_number, draw_index, card_index, question_index)
values
  ('10000000-0000-0000-0000-000000000001', 1, 1, 0, 0, 0),
  ('10000000-0000-0000-0000-000000000001', 1, 1, 0, 1, 30),
  ('10000000-0000-0000-0000-000000000001', 1, 1, 0, 2, 59);

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', true);
do $$
declare result jsonb;
begin
  result := public.select_group_game('10000000-0000-0000-0000-000000000001', 1::smallint, 'balance-ko-2026-09');
  if result->>'selectedGame' <> 'balance-ko-2026-09' then raise exception 'launch catalog no longer selectable'; end if;
  result := public.select_group_game('10000000-0000-0000-0000-000000000001', 1::smallint, 'balance-ko-2026-10');
  if result->>'selectedGame' <> 'balance-ko-2026-10' then raise exception 'current catalog missing from room payload'; end if;
  perform public.start_group_session('10000000-0000-0000-0000-000000000001', 1::smallint);
end $$;

do $$
declare event_id uuid := '10000000-0000-0000-0000-000000000001';
  turn_number integer; options jsonb; picked public.group_draws; activity jsonb;
begin
  for turn_number in 0..4 loop
    perform set_config('request.jwt.claim.sub', case when turn_number % 2 = 0
      then '00000000-0000-0000-0000-000000000001' else '00000000-0000-0000-0000-000000000002' end, true);
    select jsonb_agg(o order by card_index) into options
    from public.prepare_group_turn_card_options(event_id, 1::smallint, turn_number::smallint) o;
    if jsonb_array_length(options) <> 3
      or exists(select 1 from jsonb_array_elements(options) o where (o->>'question_index')::int not between 0 and 59)
      or (select count(distinct o->>'question_index') from jsonb_array_elements(options) o) <> 3
    then raise exception 'invalid current catalog options'; end if;
    picked := public.choose_group_card(event_id, 1::smallint, turn_number::smallint,
      (case when turn_number = 0 then 2 else 0 end)::smallint);
    if turn_number = 0 and picked.question_index <> 59 then raise exception 'last question of the current catalog was not drawable'; end if;
    activity := public.cast_group_balance_vote(event_id, 1::smallint, 'a');
    if activity->'vote'->>'myChoice' <> 'a' then raise exception 'current catalog vote unavailable'; end if;
  end loop;
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', true);
  activity := public.cast_group_balance_vote(event_id, 2::smallint, 'a');
  if activity->'vote'->>'myChoice' <> 'a' then raise exception 'legacy Balance room regressed'; end if;
end $$;
reset role;
do $$
begin
  if (select count(distinct question_index) from public.group_draws where group_number = 1) <> 5 then
    raise exception 'question repeated within a round';
  end if;
end $$;
rollback;
select 'PASS: current 60-question catalog selectable and fully drawable, votes, launch and legacy rooms intact' as result;
