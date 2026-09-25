-- Say-On public schema: publish the tables the client subscribes to over Supabase Realtime.
-- The bootstrap is a schema dump without publication membership, so a fresh project applied
-- cleanly but delivered no live roster, draw, chat, turn or vote changes to other clients.
-- Idempotent: tables already in supabase_realtime are left alone.
do $$
declare
  published_table text;
begin
  foreach published_table in array array[
    'group_room_status', 'group_draws', 'group_chat_messages', 'group_turn_windows', 'group_balance_votes'
  ] loop
    if not exists (
      select 1
      from pg_publication_rel publication_relation
      join pg_publication publication on publication.oid = publication_relation.prpubid
      where publication.pubname = 'supabase_realtime'
        and publication_relation.prrelid = format('public.%I', published_table)::regclass
    ) then
      execute format('alter publication supabase_realtime add table public.%I', published_table);
    end if;
  end loop;
end;
$$;
