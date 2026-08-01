/**
 * Regression tests for the shared prediction cache and the WebSocket fan-out hub.
 *
 * Deliberately dependency-free: a ~40-line runner over Node's `assert`, run with
 * the ts-node already in devDependencies. Adding jest/vitest to a repo with no
 * existing test setup is a bigger decision than these tests are worth, and the
 * value here is having ANY regression protection on two modules that currently
 * have none.
 *
 *     npm test
 *
 * Covers the invariants that are (a) load-bearing and (b) silent when broken —
 * single-flight, out-of-order rejection, the REST/stream metric split, room
 * cleanup, and the register-idempotency that protects the routing table.
 *
 * Nothing here imports stationStreamServer: that pulls in config/firebase, which
 * initialises the Admin SDK and needs real credentials. The hub is where the
 * logic worth testing lives; the server is thin protocol glue over it.
 *
 * StreamPrefetch is the exception — it reaches config/firebase transitively via
 * DataCacheService and StationController. That turns out to be safe: the Admin
 * SDK's initializeApp() and firestore() are lazy, so nothing connects or
 * authenticates at import time. Both of its edges are stubbed below, so no test
 * here touches Firestore, SQLite or TfL.
 */
import assert from 'assert';
import type { WebSocket } from 'ws';
import { PredictionCache } from '../services/predictionCache';
import { StationStreamHub } from '../services/stationStreamHub';
import { StreamPrefetch } from '../services/streamPrefetch';
import { LineStatusStreamHub } from '../services/lineStatusStreamHub';
import { DataCacheService } from '../services/dataCacheService';
import { StationController } from '../controllers/stationController';
import { TflApiClient, UnknownStationError, TflUnavailableError } from '../client/TflApiClient';
import { StationPredictionResponse } from '../models';

// ─── tiny runner ─────────────────────────────────────────────────────────────

type TestFn = () => void | Promise<void>;
const tests: Array<{ name: string; fn: TestFn }> = [];
const test = (name: string, fn: TestFn) => tests.push({ name, fn });

