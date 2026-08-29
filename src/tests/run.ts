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
import { DeviceLifecycleService } from '../services/deviceLifecycleService';
import { UserFcmTokenService } from '../services/userFcmTokenService';
import { UserService, PROTECTED_PROFILE_FIELDS, projectSupportMoneyForClient, readSupportMoneyEntries } from '../services/userService';
import { verifyStripeSignature, signPayloadForTest } from '../utils/stripeSignature';
import { SupportMoneyConfigService, SupportMoneyCardConfig } from '../services/supportMoneyConfigService';
import {
    SupportMoneyService, StripeEventLedger, txnIdFor, isUsableUid,
} from '../services/supportMoneyService';
import { SubscriptionService } from '../services/subscriptionService';
import { UserRevLedger } from '../services/userRevLedger';
import { UserDeviceService } from '../services/userDeviceService';
import { DevicePushService } from '../services/devicePushService';
import { LocalDbService } from '../services/localDbService';
import { EmailService } from '../services/emailService';
import { db, auth } from '../config/firebase';

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

// (The root-collection `DeviceRegistryService` and its DeviceLifecycleService
// tests were deleted with the service. Addressing a device for push is now
// `UserDeviceService` + `DevicePushService.resolveAudience`, and RELEASING one
// is no longer a separate step at all — the device row IS the session, so
// `endSession`'s transaction deletes the push address atomically with it.
//
// What survives from that suite is the one rule the merge could not absorb, and
// it is kept below: the legacy `fcm_tokens` store is keyed by TOKEN and carries
// no device id, so it can only be purged on the last device out.)

test('the legacy FCM purge fires ONLY when the last device signs out', async () => {
    // All-or-nothing by necessity, and the reason must not be lost: the frozen
    // APK's `/user/fcm/register` never sent a deviceId and never will, so the
    // backend cannot tell which token document belongs to the device that just
    // left. Purging on any single logout would mute push on the user's OTHER
    // phones — including the `reason=deleted` signal that tells a client to tear
    // its session down.
    const anyFcm = UserFcmTokenService as any;
    const saved = anyFcm.purgeAllForUid;
    const purged: string[] = [];
    anyFcm.purgeAllForUid = async (uid: string) => { purged.push(uid); return 1; };
    try {
        await DeviceLifecycleService.release('uid-1', 'device-A', false);
        assert.deepStrictEqual(purged, [], 'another device is still signed in');

        await DeviceLifecycleService.release('uid-1', 'device-B', true);
        assert.deepStrictEqual(purged, ['uid-1']);
    } finally { anyFcm.purgeAllForUid = saved; }
});

test('a failing FCM purge never throws out of release', async () => {
    // `release` is awaited by `logOut`, whose 200 the client reads as "this
    // device is signed out everywhere it matters". A throw here would turn a
    // best-effort cleanup into a failed logout.
    const anyFcm = UserFcmTokenService as any;
    const saved = anyFcm.purgeAllForUid;
    anyFcm.purgeAllForUid = async () => { throw new Error('firestore unavailable'); };
    try {
        await DeviceLifecycleService.release('uid-1', 'device-A', true);
    } finally { anyFcm.purgeAllForUid = saved; }
});
/**
 * Run [body] with `db.runTransaction` swapped for one fake SUBSCRIPTION registry
 * document (`metadata/subscribed_stations`) — not the retired device registry.
 */
async function withRegistry(
    stored: { stationCounts?: Record<string, number>; lastUpdatedTime?: number } | null,
    body: (written: Record<string, unknown>[]) => Promise<void>,
): Promise<void> {
    const written: Record<string, unknown>[] = [];
    const anyDb = db as any;
    const saved = anyDb.runTransaction;

    anyDb.runTransaction = async (fn: (tx: unknown) => Promise<void>) => {
        await fn({
            get: async () => ({ exists: stored !== null, data: () => stored ?? undefined }),
            update: (_ref: unknown, patch: Record<string, unknown>) => { written.push(patch); },
            set: (_ref: unknown, doc: Record<string, unknown>) => { written.push(doc); },
        });
    };
    try { await body(written); } finally { anyDb.runTransaction = saved; }
}

// (The `isSessionLive` tests were deleted with the predicate. It answered the
// 90-day TTL question against ISO strings in the retired `users.sessions` map;
// the merged device row stores epoch ms and `UserDeviceService.isRowLive` is
// its replacement — covered by its own tests above, INCLUDING the detached-
// receiver case, which is the trap that survives the move.)

test('reconcileCounts skips entirely when the registry moved during the scan', async () => {
    await withRegistry({ stationCounts: { A: 1 }, lastUpdatedTime: 5_000 }, async written => {
        // Baseline BEFORE the stored stamp: somebody wrote the registry after
        // this run's snapshot was taken, so the snapshot is stale and acting on
        // it could undo their increment.
        const r = await SubscriptionService.reconcileCounts({ A: 9 }, 4_000);
        assert.strictEqual(r.skippedDueToRace, true);
        assert.deepStrictEqual(written, []);
    });
});

test('reconcileCounts refuses to drain a non-empty registry from an empty target', async () => {
    await withRegistry({ stationCounts: { A: 1, B: 2 }, lastUpdatedTime: 1_000 }, async written => {
        // An empty target is far likelier a failed scan than a real "nobody is
        // subscribed to anything". Writing it would stop the Syncer polling
        // every station in the system, silently.
        const r = await SubscriptionService.reconcileCounts({}, 2_000);
        assert.strictEqual(r.changed, 0);
        assert.strictEqual(r.deleted, 0);
        assert.deepStrictEqual(written, []);
    });
});

test('reconcileCounts writes only the differing keys, and deletes at zero', async () => {
    await withRegistry({ stationCounts: { keep: 3, drop: 1, bump: 1 }, lastUpdatedTime: 1_000 }, async written => {
        const r = await SubscriptionService.reconcileCounts({ keep: 3, bump: 4, fresh: 1 }, 2_000);

        assert.strictEqual(written.length, 1);
        const patch = written[0];

        // `keep` matched, so it is absent entirely — a station present before
        // and after is never touched.
        assert.ok(!('stationCounts.keep' in patch));
        assert.strictEqual(patch['stationCounts.bump'], 4);
        assert.strictEqual(patch['stationCounts.fresh'], 1);

        // Removal must be an explicit FieldValue.delete(), never an omission or
        // a stored zero: a merge ignores absent keys, so a delete by omission
        // simply vanishes, and a key at 0 keeps the station polled anyway.
        assert.strictEqual(typeof patch['stationCounts.drop'], 'object');
        assert.ok(patch['stationCounts.drop'] !== null);
        assert.ok('lastUpdatedTime' in patch);

        assert.strictEqual(r.changed, 2);
        assert.strictEqual(r.deleted, 1);
        assert.strictEqual(r.skippedDueToRace, false);
    });
});

test('reconcileCounts creates the registry when it does not exist yet', async () => {
    await withRegistry(null, async written => {
        const r = await SubscriptionService.reconcileCounts({ A: 2 }, Date.now());
        // .update() throws NOT_FOUND against a missing document, so this path
        // must set the whole thing — the same branch updateCount already has.
        assert.deepStrictEqual((written[0] as any).stationCounts, { A: 2 });
        assert.strictEqual(r.changed, 1);
    });
});

// ─── P1: the stateRev ledger ─────────────────────────────────────────────────
//
// The ledger is a cache in front of Firestore, and the property that makes it
// SAFE rather than merely fast is that it only ever holds a value someone read
// out of the master. These tests pin that property, the monotonicity that
// protects it from out-of-order callbacks, and the read budget it exists for.

/** Run [body] with LocalDbService swapped for one in-memory `user_revs` table. */
async function withRevTable(
    seed: Record<string, number>,
    body: (rows: Record<string, number>, reads: { count: number }) => Promise<void>,
): Promise<void> {
    const rows: Record<string, number> = { ...seed };
    const anyLocal = LocalDbService as any;
    const savedGet = anyLocal.get;
    const savedRun = anyLocal.run;

    anyLocal.get = async (_q: string, params: any[]) => {
        const uid = params[0];
        return uid in rows ? { rev: rows[uid] } : undefined;
    };
    anyLocal.run = async (q: string, params: any[]) => {
        if (q.startsWith('DELETE')) { delete rows[params[0]]; return; }
        const [uid, rev] = params;
        // Mirrors the conditional upsert's WHERE clause.
        if (!(uid in rows) || rev > rows[uid]) rows[uid] = rev;
    };

    const anyDb = db as any;
    const savedCollection = anyDb.collection;
    const reads = { count: 0 };
    anyDb.collection = () => ({
        doc: (uid: string) => ({
            get: async () => {
                reads.count++;
                return { exists: true, data: () => ({ stateRev: MASTER[uid] ?? 0 }) };
            },
        }),
    });

    try { await body(rows, reads); } finally {
        anyLocal.get = savedGet;
        anyLocal.run = savedRun;
        anyDb.collection = savedCollection;
    }
}

/** What "Firestore" holds for the duration of a withRevTable block. */
const MASTER: Record<string, number> = {};

test('rev ledger: a warm hit costs ZERO Firestore reads', async () => {
    MASTER['u'] = 7;
    await withRevTable({ u: 7 }, async (_rows, reads) => {
        assert.strictEqual(await UserRevLedger.resolve('u'), 7);
        assert.strictEqual(await UserRevLedger.resolve('u'), 7);
        // This is the entire point of P1. If this ever becomes non-zero, the
        // ~20-reads-a-day-per-user the design set out to remove are back.
        assert.strictEqual(reads.count, 0);
    });
});

test('rev ledger: a cold miss reads the master exactly once, then is warm', async () => {
    MASTER['cold'] = 3;
    await withRevTable({}, async (rows, reads) => {
        assert.strictEqual(await UserRevLedger.resolve('cold'), 3);
        assert.strictEqual(reads.count, 1);
        assert.strictEqual(rows['cold'], 3);
        // Warm now — a second call must not go back to Firestore.
        assert.strictEqual(await UserRevLedger.resolve('cold'), 3);
        assert.strictEqual(reads.count, 1);
    });
});

test('rev ledger: observe is monotonic and never walks backwards', async () => {
    await withRevTable({ u: 5 }, async rows => {
        // A refresh issued first but completing second must not undo a newer
        // value. Without the WHERE on the upsert the ledger would under-report
        // until the next content write, and a client sitting on the higher rev
        // would stop fetching.
        await UserRevLedger.observe('u', 9);
        assert.strictEqual(rows['u'], 9);
        await UserRevLedger.observe('u', 6);
        assert.strictEqual(rows['u'], 9);
        await UserRevLedger.observe('u', 9);
        assert.strictEqual(rows['u'], 9);
    });
});

test('rev ledger: observe rejects values that are not usable revisions', async () => {
    await withRevTable({}, async rows => {
        await UserRevLedger.observe('', 4);
        await UserRevLedger.observe('u', Number.NaN);
        await UserRevLedger.observe('u', -1);
        // None of these are revisions, and writing any of them would put the
        // ledger into a state no read of the master could have produced.
        assert.deepStrictEqual(rows, {});
    });
});

test('rev ledger: a refresh failure answers 0 rather than throwing', async () => {
    await withRevTable({}, async () => {
        const anyDb = db as any;
        const saved = anyDb.collection;
        anyDb.collection = () => ({ doc: () => ({ get: async () => { throw new Error('firestore down'); } }) });
        try {
            // Every caller is either a fire-and-forget push callback or the rev
            // endpoint. A throw would turn a Firestore blip into a failed user
            // request; 0 reads as "nothing newer than you have" and is inert.
            assert.strictEqual(await UserRevLedger.refreshFromMaster('u'), 0);
        } finally { anyDb.collection = saved; }
    });
});

test('rev ledger: forget removes the watermark so a reused uid starts clean', async () => {
    await withRevTable({ gone: 12 }, async rows => {
        await UserRevLedger.forget('gone');
        assert.strictEqual('gone' in rows, false);
    });
});

test('stateRev is protected from the profile sync', () => {
    // `POST /user/sync/profile` spreads unknown body keys straight onto the
    // document. Without this membership a client could post `stateRev: 0` and
    // RESET the account's counter — after which every device holding a higher
    // localRev stops fetching until the counter climbs back past where it was.
    // Silent, account-wide, and self-inflicted.
    assert.ok(PROTECTED_PROFILE_FIELDS.has('stateRev'));

    // The rest of the guard list, so a careless edit to it is caught here
    // rather than by a user losing their boards to a display-name update.
    for (const f of ['boards', 'boardsUpdatedAt', 'stations', 'sessions', 'loggedIn', 'supportMoney']) {
        assert.ok(PROTECTED_PROFILE_FIELDS.has(f), `${f} must stay protected`);
    }
});

// ─── SUPPORT_MONEY: Stripe signature verification ─────────────────────────────────
//
// The gate on every pound of contribution money. Hand-rolled (see the header of
// stripeSignature.ts), so every branch is pinned here — a bug in this file is a
// bug that lets a forged event mint Supporter status or credit the wrong uid.

const SUP_SECRET = 'whsec_testsecret_0123456789';
const SUP_BODY = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' });
const nowSec = () => Math.floor(Date.now() / 1000);

test('stripe sig: a correctly signed body verifies', () => {
    const header = signPayloadForTest(SUP_BODY, SUP_SECRET, nowSec());
    const r = verifyStripeSignature(SUP_BODY, header, SUP_SECRET);
    assert.strictEqual(r.ok, true);
});

test('stripe sig: verifies against a Buffer body identically to a string', () => {
    const ts = nowSec();
    const header = signPayloadForTest(SUP_BODY, SUP_SECRET, ts);
    assert.strictEqual(verifyStripeSignature(Buffer.from(SUP_BODY, 'utf8'), header, SUP_SECRET).ok, true);
});

test('stripe sig: a multibyte (unicode) body still verifies', () => {
    const body = JSON.stringify({ note: 'thank you ☕ — £5' });
    const header = signPayloadForTest(body, SUP_SECRET, nowSec());
    assert.strictEqual(verifyStripeSignature(body, header, SUP_SECRET).ok, true);
});

test('stripe sig: multiple v1 entries pass if ANY matches', () => {
    const ts = nowSec();
    const good = signPayloadForTest(SUP_BODY, SUP_SECRET, ts).split(',')[1]; // "v1=<hex>"
    const header = `t=${ts},v1=${'0'.repeat(64)},${good}`;
    assert.strictEqual(verifyStripeSignature(SUP_BODY, header, SUP_SECRET).ok, true);
});

test('stripe sig: a tampered body is rejected', () => {
    const header = signPayloadForTest(SUP_BODY, SUP_SECRET, nowSec());
    const r = verifyStripeSignature(SUP_BODY + ' ', header, SUP_SECRET);
    assert.strictEqual(r.ok, false);
});

test('stripe sig: the wrong secret is rejected', () => {
    const header = signPayloadForTest(SUP_BODY, SUP_SECRET, nowSec());
    assert.strictEqual(verifyStripeSignature(SUP_BODY, header, 'whsec_other').ok, false);
});

test('stripe sig: a missing header is rejected', () => {
    assert.strictEqual(verifyStripeSignature(SUP_BODY, undefined, SUP_SECRET).ok, false);
    assert.strictEqual(verifyStripeSignature(SUP_BODY, '', SUP_SECRET).ok, false);
});

test('stripe sig: an unconfigured secret is rejected (fail closed)', () => {
    const header = signPayloadForTest(SUP_BODY, SUP_SECRET, nowSec());
    assert.strictEqual(verifyStripeSignature(SUP_BODY, header, undefined).ok, false);
    assert.strictEqual(verifyStripeSignature(SUP_BODY, header, '').ok, false);
});

