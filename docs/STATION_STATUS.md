# Station status: is this station closed?

A line can have Good Service while a station on it is closed. Boards showed the
line's status and whatever departures TfL listed, so a closed station looked open.

```
TfL <- Syncer -> FCM  Station_<id>   (type: station_status)
         |
         -> backend -> REST  GET /stations/status?ids=
```

The same shape as line status: the Syncer fetches, decides and pushes; the backend
keeps its answer and serves it. **Nothing here is behind a flag.** Apps that do not
know the message ignore it, and `stationStatus.show` (docs/FEATURE_FLAGS.md) decides
whether one that does acts on it.

## Who does what

| Part | Where |
|---|---|
| Ask TfL, confirm, push, remember what was pushed | Syncer `notices/StationNoticeService` |
| What a notice says. Pure | Syncer `notices/StationStatusRules` |
| The words a board shows | Syncer `notices/StationNotice` |
| Real notices, 2019 to 2026, and what we must say of each | Syncer `src/test/resources/notices/golden.json` |
| Keep, serve, log | `src/services/stationStatusService.ts`, `POST /internal/station-statuses` |
| Phone: store, and what hides | StationlyUI `StationNoticeStore`, `StationNotice` |

## Fetching

`GET /StopPoint/Mode/{modes}/Disruption`: one call for the network, with the ids
boards use. Rail every minute, buses every five; 3 and 10 from 01:30 to 04:30. Not at
all while nobody has such a stop. A failed answer, or suddenly few notices we can
read, changes nothing. Off switch: `STATION_NOTICES_ENABLED=false`.

## Being certain

Departures are hidden only for `closed`. That needs TfL's type, a window covering now,
two polls running, and the WHOLE notice, its travel advice aside, to be one of a few
plain forms:

| Kind | Plain form, for example |
|---|---|
| `closed` | Clapham Common: Closed - while we respond to a power failure |
| | COLINDALE STATION: From Friday 7 June until December 2024, the station is closed for ... |
| | This bus stop is closed due to gas works until 18:00 on 04 December |
| `part_closed` | the westbound platform at South Ealing will be closed; closed to Piccadilly line trains |
| `exit_only` | Russell Square: Exit Only - This station is exit only and westbound trains are not stopping |
| `closing` | the station will close at 2335, and the window is that one night, within 12 hours |
| `unclear` | everything else. Logged, never shown |

The name in front must be the stop's own. Reasons and travel advice come from lists; one
that is not there makes the notice unclear. A date or time must be the notice's own: "from
08:00 to 18:00" on a three-day notice is every day. One live notice that says something is
open again and nothing is claimed. Looking instead for what could be wrong with a notice
was tried first: two reviews each found dozens of wordings that got past it, and a third
got past the first allow-list, which left names, reasons and advice free.

TfL's type is no guide: closures it labels so include bus diversions and (2026-11-25) ten
open stations during a signal failure. We miss some on purpose: ones TfL marks
`Information` (Holloway Road on match days), and ones that go on in prose.

**To read a new wording**, add the real notice to `golden.json`, widen one form, and look
at every answer `GoldenNoticesTest` says has changed. `StationStatusRulesTest` holds the
wordings that must claim nothing.

**Clearing** takes one good poll. An empty or odd answer changes nothing; after 10
minutes (bus 25) without a good one we say nothing.

**Times** are marked UTC; in 2020 and 2021 they were London time. Where the words give
a time it must match the window, so an hour's error is `unclear`. Check again when the
clocks change (28 March 2027). Closures over midnight arrive cut in two and are joined.

## Pushing (Syncer)

To the existing `Station_<id>` topic (departures use it, so there is nothing to
subscribe to), for stops someone has: on a change, hourly while it lasts, and `none`
when it ends. A live notice's end rolls forward at every poll, which is not a change.
Older apps read `payload` there and find none. It is queued beside the
stop's departures, never in place of them. No collapse key (FCM keeps four per phone);
each carries `at` and a phone ignores an older one. A refused message is sent again.
What the last poll meant, and what phones were told, are in the Syncer's SQLite: a
restart repeats nothing and still clears what ended meanwhile.

