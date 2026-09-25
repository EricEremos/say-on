import { describe, expect, it } from "vitest";
import publicBootstrapMigration from "../../supabase/public/migrations/20260908080000_public_bootstrap.sql?raw";
import balanceLaunchMigration from "../../supabase/public/migrations/20260913090000_version_balance_v2_catalog.sql?raw";
import { canSetExpectedAttendance, canStartGroup, cardThemes, isMyCardTurn, normalizeHandoffCode, roomReadinessMessage } from "./group-room";

const functionSource = (name: string, source = publicBootstrapMigration) =>
  source.match(new RegExp(`create (?:or replace )?function public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`, "i"))?.[0] ?? "";

describe("waiting-room policy", () => {
  it("keeps expected attendance within the joined and supported room sizes", () => {
    expect(canSetExpectedAttendance(7, 4)).toBe(true);
    expect(canSetExpectedAttendance(3, 4)).toBe(false);
    expect(canSetExpectedAttendance(1, 1)).toBe(false);
    expect(canSetExpectedAttendance(21, 4)).toBe(false);
    expect(canSetExpectedAttendance(4.5, 4)).toBe(false);
  });

  it("allows a host to start only after attendance, readiness, and game selection match", () => {
    const waitingRoom = { phase: "waiting" as const, expectedAttendance: 6, joinedCount: 6, readyCount: 6, selectedGame: "icebreaker" as const };

    expect(canStartGroup(waitingRoom)).toBe(true);
    expect(canStartGroup({ ...waitingRoom, joinedCount: 5 })).toBe(false);
    expect(canStartGroup({ ...waitingRoom, readyCount: 5 })).toBe(false);
    expect(canStartGroup({ ...waitingRoom, phase: "live" })).toBe(false);
    expect(canStartGroup({ ...waitingRoom, selectedGame: null })).toBe(false);
  });

  it("communicates the next readiness step concisely", () => {
    expect(roomReadinessMessage({ expectedAttendance: 6, joinedCount: 4, readyCount: 4 })).toBe("2명 더 기다려요.");
    expect(roomReadinessMessage({ expectedAttendance: 6, joinedCount: 6, readyCount: 4 })).toBe("2명 준비 중이에요.");
    expect(roomReadinessMessage({ expectedAttendance: 6, joinedCount: 6, readyCount: 6 })).toBe("모두 준비됐어요.");
  });
});

describe("public Say-On bootstrap", () => {
  it("seeds only the neutral Say-On event and named-room contract", () => {
    expect(publicBootstrapMigration).toContain("values ('say-on', 'Say-On 사연')");
    expect(publicBootstrapMigration).toMatch(/create function public\.create_group_room\(p_event_id uuid, p_room_name text, p_expected_attendance smallint/i);
    expect(publicBootstrapMigration).toMatch(/create function public\.join_group_room_by_code\(p_event_id uuid, p_invite_code text, p_display_name text\)/i);
    expect(publicBootstrapMigration).toMatch(/create function public\.join_group_room_by_number\(p_event_id uuid, p_group_number smallint, p_display_name text\)/i);
    expect(publicBootstrapMigration).toContain("display name must be between 2 and 12 characters");
  });

  it("keeps sensitive room actions member-scoped, serialized, and non-public", () => {
    const memberActions = ["select_group_game", "start_group_session", "continue_group_session", "cast_group_balance_vote", "return_group_to_game_selection"];

    for (const name of memberActions) {
      expect(functionSource(name), name).toContain("perform public.assert_group_member(p_event_id, p_group_number)");
    }

    expect(functionSource("select_group_game")).toContain("only the current host may select the game");
    expect(functionSource("start_group_session")).toContain("current_session.selected_game_key is null");
    expect(functionSource("choose_group_card")).toContain("for update");
    expect(functionSource("choose_group_card")).toContain("from public.prepare_group_turn_card_options(");
    expect(functionSource("prepare_group_turn_card_options")).toContain("perform public.assert_group_member(p_event_id, p_group_number)");
    expect(publicBootstrapMigration).toMatch(/revoke all on function public\.choose_group_card\(p_event_id uuid, p_group_number smallint, p_expected_draw_index smallint, p_card_index smallint\) from public;/i);
    expect(publicBootstrapMigration).toMatch(/grant all on function public\.choose_group_card\(p_event_id uuid, p_group_number smallint, p_expected_draw_index smallint, p_card_index smallint\) to authenticated;/i);
  });

  it("resets a finished room safely and releases only a finished guest", () => {
    const finish = functionSource("finish_group_session");
    const reset = functionSource("return_group_to_game_selection");
    const leave = functionSource("leave_finished_group_session");

    expect(finish).toContain("perform public.return_group_to_game_selection(p_event_id, p_group_number)");
    expect(reset).toMatch(/delete from public\.group_draws\s+where event_id = p_event_id and group_number = p_group_number;/);
    expect(reset).toContain("set is_ready = false");
    expect(reset).toContain("phase = 'waiting'");
    expect(reset).toContain("current_round = 1");
    expect(leave).toContain("perform public.assert_group_member(p_event_id, p_group_number)");
    expect(leave).toContain("current_session.phase <> 'waiting'");
    expect(leave).toMatch(/delete from public\.group_participants[\s\S]*?and user_id = auth\.uid\(\);/);
  });
});

describe("versioned Balance game contract", () => {
  it("adds the 60-question Korean Balance catalog without rewriting existing rooms", () => {
    const selectGame = functionSource("select_group_game", balanceLaunchMigration);
    const prepareOptions = functionSource("prepare_group_turn_card_options", balanceLaunchMigration);

    expect(balanceLaunchMigration).toContain("check (selected_game_key in ('icebreaker', 'balance', 'balance-ko-2026-09', 'balance-ko-2026-10'))");
    expect(selectGame).toContain("p_game_key not in ('icebreaker', 'balance-ko-2026-09', 'balance-ko-2026-10')");
    expect(prepareOptions).toContain("when 'balance-ko-2026-10' then 60");
    expect(prepareOptions).toContain("from unused_questions as unused_question");
    expect(prepareOptions).toContain("order by unused_question.sort_order, unused_question.question_index");
    expect(prepareOptions).toContain("three unused questions are required for a turn");
  });
});

describe("game presentation policy", () => {
  it("keeps only the visual material paired in a stable order", () => {
    expect(cardThemes).toEqual([{ materialKey: "wave" }, { materialKey: "sand" }, { materialKey: "ember" }]);
  });

  it("cycles every card turn through the confirmed joining order across rounds", () => {
    expect(isMyCardTurn(1, 0, 3, 0)).toBe(true);
    expect(isMyCardTurn(1, 1, 3, 0)).toBe(false);
    expect(isMyCardTurn(1, 3, 3, 0)).toBe(true);
    expect(isMyCardTurn(2, 0, 3, 2)).toBe(true);
    expect(isMyCardTurn(1, 5, 3, 0)).toBe(false);
  });

  it("normalizes a short in-person handoff code without preserving separators", () => {
    expect(normalizeHandoffCode(" ab-12 cd ")).toBe("AB12CD");
    expect(normalizeHandoffCode(" be-ef 12:a4 ")).toBe("BEEF12A4");
    expect(normalizeHandoffCode("방장코드! 12")).toBe("12");
  });
});