test('stripe sig: a header with no timestamp is rejected', () => {
    const v1 = signPayloadForTest(SUP_BODY, SUP_SECRET, nowSec()).split(',')[1];
    assert.strictEqual(verifyStripeSignature(SUP_BODY, v1, SUP_SECRET).ok, false);
});

test('stripe sig: a header with no v1 is rejected', () => {
    assert.strictEqual(verifyStripeSignature(SUP_BODY, `t=${nowSec()}`, SUP_SECRET).ok, false);
});

test('stripe sig: a non-numeric timestamp is rejected', () => {
    const v1 = signPayloadForTest(SUP_BODY, SUP_SECRET, nowSec()).split(',')[1];
    assert.strictEqual(verifyStripeSignature(SUP_BODY, `t=abc,${v1}`, SUP_SECRET).ok, false);
});

test('stripe sig: a stale timestamp is rejected (replay protection)', () => {
    const old = nowSec() - 600; // 10 min > 300s default tolerance
    const header = signPayloadForTest(SUP_BODY, SUP_SECRET, old);
    const r = verifyStripeSignature(SUP_BODY, header, SUP_SECRET);
    assert.strictEqual(r.ok, false);
    assert.ok(!r.ok && /tolerance/.test(r.reason));
});

test('stripe sig: a far-future timestamp is rejected too', () => {
    const future = nowSec() + 600;
    const header = signPayloadForTest(SUP_BODY, SUP_SECRET, future);
    assert.strictEqual(verifyStripeSignature(SUP_BODY, header, SUP_SECRET).ok, false);
});

test('stripe sig: a stale timestamp passes when tolerance is widened', () => {
    const old = nowSec() - 600;
    const header = signPayloadForTest(SUP_BODY, SUP_SECRET, old);
    assert.strictEqual(verifyStripeSignature(SUP_BODY, header, SUP_SECRET, { toleranceSec: 1200 }).ok, true);
});

test('stripe sig: a v0 scheme signature does not satisfy the v1 requirement', () => {
    const header = signPayloadForTest(SUP_BODY, SUP_SECRET, nowSec(), 'v0');
    assert.strictEqual(verifyStripeSignature(SUP_BODY, header, SUP_SECRET).ok, false);
});

test('stripe sig: an empty body is rejected', () => {
    const header = signPayloadForTest('', SUP_SECRET, nowSec());
    assert.strictEqual(verifyStripeSignature('', header, SUP_SECRET).ok, false);
});

test('stripe sig: a non-hex v1 value is rejected, not thrown', () => {
    const header = `t=${nowSec()},v1=not-hex-at-all`;
    const r = verifyStripeSignature(SUP_BODY, header, SUP_SECRET);
    assert.strictEqual(r.ok, false);
});

// ─── SUPPORT_MONEY: config service ───────────────────────────────────────────────

test('support config: disabled by default (no SUPPORT_MONEY_ENABLED)', () => {
    const saved = process.env.SUPPORT_MONEY_ENABLED;
    delete process.env.SUPPORT_MONEY_ENABLED;
    try {
        assert.strictEqual(SupportMoneyConfigService.enabled(), false);
        assert.strictEqual(SupportMoneyConfigService.getSupportMoneyConfig().enabled, false);
        assert.strictEqual(SupportMoneyConfigService.homeConfigKeys()['home.promo.support_money.show'], 'false');
    } finally {
        if (saved === undefined) delete process.env.SUPPORT_MONEY_ENABLED;
        else process.env.SUPPORT_MONEY_ENABLED = saved;
    }
});

test('support config: SUPPORT_MONEY_ENABLED=true flips both switches', () => {
    const saved = process.env.SUPPORT_MONEY_ENABLED;
    process.env.SUPPORT_MONEY_ENABLED = 'true';
    try {
        assert.strictEqual(SupportMoneyConfigService.enabled(), true);
        assert.strictEqual(SupportMoneyConfigService.getSupportMoneyConfig().enabled, true);
        assert.strictEqual(SupportMoneyConfigService.homeConfigKeys()['home.promo.support_money.show'], 'true');
    } finally {
        if (saved === undefined) delete process.env.SUPPORT_MONEY_ENABLED;
        else process.env.SUPPORT_MONEY_ENABLED = saved;
    }
});

test('support config: badge duration defaults to 30 days and is env-overridable', () => {
    const saved = process.env.SUPPORT_MONEY_BADGE_DURATION_DAYS;
    delete process.env.SUPPORT_MONEY_BADGE_DURATION_DAYS;
    try {
        assert.strictEqual(SupportMoneyConfigService.badgeDurationDays(), 30);
        assert.strictEqual(SupportMoneyConfigService.badgeDurationMs(), 30 * 86_400_000);
        process.env.SUPPORT_MONEY_BADGE_DURATION_DAYS = '14';
        assert.strictEqual(SupportMoneyConfigService.badgeDurationDays(), 14);
        process.env.SUPPORT_MONEY_BADGE_DURATION_DAYS = 'garbage';
        assert.strictEqual(SupportMoneyConfigService.badgeDurationDays(), 30, 'garbage falls back to the default');
    } finally {
        if (saved === undefined) delete process.env.SUPPORT_MONEY_BADGE_DURATION_DAYS;
        else process.env.SUPPORT_MONEY_BADGE_DURATION_DAYS = saved;
    }
});

test('support config: home-config carries support_money.card.json that round-trips', () => {
    const keys = SupportMoneyConfigService.homeConfigKeys();
    assert.ok(typeof keys['support_money.card.json'] === 'string');
    const parsed = JSON.parse(keys['support_money.card.json']) as SupportMoneyCardConfig;
    assert.deepStrictEqual(parsed, SupportMoneyConfigService.getSupportMoneyConfig());
    assert.strictEqual(parsed.type, 'support_money_card');
});

test('support config: every home-config key is a string (the flat-map contract)', () => {
    for (const [k, v] of Object.entries(SupportMoneyConfigService.homeConfigKeys())) {
        assert.strictEqual(typeof v, 'string', `${k} must be a string`);
    }
});

test('support config: every tier has an integer amount_minor and the default id exists', () => {
    const cfg = SupportMoneyConfigService.getSupportMoneyConfig();
    assert.ok(cfg.tiers.length >= 1);
    for (const t of cfg.tiers) {
        assert.ok(Number.isInteger(t.amount_minor) && t.amount_minor > 0, `${t.id} amount`);
    }
    assert.ok(cfg.tiers.some(t => t.id === cfg.default_tier_id), 'default_tier_id must name a real tier');
});

test('support config: every tier carries its own checkout url field', () => {
    // Stripe prices a Payment Link, not a request — so each fixed amount needs
    // its own link. The field must always be a string (unset = "", which the
    // client falls back to cta.url_oneoff for), never undefined.
    const cfg = SupportMoneyConfigService.getSupportMoneyConfig();
    for (const t of cfg.tiers) {
        assert.strictEqual(typeof t.url, 'string', `${t.id} must carry a url string`);
    }
    const ids = cfg.tiers.map(t => t.id);
    assert.strictEqual(new Set(ids).size, ids.length, 'tier ids must be unique');
});

test('support config: the voice rules hold across every user-visible string', () => {
    // Three rules the owner set, and all three had already been broken once by
    // copy that read fine in isolation:
    //
    //  1. No "buy me a coffee". The metaphor made a request to cover running
    //     costs sound like a novelty purchase, and it put a drink between the
    //     reader and what the money is actually for.
    //  2. No "donation" or "donate". Stationly is not a registered charity and
    //     the word carries a legal meaning it cannot claim.
    //  3. No en or em dashes. House voice for this surface is plain sentences;
    //     a dash is where a sentence that should have been two gets stitched
    //     into one, and this is the one place in the app that has to read like
    //     a person wrote it rather than a product did.
    //
    // Asserted over the WHOLE payload plus the flat keys, because the copy is
    // spread over a structured card and eighteen loose strings and a rule that
    // only covers half of them is a rule that gets broken in the other half.
    const strings = [
        JSON.stringify(SupportMoneyConfigService.getSupportMoneyConfig()),
        ...Object.entries(SupportMoneyConfigService.homeConfigKeys())
            // The card key is the JSON above; re-checking it would double-count
            // and its escaping would hide nothing.
            .filter(([k]) => k !== 'support_money.card.json')
            .map(([, v]) => v),
    ];
    for (const raw of strings) {
        assert.ok(!/coffee/i.test(raw), `no "coffee" in support copy: ${raw.slice(0, 120)}`);
        assert.ok(!/donat(e|ion)/i.test(raw), `no "donation" in support copy: ${raw.slice(0, 120)}`);
        assert.ok(!/[\u2013\u2014]/.test(raw), `no en/em dash in support copy: ${raw.slice(0, 120)}`);
    }
});

test('support config: every tier says what that amount does, and thanks you for it', () => {
    // The ladder is £4 / £8 / £12 and the numbers alone say nothing. Each rung
    // names something REAL the money does, because "why is this one more than
    // that one" is the question a chip with only a price on it leaves the reader
    // holding. And each carries its own thank-you, because gratitude lands
    // harder when it names the specific thing the specific amount paid for.
    const cfg = SupportMoneyConfigService.getSupportMoneyConfig();
    for (const t of cfg.tiers) {
        assert.ok(t.label.trim().length > 0, `${t.id} needs a chip label`);
        assert.ok(t.hint.trim().length > 20, `${t.id} needs a real sentence, not a category`);
        assert.ok(t.thanks.trim().length > 20, `${t.id} needs its own thank-you`);
        assert.ok(t.thanks.includes('{amount}'), `${t.id} thanks must name the amount`);
    }
});

test('support config: nobody is named, and nobody is a lone hero', () => {
    // Two things the appeal must never lean on. A NAME turns a thank-you from
    // the app into a note from a stranger, and makes the whole feature read as a
    // favour to a person rather than as keeping a thing the reader uses alive.
    // "Built by one person" is the same move in the other direction: asking for
    // sympathy for the maker instead of for the product.
    const strings = [
        JSON.stringify(SupportMoneyConfigService.getSupportMoneyConfig()),
        ...Object.entries(SupportMoneyConfigService.homeConfigKeys())
            .filter(([k]) => k !== 'support_money.card.json')
            .map(([, v]) => v),
    ];
    for (const raw of strings) {
        assert.ok(!/\bNikhil\b|\bNick\b/i.test(raw), `no personal name in support copy: ${raw.slice(0, 120)}`);
        assert.ok(!/one person|single developer|solo dev/i.test(raw),
            `no lone-maker appeal in support copy: ${raw.slice(0, 120)}`);
    }
});

test('support config: the reward screen carries no status label', () => {
    // A SUPPORTER pill and a "for the next 30 days" line is a label where a
    // thank-you belongs. Someone who has just given money does not need to be
    // told what they now count as.
    const keys = SupportMoneyConfigService.homeConfigKeys();
    assert.strictEqual(keys['support_money.thanks.supporter'], undefined);
    assert.strictEqual(keys['support_money.thanks.dismiss'], undefined, 'the way out is an icon, not a worded button');
    assert.ok(keys['support_money.thanks.close'], 'but the close control still needs a label for screen readers');
});

test('support config: the badge names the app and thanks the person', () => {
    // "Supporter" alone could be a supporter of anything.
    const badge = SupportMoneyConfigService.getSupportMoneyConfig().badge;
    assert.ok(/Stationly/i.test(badge.label), 'the badge names the app');
    assert.ok(/\p{Extended_Pictographic}/u.test(badge.label), 'and carries the thank-you glyph');
});

test('support config: the thank-you says something, and says nothing meaningless', () => {
    // `board_lines` used to read "The board stays lit / +1 day" and
    // "Supporter / 30 days" — a receipt for something nobody bought. The
    // reward screen's job is a sentence about what the money does, which is
    // `note`; if a future operator puts figures back they must be real, so the
    // field survives while the default is empty.
    const thanks = SupportMoneyConfigService.getSupportMoneyConfig().thanks;
    assert.deepStrictEqual(thanks.board_lines, [], 'no invented figures on the reward screen');
    assert.ok(thanks.title_lines.length >= 1, 'the reward screen needs a headline');
    assert.ok(thanks.note.length > 80, 'the thank-you has to be a real note, not a label');
    assert.strictEqual(thanks.confetti, true);
});

test('support config: the badge window is NOT served to the client', () => {
    // The client does not decide who is a supporter — `supportMoney.isActiveSupporter`
    // on the profile response does, computed server-side. Serving the window as
    // well would hand out a second copy of a decision only one side makes, and
    // the two would disagree the moment an operator moved it.
    const raw = JSON.stringify(SupportMoneyConfigService.getSupportMoneyConfig());
    assert.ok(!/duration_days/.test(raw), 'no badge window in the payload');
    assert.ok(!/\{days\}/.test(raw), 'and no copy that would need one to interpolate');
    for (const [k, v] of Object.entries(SupportMoneyConfigService.homeConfigKeys())) {
        if (k === 'support_money.card.json') continue;
        assert.ok(!/\{days\}/.test(v), `${k} must not interpolate a day count`);
    }
    // The env var still exists — it is what `isActiveSupporter` is measured
    // against. It just never leaves the server.
    assert.strictEqual(SupportMoneyConfigService.badgeDurationDays(), 30);
});

test('support config: the badge shows on home as well as profile', () => {
    // One mark on the avatar the user already looks at. It is the only place
    // the thank-you is visible without opening Profile, and it is a mark rather
    // than a banner precisely so it can live there permanently.
    assert.strictEqual(SupportMoneyConfigService.getSupportMoneyConfig().badge.show_on_home, true);
});

test('support config: the payment method token is platform-neutral', () => {
    // A regression guard for the "platform flexible" requirement — the SDUI
    // payload must never name an iOS-only mechanism.
    const raw = JSON.stringify(SupportMoneyConfigService.getSupportMoneyConfig());
    for (const banned of [/apple ?pay/i, /google ?pay/i, /face ?id/i, /touch ?id/i, /storekit/i]) {
        assert.ok(!banned.test(raw), `no ${banned} literal in the payload`);
    }
    assert.strictEqual(SupportMoneyConfigService.getSupportMoneyConfig().cta.method, 'native_pay');
});

// ─── SUPPORT_MONEY: pure helpers ────────────────────────────────────────────────

test('support: txnIdFor prefers the checkout session over the event', () => {
    // The session is the unit of "a payment". One session can emit TWO
    // crediting events (`completed` while a delayed method is unpaid, then
    // `async_payment_succeeded` when it settles), so keying the ledger on the
    // event id would let a single payment land twice.
    assert.strictEqual(txnIdFor({ id: 'cs_test_abc' }, 'evt_1'), 'cs_test_abc');
    assert.strictEqual(txnIdFor({ id: 'cs_test_abc' }, 'evt_2'), 'cs_test_abc',
        'the same session under a different event is the same transaction');
});

test('support: txnIdFor falls back to the event id rather than an empty key', () => {
    // An empty key would make every unidentifiable payment collide with every
    // other one, so the SECOND unattributable payment would look like a
    // duplicate of the first and be silently dropped.
    assert.strictEqual(txnIdFor({}, 'evt_9'), 'evt_9');
    assert.strictEqual(txnIdFor(undefined, 'evt_9'), 'evt_9');
    assert.strictEqual(txnIdFor({ id: '' }, 'evt_9'), 'evt_9');
});

test('support: isUsableUid rejects the un-attributable', () => {
    assert.strictEqual(isUsableUid('abc123'), true);
    assert.strictEqual(isUsableUid(''), false);
    assert.strictEqual(isUsableUid(undefined), false);
    assert.strictEqual(isUsableUid(null), false);
    assert.strictEqual(isUsableUid(123 as unknown), false);
    assert.strictEqual(isUsableUid('x'.repeat(129)), false);
});