## Serving (backend)

The Syncer posts everything, every poll, so a restarted backend is right within one;
it is also kept in SQLite, which all workers share. `known` are the stops the answer
covers, each with when that was learned: one there with no notice is open, one not
there is unknown and the phone leaves it alone. The time is the Syncer's, not the
request's, so that a push sent since never looks older. Nothing for 10 minutes (bus
25) is "unknown".

Rail ids are 940G and 910G; every other stop is a bus stop.

## On the phone

Kept apart from departures, on disk. A notice hides departures only when `closed`, or
when a closed line or direction certainly is that board's. Direction is read from the
platform labels: a Tube board's own name for it is a map bearing (Arsenal:
"Southbound", platform "Westbound"). A direction at a station of several lines
(`certain: false`) is said, not hidden. Every notice expires (2 h 15 min without a
repeat), so a missed "reopened" cannot stick. Turning `show` off reaches a phone at
its next config fetch, or in minutes with `push: true`.

A closed board shows TfL's own words on its three rows, without what the title says, when
all of them fit (`rowsThatFit`, measured by each surface); else the Syncer's `details`.
Its title has an amber warning sign either side and the strip has one; the hero card turns
red. Nothing flashes.

## Rolling it out

1. Backend, then Syncer (the other way round only logs a 404 per poll). Both make their
   tables on start; the old versions ignore them, so either can be rolled back alone.
2. The Syncer starts pushing at once. Released apps ignore it: every Android 1.x handler
   returns on a message without `payload`, and iOS has no Firebase messaging.
3. Nothing is shown until `stationStatus.show` is on, and then only by an app that has
   the feature: `PUT /admin/flags` (FEATURE_FLAGS.md).
4. Stop showing: the flag. Stop pushing: `STATION_NOTICES_ENABLED=false`, restart the Syncer.

iOS: shared core has everything but the widget's and the stream's part, and the flag has no
`ios` target until an iOS release does. The push reaches Android only; iOS would ask REST.

## The log

Backend SQLite `station_status_log`, 30 days: what TfL was held to say, `unclear`
included. Admin: `GET /admin/station-status`, `GET /admin/station-status/report?days=7`.
Before turning `show` on for real users:

1. Is every `closed` right? Compare `recentRail` with tfl.gov.uk.
2. Are the `unclear` ones worth reading better?
3. Does TfL list departures at a closed Tube station? (Not seen yet. At closed bus
   stops, sometimes: 5 of 18 on 2026-11-25.)

## Tested

2026-11-25, on the final code. Rules: 205 Syncer tests (app 848, backend 276), which hold the wordings three
reviews broke them with, all real notices of 2019 to 2026 that we have, and every live
bus wording of that day. End to end: the Syncer's classes on live TfL plus simulated
notices, real FCM to a Pixel 10 Pro Fold (staging app), posts to the complete backend.
Seen there: flag off and on, closed, TfL failing, reopened, "has reopened" in the notice,
exit only, a closed lift (nothing), one line, one direction, one and both bus stops, a
Syncer that died during a closure, on the 4x2 widget and home.

Against what was live (both `release_prod` trees, before and after, same data): the whole
Syncer, 6 minutes, no errors or warnings, departures fetched, pushed and posted; also with the off
switch, and with no backend to post to. The backend, about 30 existing URLs as Android 1.0
and 2.0, iOS 1.1 and web, with 201 stops closed and the flag off: the same answers but for
the new `flag.stationStatus.show` = "false". Every Android 1.x handler returns at once on a
message without `payload`; iOS 1.1 has no Firebase messaging.

Not: the screensaver, a 2x2 widget, a v1 phone receiving a push (read in its code), a
real rail closure.
