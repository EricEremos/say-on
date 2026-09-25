from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from time import perf_counter

EVENT = "10000000-0000-0000-0000-000000000001"
USERS = [f"00000000-0000-0000-0000-{index:012d}" for index in range(1, 4)]


def verify_concurrency(execute):
    results = []

    def authenticated(user, sql):
        return execute(f"begin; set local role authenticated; select set_config('request.jwt.claim.sub', '{user}', true); {sql}; commit;")

    def race(actions):
        barrier = Barrier(len(actions))

        def run(action):
            barrier.wait(timeout=10)
            start = perf_counter()
            try:
                action()
                return {"ok": True, "milliseconds": round((perf_counter() - start) * 1000, 2)}
            except RuntimeError as error:
                return {"ok": False, "error": str(error).strip(), "milliseconds": round((perf_counter() - start) * 1000, 2)}

        with ThreadPoolExecutor(max_workers=len(actions)) as pool:
            return list(pool.map(run, actions))

    for run_number in range(1, 4):
        group = run_number + 2
        scope = f"'{EVENT}', {group}::smallint"
        execute(f"""
          insert into public.event_groups (event_id, group_number, leader_name, room_name, capacity, is_roster_room)
          values ('{EVENT}', {group}, '진행자{group}', '동시성 검증 {group}', 3, true);
          insert into public.group_sessions (event_id, group_number, host_user_id, expected_attendance, phase, selected_game_key)
          values ('{EVENT}', {group}, '{USERS[0]}', 3, 'waiting', null);
          insert into public.group_participants (event_id, group_number, user_id, display_name, is_ready, joined_at)
          select '{EVENT}', {group}, id, '참여자' || row_number() over (order by id), true,
            now() + (row_number() over (order by id)) * interval '1 second' from auth.users;
        """)
        authenticated(USERS[0], f"select public.select_group_game({scope}, 'balance-ko-2026-09'); select public.start_group_session({scope}); select * from public.prepare_group_turn_card_options({scope}, 0::smallint)")
        choices = race([
            lambda card=card: authenticated(USERS[0], f"select public.choose_group_card({scope}, 0::smallint, {card}::smallint)")
            for card in range(3)
        ])
        execute(f"""do $$ begin
          if (select count(*) from public.group_draws where event_id='{EVENT}' and group_number={group}) <> 1
          then raise exception 'competing selections produced a non-singleton draw'; end if;
          if not exists (select 1 from public.group_draws d join public.group_turn_card_options o
            on o.event_id=d.event_id and o.group_number=d.group_number and o.round_number=d.round_number
            and o.draw_index=d.draw_index and o.card_index=d.chosen_card and o.question_index=d.question_index
            where d.event_id='{EVENT}' and d.group_number={group})
          then raise exception 'race winner was not a prepared card'; end if;
        end $$;""")
        assert any(result['ok'] for result in choices), choices
        unexpected_failures = [
            result for result in choices
            if not result['ok']
            and result['error'].splitlines()[0] != 'ERROR:  a different card state is already current'
        ]
        assert not unexpected_failures, unexpected_failures
        votes = race([
            lambda user=user: authenticated(user, f"select public.cast_group_balance_vote({scope}, 'a')")
            for user in USERS
        ])
        assert all(result['ok'] for result in votes), votes
        replacements = race([
            lambda user=user: authenticated(user, f"select public.cast_group_balance_vote({scope}, 'b')")
            for user in USERS
        ])
        assert all(result['ok'] for result in replacements), replacements
        execute(f"""do $$ begin
          if (select count(*) from public.group_balance_votes where event_id='{EVENT}' and group_number={group}) <> 3
            or (select count(*) from public.group_balance_votes where event_id='{EVENT}' and group_number={group} and choice='b') <> 3
          then raise exception 'concurrent votes were lost or double-counted'; end if;
        end $$;""")
        results.append({"run": run_number, "connections": 3, "choices": choices, "votes": votes, "replacements": replacements, "singlePreparedDraw": True, "threeFinalVotes": True})
    return results
