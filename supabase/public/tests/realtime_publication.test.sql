-- Run only via scripts/test-balance-catalog-db.py in its disposable database.
-- The client subscribes to postgres_changes on exactly these five tables (use-group-room.ts,
-- use-group-draw.ts, use-room-activity.ts); each must be in supabase_realtime, and re-applying
-- the migration must be a no-op.
\ir ../migrations/20260925090000_realtime_publication.sql
\ir ../migrations/20260925090000_realtime_publication.sql
do $$
declare
  missing text;
begin
  select string_agg(expected.table_name, ', ' order by expected.table_name) into missing
  from unnest(array[
    'group_room_status', 'group_draws', 'group_chat_messages', 'group_turn_windows', 'group_balance_votes'
  ]) expected(table_name)
  where not exists (
    select 1
    from pg_publication_tables published
    where published.pubname = 'supabase_realtime'
      and published.schemaname = 'public'
      and published.tablename = expected.table_name
  );
  if missing is not null then raise exception 'realtime publication is missing %', missing; end if;
  if (select count(*) from pg_publication_tables where pubname = 'supabase_realtime') <> 5 then
    raise exception 'realtime publication has tables the client does not subscribe to';
  end if;
end;
$$;
select 'realtime publication: five client tables published; re-apply is a no-op' as result;