// ─── SUPPORT_MONEY: projectSupportMoneyForClient (the read projection) ───────

const WINDOW = 30 * 86_400_000;

test('support view: a contribution inside the window is an active supporter', () => {
    const now = 2_000_000_000_000;
    const view = projectSupportMoneyForClient(
        [{ txnId: 'cs_1', atMs: now - 86_400_000, amountMinor: 800, currency: 'GBP' }],
        now, WINDOW,
    );
    assert.strictEqual(view.isActiveSupporter, true);
    assert.strictEqual(view.count, 1);
    assert.strictEqual(view.entries.length, 1);
    assert.strictEqual(view.entries[0].txnId, 'cs_1');
});

test('support view: the badge lapses on its own the instant the window passes', () => {
    const now = 2_000_000_000_000;
    const rows = [{ txnId: 'cs_1', atMs: now - WINDOW, amountMinor: 800, currency: 'GBP' }];
    assert.strictEqual(projectSupportMoneyForClient(rows, now, WINDOW).isActiveSupporter, false);
    assert.strictEqual(projectSupportMoneyForClient(rows, now - 1, WINDOW).isActiveSupporter, true,
        'one millisecond earlier it is still active');
    // Derived from the clock, so there is no expiry job and no stored state to
    // go stale: a phone offline for the whole month comes back to the truth.
});

test('support view: only the NEWEST row is served, however many are stored', () => {
    // The store keeps everything because reconciling against Stripe needs it.
    // The client needs exactly one. Serving the rest would be building a
    // transaction history by accident — the one thing this feature has said
    // from the start it will never have.
    const now = 2_000_000_000_000;
    const view = projectSupportMoneyForClient([
        { txnId: 'cs_old', atMs: now - 200 * 86_400_000, amountMinor: 400, currency: 'GBP' },
        { txnId: 'cs_new', atMs: now - 86_400_000, amountMinor: 1200, currency: 'GBP' },
        { txnId: 'cs_mid', atMs: now - 90 * 86_400_000, amountMinor: 800, currency: 'GBP' },
    ], now, WINDOW);
    assert.strictEqual(view.entries.length, 1, 'never more than the latest');
    assert.strictEqual(view.entries[0].txnId, 'cs_new');
    assert.strictEqual(view.count, 3, 'but the count still sees all of them');
    assert.strictEqual(view.isActiveSupporter, true);
});

test('support view: the badge window can only move FORWARD, structurally', () => {
    // The old model enforced this by hand as `until = max(existing, new)`. It
    // is now impossible to violate: the window is measured from the LATEST row,
    // and a later row is by definition later. A £4 top-up cannot shorten a
    // badge a £12 contribution bought, because there is no stored `until` for
    // it to shorten.
    const now = 2_000_000_000_000;
    const big = { txnId: 'cs_big', atMs: now - 10 * 86_400_000, amountMinor: 1200, currency: 'GBP' };
    const topUp = { txnId: 'cs_small', atMs: now, amountMinor: 400, currency: 'GBP' };
    const after = projectSupportMoneyForClient([big, topUp], now + 25 * 86_400_000, WINDOW);
    assert.strictEqual(after.isActiveSupporter, true,
        'the £4 top-up EXTENDED the badge past where the £12 alone would have ended');
});

test('support view: an absent, empty, or malformed record is a well-formed non-supporter', () => {
    const now = Date.now();
    const none = { isActiveSupporter: false, count: 0, entries: [] };
    assert.deepStrictEqual(projectSupportMoneyForClient(undefined, now, WINDOW), none);
    assert.deepStrictEqual(projectSupportMoneyForClient([], now, WINDOW), none);
    // Never a fabricated £0 row: a sentinel would be a lie in the data, and
    // `isActiveSupporter` already answers what it would have been invented for.
    assert.deepStrictEqual(projectSupportMoneyForClient({ status: 'active' }, now, WINDOW), none,
        'the OLD object shape reads as no contributions, rather than throwing');
    assert.deepStrictEqual(projectSupportMoneyForClient('nonsense', now, WINDOW), none);
});

test('support view: rows missing a usable timestamp are dropped, not counted', () => {
    // A row with no `atMs` cannot be dated, so it can neither hold the badge
    // open nor be trusted as "the latest". Counting it would inflate the copy
    // ("you have done this 3 times") off a row nothing else can use.
    const now = 2_000_000_000_000;
    const view = projectSupportMoneyForClient([
        { txnId: 'cs_ok', atMs: now, amountMinor: 800, currency: 'GBP' },
        { txnId: 'cs_broken', amountMinor: 800, currency: 'GBP' },
        { txnId: 'cs_zero', atMs: 0, amountMinor: 800, currency: 'GBP' },
        null,
    ], now, WINDOW);
    assert.strictEqual(view.count, 1);
    assert.strictEqual(view.entries[0].txnId, 'cs_ok');
});

test('support view: stored rows are read newest-first regardless of stored order', () => {
    const now = 2_000_000_000_000;
    const rows = readSupportMoneyEntries([
        { txnId: 'a', atMs: 100, amountMinor: 1, currency: 'gbp' },
        { txnId: 'c', atMs: 300, amountMinor: 1, currency: 'gbp' },
        { txnId: 'b', atMs: 200, amountMinor: 1, currency: 'gbp' },
    ]);
    assert.deepStrictEqual(rows.map(r => r.txnId), ['c', 'b', 'a']);
    assert.strictEqual(rows[0].currency, 'GBP', 'currency is normalised uppercase');
});

// ─── SUPPORT_MONEY: SupportMoneyService event handling + idempotency ────────────────

/** Run [body] with an in-memory `stripe_events` table behind LocalDbService. */
async function withStripeEventLedger(body: (seen: Set<string>) => Promise<void>): Promise<void> {
    const anyLocal = LocalDbService as any;
    const savedGet = anyLocal.get;
    const savedRun = anyLocal.run;
    const seen = new Set<string>();
    anyLocal.get = async (q: string, params: any[]) => {
        if (/stripe_events/.test(q)) return seen.has(params[0]) ? { event_id: params[0] } : undefined;
        return savedGet ? savedGet.call(LocalDbService, q, params) : undefined;
    };
    anyLocal.run = async (q: string, params: any[]) => {
        if (/stripe_events/.test(q)) { seen.add(params[0]); return; }
        return savedRun ? savedRun.call(LocalDbService, q, params) : undefined;
    };
    try { await body(seen); } finally {
        anyLocal.get = savedGet;
        anyLocal.run = savedRun;
    }
}

/** Swap UserService.recordSupportMoney for a recorder that never touches Firestore. */
async function withRecordSupportMoneySpy(
    impl: (input: any) => Promise<{ recorded: boolean; reason?: string; count: number }>,
    body: (calls: any[]) => Promise<void>,
): Promise<void> {
    const anyUS = UserService as any;
    const saved = anyUS.recordSupportMoney;
    const calls: any[] = [];
    anyUS.recordSupportMoney = async (input: any) => { calls.push(input); return impl(input); };
    try { await body(calls); } finally { anyUS.recordSupportMoney = saved; }
}

const checkoutEvent = (over: Record<string, unknown> = {}) => ({
    id: 'evt_' + Math.random().toString(36).slice(2),
    type: 'checkout.session.completed',
    livemode: false,
    data: { object: {
        id: 'cs_test_1',
        client_reference_id: 'uid-alice',
        amount_total: 300,
        currency: 'gbp',
        mode: 'payment',
        payment_status: 'paid',
        ...over,
    } },
});

test('support service: a delayed payment settling later still credits the account', async () => {
    // Card / Apple Pay complete already `paid`. Bank debits and some wallets
    // complete `unpaid` and settle minutes-to-days later, when Stripe sends
    // `checkout.session.async_payment_succeeded`. Handling only `completed`
    // took the money and never granted the badge.
    await withStripeEventLedger(async seen => {
        await withRecordSupportMoneySpy(
            async () => ({ recorded: true, count: 1 }),
            async calls => {
                const ev = checkoutEvent();
                (ev as any).type = 'checkout.session.async_payment_succeeded';
                const out = await SupportMoneyService.processStripeEvent(ev);
                assert.strictEqual(out.status, 'recorded');
                assert.strictEqual(calls.length, 1, 'the settled payment credited the account');
                assert.ok(seen.has(ev.id));
            },
        );
    });
});

test('support service: the unpaid half of a delayed payment is ignored, not credited', async () => {
    await withStripeEventLedger(async () => {
        await withRecordSupportMoneySpy(
            async () => ({ recorded: true, count: 1 }),
            async calls => {
                const out = await SupportMoneyService.processStripeEvent(
                    checkoutEvent({ payment_status: 'unpaid' }),
                );
                assert.strictEqual(out.status, 'ignored');
                assert.strictEqual(calls.length, 0, 'nothing credited until it settles');
            },
        );
    });
});

test('support service: a ledger read failure asks Stripe to retry rather than answering handled', async () => {
    // The dangerous shape: if a SQLite read failure were treated as "already
    // seen", the route would answer 200, Stripe would never redeliver, and a
    // real contribution would be gone with no trace but a warning line.
    const anyLocal = LocalDbService as any;
    const savedGet = anyLocal.get;
    anyLocal.get = async () => { throw new Error('sqlite unavailable'); };
    try {
        await assert.rejects(
            () => SupportMoneyService.processStripeEvent(checkoutEvent()),
            /sqlite unavailable/,
            'the failure propagates, so the route can 500 and Stripe retries',
        );
    } finally {
        anyLocal.get = savedGet;
    }
});

test('support service: a payment for an account that no longer exists is unattributed, not duplicate', async () => {
    // `recorded:false` used to mean both "Stripe redelivered" and "nobody was
    // credited". The second is money on the floor and must be distinguishable.
    await withStripeEventLedger(async () => {
        await withRecordSupportMoneySpy(
            async () => ({ recorded: false, reason: 'missing_account', count: 0 }),
            async () => {
                const out = await SupportMoneyService.processStripeEvent(checkoutEvent());
                assert.strictEqual(out.status, 'unattributed');
            },
        );
    });
});

test('support service: a genuine redelivery caught by the document guard is still a duplicate', async () => {
    await withStripeEventLedger(async () => {
        await withRecordSupportMoneySpy(
            async () => ({ recorded: false, reason: 'duplicate_txn', count: 0 }),
            async () => {
                const out = await SupportMoneyService.processStripeEvent(checkoutEvent());
                assert.strictEqual(out.status, 'duplicate');
            },
        );
    });
});

test('support config: every checkout url carries the {uid} attribution placeholder', () => {
    // A checkout opened without `client_reference_id` reaches the webhook with
    // nobody to credit and can only be fixed by hand. Serving the placeholder
    // in the URL makes attribution the same `{uid}` substitution every other
    // field uses, so no client can forget the parameter name.
    const prev = { ...process.env };
    process.env.SUPPORT_MONEY_PAYMENT_URL_T4 = 'https://buy.stripe.com/test_A';
    process.env.SUPPORT_MONEY_PAYMENT_URL_T8 = 'https://buy.stripe.com/test_B?locale=en';
    process.env.SUPPORT_MONEY_PAYMENT_URL_T12 = 'https://buy.stripe.com/test_C?client_reference_id={uid}';
    process.env.SUPPORT_MONEY_PAYMENT_URL_ONEOFF = 'https://buy.stripe.com/test_D';
    try {
        const cfg = SupportMoneyConfigService.getSupportMoneyConfig();
        const byId = Object.fromEntries(cfg.tiers.map(t => [t.id, t.url]));
        assert.strictEqual(byId.t4, 'https://buy.stripe.com/test_A?client_reference_id={uid}');
        assert.strictEqual(byId.t8, 'https://buy.stripe.com/test_B?locale=en&client_reference_id={uid}',
            'an existing query string keeps its parameters');
        assert.strictEqual(byId.t12, 'https://buy.stripe.com/test_C?client_reference_id={uid}',
            'a link the operator already templated is left alone');
        assert.strictEqual(cfg.cta.url_oneoff, 'https://buy.stripe.com/test_D?client_reference_id={uid}');
    } finally {
        process.env = prev;
    }
});

test('support config: an unset checkout url stays empty rather than becoming a bare query string', () => {
    const prev = { ...process.env };
    for (const k of ['T4', 'T8', 'T12', 'ONEOFF', 'MONTHLY']) delete process.env[`SUPPORT_MONEY_PAYMENT_URL_${k}`];
    try {
        const cfg = SupportMoneyConfigService.getSupportMoneyConfig();
        for (const t of cfg.tiers) assert.strictEqual(t.url, '', `${t.id} is inert, not broken`);
        assert.strictEqual(cfg.cta.url_oneoff, '');
        assert.strictEqual(cfg.cta.url_monthly, '');
    } finally {
        process.env = prev;
    }
});

test('support service: a paid checkout records a contribution and marks the event', async () => {
    await withStripeEventLedger(async seen => {
        await withRecordSupportMoneySpy(
            async () => ({ recorded: true, count: 1 }),
            async calls => {
                const ev = checkoutEvent();
                const out = await SupportMoneyService.processStripeEvent(ev);
                assert.strictEqual(out.status, 'recorded');
                assert.strictEqual(calls.length, 1);
                assert.strictEqual(calls[0].uid, 'uid-alice');
                assert.strictEqual(calls[0].txnId, 'cs_test_1', 'keyed on the checkout session');
                assert.strictEqual(calls[0].amountMinor, 300);
                assert.strictEqual(calls[0].currency, 'GBP');
                assert.strictEqual(calls[0].tier, undefined, 'no tier is stored any more');
                assert.ok(seen.has(ev.id), 'event id is in the ledger after processing');
            },
        );
    });
});

test('support service: a redelivered event is a no-op duplicate (does not re-credit)', async () => {
    await withStripeEventLedger(async () => {
        await withRecordSupportMoneySpy(
            async () => ({ recorded: true, count: 1 }),
            async calls => {
                const ev = checkoutEvent();
                await SupportMoneyService.processStripeEvent(ev);
                const second = await SupportMoneyService.processStripeEvent(ev);
                assert.strictEqual(second.status, 'duplicate');
                assert.strictEqual(calls.length, 1, 'recordSupportMoney called exactly once across two deliveries');
            },
        );
    });
});

test('support service: a subscription checkout records the same row a one-off does', async () => {
    // There is no tier distinction left to get wrong. Under the ledger model a
    // renewal would simply be another row, so a recurring supporter keeps the
    // badge by paying rather than by a subscription-shaped special case — which
    // is what the old "grant a conservative 31 days" branch was standing in for.
    await withStripeEventLedger(async () => {
        await withRecordSupportMoneySpy(
            async () => ({ recorded: true, count: 1 }),
            async calls => {
                await SupportMoneyService.processStripeEvent(
                    checkoutEvent({ mode: 'subscription', amount_total: 249 }),
                );
                assert.strictEqual(calls[0].amountMinor, 249);
                assert.strictEqual(calls[0].txnId, 'cs_test_1');
            },
        );
    });
});

test('support service: a missing client_reference_id is unattributed, not credited', async () => {
    await withStripeEventLedger(async seen => {
        await withRecordSupportMoneySpy(
            async () => ({ recorded: true, count: 1 }),
            async calls => {
                const ev = checkoutEvent({ client_reference_id: undefined });
                const out = await SupportMoneyService.processStripeEvent(ev);
                assert.strictEqual(out.status, 'unattributed');
                assert.strictEqual(calls.length, 0, 'no account was credited');
                assert.ok(seen.has(ev.id), 'still marked so Stripe stops retrying a payment that can never attach');
            },
        );
    });
});

