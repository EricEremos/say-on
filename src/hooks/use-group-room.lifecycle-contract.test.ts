import { describe, expect, it } from "vitest";
import publicBootstrapMigration from "../../supabase/public/migrations/20260908080000_public_bootstrap.sql?raw";

describe("public room lifecycle database contract", () => {
  it("resets a completed room for the next shared activity and exposes a member-safe status", () => {
    expect(publicBootstrapMigration).toContain("CREATE FUNCTION public.get_group_room_release_status");
    expect(publicBootstrapMigration).toContain("CREATE FUNCTION public.return_group_to_game_selection");
    expect(publicBootstrapMigration).toMatch(/delete from public\.group_draws\s+where event_id = p_event_id\s+and group_number = p_group_number;/i);
    expect(publicBootstrapMigration).toMatch(/update public\.group_participants\s+set is_ready = false,/i);
    expect(publicBootstrapMigration).toMatch(/set phase = 'waiting',\s+current_round = 1,\s+selected_game_key = null,/i);
    expect(publicBootstrapMigration).toContain("GRANT ALL ON FUNCTION public.get_group_room_release_status(p_event_id uuid, p_group_number smallint) TO authenticated;");
  });
});