async function main(): Promise<void> {
    let passed = 0;
    const failures: Array<{ name: string; err: unknown }> = [];

    for (const { name, fn } of tests) {
        try {
            // Both modules are process-global statics, so without this a leaked
            // room or a stray counter from one test shows up as a failure in an
            // unrelated one — which is exactly how the register-idempotency bug
            // presented before it was fixed.
            PredictionCache.reset();
            StationStreamHub.closeAll();
            StreamPrefetch.reset();
            LineStatusStreamHub.reset();
            await fn();
            passed++;
            console.log(`  ✓ ${name}`);
        } catch (err) {
            failures.push({ name, err });
            console.log(`  ✗ ${name}`);
        }
    }

    console.log(`\n${passed}/${tests.length} passed`);
    if (failures.length) {
        for (const { name, err } of failures) {
            console.log(`\n─── ${name}\n${err instanceof Error ? err.stack : String(err)}`);
        }
        process.exit(1);
    }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

const payload = (id: string, lut: string): StationPredictionResponse =>
    ({ id, name: id, lut, lines: {} } as StationPredictionResponse);

const ISO_NOW = new Date().toISOString();
const ISO_OLDER = new Date(Date.now() - 60_000).toISOString();
const ISO_NEWER = new Date(Date.now() + 60_000).toISOString();

/** Minimal stand-in for a ws socket — only the members the hub actually touches. */
function fakeSocket(): WebSocket & { sent: string[]; closed: boolean } {
    const s = {
        readyState: 1, // WebSocket.OPEN
        sent: [] as string[],
        closed: false,
        send(frame: string) { s.sent.push(frame); },
        ping() { /* no-op */ },
        terminate() { s.closed = true; },
        close() { s.closed = true; },
    };
    return s as unknown as WebSocket & { sent: string[]; closed: boolean };
}

// ─── PredictionCache ─────────────────────────────────────────────────────────

test('getFresh misses on an empty cache and counts a restMiss', () => {
    assert.strictEqual(PredictionCache.getFresh('940GZZDLTWG'), undefined);
    assert.strictEqual(PredictionCache.stats().restMisses, 1);
});

test('set then getFresh serves the payload and counts a restHit', () => {
    PredictionCache.set('940GZZDLTWG', payload('940GZZDLTWG', ISO_NOW), 'syncer');
    assert.strictEqual(PredictionCache.getFresh('940GZZDLTWG')?.id, '940GZZDLTWG');
    assert.strictEqual(PredictionCache.stats().restHits, 1);
});

test('a lapsed entry is not served and counts as a staleMiss, not a miss', () => {
    PredictionCache.set('940GZZDLTWG', payload('940GZZDLTWG', ISO_NOW), 'syncer');
    // -1 forces "older than the window" without sleeping.
    assert.strictEqual(PredictionCache.getFresh('940GZZDLTWG', -1), undefined);
    const s = PredictionCache.stats();
    assert.strictEqual(s.restStaleMisses, 1);
    assert.strictEqual(s.restMisses, 0);
});

test('getLatest serves a lapsed entry at any age — the stream contract', () => {
    PredictionCache.set('940GZZDLTWG', payload('940GZZDLTWG', ISO_OLDER), 'syncer');
    assert.strictEqual(PredictionCache.getLatest('940GZZDLTWG')?.id, '940GZZDLTWG');
    assert.strictEqual(PredictionCache.stats().streamHits, 1);
});

test('an older lut is rejected; a newer one is accepted', () => {
    assert.strictEqual(PredictionCache.set('X', payload('X', ISO_NOW), 'syncer'), true);
    assert.strictEqual(PredictionCache.set('X', payload('X', ISO_OLDER), 'syncer'), false);
    assert.strictEqual(PredictionCache.set('X', payload('X', ISO_NEWER), 'syncer'), true);
    assert.strictEqual(PredictionCache.stats().rejectedOutOfOrder, 1);
    assert.strictEqual(PredictionCache.getLatest('X')?.lut, ISO_NEWER);
});

test('re-storing the identical payload counts as one write, not two', () => {
    // The REST path stores the same object twice — once via broadcast() inside
    // fetchPredictionsFromTfl, once when getOrFetch resolves — which made
    // writes.rest read 2x reality.
    const p = payload('A', ISO_NOW);
    assert.strictEqual(PredictionCache.set('A', p, 'rest'), true);
    assert.strictEqual(PredictionCache.set('A', p, 'rest'), true, 'must still report accepted');
    assert.strictEqual(PredictionCache.stats().writes.rest, 1, 'one fetch is one write');
});

test('a TfL-404 is remembered, counted, and expires', () => {
    PredictionCache.markUnknown('DEADID');
    assert.strictEqual(PredictionCache.isUnknown('DEADID'), true);
    assert.strictEqual(PredictionCache.stats().negativeHits, 1);

    PredictionCache.markUnknown('GONE', -1); // TTL already elapsed
    assert.strictEqual(PredictionCache.isUnknown('GONE'), false, 'expired entries drop on read');
    assert.strictEqual(PredictionCache.stats().unknownIds, 1);
});

test('an unparseable lut never blocks a write', () => {
    PredictionCache.set('X', payload('X', ISO_NOW), 'syncer');
    assert.strictEqual(PredictionCache.set('X', payload('X', 'not-a-date'), 'syncer'), true);
    assert.strictEqual(PredictionCache.stats().rejectedOutOfOrder, 0);
});

test('the Station_ topic prefix normalises to the bare naptanId', () => {
    PredictionCache.set('Station_940GZZDLTWG', payload('940GZZDLTWG', ISO_NOW), 'syncer');
    assert.ok(PredictionCache.getFresh('940GZZDLTWG'), 'bare id should hit');
    assert.strictEqual(PredictionCache.stats().size, 1, 'must not keep two entries');
});

test('single-flight: concurrent misses share ONE fetch', async () => {
    let calls = 0;
    const fetcher = async () => { calls++; await new Promise(r => setTimeout(r, 10)); return payload('Y', ISO_NOW); };

    const results = await Promise.all(Array.from({ length: 5 }, () => PredictionCache.getOrFetch('Y', fetcher)));

    assert.strictEqual(calls, 1, 'TfL should be called once, not five times');
    assert.strictEqual(PredictionCache.stats().coalesced, 4);
    for (const r of results) assert.strictEqual(r.id, 'Y');
});

test('a failed fetch does not poison the station — the next caller retries', async () => {
    await assert.rejects(PredictionCache.getOrFetch('Z', async () => { throw new Error('TfL 429'); }));
    // Must not inherit the rejected promise forever.
    const ok = await PredictionCache.getOrFetch('Z', async () => payload('Z', ISO_NOW));
    assert.strictEqual(ok.id, 'Z');
});

test('getOrFetch writes back, tagged as a rest write', async () => {
    await PredictionCache.getOrFetch('W', async () => payload('W', ISO_NOW));
    const s = PredictionCache.stats();
    assert.strictEqual(s.writes.rest, 1);
    assert.strictEqual(s.writes.syncer, 0);
    assert.ok(PredictionCache.getFresh('W'), 'the fetched value should now be cached');
});

test('stream reads are excluded from restHitRate', () => {
    PredictionCache.set('A', payload('A', ISO_NOW), 'syncer');
    PredictionCache.getFresh('A');            // 1 REST hit
    PredictionCache.getFresh('B');            // 1 REST miss
    for (let i = 0; i < 50; i++) PredictionCache.getLatest('A'); // stream reads

    const s = PredictionCache.stats();
    assert.strictEqual(s.restHitRate, 0.5, 'must stay 1 hit / 2 REST reads');
    assert.strictEqual(s.streamHits, 50, 'stream reads still counted separately');
});

test('sweep drops entries past retainForMs', () => {
    PredictionCache.set('A', payload('A', ISO_NOW), 'syncer');
    PredictionCache.configure({ retainForMs: -1 }); // everything is past retention
    assert.strictEqual(PredictionCache.sweep(), 1);
    assert.strictEqual(PredictionCache.stats().size, 0);
    PredictionCache.configure({ retainForMs: 10 * 60_000 }); // restore the default
});

test('maxEntries evicts the oldest entry', () => {
    PredictionCache.configure({ maxEntries: 2 });
    PredictionCache.set('first', payload('first', ISO_NOW), 'syncer');
    PredictionCache.set('second', payload('second', ISO_NOW), 'syncer');
    PredictionCache.set('third', payload('third', ISO_NOW), 'syncer');

    assert.strictEqual(PredictionCache.stats().size, 2);
    assert.strictEqual(PredictionCache.getLatest('first'), undefined, 'oldest should go');
    assert.ok(PredictionCache.getLatest('third'), 'newest should stay');
    PredictionCache.configure({ maxEntries: 500 }); // restore the default
});

// ─── StationStreamHub ────────────────────────────────────────────────────────

test('broadcast reaches subscribers and only subscribers', () => {
    const watcher = fakeSocket();
    const bystander = fakeSocket();
    StationStreamHub.register(watcher, 'uid-1');
    StationStreamHub.register(bystander, 'uid-2');
    StationStreamHub.subscribe(watcher, ['940GZZDLTWG']);

    const sent = StationStreamHub.broadcast('940GZZDLTWG', payload('940GZZDLTWG', ISO_NOW), 'syncer');

    assert.strictEqual(sent, 1);
    assert.strictEqual(watcher.sent.length, 1);
    assert.strictEqual(bystander.sent.length, 0);
    assert.ok(watcher.sent[0].includes('"type":"update"'));

    StationStreamHub.unregister(watcher);
    StationStreamHub.unregister(bystander);
});

test('the Station_ prefix routes to bare-id subscribers', () => {
    const sock = fakeSocket();
    StationStreamHub.register(sock, 'uid');
    StationStreamHub.subscribe(sock, ['940GZZDLTWG']);

    StationStreamHub.broadcast('Station_940GZZDLTWG', payload('940GZZDLTWG', ISO_NOW), 'syncer');

    assert.strictEqual(sock.sent.length, 1);
    StationStreamHub.unregister(sock);
});

test('broadcast returns -1 and sends nothing when the payload is out-of-order', () => {
    const sock = fakeSocket();
    StationStreamHub.register(sock, 'uid');
    StationStreamHub.subscribe(sock, ['S']);

    StationStreamHub.broadcast('S', payload('S', ISO_NOW), 'syncer');
    const second = StationStreamHub.broadcast('S', payload('S', ISO_OLDER), 'syncer');

    assert.strictEqual(second, -1, 'callers distinguish this from "0 sockets"');
    assert.strictEqual(sock.sent.length, 1, 'must not re-broadcast older data');
    StationStreamHub.unregister(sock);
});

test('unregister removes the socket from every room it joined', () => {
    const sock = fakeSocket();
    StationStreamHub.register(sock, 'uid');
    StationStreamHub.subscribe(sock, ['A', 'B', 'C']);
    assert.strictEqual(StationStreamHub.stats().rooms, 3);

    StationStreamHub.unregister(sock);

    assert.strictEqual(StationStreamHub.stats().rooms, 0, 'empty rooms must be deleted, not left behind');
    assert.strictEqual(StationStreamHub.stats().connections, 0);
});

test('unsubscribe drops the room once its last subscriber leaves', () => {
    const sock = fakeSocket();
    StationStreamHub.register(sock, 'uid');
    StationStreamHub.subscribe(sock, ['A']);
    StationStreamHub.unsubscribe(sock, ['A']);

    assert.strictEqual(StationStreamHub.stats().rooms, 0);
    assert.strictEqual(StationStreamHub.broadcast('A', payload('A', ISO_NOW), 'syncer'), 0);
    StationStreamHub.unregister(sock);
});

test('register is idempotent — a second call must not wipe the station set', () => {
    const sock = fakeSocket();
    StationStreamHub.register(sock, 'uid');
    StationStreamHub.subscribe(sock, ['A']);

    StationStreamHub.register(sock, 'uid'); // e.g. a racing second auth frame
    StationStreamHub.unregister(sock);

    // If the second register had installed a fresh empty state, unregister
    // would have had nothing to iterate and room 'A' would be stranded.
    assert.strictEqual(StationStreamHub.stats().rooms, 0, 'routing table must not leak');
});

test('subscriptions past the per-client limit are reported, not silently dropped', () => {
    const sock = fakeSocket();
    StationStreamHub.register(sock, 'uid');

    const ids = Array.from({ length: 30 }, (_, i) => `STN${i}`);
    const { subscribed, rejected } = StationStreamHub.subscribe(sock, ids);

    assert.strictEqual(subscribed.length, 25);
    assert.strictEqual(rejected.length, 5);
    StationStreamHub.unregister(sock);
});

test('re-sending an existing subscription at the limit is idempotent', () => {
    const sock = fakeSocket();
    StationStreamHub.register(sock, 'uid');

    const ids = Array.from({ length: 25 }, (_, i) => `STN${i}`);
    StationStreamHub.subscribe(sock, ids);
    const again = StationStreamHub.subscribe(sock, ids);

    assert.strictEqual(again.rejected.length, 0, 'already-subscribed ids must not be rejected');
    assert.strictEqual(again.subscribed.length, 25);
    assert.strictEqual(StationStreamHub.stats().rooms, 25);
    StationStreamHub.unregister(sock);
});

test('a snapshot costs exactly one stream read', () => {
    const sock = fakeSocket();
    StationStreamHub.register(sock, 'uid');
    PredictionCache.set('A', payload('A', ISO_NOW), 'syncer');

    const { subscribed } = StationStreamHub.subscribe(sock, ['A']);
    for (const id of subscribed) StationStreamHub.snapshotFrame(id);

    // Regression: subscribe() used to pre-test the cache with its own
    // getLatest, making streamHits exactly 2x reality.
    assert.strictEqual(PredictionCache.stats().streamHits, 1);
    StationStreamHub.unregister(sock);
});

test('snapshotFrame returns undefined when the cache holds nothing', () => {
    assert.strictEqual(StationStreamHub.snapshotFrame('NOPE'), undefined);
    assert.strictEqual(PredictionCache.stats().streamMisses, 1);
});

test('the update frame is serialised once and shared by every socket', () => {
    const a = fakeSocket();
    const b = fakeSocket();
    StationStreamHub.register(a, 'uid-a');
    StationStreamHub.register(b, 'uid-b');
    StationStreamHub.subscribe(a, ['A']);
    StationStreamHub.subscribe(b, ['A']);

    const sent = StationStreamHub.broadcast('A', payload('A', ISO_NOW), 'syncer');

    assert.strictEqual(sent, 2);
    assert.strictEqual(a.sent[0], b.sent[0], 'both sockets should get the identical string');
    StationStreamHub.unregister(a);
    StationStreamHub.unregister(b);
});

test('a closed socket is skipped rather than throwing mid-fan-out', () => {
    const live = fakeSocket();
    const dead = fakeSocket();
    StationStreamHub.register(live, 'uid-1');
    StationStreamHub.register(dead, 'uid-2');
    StationStreamHub.subscribe(live, ['A']);
    StationStreamHub.subscribe(dead, ['A']);
    (dead as any).readyState = 3; // CLOSED

    assert.strictEqual(StationStreamHub.broadcast('A', payload('A', ISO_NOW), 'syncer'), 1);
    assert.strictEqual(dead.sent.length, 0);

    StationStreamHub.unregister(live);
    StationStreamHub.unregister(dead);
});

test('a socket that misses two pings is terminated', () => {
    const sock = fakeSocket();
    StationStreamHub.register(sock, 'uid');

    StationStreamHub.sweep();              // arms awaitingPong
    assert.strictEqual(sock.closed, false);
    StationStreamHub.sweep();              // no pong arrived → terminate
    assert.strictEqual(sock.closed, true);

    StationStreamHub.unregister(sock);
});

test('a pong clears the strike so the socket survives', () => {
    const sock = fakeSocket();
    StationStreamHub.register(sock, 'uid');

    StationStreamHub.sweep();
    StationStreamHub.markPong(sock);
    StationStreamHub.sweep();

    assert.strictEqual(sock.closed, false);
    StationStreamHub.unregister(sock);
});

// ─── negative cache, end to end ──────────────────────────────────────────────

test('a dead id costs ONE TfL call; repeats are refused from memory', async () => {
    // Stub the one TfL edge an unknown id reaches. Permanent for the rest of
    // the run — no later test calls TfL (StreamPrefetch tests stub the whole
    // controller anyway).
    let calls = 0;
    (TflApiClient as any).getArrivalsForStation = async (id: string) => {
        calls++;
        throw new UnknownStationError(id);
    };

    await assert.rejects(StationController.fetchPredictions('910GNOWHERE'), UnknownStationError);
    assert.strictEqual(PredictionCache.isUnknown('910GNOWHERE'), true, 'the 404 must be remembered');

    await assert.rejects(StationController.fetchPredictions('910GNOWHERE'), UnknownStationError);
    assert.strictEqual(calls, 1, 'the repeat must be served by the negative cache, not TfL');
});

test('a TfL outage never overwrites good cached data', async () => {
    // The bug this pins: on a TfL 5xx the arrivals call used to flatten to [],
    // an empty board was built with a FRESH lut, and that was cached (beating
    // the ordering guard, since its timestamp was newest) and broadcast — so one
    // failed fetch replaced a good board with "no service" for every subscriber.
    const good = payload('940GZZLUOXC', ISO_NOW);
    PredictionCache.set('940GZZLUOXC', good, 'rest');

    // Force the entry past its REST freshness window so the fetch is actually
    // attempted, while it stays RETAINED — exactly the state an outage finds.
    PredictionCache.configure({ freshForMs: -1 });
    (TflApiClient as any).getArrivalsForStation = async (id: string) => {
        throw new TflUnavailableError(id, 'connect ETIMEDOUT');
    };

    try {
        await assert.rejects(
            StationController.fetchPredictions('940GZZLUOXC', false),
            TflUnavailableError,
            'an unreachable upstream must surface, not masquerade as an empty board',
        );

        assert.strictEqual(
            PredictionCache.getLatest('940GZZLUOXC'),
            good,
            'the previously-good payload must survive the failed fetch',
        );
        // A network failure is a fact about the network, not the station.
        // Blacklisting here would take out every station an outage touched.
        assert.strictEqual(PredictionCache.isUnknown('940GZZLUOXC'), false);
    } finally {
        PredictionCache.configure({ freshForMs: 60_000 });
    }
});

// ─── StreamPrefetch ──────────────────────────────────────────────────────────

/**
 * Stub both edges of the prefetch path: station existence (normally the
 * SQLite-backed station cache) and the fetch itself (normally a live TfL call).
 *
 * Both are statics on imported classes, so assigning to them is seen by
 * StreamPrefetch without needing any injection seam in production code. Not
 * restored afterwards — these are the only tests that touch either class, and
 * they run last.
 *
 * Returns the array of naptanIds the fetcher was actually called with, which is
 * the assertion that matters: everything here is ultimately about what does and
 * does not reach TfL.
 */
function stubPrefetch(opts: {
    known?: (naptanId: string) => boolean;
    fetch?: (naptanId: string) => Promise<StationPredictionResponse>;
} = {}): string[] {
    const calls: string[] = [];
    (DataCacheService as any).getStationById = (id: string) =>
        (opts.known ? opts.known(id) : true) ? { id } : undefined;
    (StationController as any).fetchPredictions = (id: string) => {
        calls.push(id);
        return opts.fetch ? opts.fetch(id) : Promise.resolve(payload(id, ISO_NOW));
    };
    return calls;
}

const ids = (n: number, prefix = 'S') => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

test('a naptanId absent from the local station table never reaches TfL', () => {
    const calls = stubPrefetch({ known: (id) => id !== 'ASDF1' });
    const sock = fakeSocket();

    const { unknown } = StreamPrefetch.request(sock, ['940GZZDLTWG', 'ASDF1'], () => { });

    assert.deepStrictEqual(unknown, ['ASDF1'], 'the client must be told which id was junk');
    assert.deepStrictEqual(calls, ['940GZZDLTWG'], 'a junk id must not become an outbound TfL call');
});

test('a socket cannot exceed its prefetch budget however it splits the requests', () => {
    const calls = stubPrefetch({ fetch: () => new Promise(() => { }) }); // never settles
    const sock = fakeSocket();

    // 25 + 25 across two subscribes — under the per-subscribe cap both times,
    // which is exactly the loop the concurrent subscription limit cannot catch.
    const first = StreamPrefetch.request(sock, ids(25, 'A'), () => { });
    const second = StreamPrefetch.request(sock, ids(25, 'B'), () => { });

    assert.strictEqual(first.throttled.length, 0, 'the first 25 are within budget');
    assert.strictEqual(second.throttled.length, 10, '40 allowed per window, so 10 of the next 25 are refused');
    assert.strictEqual(calls.length + StreamPrefetch.stats().queued, 40, 'exactly the budget may be admitted');
});

test('a separate socket gets its own budget', () => {
    stubPrefetch({ fetch: () => new Promise(() => { }) });
    const greedy = fakeSocket();
    const innocent = fakeSocket();

    StreamPrefetch.request(greedy, ids(50, 'A'), () => { });
    const { throttled } = StreamPrefetch.request(innocent, ids(5, 'B'), () => { });

    assert.strictEqual(throttled.length, 0, 'one abusive socket must not throttle everyone else');
});

test('outbound TfL fetches are capped, and the queue drains as slots free', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const calls = stubPrefetch({ fetch: async (id) => { await gate; return payload(id, ISO_NOW); } });
    const sock = fakeSocket();

    StreamPrefetch.request(sock, ids(20), () => { });

    assert.strictEqual(calls.length, 4, 'must not fire all 20 at TfL at once');
    assert.strictEqual(StreamPrefetch.stats().active, 4);
    assert.strictEqual(StreamPrefetch.stats().queued, 16);

    release();
    for (let i = 0; i < 200 && StreamPrefetch.stats().queued > 0; i++) {
        await new Promise((r) => setImmediate(r));
    }
    assert.strictEqual(calls.length, 20, 'every queued station must eventually be fetched');
});