test('support service: an unpaid completed session is ignored', async () => {
    await withStripeEventLedger(async () => {
        await withRecordSupportMoneySpy(
            async () => ({ recorded: true, count: 1 }),
            async calls => {
                const out = await SupportMoneyService.processStripeEvent(checkoutEvent({ payment_status: 'unpaid' }));
                assert.strictEqual(out.status, 'ignored');
                assert.strictEqual(calls.length, 0);
            },
        );
    });
});

test('support service: subscription lifecycle events are acknowledged but not applied (Phase 2)', async () => {
    await withStripeEventLedger(async () => {
        await withRecordSupportMoneySpy(
            async () => ({ recorded: true, count: 1 }),
            async calls => {
                for (const t of ['customer.subscription.updated', 'customer.subscription.deleted']) {
                    const out = await SupportMoneyService.processStripeEvent({ id: 'evt_' + t, type: t, livemode: false });
                    assert.strictEqual(out.status, 'ignored');
                }
                assert.strictEqual(calls.length, 0);
            },
        );
    });
});

test('support service: an unknown event type is ignored', async () => {
    await withStripeEventLedger(async () => {
        const out = await SupportMoneyService.processStripeEvent({ id: 'evt_x', type: 'invoice.paid', livemode: false });
        assert.strictEqual(out.status, 'ignored');
    });
});

test('support service: a genuine recordSupportMoney failure propagates (so the webhook 500s and Stripe retries)', async () => {
    await withStripeEventLedger(async seen => {
        await withRecordSupportMoneySpy(
            async () => { throw new Error('firestore down'); },
            async () => {
                const ev = checkoutEvent();
                await assert.rejects(() => SupportMoneyService.processStripeEvent(ev), /firestore down/);
                assert.ok(!seen.has(ev.id), 'NOT marked processed — the retry must be able to apply it');
            },
        );
    });
});

test('support service: recordSupportMoney returning {recorded:false} is treated as a duplicate', async () => {
    await withStripeEventLedger(async () => {
        await withRecordSupportMoneySpy(
            async () => ({ recorded: false, count: 0 }),
            async () => {
                const out = await SupportMoneyService.processStripeEvent(checkoutEvent());
                assert.strictEqual(out.status, 'duplicate');
            },
        );
    });
});

// ─── SUPPORT_MONEY: UserService.recordSupportMoney (the Firestore transaction) ──────────

/** Run [body] with `db.runTransaction` backed by one fake `users/{uid}` doc. */
async function withSupportMoneyUserDoc(
    stored: Record<string, unknown> | null,
    body: (written: Record<string, unknown>[]) => Promise<void>,
): Promise<void> {
    const written: Record<string, unknown>[] = [];
    const anyDb = db as any;
    const savedTx = anyDb.runTransaction;
    const anyUS = UserService as any;
    const savedCollection = anyUS.collection;
    const savedAfter = anyUS.afterContentWrite;
    let afterCalls = 0;

    anyUS.collection = { doc: () => ({}) };
    anyUS.afterContentWrite = () => { afterCalls++; };
    anyDb.runTransaction = async (fn: (tx: unknown) => Promise<unknown>) => {
        return fn({
            get: async () => ({ exists: stored !== null, data: () => stored ?? undefined }),
            update: (_ref: unknown, patch: Record<string, unknown>) => { written.push(patch); },
        });
    };
    try {
        await body(written);
        (body as any).afterCalls = afterCalls;
    } finally {
        anyDb.runTransaction = savedTx;
        anyUS.collection = savedCollection;
        anyUS.afterContentWrite = savedAfter;
    }
}

test('recordSupportMoney: a first contribution appends a row, bumps stateRev, fans out', async () => {
    const now = 3_000_000_000_000;
    await withSupportMoneyUserDoc({ stateRev: 5 }, async written => {
        const r = await UserService.recordSupportMoney({
            uid: 'u', txnId: 'cs_a', amountMinor: 500, currency: 'gbp', nowMs: now,
        });
        assert.strictEqual(r.recorded, true);
        assert.strictEqual(r.count, 1);
        assert.strictEqual(written.length, 1);
        const patch: any = written[0];
        assert.deepStrictEqual(patch.supportMoney, [
            { txnId: 'cs_a', atMs: now, amountMinor: 500, currency: 'GBP' },
        ], 'four fields, nothing derived, nothing spare');
        // stateRev bump is a FieldValue sentinel — present and not a plain number.
        assert.ok(patch.stateRev && typeof patch.stateRev === 'object');
    });
});

test('recordSupportMoney: a second contribution APPENDS rather than overwriting', async () => {
    const now = 3_000_000_000_000;
    const first = { txnId: 'cs_a', atMs: now - 5 * 86_400_000, amountMinor: 1200, currency: 'GBP' };
    await withSupportMoneyUserDoc({ stateRev: 5, supportMoney: [first] }, async written => {
        const r = await UserService.recordSupportMoney({
            uid: 'u', txnId: 'cs_b', amountMinor: 300, nowMs: now,
        });
        const patch: any = written[0];
        assert.strictEqual(r.count, 2);
        assert.strictEqual(patch.supportMoney.length, 2);
        assert.strictEqual(patch.supportMoney[0].txnId, 'cs_b', 'newest first, matching the read order');
        assert.strictEqual(patch.supportMoney[1].txnId, 'cs_a', 'the older row is kept, for reconciliation');
    });
});

test('recordSupportMoney: the SAME txnId already on the doc is a no-op', async () => {
    const now = 3_000_000_000_000;
    await withSupportMoneyUserDoc(
        { supportMoney: [{ txnId: 'cs_dup', atMs: now - 1000, amountMinor: 800, currency: 'GBP' }] },
        async written => {
            const r = await UserService.recordSupportMoney({
                uid: 'u', txnId: 'cs_dup', amountMinor: 800, nowMs: now,
            });
            assert.strictEqual(r.recorded, false);
            assert.strictEqual(r.reason, 'duplicate_txn', 'a replay, not lost money');
            assert.strictEqual(written.length, 0, 'no write on a replay');
        },
    );
});

test('recordSupportMoney: an OLD row still guards, which lastEventId could not do', async () => {
    // The guard this replaces only ever remembered the most recent event, so a
    // redelivery of anything older than the last one walked straight past it
    // and credited the account twice. Every transaction is a guard now.
    const now = 3_000_000_000_000;
    await withSupportMoneyUserDoc(
        {
            supportMoney: [
                { txnId: 'cs_recent', atMs: now - 1000, amountMinor: 400, currency: 'GBP' },
                { txnId: 'cs_ancient', atMs: now - 400 * 86_400_000, amountMinor: 800, currency: 'GBP' },
            ],
        },
        async written => {
            const r = await UserService.recordSupportMoney({
                uid: 'u', txnId: 'cs_ancient', amountMinor: 800, nowMs: now,
            });
            assert.strictEqual(r.recorded, false);
            assert.strictEqual(r.reason, 'duplicate_txn');
            assert.strictEqual(written.length, 0);
        },
    );
});

test('recordSupportMoney: the two crediting events of ONE session cannot double-credit', async () => {
    // A delayed payment method completes `unpaid` and settles later, so Stripe
    // sends `checkout.session.completed` and then
    // `checkout.session.async_payment_succeeded` — different event ids, the
    // same session, the same money. Keyed on the session, the second is a
    // duplicate by construction.
    const now = 3_000_000_000_000;
    await withSupportMoneyUserDoc({ stateRev: 1 }, async written => {
        await UserService.recordSupportMoney({ uid: 'u', txnId: 'cs_delayed', amountMinor: 800, nowMs: now });
        assert.strictEqual(written.length, 1);
    });
    await withSupportMoneyUserDoc(
        { supportMoney: [{ txnId: 'cs_delayed', atMs: now, amountMinor: 800, currency: 'GBP' }] },
        async written => {
            const r = await UserService.recordSupportMoney({
                uid: 'u', txnId: 'cs_delayed', amountMinor: 800, nowMs: now + 60_000,
            });
            assert.strictEqual(r.recorded, false);
            assert.strictEqual(written.length, 0);
        },
    );
});

test('recordSupportMoney: a payment for a deleted account writes nothing and does not throw', async () => {
    await withSupportMoneyUserDoc(null, async written => {
        const r = await UserService.recordSupportMoney({
            uid: 'ghost', txnId: 'cs_ghost', amountMinor: 300,
        });
        assert.strictEqual(r.recorded, false);
        assert.strictEqual(r.reason, 'missing_account',
            'the caller must be able to tell this from a benign redelivery');
        assert.strictEqual(written.length, 0);
    });
});

test('recordSupportMoney: a missing amount writes 0 rather than undefined (Firestore rejects undefined)', async () => {
    await withSupportMoneyUserDoc({ stateRev: 1 }, async written => {
        await UserService.recordSupportMoney({ uid: 'u', txnId: 'cs_noamt' });
        const row: any = (written[0] as any).supportMoney[0];
        assert.strictEqual(row.amountMinor, 0);
        assert.strictEqual(row.currency, 'GBP', 'and a default currency, never undefined');
        for (const v of Object.values(row)) assert.notStrictEqual(v, undefined);
    });
});

test('recordSupportMoney: a garbage stored field is replaced rather than crashing the write', async () => {
    // The old OBJECT shape sitting on a document from before this model. There
    // is no migration by design (pre-launch), so the read has to treat it as
    // "no contributions" and the write has to leave a well-formed array.
    await withSupportMoneyUserDoc(
        { supportMoney: { status: 'active', until: 9_999_999_999_999, count: 7 } },
        async written => {
            const r = await UserService.recordSupportMoney({ uid: 'u', txnId: 'cs_new', amountMinor: 400 });
            assert.strictEqual(r.recorded, true);
            const rows: any = (written[0] as any).supportMoney;
            assert.ok(Array.isArray(rows) && rows.length === 1);
            assert.strictEqual(rows[0].txnId, 'cs_new');
        },
    );
});

test('LOGIN CONTRACT: the stored ledger is projected on the login response, not spread raw', async () => {
    const now = Date.now();
    await withSyncableUserDoc(
        {
            uid: 'u', email: 'a@b.c', displayName: 'NAME', stations: [], boards: [], stateRev: 3,
            supportMoney: [
                { txnId: 'cs_new', atMs: now - 1000, amountMinor: 500, currency: 'GBP' },
                { txnId: 'cs_old', atMs: now - 400 * 86_400_000, amountMinor: 800, currency: 'GBP' },
            ],
        },
        async () => {
            const wire = JSON.parse(JSON.stringify(await UserService.createOrUpdateUser(
                'u', 'a@b.c', {}, false, undefined, undefined,
            )));
            assert.ok(wire.supportMoney, 'supportMoney is on the login response');
            assert.strictEqual(wire.supportMoney.isActiveSupporter, true);
            assert.strictEqual(wire.supportMoney.count, 2, 'the count sees every row');
            assert.strictEqual(wire.supportMoney.entries.length, 1, 'but only the newest is served');
            assert.strictEqual(wire.supportMoney.entries[0].txnId, 'cs_new');
            // The login response spreads the stored document, so without the
            // projection the WHOLE ledger would ride out on it — every
            // transaction the account has ever made, on every login.
            assert.ok(!Array.isArray(wire.supportMoney), 'the raw array must not reach the client');
        },
    );
});

test('LOGIN CONTRACT: an account with no support record gets no support key', async () => {
    await withSyncableUserDoc(
        { uid: 'u', email: 'a@b.c', displayName: 'NAME', stations: [], boards: [], stateRev: 3 },
        async () => {
            const wire = JSON.parse(JSON.stringify(await UserService.createOrUpdateUser(
                'u', 'a@b.c', {}, false, undefined, undefined,
            )));
            assert.ok(!('supportMoney' in wire), 'no new key for the current user base');
        },
    );
});


// ─── P4: the socket tier ─────────────────────────────────────────────────────
//
// The third and fastest delivery tier. What matters is that it reaches exactly
// the account it was meant for and nobody else — a frame leaking to the wrong
// uid would hand one user a signal to reconcile against another's account.

test('sendToUid reaches only the sockets belonging to that account', () => {
    const mine1 = fakeSocket();
    const mine2 = fakeSocket();
    const theirs = fakeSocket();
    StationStreamHub.register(mine1, 'uid-me');
    StationStreamHub.register(mine2, 'uid-me');
    StationStreamHub.register(theirs, 'uid-them');

    const sent = StationStreamHub.sendToUid('uid-me', { type: 'user_sync', reason: 'boards', rev: 4 });

    assert.strictEqual(sent, 2);
    assert.strictEqual(mine1.sent.length, 1);
    assert.strictEqual(mine2.sent.length, 1);
    // The whole point. A cross-account leak would tell somebody else's device to
    // reconcile against an account it is not signed into.
    assert.strictEqual(theirs.sent.length, 0);

    const frame = JSON.parse(mine1.sent[0]);
    assert.strictEqual(frame.type, 'user_sync');
    assert.strictEqual(frame.reason, 'boards');
    assert.strictEqual(frame.rev, 4);

    StationStreamHub.unregister(mine1);
    StationStreamHub.unregister(mine2);
    StationStreamHub.unregister(theirs);
});

test('sendToUid skips sockets that are not open', () => {
    const open = fakeSocket();
    const closing = fakeSocket();
    (closing as any).readyState = 2; // CLOSING
    StationStreamHub.register(open, 'uid');
    StationStreamHub.register(closing, 'uid');

    assert.strictEqual(StationStreamHub.sendToUid('uid', { type: 'user_sync' }), 1);
    assert.strictEqual(closing.sent.length, 0);

    StationStreamHub.unregister(open);
    StationStreamHub.unregister(closing);
});

test('sendToUid is a no-op for an account with nothing connected', () => {
    const other = fakeSocket();
    StationStreamHub.register(other, 'somebody-else');
    // Must not throw and must not write. A user with no foregrounded device is
    // the normal case, and the push tiers cover them.
    assert.strictEqual(StationStreamHub.sendToUid('nobody-here', { type: 'user_sync' }), 0);
    assert.strictEqual(StationStreamHub.sendToUid('', { type: 'user_sync' }), 0);
    assert.strictEqual(other.sent.length, 0);
    StationStreamHub.unregister(other);
});

test('sendToUid survives a socket that throws mid-write', () => {
    const bad = fakeSocket();
    const good = fakeSocket();
    (bad as any).send = () => { throw new Error('EPIPE'); };
    StationStreamHub.register(bad, 'uid');
    StationStreamHub.register(good, 'uid');

    // One dead connection must not stop the user's other devices being told.
    // Cleanup is the close handler's job, not this function's.
    assert.strictEqual(StationStreamHub.sendToUid('uid', { type: 'user_sync' }), 1);
    assert.strictEqual(good.sent.length, 1);

    StationStreamHub.unregister(bad);
    StationStreamHub.unregister(good);
});

test('sendToUid does not disturb the station routing table', () => {
    const sock = fakeSocket();
    StationStreamHub.register(sock, 'uid');
    StationStreamHub.subscribe(sock, ['940GZZLUKSX']);

    StationStreamHub.sendToUid('uid', { type: 'user_sync' });

    // An account frame is not a departures frame: it must not touch
    // PredictionCache, and the socket must still be in its station room.
    sock.sent.length = 0;
    StationStreamHub.broadcast('940GZZLUKSX', { id: '940GZZLUKSX', lines: {} }, 'rest');
    assert.strictEqual(sock.sent.length, 1);
    assert.strictEqual(JSON.parse(sock.sent[0]).type, 'update');

    StationStreamHub.unregister(sock);
});

