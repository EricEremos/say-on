import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type EffectSlot = Readonly<{ deps: readonly unknown[] | undefined; cleanup: (() => void) | undefined }>;

const hookRuntime = vi.hoisted(() => {
  let cursor = 0;
  const states: unknown[] = [];
  const refs: Array<{ current: unknown }> = [];
  const effects = new Map<number, EffectSlot>();
  const callbacks = new Map<number, Readonly<{ deps: readonly unknown[] | undefined; callback: (...args: never[]) => unknown }>>();
  let pending: Array<() => void> = [];
  const changed = (left: readonly unknown[] | undefined, right: readonly unknown[] | undefined): boolean => left === undefined || right === undefined || left.length !== right.length || left.some((item, index) => !Object.is(item, right[index]));

  return {
    begin: (): void => { cursor = 0; },
    reset: (): void => {
      for (const effect of effects.values()) effect.cleanup?.();
      states.length = 0;
      refs.length = 0;
      effects.clear();
      callbacks.clear();
      pending = [];
      cursor = 0;
    },
    flush: async (): Promise<void> => {
      const next = pending;
      pending = [];
      for (const effect of next) effect();
      await Promise.resolve();
      await Promise.resolve();
    },
    useState: <Value,>(initial: Value | (() => Value)): readonly [Value, (value: Value | ((current: Value) => Value)) => void] => {
      const index = cursor++;
      if (!(index in states)) states[index] = typeof initial === "function" ? (initial as () => Value)() : initial;
      const setState = (value: Value | ((current: Value) => Value)): void => {
        const current = states[index] as Value;
        states[index] = typeof value === "function" ? (value as (current: Value) => Value)(current) : value;
      };
      return [states[index] as Value, setState];
    },
    useEffect: (effect: () => void | (() => void), deps: readonly unknown[] | undefined): void => {
      const index = cursor++;
      const previous = effects.get(index);
      if (previous === undefined || changed(previous.deps, deps)) {
        previous?.cleanup?.();
        pending.push(() => {
          const cleanup = effect();
          effects.set(index, { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined });
        });
      }
    },
    useCallback: <Callback extends (...args: never[]) => unknown>(callback: Callback, deps: readonly unknown[] | undefined): Callback => {
      const index = cursor++;
      const previous = callbacks.get(index);
      if (previous !== undefined && !changed(previous.deps, deps)) return previous.callback as Callback;
      callbacks.set(index, { deps, callback });
      return callback;
    },
    useRef: <Value,>(initial: Value): { current: Value } => {
      const index = cursor++;
      if (!(index in refs)) refs[index] = { current: initial };
      return refs[index] as { current: Value };
    }
  };
});

const remoteRoom = vi.hoisted(() => {
  let rows: readonly unknown[] = [];
  let prepareResponses: Array<Readonly<{ data: unknown; error: unknown }>> = [];
  const query = {
    select: () => query,
    eq: () => query,
    order: () => query,
    then: (resolve: (value: Readonly<{ data: readonly unknown[]; error: null }>) => unknown) => Promise.resolve({ data: rows, error: null }).then(resolve)
  };
  const channel = {
    on: () => channel,
    subscribe: (callback: (status: string) => void) => { callback("SUBSCRIBED"); return channel; }
  };
  return {
    setRows: (next: readonly unknown[]): void => { rows = next; },
    setPrepareResponses: (next: Array<Readonly<{ data: unknown; error: unknown }>>): void => { prepareResponses = [...next]; },
    client: {
      from: () => query,
      channel: () => channel,
      removeChannel: async () => undefined,
      rpc: async (name: string) => name === "prepare_group_turn_card_options"
        ? prepareResponses.shift() ?? { data: null, error: null }
        : { data: null, error: null }
    }
  };
});

vi.mock("react", () => ({
  useState: hookRuntime.useState,
  useEffect: hookRuntime.useEffect,
  useCallback: hookRuntime.useCallback,
  useRef: hookRuntime.useRef
}));

vi.mock("../lib/supabase", () => ({ supabase: remoteRoom.client }));

import { useGroupDraw } from "./use-group-draw";

class TestBroadcastChannel {
  addEventListener(): void {}
  close(): void {}
  postMessage(): void {}
}

const draw = (drawIndex: number, cardIndex: number): Readonly<Record<string, unknown>> => ({
  group_number: 7,
  round_number: 1,
  draw_index: drawIndex,
  chosen_card: cardIndex,
  question_index: drawIndex + cardIndex,
  chosen_at: `2026-08-25T12:00:0${drawIndex}.000Z`
});

const renderRoomDraws = async (phase: "waiting" | "live", revision: number) => {
  hookRuntime.begin();
  useGroupDraw("event-7", 7, 1, true, revision, phase);
  await hookRuntime.flush();
  hookRuntime.begin();
  const transport = useGroupDraw("event-7", 7, 1, true, revision, phase);
  await hookRuntime.flush();
  return transport;
};

describe("remote group-draw restart lifecycle", () => {
  beforeEach(() => {
    vi.stubGlobal("window", {
      localStorage: { getItem: () => null, setItem: () => undefined },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => true
    });
    vi.stubGlobal("BroadcastChannel", TestBroadcastChannel);
    hookRuntime.reset();
  });

  afterEach(() => {
    hookRuntime.reset();
    vi.unstubAllGlobals();
  });

  it("returns an empty public history after reset, then shows restarted card one", async () => {
    remoteRoom.setRows([draw(0, 1), draw(1, 2)]);
    expect((await renderRoomDraws("live", 8)).history.map((item) => item.drawIndex)).toEqual([0, 1]);

    remoteRoom.setRows([]);
    const reset = await renderRoomDraws("waiting", 9);
    expect(reset.history).toEqual([]);
    expect(reset.draws).toEqual([]);

    remoteRoom.setRows([draw(0, 2)]);
    const restarted = await renderRoomDraws("live", 10);
    expect(restarted.history).toHaveLength(1);
    expect(restarted.draws[0]).toMatchObject({ roundNumber: 1, drawIndex: 0, cardIndex: 2 });
  });

  it("lets the selector retry a transient prepared-card failure without reloading", async () => {
    remoteRoom.setRows([]);
    remoteRoom.setPrepareResponses([
      { data: null, error: { message: "temporary connection failure" } },
      { data: [{ card_index: 0, question_index: 18 }, { card_index: 1, question_index: 24 }, { card_index: 2, question_index: 29 }], error: null }
    ]);

    const failed = await renderRoomDraws("live", 11);
    expect(failed.problem).toContain("카드 세 장을 준비하지 못했습니다");
    failed.retryCardOptions();

    expect((await renderRoomDraws("live", 11)).cardOptions.map((option) => option.questionIndex)).toEqual([18, 24, 29]);
  });
});
