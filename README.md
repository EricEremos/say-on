# Say-On 사연

**A conversation starts when someone has something worth saying.**

Say-On 사연 is a shared Korean conversation game for friends, clubs, teams, classrooms, and first meetings. One person opens a room, everyone joins with a code, and the group draws one prompt to discuss together.

<p align="center">
  <img src="public/images/say-on/shared-table-cutout-v1.webp" width="520" alt="A small round table with two cups and a deck of conversation cards.">
</p>

## Two ways to begin

| Mode | At the table |
| --- | --- |
| **아이스브레이크** | Draw an open question and share a story. |
| **밸런스 게임** | Choose between two familiar options, then talk about the reason. |

The Balance Game includes 60 short, everyday pairs: **짜장면 or 짬뽕**, **물냉면 or 비빔냉면**, **집에서 쉬기 or 즉흥 약속**, and more. Every choice has its own transparent illustration, placed directly inside the answer card.

## Why “Say-On 사연”

**사연** is the reason or story behind what someone chooses. **Say on** is an invitation to keep speaking. The name describes the product’s role: give a group one approachable opening, then leave room for the people at the table.

The interface uses warm paper tones, quiet type, and transparent object illustrations. A label, button, or card appears only when it helps someone join, choose, or continue.

## Run it locally

Use Node.js 22.12+ and pnpm.

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm dev
```

Then open the local address printed by Vite. Without backend settings, the app uses browser-local rehearsal mode for interface review in one browser.

```sh
pnpm test
pnpm build
```

Validate the 60-question Balance catalog independently with:

```sh
pnpm validate:balance
```

## Shared rooms with Supabase

For real shared rooms, create an isolated Supabase project and add its public client settings to `.env.local`:

```dotenv
VITE_SUPABASE_URL=<project-url>
VITE_SUPABASE_ANON_KEY=<anonymous-client-key>
VITE_EVENT_CODE=say-on
```

Then prepare the project:

1. Run every file in [`supabase/public/migrations/`](supabase/public/migrations/) against it in filename order, with the SQL editor or `psql`. The first file creates the `say-on` event that `VITE_EVENT_CODE` selects, and `20260925090000_realtime_publication.sql` adds the five room tables to the Realtime publication.
2. Turn on **Anonymous Sign-Ins** under Authentication → Sign In / Providers. Every participant joins as an anonymous user.

Never put a service-role key in frontend environment variables.

Check the setup before using the project at an event:

```sh
python3 scripts/test-balance-catalog-db.py
node scripts/rehearsal-multi-client.cjs --base-url http://localhost:4173 --mode connected --runs 3
```

The first command applies the same migrations to a disposable local PostgreSQL (`initdb`, `pg_ctl` and `psql` required) and checks rooms, draws, votes, leaving, expiry, the full 60-question Balance catalog and the Realtime publication. The second drives a host, two guests and a separate room through `pnpm build && pnpm preview` in independent browser sessions; it needs the `playwright` package resolvable, for example through `NODE_PATH`.

The browser-local mode is deliberately scoped to the current browser. It is useful for visual and interaction review; it does not replace cross-device rooms.

## Project map

| Need | Location |
| --- | --- |
| App screens and room flow | [`src/App.tsx`](src/App.tsx) |
| Balance prompt catalog | [`content/balance.v2.json`](content/balance.v2.json) |
| Icebreaker questions and card art | [`src/lib/questions.ts`](src/lib/questions.ts) |
| Per-choice Balance artwork mapping | [`src/lib/balance-art.ts`](src/lib/balance-art.ts) |
| Neutral database bootstrap | [`supabase/public/`](supabase/public/) |
| Visual and content provenance | [`docs/design-review/asset-provenance.md`](docs/design-review/asset-provenance.md) |

## License and media

The source is available under the [MIT License](LICENSE). Generated visual assets and their release considerations are documented in the [asset provenance policy](docs/design-review/asset-provenance.md).