// ─── The frozen Android APK's wire contract ──────────────────────────────────
//
// Android is live on the Play Store at versionCode 2 and NO new APK is being
// built. It therefore cannot be fixed if the backend breaks it, which makes the
// four fields below a hard contract rather than a convention.
//
// At the released client's commit, `UserProfileResponse` declares:
//
//     uid: String              REQUIRED — no default
//     email: String            REQUIRED — no default
//     displayName: String      REQUIRED — no default
//     photoURL: String?  = null
//     address: String?   = null
//     stations: List<SubscribedStation>   REQUIRED — NO DEFAULT
//
// Its Ktor JSON is `ignoreUnknownKeys = true`, so ADDING fields is safe and has
// been proven so in production (`boards`, `boardsUpdatedAt`, and now `stateRev`
// all arrive and are silently discarded). REMOVING one, or sending null for
// one, throws MissingFieldException on EVERY LOGIN — a hard failure, not a
// degraded one. `coerceInputValues` does not save `stations`, because coercion
// falls back to a DEFAULT and `stations` has none.
//
// `stations` is the sharp one: it is the legacy v1 board list, exactly the kind
// of field a later cleanup deletes. These tests are what stands between that
// cleanup and every Android user being locked out.

/**
 * Run [body] with the users collection stubbed to return one document.
 *
 * Replaces `UserService.collection`, NOT `db.collection`. The service binds its
 * collection reference once, as a static initialiser (`private static
 * collection = db.collection('users')`), so swapping `db.collection` afterwards
 * changes nothing and every call still reaches real Firestore.
 */
async function withUserDoc(doc: Record<string, unknown> | null, body: () => Promise<void>): Promise<void> {
    const anyUserService = UserService as any;
    const saved = anyUserService.collection;
    anyUserService.collection = {
        doc: () => ({
            get: async () => ({ exists: doc !== null, data: () => doc ?? undefined }),
        }),
    };
    try { await body(); } finally { anyUserService.collection = saved; }
}

test('ANDROID CONTRACT: the four required fields survive a minimal document', async () => {
    await withUserDoc({ uid: 'u', email: 'a@b.c', displayName: 'A' }, async () => {
        const p: any = await UserService.getUserProfile('u');
        for (const field of ['uid', 'email', 'displayName', 'stations']) {
            assert.ok(field in p, `${field} must be present — the released APK has no default for it`);
            assert.notStrictEqual(p[field], null, `${field} must never be null`);
            assert.notStrictEqual(p[field], undefined, `${field} must never be undefined`);
        }
    });
});

test('ANDROID CONTRACT: stations is always an array even when absent from the document', async () => {
    // The document genuinely has no `stations` — an iOS-only account. The APK
    // still requires the key, so this must not become `undefined` and must not
    // be dropped from the JSON.
    await withUserDoc({ uid: 'u', email: 'a@b.c', displayName: 'A', boards: [] }, async () => {
        const p: any = await UserService.getUserProfile('u');
        assert.ok(Array.isArray(p.stations));
        // And it must survive serialisation — `undefined` vanishes through
        // JSON.stringify, which is how a required key goes missing on the wire
        // without anything on this side looking wrong.
        assert.ok('stations' in JSON.parse(JSON.stringify(p)));
    });
});

test('ANDROID CONTRACT: stateRev is ADDITIVE and never displaces a required field', async () => {
    await withUserDoc({ uid: 'u', email: 'a@b.c', displayName: 'A', stations: [], stateRev: 42 }, async () => {
        const wire = JSON.parse(JSON.stringify(await UserService.getUserProfile('u')));
        assert.strictEqual(wire.stateRev, 42);
        // The APK ignores unknown keys, so stateRev riding along is free — but
        // only while everything it needs is still there beside it.
        assert.strictEqual(wire.uid, 'u');
        assert.strictEqual(wire.email, 'a@b.c');
        assert.strictEqual(wire.displayName, 'A');
        assert.ok(Array.isArray(wire.stations));
    });
});

test('ANDROID CONTRACT: a document predating stateRev reads as 0 not undefined', async () => {
    await withUserDoc({ uid: 'u', email: 'a@b.c', displayName: 'A', stations: [] }, async () => {
        const wire = JSON.parse(JSON.stringify(await UserService.getUserProfile('u')));
        // Zero, not a missing key. `undefined` would vanish through
        // JSON.stringify and the iOS client would decode its default — which is
        // also 0, so this is belt and braces, but it keeps the wire honest and
        // means the field can never be "sometimes there".
        assert.strictEqual(wire.stateRev, 0);
    });
});

test('ANDROID CONTRACT: the legacy stations list is never replaced by boards', async () => {
    const legacy = [{ id: '940GZZLUKSX', line: 'victoria', direction: 'inbound', mode: 'tube' }];
    await withUserDoc(
        { uid: 'u', email: 'a@b.c', displayName: 'A', stations: legacy, boards: [{ id: 'b1', selections: [] }] },
        async () => {
            const p: any = await UserService.getUserProfile('u');
            // Two lists, deliberately. Android reads `stations`; iOS reads
            // `boards`. Collapsing them is what the split exists to prevent, and
            // it would take every Android user's board with it.
            assert.deepStrictEqual(p.stations, legacy);
            assert.strictEqual(p.boards.length, 1);
        },
    );
});

/**
 * `createOrUpdateUser` against a fake user document, for the POST half of the
 * contract. Separate from [withUserDoc] because this path WRITES, so the stub
 * needs an `update`, and `startSession` has to be held off — it is covered by
 * its own tests and would otherwise drag the whole transaction fake in here.
 */
async function withSyncableUserDoc(
    doc: Record<string, unknown> | null,
    body: () => Promise<void>,
): Promise<void> {
    const anyUserService = UserService as any;
    const savedCollection = anyUserService.collection;
    const savedStart = anyUserService.startSession;
    const savedAfter = anyUserService.afterContentWrite;
    anyUserService.startSession = async () => {};
    anyUserService.afterContentWrite = () => {};
    anyUserService.collection = {
        doc: () => ({
            get: async () => ({ exists: doc !== null, data: () => doc ?? undefined }),
            update: async () => {},
            set: async () => {},
        }),
    };
    try { await body(); } finally {
        anyUserService.collection = savedCollection;
        anyUserService.startSession = savedStart;
        anyUserService.afterContentWrite = savedAfter;
    }
}

test('ANDROID CONTRACT: the LOGIN response carries the four required fields too', async () => {
    // ⚠️ The other four ANDROID CONTRACT tests all exercise `getUserProfile`,
    // i.e. GET /user/sync/profile. The released APK ALSO decodes
    // `UserProfileResponse` from the POST — `syncProfile(...).body()`, verified
    // at commit 1a6c846 — and that is the login path, the one a failure locks
    // every Android user out of.
    //
    // It is also the response that has actually shipped broken once: the
    // Firestore-sentinel bug lived here, not on the GET. The test that pins that
    // bug asserts only `stateRev`, so until now nothing checked that the four
    // fields the APK cannot survive losing were still beside it.
    //
    // A CHANGED display name, because that is the branch that builds a non-empty
    // `updateData` and therefore the one that can drop or overwrite a key.
    await withSyncableUserDoc(
        { uid: 'u', email: 'a@b.c', displayName: 'OLD', stations: [{ id: 'A', line: 'victoria' }], stateRev: 3 },
        async () => {
            const profile: any = await UserService.createOrUpdateUser(
                'u', 'a@b.c', { displayName: 'NEW' }, false, undefined, undefined,
            );
            // Through JSON, which is what actually reaches the client. An
            // `undefined` vanishes silently here, and that is precisely how a
            // required key goes missing on the wire while the object on this
            // side still looks correct in a debugger.
            const wire = JSON.parse(JSON.stringify(profile));
            for (const field of ['uid', 'email', 'displayName', 'stations']) {
                assert.ok(field in wire, `${field} must survive the login response — the APK has no default for it`);
                assert.notStrictEqual(wire[field], null, `${field} must never be null`);
            }
            assert.strictEqual(wire.displayName, 'NEW', 'the changed field must be the NEW value');
            assert.ok(Array.isArray(wire.stations));
            assert.strictEqual(wire.stations.length, 1, 'the legacy list must not be emptied by a profile sync');
        },
    );
});

test('ANDROID CONTRACT: a login response never carries a Firestore sentinel in ANY field', async () => {
    // The generalisation of the bug that shipped. Pinning `stateRev` alone
    // guards the one field that has already bitten; the rule is broader and the
    // next violation will be a different field — a `serverTimestamp()` on
    // `updatedAt`, an `arrayUnion` on a list.
    //
    // A sentinel survives JSON.stringify as an opaque OBJECT where the client
    // expects a scalar, so the check is structural rather than by name: no value
    // in this response may be a non-array object unless the schema says so.
    await withSyncableUserDoc(
        { uid: 'u', email: 'a@b.c', displayName: 'OLD', stations: [], boards: [], stateRev: 3 },
        async () => {
            const wire = JSON.parse(JSON.stringify(await UserService.createOrUpdateUser(
                'u', 'a@b.c', { displayName: 'NEW' }, false, undefined, undefined,
            )));
            const structural = new Set(['stations', 'boards', 'preferences', 'sessions']);
            for (const [k, v] of Object.entries(wire)) {
                if (structural.has(k)) continue;
                assert.ok(
                    v === null || typeof v !== 'object' || Array.isArray(v),
                    `${k} serialised as an object (${JSON.stringify(v)}) — a Firestore sentinel reached the wire`,
                );
            }
            assert.strictEqual(typeof wire.stateRev, 'number');
        },
    );
});

// ─── P2: the merged device row ───────────────────────────────────────────────
//
// `rowFrom` is the whole of the storage migration's data mapping, and it is pure
// — so the rules that decide whether a user keeps their push tokens are testable
// without Firestore. Losing a token here is SILENT in production: the device
// simply stops receiving pushes and nothing errors.

const ISO = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

test('rowFrom merges what a device IS with how to REACH it', () => {
    const row = UserDeviceService.rowFrom(
        'dev-1',
        { platform: 'ios', model: 'iPhone', osVersion: 'iOS 26.6', appVersion: '1.0',
          firstSeen: ISO(86400000), lastSeen: ISO(0) },
        { environment: 'production', appToken: 'a'.repeat(64), widgetToken: 'w'.repeat(64), iosVersion: 'IGNORED' },
    );
    // The session says what it is; only the sessions map ever had platform and
    // model, which is why the push registry alone cannot describe a device.
    assert.strictEqual(row.platform, 'ios');
    assert.strictEqual(row.model, 'iPhone');
    // The session's osVersion WINS over the registry's iosVersion when both exist.
    assert.strictEqual(row.osVersion, 'iOS 26.6');
    // The registry says how to reach it.
    assert.strictEqual(row.environment, 'production');
    assert.strictEqual(row.appToken, 'a'.repeat(64));
    assert.strictEqual(row.widgetToken, 'w'.repeat(64));
});

test('rowFrom renames iosVersion to osVersion when only the registry has it', () => {
    const row = UserDeviceService.rowFrom('dev-1', undefined, { iosVersion: 'iOS 26.3', environment: 'sandbox' });
    assert.strictEqual(row.osVersion, 'iOS 26.3');
    // The old spelling must not survive: the merged row is cross-platform and
    // an iOS-specific name was about to describe Android and web devices.
    assert.strictEqual((row as any).iosVersion, undefined);
});

test('rowFrom carries NO uid and NO stations/lines', () => {
    const row: any = UserDeviceService.rowFrom(
        'dev-1',
        { platform: 'ios', firstSeen: ISO(0), lastSeen: ISO(0) },
        { uid: 'someone', stations: ['940GZZLUKSX'], lines: ['victoria'], environment: 'production' },
    );
    // The parent document IS the uid — storing it again is a second copy that
    // can drift from the path holding it.
    assert.strictEqual(row.uid, undefined);
    // Named like device data, holds ACCOUNT data. Dropping them is what stops a
    // board edit rewriting the row on every one of the user's devices.
    assert.strictEqual(row.stations, undefined);
    assert.strictEqual(row.lines, undefined);
});

test('rowFrom converts ISO timestamps to epoch ms', () => {
    const first = ISO(2 * 86400000);
    const last = ISO(86400000);
    const row = UserDeviceService.rowFrom('dev-1', { platform: 'ios', firstSeen: first, lastSeen: last }, undefined);
    // Epoch ms, never ISO — the sweep's range query needs a number, and the
    // house convention for a watermark is an integer.
    assert.strictEqual(typeof row.firstSeen, 'number');
    assert.strictEqual(typeof row.lastSeen, 'number');
    assert.strictEqual(row.firstSeen, Date.parse(first));
    assert.strictEqual(row.lastSeen, Date.parse(last));
});

test('rowFrom never lets lastSeen precede firstSeen', () => {
    // The two sources were written by different paths at different times and can
    // genuinely disagree. A row whose lastSeen is older than its firstSeen would
    // read as impossibly stale to the sweep.
    const row = UserDeviceService.rowFrom(
        'dev-1',
        { platform: 'ios', firstSeen: ISO(0), lastSeen: ISO(10 * 86400000) },
        undefined,
    );
    assert.ok(row.lastSeen >= row.firstSeen);
});

test('rowFrom omits absent fields rather than writing null', () => {
    const row: any = UserDeviceService.rowFrom(
        'dev-1',
        { platform: 'ios', firstSeen: ISO(0), lastSeen: ISO(0) },
        { environment: 'production', appToken: null, widgetToken: null },
    );
    // Firestore rejects `undefined` anywhere in the graph, and a NULL token is
    // worse than an absent one: a row that HAS the field can join a push
    // audience and then be undeliverable.
    assert.ok(!('appToken' in row));
    assert.ok(!('widgetToken' in row));
    assert.ok(!('model' in row));
});

test('rowFrom survives a registry row with no session, and vice versa', () => {
    // Registry only: a device that registered for push while signed out, or one
    // whose session was pruned. Platform is inferred, because the registry never
    // stored one and every row in the field was written by an iOS build.
    const registryOnly = UserDeviceService.rowFrom('dev-1', undefined, { environment: 'sandbox', updatedAt: 1_700_000_000_000 });
    assert.strictEqual(registryOnly.platform, 'ios');
    assert.strictEqual(registryOnly.firstSeen, 1_700_000_000_000);

    // Session only: signed in but never registered for push. No tokens, and that
    // is correct — it has none.
    const sessionOnly: any = UserDeviceService.rowFrom('dev-2', { platform: 'android', firstSeen: ISO(0), lastSeen: ISO(0) }, undefined);
    assert.strictEqual(sessionOnly.platform, 'android');
    assert.ok(!('appToken' in sessionOnly));
    assert.ok(!('environment' in sessionOnly));
});

test('rowFrom always stores deviceId as a FIELD', () => {
    // A collection-group query cannot filter on document id across unknown
    // parents, and the login steal check is exactly such a query. Losing this
    // makes the steal check silently match nothing.
    assert.strictEqual(UserDeviceService.rowFrom('dev-xyz', undefined, undefined).deviceId, 'dev-xyz');
});

// ─── P2c: the audience derivation ────────────────────────────────────────────
//
// After §3.1 took `stations[]` and `lines[]` off the device row, THIS is the
// only place the disruption audience is derived from. Getting it wrong sends
// somebody else's disruption notifications, or none.

test('effectiveLineIds unions both board lists and lower-cases', () => {
    const lines = UserService.effectiveLineIds({
        stations: [{ id: 'a', line: 'Victoria' }],
        boards: [{ id: 'b', selections: [{ naptanId: 'n1', line: 'DISTRICT' }, { naptanId: 'n2', line: 'victoria' }] }],
    });
    // TfL line ids arrive in mixed case across the two lists. A case-sensitive
    // index silently splits one line into two audiences, each getting half the
    // notifications — and nothing errors.
    assert.deepStrictEqual(lines.sort(), ['district', 'victoria']);
});

