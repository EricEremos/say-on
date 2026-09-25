import { useEffect, useState } from "react";
import {
  broadcastEvent,
  createEventChannel,
  readRehearsalEvent,
  writeRehearsalEvent
} from "../lib/rehearsal-store";
import type { EventState } from "../lib/rehearsal-store";
import { rehearsalEventStorageKey, rehearsalEventChannelName } from "../lib/event-config";

export const useRehearsalEvent = (): readonly [EventState, (next: EventState) => void] => {
  const [event, setEvent] = useState<EventState>(readRehearsalEvent);

  useEffect(() => {
    const channel = createEventChannel(setEvent);
    const receiveStorage = (storageEvent: StorageEvent): void => {
      if (storageEvent.key === rehearsalEventStorageKey) setEvent(readRehearsalEvent());
    };
    window.addEventListener("storage", receiveStorage);
    return () => {
      window.removeEventListener("storage", receiveStorage);
      channel.close();
    };
  }, []);

  const publish = (next: EventState): void => {
    writeRehearsalEvent(next);
    setEvent(next);
    const channel = new BroadcastChannel(rehearsalEventChannelName);
    broadcastEvent(channel, next);
    channel.close();
  };

  return [event, publish];
};