test('two sockets cold on the same station share ONE TfL fetch', () => {
    const calls = stubPrefetch({ fetch: () => new Promise(() => { }) });
    const a = fakeSocket();
    const b = fakeSocket();

    StreamPrefetch.request(a, ['940GZZDLTWG'], () => { });
    StreamPrefetch.request(b, ['940GZZDLTWG'], () => { });

    // The second socket is still served — it is in the room, so the in-flight
    // fetch's broadcast reaches it — but it must not cost a second slot.
    assert.deepStrictEqual(calls, ['940GZZDLTWG']);
});

test('a shared in-flight failure notifies EVERY waiting socket', async () => {
    // Regression guard: with a bare pending Set only the FIRST requester's
    // callback survived, so a TfL-404 on a shared cold station left every later
    // subscriber holding a dead subscription with no unknown_station frame to
    // explain it.
    stubPrefetch({ fetch: async (id) => { throw new UnknownStationError(id); } });
    const a = fakeSocket();
    const b = fakeSocket();
    const notified: string[] = [];

    StreamPrefetch.request(a, ['940GZZDLTWG'], (_id, permanent) => notified.push(`a:${permanent}`));
    StreamPrefetch.request(b, ['940GZZDLTWG'], (_id, permanent) => notified.push(`b:${permanent}`));

    for (let i = 0; i < 50 && notified.length < 2; i++) {
        await new Promise((r) => setImmediate(r));
    }
    assert.deepStrictEqual(notified.sort(), ['a:true', 'b:true']);
});