test('effectiveLineIds tolerates absent and malformed lists', () => {
    assert.deepStrictEqual(UserService.effectiveLineIds(undefined), []);
    assert.deepStrictEqual(UserService.effectiveLineIds({}), []);
    assert.deepStrictEqual(UserService.effectiveLineIds({ boards: 'not an array' as any }), []);
    // A selection with no line contributes nothing rather than an empty-string
    // audience key that would match every other line-less selection.
    assert.deepStrictEqual(UserService.effectiveLineIds({ boards: [{ id: 'b', selections: [{ naptanId: 'n' }] }] }), []);
});

test('effectiveStationIds still collects per-SELECTION naptans not board ids', () => {
    // Regression guard on the trap called out in its own comment: a v2 board's
    // `id` is the HUB, not a naptan anything is fetched from. On a bus hub the
    // pollable ids hang off each direction and differ per pole. Collecting
    // board.id would leave every bus board silently empty while the client's
    // subscription still succeeded.
    const ids = UserService.effectiveStationIds({
        boards: [{ id: '490G00008805', selections: [
            { naptanId: '490008805N' }, { naptanId: '490012211N' },
        ] }],
    });
    assert.deepStrictEqual(ids.sort(), ['490008805N', '490012211N']);
    assert.ok(!ids.includes('490G00008805'));
});

test('isRowLive reads epoch ms and rejects the old ISO shape', () => {
    const DAY = 86400000;
    assert.strictEqual(UserDeviceService.isRowLive({ lastSeen: Date.now() }), true);
    assert.strictEqual(UserDeviceService.isRowLive({ lastSeen: Date.now() - 89 * DAY }), true);
    assert.strictEqual(UserDeviceService.isRowLive({ lastSeen: Date.now() - 91 * DAY }), false);
    // The merged row stores epoch ms where the sessions map stored ISO. An ISO
    // string reaching here means a row was written by the wrong path, and
    // treating it as live would pin the account's holds open forever.
    assert.strictEqual(UserDeviceService.isRowLive({ lastSeen: new Date().toISOString() as any }), false);
    assert.strictEqual(UserDeviceService.isRowLive({}), false);
    assert.strictEqual(UserDeviceService.isRowLive(undefined), false);
});

test('isRowLive survives being passed detached', () => {
    // Called as `docs.some(d => …)` and `.filter(…)` in three places. If TTL_MS
    // is ever read through `this` instead of the class name, this is the only
    // thing that notices — and the failure is a 3am cron throwing, or worse,
    // silently deciding every device is dead.
    const rows = [{ lastSeen: Date.now() }];
    assert.strictEqual(rows.some(UserDeviceService.isRowLive), true);
    assert.strictEqual([undefined].some(UserDeviceService.isRowLive), false);
});

test('a device row with no push token never joins an audience', async () => {
    // Regression guard on a bug this cutover INTRODUCED and staging caught.
    //
    // Under the old root collection a row was created by /device/register, so a
    // row implied a token. Under the merged shape the row is the SESSION —
    // login creates it and deliberately writes no token — so a signed-in device
    // that has not registered for push has a row with no way to reach it.
    //
    // Observed on staging as `APNs → 0/2 device(s)` where the honest count was
    // 1. That inflated `devicesTargeted`, which is precisely the number the
    // design's verification advice ("assert the audience is non-empty, verify
    // the audience, never the send") relies on.
    const anyPush = DevicePushService as any;
    const env = 'production';
    assert.strictEqual(anyPush.isReachable({ deviceId: 'a', appToken: 'x', environment: env }), true);
    assert.strictEqual(anyPush.isReachable({ deviceId: 'b', widgetToken: 'y', environment: env }), true);
    assert.strictEqual(anyPush.isReachable({ deviceId: 'c', environment: env }), false);
    assert.strictEqual(anyPush.isReachable({ deviceId: 'd', appToken: '', widgetToken: '', environment: env }), false);

    // An ENVIRONMENT is as necessary as a token. An APNs token is valid against
    // exactly one host, and guessing is the trap the field exists to prevent: a
    // sandbox token sent to the production gateway comes back BadDeviceToken,
    // which is indistinguishable from a dead token — so the device gets pruned
    // from its own audience for being addressed wrongly.
    assert.strictEqual(anyPush.isReachable({ deviceId: 'e', appToken: 'x' }), false);
});

// ─── The cutover trap: a superseded store that is still readable ─────────────

test('the login short-circuit consults the device ROW not the legacy map', async () => {
    // The bug this pins was found on a real iPhone, not by a test, and nothing
    // errored while it was live.
    //
    // P2c stopped WRITING `users.sessions` but did not DELETE it. The guard that
    // decides whether to run `startSession` was still reading that frozen map,
    // so after a sign-out had deleted the device row the map still showed the
    // device as active — the guard short-circuited, `startSession` never ran,
    // and THE ROW WAS NEVER RECREATED ON SIGN-IN. The device silently dropped
    // out of its own account's push audience while `loggedIn` stayed true on the
    // strength of the account's other devices. Every request returned 200.
    //
    // The general rule: while a superseded store is still readable, "stopped
    // writing it" is not the same as "nothing reads it".
    const anyUds = UserDeviceService as any;
    const savedGet = anyUds.get;
    const asked: string[] = [];
    anyUds.get = async (_uid: string, deviceId: string) => { asked.push(deviceId); return null; };

    const anyUserService = UserService as any;
    const savedCollection = anyUserService.collection;
    let startedFor: string | null = null;
    const savedStart = anyUserService.startSession;
    anyUserService.startSession = async (_uid: string, deviceId: string) => { startedFor = deviceId; };

    // A user document that still carries a STALE sessions map naming the device
    // — precisely the state every account was in immediately after the cutover.
    anyUserService.collection = {
        doc: () => ({
            get: async () => ({
                exists: true,
                data: () => ({
                    uid: 'u', email: 'a@b.c', displayName: 'A', loggedIn: true,
                    sessions: { 'dev-1': { lastSeen: new Date().toISOString() } },
                }),
            }),
            update: async () => {},
        }),
    };

    try {
        await UserService.createOrUpdateUser('u', 'a@b.c', { displayName: 'A' }, false, 'dev-1', undefined);
        // It must have LOOKED at the row…
        assert.ok(asked.includes('dev-1'), 'must consult the device row');
        // …and, finding none, must have run the transaction that recreates it.
        assert.strictEqual(startedFor, 'dev-1', 'a missing row must trigger startSession');
    } finally {
        anyUds.get = savedGet;
        anyUserService.collection = savedCollection;
        anyUserService.startSession = savedStart;
    }
});

test('SIGNUP creates the device row, in the same one place a re-login does', async () => {
    // The new-account branch used to `return newUser` before reaching
    // `startSession`, and its only device work was `DeviceLifecycleService.bind`
    // — a named no-op since P2. So a brand-new account sat at `loggedIn: true`
    // with ZERO device rows, which is precisely the state the nightly sweep
    // reads as "every session on this account has ended".
    //
    // Sign up in the evening, save a station, close the app, and at 03:00 the
    // sweep released the subscription holds and purged the FCM tokens. Silent,
    // and only self-healing on the account's SECOND app open.
    //
    // A comment three lines above the return claimed the branch "falls through
    // to `startSession` below". It did not. That is the shape worth pinning: the
    // code and the comment disagreed, and the comment was the more convincing of
    // the two.
    const anyUserService = UserService as any;
    const savedCollection = anyUserService.collection;
    const savedStart = anyUserService.startSession;
    const savedGetUser = (auth as any).getUser;
    const savedWelcome = (EmailService as any).sendWelcomeEmail;

    let startedFor: string | null = null;
    anyUserService.startSession = async (_uid: string, deviceId: string) => { startedFor = deviceId; };
    (auth as any).getUser = async () => ({ uid: 'new-1' });
    (EmailService as any).sendWelcomeEmail = async () => {};
    anyUserService.collection = {
        doc: () => ({
            // The whole point of this branch: no document yet.
            get: async () => ({ exists: false, data: () => undefined }),
            set: async () => {},
            update: async () => {},
        }),
        // purgeOrphanDocsForEmail runs on this path.
        where: () => ({ get: async () => ({ docs: [] }) }),
    };

    try {
        await UserService.createOrUpdateUser(
            'new-1', 'new@b.c', { displayName: 'New' }, false, 'dev-1', { platform: 'ios' } as any,
        );
        assert.strictEqual(
            startedFor, 'dev-1',
            'a signup must reach startSession — otherwise the account has loggedIn:true and no rows',
        );
    } finally {
        anyUserService.collection = savedCollection;
        anyUserService.startSession = savedStart;
        (auth as any).getUser = savedGetUser;
        (EmailService as any).sendWelcomeEmail = savedWelcome;
    }
});

test('the login short-circuit does NOT skip a row /device/register created', async () => {
    // The second half of the elision race, and the one that made the first fix
    // useless. `startSession` was taught that a row with no `firstSeen` still
    // needs its login write — and nothing changed on the device, because THIS
    // guard has its own copy of the same question and answered first, so the
    // transaction never ran at all.
    //
    // Both now go through `UserService.rowNeedsLoginWrite`. This pins the caller
    // side: a fresh-looking row that login has never written must NOT
    // short-circuit.
    const anyUds = UserDeviceService as any;
    const savedGet = anyUds.get;
    // Exactly what `/device/register`'s upsert leaves behind when it wins the
    // race: reachable, recently seen, and missing everything login owns.
    anyUds.get = async () => ({
        deviceId: 'dev-1', platform: 'ios', lastSeen: Date.now() - 2000,
        appToken: 'a'.repeat(64), environment: 'production',
    });

    const anyUserService = UserService as any;
    const savedCollection = anyUserService.collection;
    const savedAfter = anyUserService.afterContentWrite;
    let started = false;
    const savedStart = anyUserService.startSession;
    anyUserService.startSession = async () => { started = true; };
    anyUserService.afterContentWrite = () => {};
    anyUserService.collection = {
        doc: () => ({
            get: async () => ({
                exists: true,
                data: () => ({ uid: 'u', email: 'a@b.c', displayName: 'A', loggedIn: true, stations: [] }),
            }),
            update: async () => {},
        }),
    };

    try {
        await UserService.createOrUpdateUser('u', 'a@b.c', { displayName: 'A' }, false, 'dev-1', undefined);
        assert.ok(started, 'a row login has never written must still reach startSession');
    } finally {
        anyUds.get = savedGet;
        anyUserService.collection = savedCollection;
        anyUserService.startSession = savedStart;
        anyUserService.afterContentWrite = savedAfter;
    }
});

test('rowNeedsLoginWrite: one predicate, and it reads firstSeen not just freshness', () => {
    const now = Date.now();
    assert.strictEqual(UserService.rowNeedsLoginWrite(undefined, now), true, 'no row at all');
    assert.strictEqual(
        UserService.rowNeedsLoginWrite({ lastSeen: now - 2000, appToken: 'x' }, now), true,
        'a /device/register row is fresh but login has never written it',
    );
    assert.strictEqual(
        UserService.rowNeedsLoginWrite({ firstSeen: now - 86_400_000, lastSeen: now - 60_000 }, now), false,
        'a warm row login owns is left alone — the elision still has to work',
    );
    assert.strictEqual(
        UserService.rowNeedsLoginWrite({ firstSeen: 1, lastSeen: now - 200 * 86_400_000 }, now), true,
        'past the refresh window',
    );
    assert.strictEqual(
        UserService.rowNeedsLoginWrite({ firstSeen: 1, lastSeen: 'nope' as any }, now), true,
        'a non-numeric lastSeen is not a freshness claim',
    );
});

test('the profile sync response never leaks a Firestore sentinel', async () => {
    // This shipped and broke login on the device. `createOrUpdateUser` returned
    // `{...existingData, ...updateData}`, and `updateData` carries
    // `stateRev: FieldValue.increment(1)` — a WRITE INSTRUCTION, not a value.
    // Serialised to JSON it becomes an opaque object; iOS declares
    // `stateRev: Long` and threw; `LoginViewModel` catches, rolls back and signs
    // the user out. The POST returned 200 the whole time.
    //
    // Intermittent in the most misleading way: it only fired when a profile
    // field had actually changed, so the immediate retry wrote nothing, carried
    // no sentinel, and worked.
    const anyUserService = UserService as any;
    const savedCollection = anyUserService.collection;
    const savedStart = anyUserService.startSession;
    anyUserService.startSession = async () => {};
    anyUserService.collection = {
        doc: () => ({
            get: async () => ({
                exists: true,
                data: () => ({ uid: 'u', email: 'a@b.c', displayName: 'OLD', stations: [], stateRev: 4 }),
            }),
            update: async () => {},
        }),
    };
    try {
        // A CHANGED display name, so updateData is non-empty — the only case
        // that ever carried the sentinel.
        const profile: any = await UserService.createOrUpdateUser(
            'u', 'a@b.c', { displayName: 'NEW' }, false, undefined, undefined,
        );
        assert.strictEqual(typeof profile.stateRev, 'number', 'stateRev must be a number on the wire');
        // Optimistic next value: it may undershoot under concurrency, never exceed.
        assert.strictEqual(profile.stateRev, 5);
        // And the whole response must survive a JSON round trip, which is what
        // actually reaches the client.
        assert.strictEqual(JSON.parse(JSON.stringify(profile)).stateRev, 5);
    } finally {
        anyUserService.collection = savedCollection;
        anyUserService.startSession = savedStart;
    }
});


// ─── P2: the session transactions ────────────────────────────────────────────
//
// `startSession` and `endSession` are the riskiest code in this migration and
// had NO tests at all — they appeared in this file only as stubs being replaced
// by the two tests above. What is uncovered by that is exactly what is hardest
// to see in review and impossible to see in production:
//
//   - the per-attempt flag reset. Firestore RETRIES a transaction callback on
//     contention, and the result flags live outside it. The comment in
//     `startSession` says this was "already bitten once"; nothing stopped it
//     being bitten twice.
//   - all reads before any writes. Firestore rejects a read after a write, and
//     the steal reads documents whose identity is only known after a query
//     returns — so the ordering is load-bearing and easy to break by adding one
//     innocent-looking read.
//   - the steal itself: victim selection, the root-collection skip, and the
//     victim's last-out transition.
//   - retry idempotence of the whole thing.
//
// The harness below is the same shape as `withRegistry` above: swap
// `db.runTransaction` for a fake over an in-memory world. It is more machinery
// than that one because these transactions read three different SHAPES — a
// document, a subcollection, and a collection-group query — and the difference
// between them is where the bugs live.

/** One account in the fake world. */
interface FakeAccount {
    doc: Record<string, any> | null;
    devices: Record<string, Record<string, any>>;
}

/** A row sitting in the RETIRED root `devices` collection, which a group query also matches. */
interface FakeRootRow { id: string; data: Record<string, any>; }

interface SessionWorld {
    accounts: Record<string, FakeAccount>;
    rootRows: FakeRootRow[];
    /** Every write the transaction issued, in order. */
    writes: Array<{ op: 'update' | 'set' | 'delete'; path: string; patch?: Record<string, any>; merge?: boolean }>;
    /** Read/write opcodes in order, so "all reads before writes" is assertable. */
    ops: string[];
    /** `applySubscriptionDelta(before, after)` calls, post-transaction. */
    deltas: Array<{ before: string[]; after: string[] }>;
    /** `DeviceLifecycleService.release(uid, deviceId, lastOut)` calls. */
    releases: Array<{ uid: string; deviceId?: string; lastOut: boolean }>;
    /** Attempts the transaction callback actually ran. */
    attempts: number;
}

/**
 * Run [body] against a fake Firestore built from [accounts].
 *
 * [onAttempt] is called before each transaction attempt with the attempt number
 * (1-based) and the world, so a test can MUTATE the world between attempts —
 * which is how a contention retry is simulated. Return the number of attempts
 * to run; anything above 1 exercises the retry path. Only the final attempt's
 * writes are kept, because that is what Firestore does with a losing attempt.
 */
