# `viaKey` — which branch a train takes

## The problem

You are at Camden Town. Two trains say **Morden**. One runs via Bank, one via
Charing Cross. They take completely different routes through central London,
meet again at Kennington, and finish in the same place.

Ask for "trains through Bank" and the app has to answer yes or no per train. All
it had was the destination:

```
Train A   destId: 940GZZLUMDN
Train B   destId: 940GZZLUMDN
```

Identical. So it showed both, and one of them never goes near Bank.

`viaKey` is the missing discriminator, and TfL was already publishing it in
`towards` — the same string we clean into `displayName` and print on the board.

## The field

On each entry of `lines[].dirs[].preds[]`:

```jsonc
{ "destId": "940GZZLUMDN", "displayName": "Morden via Bank", "viaKey": "bank" }
```

**OMITTED when there is no branch.** Not null, absent:

```jsonc
{ "destId": "940GZZLUBXN", "displayName": "Brixton" }
```

Absent is the normal case by a wide margin. Only the **Northern** and **Central**
lines produce a value — they are the only two that split, rejoin, *and* get
labelled by TfL. Sending an explicit null would put a dead key on every departure
of every other line, repeated on every stream frame.

### Clients must fail open

Absent, null, or a token we do not recognise all mean **"cannot narrow — show the
train"**. Reading a missing branch as "not on my branch" would empty boards
across most of the network. The Kotlin client declares `val viaKey: String? = null`,
so absent and null decode identically; the runtime check ignores an empty token
set. Pinned by `core/.../ViaKeyWireFormatTest.kt`.

## Where it is set

**`PredictionCache.set`, and nowhere else.**

That is the single write-through, and it has to be, because there are TWO
producers:

```
  our TypeScript sources ─┐
                          ├─> PredictionCache.set ──> stamped here
  Java Syncer (verbatim) ─┘
```

The Syncer POSTs its own payloads to `/internal/station-updates` and they are
stored unchanged. Deriving `viaKey` in a `PredictionSource` covered only our own,
so the field was present on unsubscribed stations and absent on subscribed ones —
the same station answering differently depending on who wrote last. **Do not move
this back into a source.**

It is read off `displayName` rather than the raw `towards`, because
`displayName` is the one field both producers populate, and it keeps the token
and the text on the board derived from the same string.

## Normalisation

`src/utils/viaKey.ts` is used by BOTH sides — route building and prediction
stamping — deliberately. A route tagged `charingcross` and a prediction tagged
`charing-cross` would silently never match, and that failure looks exactly like
"no trains on this branch".

The two feeds do not use the same words:

| Route sequence name | Live arrival `towards` | Token |
|---|---|---|
| `… via Charing Cross` | `Morden via CX` | `charingcross` |
| `… via Bank` | `Morden via Bank` | `bank` |
| `… via Newbury Park` | `Hainault via Newbury Park` | `newburypark` |
| `… via Woodford` | `Grange Hill via Woodford` | `woodford` |

Lowercased, stripped to `[a-z0-9]`, then an alias table with exactly one entry:
`cx → charingcross`. Add to it only where the two feeds genuinely disagree — a
token that already matches a stop name needs nothing.

## Where it does NOT help

- **Metropolitan** rejoins genuinely (Chalfont & Latimer, Moor Park,
  Harrow-on-the-Hill), but its four patterns to Aldgate differ only in whether
  they call at Willesden Green, and TfL says just `towards: "Aldgate"`. Nothing
  to match on. Those fail open by design.
- **Circle** does not rejoin at all. It is a spiral that calls at Edgware Road
  **twice on one journey**. That is a different problem — which visit do you
  mean — and `viaKey` does nothing for it.

## Related

- `docs/ROUTE_DIRECTIONS.md` — the route payload and its `patterns[]`
- `StationlyUI/docs/ROUTE_BRANCHES_AND_REJOINS.md` — the full change, both ends
