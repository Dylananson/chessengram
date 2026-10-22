# chess.com import: is it allowed for an app like this?

Scope: **CC-001** — import the user's own chess.com games and generate puzzle sets
from their mistakes. This note answers the question the owner raised — *"make sure
TOS is allowed for this kind of app"* — and turns the answer into binding
constraints for the importer.

Sources read (2026-10-19):

| Source | Used for |
|---|---|
| [Published-Data API docs](https://www.chess.com/news/view/published-data-api) (updated 2026-04-22) | what the API is, rate limits, client etiquette, brand/IP rules |
| [User Agreement](https://www.chess.com/legal/user-agreement) (last updated 2026-03-25) | the binding terms: licence scope, UGA, use restrictions, AI/automation clause |

Not legal advice. The clauses below are quoted so the decision is auditable; if
this ever stops being a personal app, ask a lawyer **and** chess.com (their docs
invite it, see §5).

## Verdict: allowed for this app, with conditions

ChessEngram is a **personal, non-commercial** trainer that would read **the owner's
own** public game records through the **documented** API and analyse them
locally. On the clauses that matter that is permitted — the API exists for
exactly this and its documentation invites non-commercial ecosystem use — but it
is permitted *narrowly*, and four of the constraints below are things we must
actually implement rather than assume.

The one clause that is genuinely uncomfortable is the **UGA derivative-use**
restriction; see §4. Everything else is compatible, including syncing.

## What the sources actually say

### 1. The API is chess.com's sanctioned interface, and it's public data

> "The PubAPI is a read-only REST API … re-packages **public data** from the
> website … 'Public Data' is information available to people who are not logged
> in, such as player data, **game data** …"

The User Agreement §2.B says: *"You agree not to access the Service by any means
other than through the interface that is provided by Chess.com for use in
accessing the Service."* The PubAPI **is** an interface they provide — so using
it (including the documented monthly-archive and PGN-download endpoints) is the
sanctioned path, not circumvention. Scraping the website, by contrast, is named
as a breach in §4.C.

### 2. Personal, non-commercial only

§2.B grants a licence to use the Content *"for your personal, noncommercial use
only"*, and the User Agreement's own summary says *"Each account is assigned to a
single User, and it is intended solely for personal, non-commercial use."*

**Consequence:** CC-001 must stay a personal tool. A hosted, multi-tenant or paid
version that imports chess.com games is a different question (§4.D requires
*prior written authorization* for automated access beyond this scope).

### 3. Your own game records are explicitly usable

§2.C (User Game Activity): *"This record of your UGA is **publicly available and
can be accessed, used, and monetized by anyone** for any number of purposes,
including, but not limited to, publishing images of your UGA in blogs, videos,
social media posts, **game collections**, or creating NFTs."*

**But** the UGA licence that follows (§2.D) is narrower, and that is where the
"derivative" friction is.

### 4. The derivative-use restriction — the real grey area

§2.D grants a limited licence to access/display/use the UGA which *"does not
include any right to: … (b) hide, delete, modify or otherwise make any
**derivative uses** of the UGA, or any portion thereof; (c) use any data mining,
robots or similar data gathering or extraction methods; (d) download (other than
page caching) any portion of the UGA; **except as expressly permitted by us**"*.
§4.C repeats it: no *"create derivative works from … any information … obtained
from or through the Services, except … **as otherwise expressly permitted in
this Agreement**"*.

Is a training puzzle built from your own game a "derivative use of the UGA"?

- **Odds it is fine for us:** the only act of *copying/transmission* is retrieving
  your own games through the documented API (expressly permitted — §2.D's
  carve-out, and §2.C's "anyone may use it for any number of purposes, including
  game collections"). What we then produce is **our own analysis** of a position
  (an engine evaluation plus our own labels, goals and packaging), stored
  privately for the account owner's personal training. Chess positions and move
  sequences are the classic example of uncopyrightable facts, and the app neither
  republishes the game record nor exposes chess.com's presentation of it.
- **What would make it a problem:** publishing the imported games or the derived
  sets, sharing them between users, building a public/aggregate game database, or
  selling the result — each of which is separately prohibited (§4.C, §4.D,
  §4.C's "no commercial" bar) and would also stop being "personal use".

**Therefore:** keep the imported games and the generated sets **private to the
user**, never publish or share them, and never build an aggregate dataset. Store
per-game provenance (game URL + date) so the user — and we — can always point
back to the source rather than treating chess.com content as ours.

### 5. AI/automation clause (§4.D) — read carefully, it constrains the *shape*

> "You may not use automated or artificial intelligence (AI) tools to access,
> scan, scrape, data mine, copy, or use the materials or content in the Services;
> for the purpose of developing training, or improving an AI model,
> machine-learning system, dataset, or competitive product or service. This
> includes … develop or enhance chess engines, training models, **educational
> tools**, or **game databases**; create or improve any product or service that
> competes with or substitutes for Chess.com; or reproduce, mirror, or
> systematically harvest substantial portions of our Services."

Our reading: this targets **automated access to chess.com to build models,
datasets, engines, or competing products** — not a user running *their own*
engine over *their own* games for personal study. Our access is a serial,
documented-API fetch; our analysis is local; we build no dataset and no model.

It nonetheless sets hard limits we must respect:

- no systematic harvesting / mirroring ("substantial portions of our Services");
- no public game database, no dataset creation, no model training on their content;
- nothing that "substitutes for" chess.com as a product.

And it names **"educational tools"** explicitly, which is uncomfortably close to
what ChessEngram is. For a personal app the risk is low; **if CC-001 ever ships to
other people, this clause is what makes prior written authorization the required
next step**, and the API docs say exactly who to ask:

> "If you're building something and aren't sure if it might cross a line, please
> write to us at [legal@chess.com]. We'd much rather talk proactively and
> constructively than send a legal notice."

### 6. Client etiquette (documented expectations, and cheap to honour)

- *"Your serial access rate is unlimited. If you always wait to receive the
  response to your previous request before making your next request, then you
  should never encounter rate limiting."* Parallel requests may be blocked
  (`429`).
- *"If you supply a **recognizable user-agent** that contains contact
  information, then if we must block your application we will attempt to contact
  you to correct the problem."*
- Endpoints refresh *"at most once every 12 hours"* / *"24 hours"* and support
  `ETag`/`Last-Modified` + `304` — so caching is both allowed and expected.
- Available game endpoints we may use: `/pub/player/{u}/games/archives`,
  `/pub/player/{u}/games/{YYYY}/{MM}`, `…/{YYYY}/{MM}/pgn`.

### 7. Brand and IP: no chess.com look-and-feel

> "we do require that you respect our IP: **board color palettes, piece designs,
> sound effects, move classification glyphs**, and the other features recognized
> as Chess.com products."

This is directly actionable, because CC-001's whole point is *mistake
classification*. We must therefore use **our own** taxonomy, labels and visuals —
never chess.com's "Brilliant/Great/Mistake/Blunder" glyphs or wording, and never
their board palettes, piece sets or sounds. (The app already uses clean-room
board themes and its own pieces; this just extends the same discipline to the new
classification UI, and to `THIRD-PARTY-NOTICE.md` if we ever reuse anything.)

## Syncing the generated puzzles (owner decision, 2026-10-19)

Owner: *"they should sync generated puzzles, thats fine but make sure TOS is
allowed for this kind of app."*

The ToS analysis above says syncing is compatible, **because it is not
publication**: the generated set is written to the owner's own account rows on
our server (the same place their other training data lives), visible to nobody
else, never exported to a public gallery, and never aggregated across users. The
constraints that keep it compatible are therefore:

1. **Private per-user storage only** — no share links, no public collections, no
   cross-user aggregates of imported games or derived puzzles.
2. **Personal, non-commercial** — unchanged by syncing.
3. Note the interaction with the current server model: sync payloads are
   **plaintext** on the server (ONL-020), so imported game data would sit readable
   in D1. That is already true of all training data and was an accepted trade-off,
   but it is worth stating explicitly for *imported chess.com* content: it is
   private-by-policy, not private-by-cryptography.

## Binding constraints for CC-001 (acceptance criteria)

CC-001a (importer) must:

- use **only** the documented PubAPI endpoints, **serially** (wait for each
  response), with backoff on `429`, and honour `ETag`/`Last-Modified`/`Cache-Control`
  so a re-run is cheap and does not re-poll;
- send an identifying **`User-Agent` with contact info** (e.g.
  `ChessEngram/<version> (+<repo or contact URL>)`);
- import **only the user's own account** by default — never bulk-import other
  players' games;
- keep imported games and generated puzzles **private to that user** (no
  publishing, no sharing, no aggregate), and never treat chess.com data as ours;
- store per-game provenance (game URL, end date, colours) so the source is
  always attributable and the user can open the original game;
- be a **manual, opt-in, cancellable** operation — no background polling.

CC-001c/d (generation + UI) must:

- use **our own** mistake taxonomy, labels and visuals — no chess.com
  classification glyphs/wording, board palettes, piece designs or sounds;
- label imported sets as coming from chess.com games, with the source links.

Not blocked by ToS, but still open (decisions 1–2 in `BACKLOG.md`): the engine
choice/licence (Stockfish is GPL-3.0; bundling it in this AGPL-3.0 app is
compatible but obliges a `THIRD-PARTY-NOTICE.md` entry + source offer) and
whether analysis runs client-side or server-side.

## When this verdict would change (re-check before shipping)

- CC-001 becomes available to **other users**, hosted at scale, or commercial
  (§2.B "personal, noncommercial"; §4.D requires prior written authorization).
- We want to publish, share or aggregate imported games or derived sets.
- chess.com changes the PubAPI docs or the User Agreement (both are updated
  periodically — re-read §2.D, §4.C and §4.D, which are the operative ones here).
- We ever reuse chess.com artwork, palettes, sounds or classification glyphs.