async function withSessionWorld(
    accounts: Record<string, FakeAccount>,
    body: (w: SessionWorld) => Promise<void>,
    opts: { rootRows?: FakeRootRow[]; attempts?: number; beforeAttempt?: (n: number, w: SessionWorld) => void } = {},
): Promise<void> {
    const world: SessionWorld = {
        accounts,
        rootRows: opts.rootRows ?? [],
        writes: [], ops: [], deltas: [], releases: [], attempts: 0,
    };

    const anyDb = db as any;
    const anyUser = UserService as any;
    const anyDevices = UserDeviceService as any;
    const anyLifecycle = DeviceLifecycleService as any;

    const savedRunTx = anyDb.runTransaction;
    const savedGroup = anyDb.collectionGroup;
    const savedCollection = anyUser.collection;
    const savedDevices = anyDevices.devices;
    const savedDelta = anyUser.applySubscriptionDelta;
    const savedRelease = anyLifecycle.release;

    // A document handle carries its own path so writes are attributable.
    const userDoc = (uid: string) => ({ __kind: 'userDoc', uid, path: `users/${uid}` });
    const deviceDoc = (uid: string, id: string) =>
        ({ __kind: 'deviceDoc', uid, id, path: `users/${uid}/devices/${id}` });
    const devicesCol = (uid: string) => ({
        __kind: 'devicesCol', uid,
        doc: (id: string) => deviceDoc(uid, id),
    });

    /** A subcollection row's `.ref.parent.parent` is its ACCOUNT document. */
    const subRowSnap = (uid: string, id: string, data: Record<string, any>) => ({
        id, data: () => data,
        ref: { ...deviceDoc(uid, id), parent: { parent: { id: uid } } },
    });
    /** A ROOT-collection row's is null — the whole basis of the parent filter. */
    const rootRowSnap = (r: FakeRootRow) => ({
        id: r.id, data: () => r.data,
        ref: { __kind: 'rootDoc', id: r.id, path: `devices/${r.id}`, parent: { parent: null } },
    });

    anyUser.collection = { doc: userDoc };
    anyDevices.devices = devicesCol;
    anyDb.collectionGroup = (name: string) => ({
        where: (field: string, _op: string, value: unknown) =>
            ({ __kind: 'groupQuery', name, field, value }),
    });
    anyUser.applySubscriptionDelta = (before: string[], after: string[]) => {
        world.deltas.push({ before, after });
    };
    anyLifecycle.release = async (uid: string, deviceId: string | undefined, lastOut: boolean) => {
        world.releases.push({ uid, deviceId, lastOut });
    };

    anyDb.runTransaction = async (fn: (tx: any) => Promise<void>) => {
        const total = opts.attempts ?? 1;
        for (let n = 1; n <= total; n++) {
            world.attempts = n;
            opts.beforeAttempt?.(n, world);
            // A losing attempt's writes are DISCARDED by Firestore. Modelling
            // that is the whole point: it is what makes a leaked result flag
            // observable, because the flag survives while the writes do not.
            world.writes = [];
            world.ops = [];

            // Writes land in the world, not just in the log.
            //
            // Every test here used to assert on the WRITE LIST, which answers
            // "what did this transaction do" and cannot answer "what does the row
            // look like once two different writers have both had a go". That
            // second question is the one the sign-in race turned on, and it was
            // unaskable — which is why the race was found on a phone instead.
            //
            // Merge semantics, because that is what `tx.set(..., {merge:true})`
            // does; a wholesale replace here would make the merge tests pass for
            // the wrong reason.
            // ⚠️ HONOURS the merge flag. `set(ref, data)` REPLACES in Firestore;
            // only `set(ref, data, {merge:true})` merges.
            //
            // Modelling both as a merge made the harness kinder than the database
            // and cost a real assertion: a mutant that dropped `{merge:true}` from
            // login's row write — which in production would wipe the push tokens
            // `/device/register` had just written — passed the whole suite. A fake
            // that is more forgiving than the thing it stands in for does not test
            // the code, it tests the fake.
            const apply = (ref: any, patch: Record<string, any>, merge: boolean) => {
                const acct = world.accounts[ref.uid];
                if (!acct) return;
                if (ref.__kind === 'deviceDoc') {
                    const prev = merge ? (acct.devices[ref.id] ?? {}) : {};
                    acct.devices[ref.id] = { ...prev, ...patch };
                } else if (ref.__kind === 'userDoc' && acct.doc) {
                    // `tx.update` is always a merge of the named fields.
                    acct.doc = { ...acct.doc, ...patch };
                }
            };

            const tx = {
                get: async (target: any) => {
                    if (target.__kind === 'userDoc') {
                        world.ops.push(`read:users/${target.uid}`);
                        const acct = world.accounts[target.uid];
                        const data = acct?.doc ?? null;
                        return { exists: data !== null, data: () => data ?? undefined };
                    }
                    if (target.__kind === 'devicesCol') {
                        world.ops.push(`read:users/${target.uid}/devices`);
                        const rows = world.accounts[target.uid]?.devices ?? {};
                        const docs = Object.entries(rows).map(([id, d]) => subRowSnap(target.uid, id, d));
                        return { docs, size: docs.length };
                    }
                    if (target.__kind === 'groupQuery') {
                        world.ops.push(`read:group:${target.field}=${String(target.value)}`);
                        const docs: any[] = [];
                        for (const [uid, acct] of Object.entries(world.accounts)) {
                            for (const [id, d] of Object.entries(acct.devices)) {
                                if (d[target.field] === target.value) docs.push(subRowSnap(uid, id, d));
                            }
                        }
                        // The retired root collection matches the SAME group query.
                        for (const r of world.rootRows) {
                            if (r.data[target.field] === target.value) docs.push(rootRowSnap(r));
                        }
                        return { docs, size: docs.length };
                    }
                    throw new Error(`unexpected tx.get target ${JSON.stringify(target)}`);
                },
                update: (ref: any, patch: Record<string, any>) => {
                    world.ops.push(`write:${ref.path}`);
                    world.writes.push({ op: 'update', path: ref.path, patch });
                    apply(ref, patch, true);
                },
                set: (ref: any, patch: Record<string, any>, options?: { merge?: boolean }) => {
                    world.ops.push(`write:${ref.path}`);
                    world.writes.push({ op: 'set', path: ref.path, patch, merge: options?.merge === true });
                    apply(ref, patch, options?.merge === true);
                },
                delete: (ref: any) => {
                    world.ops.push(`write:${ref.path}`);
                    world.writes.push({ op: 'delete', path: ref.path });
                    if (ref.__kind === 'deviceDoc') delete world.accounts[ref.uid]?.devices[ref.id];
                },
            };
            await fn(tx);
        }
    };

    try {
        await body(world);
        // ⚠️ Drain the deferred work into THIS world before the stubs come down.
        //
        // `startSession` fires the victim's FCM release from a `setImmediate`, so
        // it is still queued when `body` returns. Without this it lands during
        // some LATER test, whose harness has re-stubbed the same method — and
        // because these tests reuse account names, the stray call is
        // indistinguishable from that test's own. It cost a confusing
        // double-count before this line existed; leaving it out makes every test
        // here quietly non-hermetic.
        await new Promise(resolve => setImmediate(resolve));
    } finally {
        anyDb.runTransaction = savedRunTx;
        anyDb.collectionGroup = savedGroup;
        anyUser.collection = savedCollection;
        anyDevices.devices = savedDevices;
        anyUser.applySubscriptionDelta = savedDelta;
        anyLifecycle.release = savedRelease;
    }
}

const FRESH = () => Date.now() - 1000;
const ANCIENT = () => Date.now() - 200 * 24 * 60 * 60 * 1000;

/** Assert no read was issued after the first write — Firestore forbids it outright. */
function assertReadsBeforeWrites(ops: string[]) {
    const firstWrite = ops.findIndex(o => o.startsWith('write:'));
    if (firstWrite === -1) return;
    const lateRead = ops.slice(firstWrite).find(o => o.startsWith('read:'));
    assert.strictEqual(
        lateRead, undefined,
        `a read (${lateRead}) was issued after the first write — Firestore rejects this at runtime:\n  ${ops.join('\n  ')}`,
    );
}

test('startSession: all reads happen before any write, steal included', async () => {
    // The steal reads documents whose identity is only known once the
    // collection-group query has returned, so the victim reads MUST still be
    // gathered above the write section. This is the constraint most easily
    // broken by adding one reasonable-looking read.
    await withSessionWorld({
        me:     { doc: { loggedIn: false, stations: [] }, devices: {} },
        victim: { doc: { loggedIn: true, stations: [] }, devices: { 'dev-1': { deviceId: 'dev-1', lastSeen: FRESH() } } },
    }, async w => {
        await UserService.startSession('me', 'dev-1', { platform: 'ios' } as any);
        assertReadsBeforeWrites(w.ops);
        // And prove the victim really was read, so the assertion above is not
        // passing merely because the steal never ran.
        assert.ok(w.ops.includes('read:users/victim'), 'the victim account must be read');
        assert.ok(w.ops.includes('read:users/victim/devices'), "the victim's devices must be read");
    });
});

test('startSession: a retry does NOT double-count the activation', async () => {
    // THE bug the code comment calls "already bitten once".
    //
    // Attempt 1 reads `loggedIn: false` and decides this is an activation.
    // Another device wins the race and the account is now logged in. Attempt 2
    // reads `loggedIn: true` and correctly decides NOT to activate — but if
    // `didActivate` is only ever set to true, the flag survives from attempt 1
    // and every saved station on the account is counted TWICE for one logical
    // activation. An inflated count never self-corrects: `updateCount` releases
    // a station only at 0, so the Syncer polls TfL for it forever.
    await withSessionWorld({
        me: { doc: { loggedIn: false, stations: [{ id: 'A', line: 'victoria' }] }, devices: {} },
    }, async w => {
        await UserService.startSession('me', 'dev-1', { platform: 'ios' } as any);
        assert.strictEqual(w.attempts, 2, 'the harness must have retried');
        assert.deepStrictEqual(w.deltas, [], 'attempt 2 saw an active account — nothing to activate');
    }, {
        attempts: 2,
        beforeAttempt: (n, w) => {
            // Between the attempts, another device signs in.
            if (n === 2) w.accounts.me.doc!.loggedIn = true;
        },
    });
});

test('startSession: a retry does NOT re-release a victim that came back', async () => {
    // The same hazard on the more dangerous flag. `deactivated` accumulates
    // victims, and a stale entry DECREMENTS an account that is still signed in
    // — which can take a live station away from every other user watching it.
    await withSessionWorld({
        me:     { doc: { loggedIn: true, stations: [] }, devices: {} },
        victim: { doc: { loggedIn: true, stations: [{ id: 'VIC', line: 'victoria' }] },
                  devices: { 'dev-1': { deviceId: 'dev-1', lastSeen: FRESH() } } },
    }, async w => {
        await UserService.startSession('me', 'dev-1', { platform: 'ios' } as any);
        assert.strictEqual(w.attempts, 2);
        // On attempt 2 the victim has a SECOND device, so it is not their last
        // one out and nothing may be released. If `deactivated` were not reset,
        // attempt 1's entry would still be there and VIC would be decremented.
        assert.deepStrictEqual(w.deltas, []);
        assert.deepStrictEqual(w.releases, []);
    }, {
        attempts: 2,
        beforeAttempt: (n, w) => {
            if (n === 2) w.accounts.victim.devices['dev-2'] = { deviceId: 'dev-2', lastSeen: FRESH() };
        },
    });
});

test('startSession: the steal deletes the other account\'s row and runs its last-out transition', async () => {
    await withSessionWorld({
        me:     { doc: { loggedIn: true, stations: [] }, devices: {} },
        victim: { doc: { loggedIn: true, stations: [{ id: 'VIC', line: 'victoria' }] },
                  devices: { 'dev-1': { deviceId: 'dev-1', lastSeen: FRESH() } } },
    }, async w => {
        await UserService.startSession('me', 'dev-1', { platform: 'ios' } as any);

        // The victim's row is gone…
        assert.ok(w.writes.some(x => x.op === 'delete' && x.path === 'users/victim/devices/dev-1'),
            'the stolen row must be deleted');
        // …their flag is down…
        const flag = w.writes.find(x => x.path === 'users/victim' && x.op === 'update');
        assert.strictEqual(flag?.patch?.loggedIn, false);
        // …and their hold is released exactly once, for the stations they held.
        assert.deepStrictEqual(w.deltas, [{ before: ['VIC'], after: [] }]);
        // The legacy FCM store is keyed by token and can only be cleared on the
        // last-device-out gate, so the steal has to fire it for the victim.
        //
        // Deferred by a `setImmediate` in the source — deliberately, so a slow
        // Firestore delete cannot hold up the login that triggered it. Drained
        // here because this assertion is inside `body`, which runs before the
        // harness's own drain.
        await new Promise(resolve => setImmediate(resolve));
        assert.deepStrictEqual(w.releases, [{ uid: 'victim', deviceId: undefined, lastOut: true }]);
    });
});

test('startSession: a victim with another device is NOT signed out', async () => {
    await withSessionWorld({
        me:     { doc: { loggedIn: true, stations: [] }, devices: {} },
        victim: { doc: { loggedIn: true, stations: [{ id: 'VIC', line: 'victoria' }] },
                  devices: {
                      'dev-1': { deviceId: 'dev-1', lastSeen: FRESH() },
                      'dev-2': { deviceId: 'dev-2', lastSeen: FRESH() },
                  } },
    }, async w => {
        await UserService.startSession('me', 'dev-1', { platform: 'ios' } as any);
        // Their phone is taken; their tablet is not. The row goes, the account stays.
        assert.ok(w.writes.some(x => x.op === 'delete' && x.path === 'users/victim/devices/dev-1'));
        assert.ok(!w.writes.some(x => x.path === 'users/victim' && x.patch?.loggedIn === false),
            'an account with a live device must never be deactivated');
        assert.deepStrictEqual(w.deltas, [], 'nothing may be released while they still hold a session');
    });
});

test('startSession: a ROOT-collection row is never mistaken for a session to steal', async () => {
    // ⚠️ The parent filter. A collection GROUP matches every collection of that
    // name at any depth, INCLUDING the retired root `devices`. A stale root row
    // read as a live session would make login "steal" a session that does not
    // exist — signing a real user out of a device they are still using.
    await withSessionWorld({
        me: { doc: { loggedIn: true, stations: [] }, devices: {} },
    }, async w => {
        await UserService.startSession('me', 'dev-1', { platform: 'ios' } as any);
        assert.deepStrictEqual(w.deltas, [], 'a root row must release nobody');
        assert.deepStrictEqual(w.releases, []);

        // The strong form: a skipped row must never become a VICTIM, and a
        // victim is read before it is written. So no account other than our own
        // may be read at all.
        //
        // Asserting only "no delete under devices/" was too weak to catch this:
        // a filter that mis-derives the parent writes to `users/<whatever>/…`,
        // not to the root path, so the narrower check passed against a mutant
        // that had genuinely broken the rule.
        const foreignReads = w.ops.filter(o => o.startsWith('read:users/') && !o.startsWith('read:users/me'));
        assert.deepStrictEqual(foreignReads, [], `a root row must never be resolved to an account: ${foreignReads}`);
        const foreignWrites = w.writes.filter(x => !x.path.startsWith('users/me'));
        assert.deepStrictEqual(foreignWrites, [], 'nothing outside this account may be written');
    }, {
        // The shape staging really had: a retired root row for the same device.
        rootRows: [{ id: 'dev-1', data: { deviceId: 'dev-1', uid: 'someone-else', lastSeen: FRESH() } }],
    });
});

