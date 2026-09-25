import { describe, expect, it } from "vitest";
import {
  advanceWaitingRoomQACard,
  beginNextWaitingRoomQASession,
  createWaitingRoomQAState,
  confirmWaitingRoomQACard,
  continueWaitingRoomQANickname,
  getWaitingRoomQACounts,
  openWaitingRoomQAAtlas,
  resetWaitingRoomQAState,
  selectWaitingRoomQACard,
  setWaitingRoomQAReady,
  startWaitingRoomQA,
  transferWaitingRoomQAHost,
} from "./waiting-room-qa";

describe("local waiting-room QA state", () => {
  it("starts only when every expected participant has joined and prepared", () => {
    const initial = createWaitingRoomQAState();
    const threeReady = setWaitingRoomQAReady(
      setWaitingRoomQAReady(
        setWaitingRoomQAReady(initial, "host"),
        "member-1",
      ),
      "member-2",
    );

    expect(startWaitingRoomQA(threeReady).phase).toBe("waiting");

    const everyoneReady = setWaitingRoomQAReady(threeReady, "member-3");

    expect(getWaitingRoomQACounts(everyoneReady)).toEqual({ expectedAttendance: 4, joinedCount: 4, readyCount: 4 });
    expect(startWaitingRoomQA(everyoneReady).phase).toBe("live");
  });

  it("allows host handoff only to a joined participant", () => {
    const initial = createWaitingRoomQAState();

    expect(transferWaitingRoomQAHost(initial, "member-2").hostId).toBe("member-2");
    expect(transferWaitingRoomQAHost(initial, "missing").hostId).toBe("host");
  });

  it("resets all readiness and returns control to the original host", () => {
    const changed = transferWaitingRoomQAHost(
      setWaitingRoomQAReady(createWaitingRoomQAState(), "member-1"),
      "member-1",
    );

    expect(resetWaitingRoomQAState(changed)).toEqual(createWaitingRoomQAState());
  });

  it("keeps nickname and each confirmed card inside the local QA journey", () => {
    const initial = continueWaitingRoomQANickname(createWaitingRoomQAState(), "하늘");
    const ready = ["host", "member-1", "member-2", "member-3"].reduce(
      (state, personId) => setWaitingRoomQAReady(state, personId),
      initial,
    );
    const live = startWaitingRoomQA(ready);
    const selected = selectWaitingRoomQACard(live, 7, 2);
    const revealed = confirmWaitingRoomQACard(selected, 7);

    expect(revealed.nickname).toBe("하늘");
    expect(revealed.stage).toBe("revealed");
    expect(revealed.sessionDraws).toHaveLength(1);
    expect(revealed.unlockedQuestionIndexes).toHaveLength(1);
    expect(openWaitingRoomQAAtlas(revealed).stage).toBe("revealed");
  });

  it("keeps unlocked cards while a group starts another five-question round", () => {
    const ready = ["host", "member-1", "member-2", "member-3"].reduce(
      (state, personId) => setWaitingRoomQAReady(state, personId),
      continueWaitingRoomQANickname(createWaitingRoomQAState(), "하늘"),
    );
    let state = startWaitingRoomQA(ready);

    for (const cardIndex of [0, 1, 2, 0, 1]) {
      state = confirmWaitingRoomQACard(selectWaitingRoomQACard(state, 7, cardIndex), 7);
      state = advanceWaitingRoomQACard(state);
    }

    expect(state.stage).toBe("complete");
    expect(state.unlockedQuestionIndexes).toHaveLength(5);
    expect(openWaitingRoomQAAtlas(state).stage).toBe("atlas");

    const nextSession = beginNextWaitingRoomQASession(state);

    expect(nextSession.stage).toBe("choosing");
    expect(nextSession.sessionDraws).toHaveLength(0);
    expect(nextSession.unlockedQuestionIndexes).toHaveLength(5);
  });
});