test('a failed fetch notifies the requesting socket rather than dying silently', async () => {
    stubPrefetch({ fetch: async () => { throw new Error('TfL 503'); } });
    const sock = fakeSocket();
    const notified: Array<[string, boolean]> = [];

    StreamPrefetch.request(sock, ['940GZZDLTWG'], (id, permanent) => notified.push([id, permanent]));

    for (let i = 0; i < 50 && notified.length === 0; i++) {
        await new Promise((r) => setImmediate(r));
    }
    // A 503 is the service, not the id: reported as TRANSIENT so the client
    // keeps the subscription and the board fills on the next push.
    assert.deepStrictEqual(notified, [['940GZZDLTWG', false]]);
    assert.strictEqual(StreamPrefetch.stats().failed, 1);
    assert.strictEqual(StreamPrefetch.stats().rejectedByTfl, 0);
});

test('a station TfL 404s is reported as permanent, not as a transient failure', async () => {
    // The case the local table CANNOT catch: an id we still list, but which TfL
    // has retired or renamed. Miscategorising it would leave the client retrying
    // a dead station forever.
    stubPrefetch({ fetch: async (id) => { throw new UnknownStationError(id); } });
    const sock = fakeSocket();
    const notified: Array<[string, boolean]> = [];

    StreamPrefetch.request(sock, ['940GZZDLTWG'], (id, permanent) => notified.push([id, permanent]));

    for (let i = 0; i < 50 && notified.length === 0; i++) {
        await new Promise((r) => setImmediate(r));
    }
    assert.deepStrictEqual(notified, [['940GZZDLTWG', true]]);
    assert.strictEqual(StreamPrefetch.stats().rejectedByTfl, 1);
});