test('startSession: your own row is not a theft', async () => {
    await withSessionWorld({
        me: { doc: { loggedIn: true, stations: [{ id: 'A', line: 'victoria' }] },
              devices: { 'dev-1': { deviceId: 'dev-1', lastSeen: ANCIENT() } } },
    }, async w => {
        await UserService.startSession('me', 'dev-1', { platform: 'ios' } as any);
        assert.deepStrictEqual(w.deltas, [], 'signing in again must not release your own hold');
        assert.ok(!w.writes.some(x => x.op === 'delete' && x.path === 'users/me/devices/dev-1'),
            'the row being refreshed must never be deleted as a steal');
    });
});

test('startSession: the login write never invents a token field', async () => {
    // Only /device/register supplies tokens. A login that wrote one — or wrote
    // `undefined` into one — would put a token-less phantom into the broadcast
    // audience, which is the trap the old root-collection `bind` was bitten by.
    await withSessionWorld({
        me: { doc: { loggedIn: true, stations: [] }, devices: {} },
    }, async w => {
        // The deviceInfo deliberately CARRIES token fields. A client can put
        // anything in this object, and the rule is that login ignores them
        // whatever arrives — so a test passing a clean deviceInfo proves
        // nothing, because the forbidden keys would be absent either way.
        await UserService.startSession('me', 'dev-1', {
            platform: 'ios', model: 'iPhone12,1',
            appToken: 'a'.repeat(64), widgetToken: 'w'.repeat(64),
            fcmToken: 'fcm-token', environment: 'production',
        } as any);
        const row = w.writes.find(x => x.path === 'users/me/devices/dev-1' && x.op === 'set');
        assert.ok(row, 'the device row must be written');
        for (const forbidden of ['appToken', 'widgetToken', 'fcmToken', 'environment']) {
            assert.ok(!(forbidden in row!.patch!),
                `login must not write ${forbidden}, even when the client sends it`);
        }
        // And no undefined anywhere: Firestore rejects the whole write.
        for (const [k, v] of Object.entries(row!.patch!)) {
            assert.notStrictEqual(v, undefined, `${k} must be stripped, not written as undefined`);
        }
        assert.strictEqual(row!.patch!.deviceId, 'dev-1', 'deviceId must be stored as a FIELD');
    });
});

test('startSession: a warm re-open writes nothing at all', async () => {
    // The write-elision that keeps the hot user document off the per-open path.
    //
    // `firstSeen` is present because a row LOGIN has written always has one —
    // leaving it out made this fixture describe a row only `/device/register`
    // could have produced, which is a different case entirely and now has its own
    // test above.
    await withSessionWorld({
        me: { doc: { loggedIn: true, stations: [] },
              devices: { 'dev-1': {
                  deviceId: 'dev-1', platform: 'ios',
                  firstSeen: Date.now() - 86_400_000, lastSeen: Date.now() - 60_000,
              } } },
    }, async w => {
        await UserService.startSession('me', 'dev-1', { platform: 'ios' } as any);
        assert.deepStrictEqual(w.writes, [], 'an unchanged re-open inside the refresh window must be free');
    });
});

test('startSession: a row created by /device/register still gets its login fields', async () => {
    // The elision race, measured on the connected iPhone rather than imagined.
    //
    // Once iOS started registering for push at sign-in, `/device/register` began
    // WINNING the race against `/user/sync/profile`: three registrations landed
    // between the logout and the profile POST. `upsert` creates the row, so by
    // the time this transaction ran there was an `existing` row with a `lastSeen`
    // two seconds old — and the freshness elision skipped the whole write.
    //
    // The result was a row with tokens but no `firstSeen` and no `model`, and it
    // was PERMANENT: every subsequent login took the same short-circuit, because
    // the field that made the row look fresh was refreshed by the one path that
    // cannot supply what was missing.
    await withSessionWorld({
        me: {
            doc: { loggedIn: true, stations: [] },
            devices: {
                // Exactly what `/device/register` leaves behind: reachable, and
                // missing everything only login writes.
                'dev-1': {
                    deviceId: 'dev-1', platform: 'ios', lastSeen: Date.now() - 2000,
                    appToken: 'a'.repeat(64), widgetToken: 'w'.repeat(64),
                    environment: 'production',
                },
            },
        },
    }, async w => {
        await UserService.startSession('me', 'dev-1', { platform: 'ios', model: 'iPhone12,1' } as any);

        const row = w.writes.find(x => x.path === 'users/me/devices/dev-1' && x.op === 'set');
        assert.ok(row, 'a row with no firstSeen must NOT be treated as fresh — login has never written it');
        assert.strictEqual(typeof row!.patch!.firstSeen, 'number', 'firstSeen must be filled in');
        assert.strictEqual(row!.patch!.model, 'iPhone12,1', 'model is login-owned and must be written');
        // And it still must not touch the tokens the registration just wrote.
        for (const forbidden of ['appToken', 'widgetToken', 'environment']) {
            assert.ok(!(forbidden in row!.patch!), `login must not write ${forbidden}`);
        }
    });
});

test('startSession: stale sibling rows are pruned lazily', async () => {
    await withSessionWorld({
        me: { doc: { loggedIn: true, stations: [] },
              devices: {
                  'dev-1': { deviceId: 'dev-1', lastSeen: FRESH() },
                  'old-1': { deviceId: 'old-1', lastSeen: ANCIENT() },
              } },
    }, async w => {
        await UserService.startSession('me', 'dev-1', { platform: 'ios' } as any);
        assert.ok(w.writes.some(x => x.op === 'delete' && x.path === 'users/me/devices/old-1'),
            'a row past the TTL must be pruned by the account\'s next login');
        assert.ok(!w.writes.some(x => x.op === 'delete' && x.path === 'users/me/devices/dev-1'));
    });
});

// ─── The sign-in RACE, both orderings ────────────────────────────────────────
//
// `/device/register` and `/user/sync/profile` both write
// `users/{uid}/devices/{deviceId}`, they own DIFFERENT fields, and since iOS
// began registering at sign-in they arrive in either order within a few hundred
// milliseconds. This is the seam that broke twice in one afternoon, and both
// times it was found on a device because every test here exercised one path at
// a time.
//
// The invariant, stated once: whichever writer lands first, the finished row
// carries the UNION — login's identity fields AND registration's push address.
// Neither writer may erase or suppress the other's half.

/** What `/device/register`'s `UserDeviceService.upsert` leaves on the row. */
const REGISTRATION_WRITE = {
    deviceId: 'dev-1',
    platform: 'ios' as const,
    appToken: 'a'.repeat(64),
    widgetToken: 'w'.repeat(64),
    environment: 'production' as const,
    osVersion: 'iOS 26.3',
    appVersion: '1.0',
};

test('sign-in race: registration lands FIRST, login still adds its own fields', async () => {
    // The ordering actually measured on the connected iPhone: three
    // registrations between the logout and the profile sync. The row exists and
    // looks fresh before login ever runs.
    await withSessionWorld({
        me: {
            doc: { loggedIn: true, stations: [] },
            devices: { 'dev-1': { ...REGISTRATION_WRITE, lastSeen: Date.now() - 2000 } },
        },
    }, async w => {
        await UserService.startSession('me', 'dev-1', { platform: 'ios', model: 'iPhone12,1' } as any);

        const row = w.accounts.me.devices['dev-1'];
        // Login's half — the fields that went missing in production.
        assert.strictEqual(typeof row.firstSeen, 'number', 'firstSeen must be filled in');
        assert.strictEqual(row.model, 'iPhone12,1', 'model is login-owned');
        // Registration's half must SURVIVE. A login that clobbered these would
        // silently unreachable the device, which is the same outcome by the
        // opposite route.
        assert.strictEqual(row.appToken, REGISTRATION_WRITE.appToken);
        assert.strictEqual(row.widgetToken, REGISTRATION_WRITE.widgetToken);
        assert.strictEqual(row.environment, 'production');
    });
});

test('sign-in race: login lands FIRST, registration still adds the push address', async () => {
    // The other ordering, and the one that looks obviously fine — which is
    // exactly why it is worth pinning. Login creates the row with no tokens by
    // design; the registration that follows must be able to merge them on.
    await withSessionWorld({
        me: { doc: { loggedIn: true, stations: [] }, devices: {} },
    }, async w => {
        await UserService.startSession('me', 'dev-1', { platform: 'ios', model: 'iPhone12,1' } as any);

        const afterLogin = w.accounts.me.devices['dev-1'];
        assert.ok(afterLogin, 'login must create the row');
        assert.strictEqual(afterLogin.appToken, undefined, 'login must NOT invent a token');

        // Now the registration merges in, exactly as `upsert` does.
        w.accounts.me.devices['dev-1'] = { ...afterLogin, ...REGISTRATION_WRITE };

        const row = w.accounts.me.devices['dev-1'];
        assert.strictEqual(typeof row.firstSeen, 'number', "login's firstSeen must survive the merge");
        assert.strictEqual(row.model, 'iPhone12,1', "login's model must survive the merge");
        assert.strictEqual(row.appToken, REGISTRATION_WRITE.appToken);
    });
});

test('sign-in race: a SECOND login does not re-elide a row already made whole', async () => {
    // The permanence half of the bug. Once the row has both halves, the elision
    // must go back to doing its job — otherwise the fix for the race would turn
    // every warm re-open back into a write, which is the cost the elision exists
    // to remove.
    const now = Date.now();
    await withSessionWorld({
        me: {
            doc: { loggedIn: true, stations: [] },
            devices: { 'dev-1': {
                ...REGISTRATION_WRITE,
                model: 'iPhone12,1',
                firstSeen: now - 86_400_000,
                lastSeen: now - 60_000,
            } },
        },
    }, async w => {
        await UserService.startSession('me', 'dev-1', { platform: 'ios', model: 'iPhone12,1' } as any);
        assert.deepStrictEqual(w.writes, [], 'a complete, warm row must still cost nothing');
    });
});

test('endSession: a retry does NOT decrement an account that signed back in', async () => {
    // The more dangerous direction of the same reset rule. `updateCount` deletes
    // a station at 0, so a decrement that should not have happened can take a
    // live station away from every OTHER user watching it.
    await withSessionWorld({
        me: { doc: { loggedIn: true, stations: [{ id: 'A', line: 'victoria' }] }, devices: {} },
    }, async w => {
        await UserService.endSession('me', 'dev-1');
        assert.strictEqual(w.attempts, 2);
        assert.deepStrictEqual(w.deltas, [], 'attempt 2 found a live device — nothing to release');
        assert.deepStrictEqual(w.releases, [{ uid: 'me', deviceId: 'dev-1', lastOut: false }]);
    }, {
        attempts: 2,
        beforeAttempt: (n, w) => {
            if (n === 2) w.accounts.me.devices['dev-2'] = { deviceId: 'dev-2', lastSeen: FRESH() };
        },
    });
});

test('endSession: the last device out releases the union of BOTH board lists', async () => {
    await withSessionWorld({
        me: {
            doc: {
                loggedIn: true,
                // Android's legacy list and an iOS board, which are different
                // stations. Releasing only one list would strand the other.
                stations: [{ id: 'LEGACY', line: 'victoria' }],
                // naptanId, not id: a board's `id` is the HUB and is not a
                // stop anything is fetched from. See `effectiveStationIds`.
                boards: [{ id: 'b1', selections: [{ naptanId: 'V2', line: 'central' }] }],
            },
            devices: { 'dev-1': { deviceId: 'dev-1', lastSeen: FRESH() } },
        },
    }, async w => {
        await UserService.endSession('me', 'dev-1');
        assert.ok(w.writes.some(x => x.op === 'delete' && x.path === 'users/me/devices/dev-1'));
        assert.strictEqual(w.deltas.length, 1, 'exactly one delta, never two');
        assert.deepStrictEqual([...w.deltas[0].before].sort(), ['LEGACY', 'V2']);
        assert.deepStrictEqual(w.deltas[0].after, []);
        assert.deepStrictEqual(w.releases, [{ uid: 'me', deviceId: 'dev-1', lastOut: true }]);
    });
});

test('endSession: one device out of two releases nothing', async () => {
    await withSessionWorld({
        me: { doc: { loggedIn: true, stations: [{ id: 'A', line: 'victoria' }] },
              devices: {
                  'dev-1': { deviceId: 'dev-1', lastSeen: FRESH() },
                  'dev-2': { deviceId: 'dev-2', lastSeen: FRESH() },
              } },
    }, async w => {
        await UserService.endSession('me', 'dev-1');
        assert.ok(w.writes.some(x => x.op === 'delete' && x.path === 'users/me/devices/dev-1'));
        assert.ok(!w.writes.some(x => x.path === 'users/me' && x.op === 'update'),
            'loggedIn must not move while another device holds a session');
        assert.deepStrictEqual(w.deltas, []);
        assert.deepStrictEqual(w.releases, [{ uid: 'me', deviceId: 'dev-1', lastOut: false }]);
    });
});

test('endSession: a replayed logout cannot touch a session that moved accounts', async () => {
    // The replay-safety argument, made executable. `PendingOps` queues a logout
    // durably and can replay it long afterwards; the guarantee is that it
    // addresses `users/{uid}/devices/{deviceId}`, a path that NAMES the account.
    // If B has since signed in on that device, B's row is under a different
    // parent and A's replay cannot see it.
    await withSessionWorld({
        A: { doc: { loggedIn: false, stations: [{ id: 'A1', line: 'victoria' }] }, devices: {} },
        B: { doc: { loggedIn: true, stations: [{ id: 'B1', line: 'central' }] },
             devices: { 'dev-1': { deviceId: 'dev-1', lastSeen: FRESH() } } },
    }, async w => {
        await UserService.endSession('A', 'dev-1');
        // Nothing of B's may be written, at all.
        assert.ok(!w.writes.some(x => x.path.startsWith('users/B')),
            "a replayed logout for A must never write anything under B");
        assert.deepStrictEqual(w.deltas, [], "B's hold must survive A's replay");
    });
});

test('endSession: loggedIn true with zero rows self-heals', async () => {
    // Repairs the `loggedIn: true, sessions: {}` artefact the old shape could
    // produce, and is what the drift cron's true→false heal delegates to.
    await withSessionWorld({
        me: { doc: { loggedIn: true, stations: [{ id: 'A', line: 'victoria' }] }, devices: {} },
    }, async w => {
        await UserService.endSession('me');
        const flag = w.writes.find(x => x.path === 'users/me' && x.op === 'update');
        assert.strictEqual(flag?.patch?.loggedIn, false);
        assert.deepStrictEqual(w.deltas, [{ before: ['A'], after: [] }]);
    });
});

test('endSession: sign-out-everywhere takes every row, and reads before writes', async () => {
    await withSessionWorld({
        me: { doc: { loggedIn: true, stations: [{ id: 'A', line: 'victoria' }] },
              devices: {
                  'dev-1': { deviceId: 'dev-1', lastSeen: FRESH() },
                  'dev-2': { deviceId: 'dev-2', lastSeen: FRESH() },
                  'old-1': { deviceId: 'old-1', lastSeen: ANCIENT() },
              } },
    }, async w => {
        await UserService.endSession('me');
        assertReadsBeforeWrites(w.ops);
        for (const id of ['dev-1', 'dev-2', 'old-1']) {
            assert.ok(w.writes.some(x => x.op === 'delete' && x.path === `users/me/devices/${id}`), id);
        }
        assert.deepStrictEqual(w.deltas, [{ before: ['A'], after: [] }]);
    });
});

test('endSession: a missing account writes nothing and releases nothing', async () => {
    await withSessionWorld({
        me: { doc: null, devices: {} },
    }, async w => {
        await UserService.endSession('me', 'dev-1');
        assert.deepStrictEqual(w.writes, []);
        assert.deepStrictEqual(w.deltas, []);
    });
});

main();
