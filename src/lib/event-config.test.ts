import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

const loadEvent = async (code: string | undefined) => {
  vi.resetModules();
  vi.stubEnv("VITE_EVENT_CODE", code);
  return {
    config: await import("./event-config"),
    store: await import("./rehearsal-store"),
  };
};

describe("organization event selection", () => {
  it.each([undefined, ""])("defaults an unset code (%s) to say-on", async (code) => {
    const { config, store } = await loadEvent(code);
    expect(config.eventCode).toBe("say-on");
    expect(store.initialEvent().code).toBe("say-on");
  });

  it.each(["team-night", "campus-circle"])("supports explicitly configured event %s", async (code) => {
    const { config, store } = await loadEvent(code);
    expect(config.eventCode).toBe(code);
    expect(store.initialEvent().code).toBe(code);
  });

  it.each(["abc", "A-team", "team night", "a".repeat(33), "팀모임"])("rejects invalid event code %s", async (code) => {
    await expect(loadEvent(code)).rejects.toThrow();
  });

  it("keeps stored event state separate and rejects misplaced state", async () => {
    const first = await loadEvent("team-one");
    const second = await loadEvent("team-two");
    const saved = new Map([
      [first.config.rehearsalEventStorageKey, JSON.stringify({ ...first.store.initialEvent(), revision: 8 })],
    ]);
    vi.stubGlobal("window", { localStorage: { getItem: (key: string) => saved.get(key) ?? null } });

    expect(first.store.readRehearsalEvent().revision).toBe(8);
    expect(second.store.readRehearsalEvent()).toEqual(second.store.initialEvent());
    saved.set(second.config.rehearsalEventStorageKey, saved.get(first.config.rehearsalEventStorageKey)!);
    expect(second.store.readRehearsalEvent()).toEqual(second.store.initialEvent());
  });

  it("accepts only its configured event on a real BroadcastChannel", async () => {
    const first = await loadEvent("team-one");
    const second = await loadEvent("team-two");
    expect(first.config.rehearsalEventChannelName).not.toBe(second.config.rehearsalEventChannelName);
    const received: unknown[] = [];
    let finish: () => void = () => {};
    const delivered = new Promise<void>((resolve) => { finish = resolve; });
    const receiver = first.store.createEventChannel((event) => {
      received.push(event);
      finish();
    });
    const sender = new BroadcastChannel(first.config.rehearsalEventChannelName);
    try {
      sender.postMessage(second.store.initialEvent());
      sender.postMessage(first.store.initialEvent());
      await delivered;
      expect(received).toEqual([first.store.initialEvent()]);
    } finally {
      sender.close();
      receiver.close();
    }
  });
});