// ─── LineStatusStreamHub ─────────────────────────────────────────────────────

const status = (id: string, severity: string) =>
    ({ id, name: id, statusSeverityDescription: severity, mode: 'tube', lastUpdatedTime: Date.now() });

test('a line status reaches subscribers and only subscribers', () => {
    const watcher = fakeSocket();
    const bystander = fakeSocket();
    LineStatusStreamHub.subscribe(watcher, ['victoria']);
    LineStatusStreamHub.subscribe(bystander, ['central']);

    const sent = LineStatusStreamHub.broadcast('victoria', status('victoria', 'Good Service'));

    assert.strictEqual(sent, 1);
    assert.strictEqual(watcher.sent.length, 1);
    assert.strictEqual(bystander.sent.length, 0, 'a line room must not leak to other lines');
    const frame = JSON.parse(watcher.sent[0]);
    assert.strictEqual(frame.type, 'update');
    assert.strictEqual(frame.line, 'victoria', 'line frames key on `line`, not `station`');
});

test('an identical status is suppressed rather than re-sent', () => {
    // Guards a GUARANTEED duplicate: refreshLineStatusesFromTfl writes to
    // Firestore, and that write echoes back through this instance's own
    // snapshot listener, calling setLineStatus a second time with the same data.
    const sock = fakeSocket();
    LineStatusStreamHub.subscribe(sock, ['victoria']);
    const payload = status('victoria', 'Good Service');

    assert.strictEqual(LineStatusStreamHub.broadcast('victoria', payload), 1);
    assert.strictEqual(LineStatusStreamHub.broadcast('victoria', { ...payload }), -1, 'echo must be suppressed');
    assert.strictEqual(sock.sent.length, 1, 'the client must see the change once');
    assert.strictEqual(LineStatusStreamHub.stats().suppressedDuplicates, 1);
});

