import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const usage = `
Usage: pnpm capacity:rehearsal --event-code <isolated-event-code> [--guests 160] [--observe-seconds 30]

Reads VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY from .env.local or the shell.
It opens one narrow Realtime connection per guest: 160 by default.
Run only against the isolated rehearsal event, then check the Supabase dashboard peak.
`;

const readOption = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
};

const positiveInteger = (value, name) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer.`);
  return parsed;
};

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const localEnv = (() => {
  try {
    return Object.fromEntries(
      readFileSync(new URL("../.env.local", import.meta.url), "utf8")
        .split(/\r?\n/)
        .flatMap((line) => {
          const separator = line.indexOf("=");
          return separator > 0 && !line.startsWith("#")
            ? [[line.slice(0, separator).trim(), line.slice(separator + 1).trim()]]
            : [];
        })
    );
  } catch {
    return {};
  }
})();

if (process.argv.includes("--help")) {
  console.log(usage.trim());
  process.exit(0);
}

const guests = positiveInteger(readOption("--guests", "160"), "--guests");
const observeSeconds = positiveInteger(readOption("--observe-seconds", "30"), "--observe-seconds");
const eventCode = readOption("--event-code", undefined);
const url = process.env.VITE_SUPABASE_URL ?? localEnv.VITE_SUPABASE_URL;
const anonKey = process.env.VITE_SUPABASE_ANON_KEY ?? localEnv.VITE_SUPABASE_ANON_KEY;

if (typeof eventCode !== "string" || eventCode.trim() === "" || eventCode.startsWith("--")) {
  console.error("Missing --event-code. Choose the isolated rehearsal event to observe.");
  process.exit(1);
}

if (url === undefined || anonKey === undefined) {
  console.error("Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. Put the public values in .env.local.");
  process.exit(1);
}

const seedClient = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } });
const eventResult = await seedClient.from("events").select("id").eq("public_code", eventCode).single();
if (eventResult.error !== null || eventResult.data === null) {
  console.error(`Could not load the rehearsal event '${eventCode}'. ${eventResult.error?.message ?? ""}`.trim());
  process.exit(1);
}

const roles = Array.from({ length: guests }, (_, index) => ({ name: `guest-${index + 1}` }));
const timeoutMilliseconds = 45_000;
const clients = [];
const failures = [];

const subscribe = async (role) => {
  const client = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } });
  clients.push(client);
  const channel = client
    .channel(`say-on-capacity-${role.name}-${Date.now()}`)
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "group_draws", filter: `event_id=eq.${eventResult.data.id}` }, () => undefined);

  return new Promise((resolve) => {
    let joined = false;
    const timeout = setTimeout(() => {
      if (!joined) failures.push({ role: role.name, status: "TIMED_OUT", detail: "No subscription acknowledgement within 45 seconds." });
      resolve();
    }, timeoutMilliseconds);
    channel.subscribe((status, error) => {
      if (status === "SUBSCRIBED") {
        joined = true;
        clearTimeout(timeout);
        resolve();
        return;
      }
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        failures.push({ role: role.name, status, detail: error instanceof Error ? error.message : String(error ?? "No error detail.") });
        if (!joined) {
          clearTimeout(timeout);
          resolve();
        }
      }
    });
  });
};

try {
  await Promise.all(roles.map(subscribe));
  await wait(observeSeconds * 1_000);
  const report = { expectedConnections: roles.length, guests, observeSeconds, failures };
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = failures.length === 0 ? 0 : 1;
} finally {
  await Promise.all(clients.map((client) => client.removeAllChannels().catch(() => undefined)));
  await seedClient.removeAllChannels().catch(() => undefined);
}
