-- Say-On public schema: let the 60-question Balance catalog (balance-ko-2026-10) store its draws.
-- The catalog draws question indexes 0-59, but group_draws and group_turn_card_options still
-- capped them at 0-29, so most turns in that catalog failed when their options or draw were
-- inserted. Per-catalog limits stay in the RPC functions; the table checks bound the largest one.
alter table public.group_draws
  drop constraint if exists group_draws_question_index_check;
alter table public.group_draws
  add constraint group_draws_question_index_check check (question_index between 0 and 59);

alter table public.group_turn_card_options
  drop constraint if exists group_turn_card_options_question_index_check;
alter table public.group_turn_card_options
  add constraint group_turn_card_options_question_index_check check (question_index between 0 and 59);