test('a genuine status change after a suppressed echo still gets through', () => {
    const sock = fakeSocket();
    LineStatusStreamHub.subscribe(sock, ['victoria']);
    const good = status('victoria', 'Good Service');

    LineStatusStreamHub.broadcast('victoria', good);
    LineStatusStreamHub.broadcast('victoria', { ...good });          // echo
    LineStatusStreamHub.broadcast('victoria', status('victoria', 'Severe Delays'));

    assert.strictEqual(sock.sent.length, 2, 'suppression must not swallow a real change');
    assert.strictEqual(JSON.parse(sock.sent[1]).payload.statusSeverityDescription, 'Severe Delays');
});

test('forget() frees every line room the socket joined', () => {
    // The leak this guards is specific to this hub: it has no lifecycle of its
    // own, so it is only cleaned because the socket's close handler calls it.
    const sock = fakeSocket();
    LineStatusStreamHub.subscribe(sock, ['victoria', 'central', 'northern']);
    assert.strictEqual(LineStatusStreamHub.stats().rooms, 3);

    LineStatusStreamHub.forget(sock);

    assert.strictEqual(LineStatusStreamHub.stats().rooms, 0, 'empty rooms must be deleted, not left behind');
    assert.strictEqual(LineStatusStreamHub.stats().subscribers, 0);
    assert.strictEqual(LineStatusStreamHub.broadcast('victoria', status('victoria', 'Minor Delays')), 0);
});

