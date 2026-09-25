import { z } from "zod";

export const eventCode = z.string().regex(/^[a-z0-9-]{4,32}$/).parse(
  import.meta.env["VITE_EVENT_CODE"] || "say-on",
);

export const rehearsalEventStorageKey = `say-on/${eventCode}/rehearsal-event/v1`;
export const rehearsalEventChannelName = `say-on/${eventCode}/rehearsal-event`;