test('unsubscribe drops the room once its last subscriber leaves', () => {
    const sock = fakeSocket();
    LineStatusStreamHub.subscribe(sock, ['victoria']);
    LineStatusStreamHub.unsubscribe(sock, ['victoria']);

    assert.strictEqual(LineStatusStreamHub.stats().rooms, 0);
    assert.strictEqual(LineStatusStreamHub.stats().subscribers, 0);
});

test('re-subscribing at the line limit is idempotent, and excess is reported', () => {
    const sock = fakeSocket();
    const many = Array.from({ length: 35 }, (_, i) => `line-${i}`);

    const first = LineStatusStreamHub.subscribe(sock, many);
    assert.strictEqual(first.subscribed.length, 30);
    assert.strictEqual(first.rejected.length, 5, 'over-limit lines are reported, not silently dropped');

    const again = LineStatusStreamHub.subscribe(sock, many.slice(0, 30));
    assert.strictEqual(again.rejected.length, 0, 're-sending an existing list must not trip the limit');
});

test('writes are attributed by producer, so a dead Syncer push is visible', () => {
    // The Syncer's push is the ONLY live source of line status. If it stops,
    // the TfL fallback keeps the cache warm and nothing looks broken — a flat
    // writes.syncer is the only signal, so it must actually be tracked.
    LineStatusStreamHub.broadcast('victoria', status('victoria', 'Good Service'), 'syncer');
    LineStatusStreamHub.broadcast('central', status('central', 'Minor Delays'), 'tfl');

    assert.deepStrictEqual(LineStatusStreamHub.stats().writes, { syncer: 1, tfl: 1 });
});

test('a snapshot frame is undefined when nothing is held', () => {
    assert.strictEqual(LineStatusStreamHub.snapshotFrame('victoria', undefined), undefined);
    const frame = LineStatusStreamHub.snapshotFrame('victoria', status('victoria', 'Good Service'));
    assert.strictEqual(JSON.parse(frame!).type, 'snapshot');
});

main();
