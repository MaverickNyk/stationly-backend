import * as admin from 'firebase-admin';
import { db } from '../config/firebase';

const FieldValue = admin.firestore.FieldValue;

/**
 * The user's own activity trail — what they did in the app, and when.
 *
 * ## Uploaded in batches, long after the fact, and that is the design
 * Nothing here is real-time. Clients append events to a local queue and flush
 * it on a schedule (nightly on both platforms, with a foreground fallback,
 * because neither OS guarantees a wake at a particular hour). A user who opens
 * the app forty times a day therefore costs ONE Firestore write, not forty.
 *
 * That means every consumer has to treat these timestamps as historical.
 * `t` is the device's clock at the moment the event happened, not the moment
 * it arrived, and the two can be a day apart.
 *
 * ## No per-event arrival time, and that is forced
 * An earlier version stamped each event with the server's clock on arrival. It
 * had to go: it made a retried batch produce DIFFERENT objects, which silently
 * defeated the `arrayUnion` dedup below and stored every replayed event twice
 * (measured — a repeated 2-event batch left 4 rows). Idempotency is worth more
 * than arrival time, so the only server clock recorded is `updatedAt` on the
 * document. A device with a wrong clock is still caught: future timestamps are
 * clamped and very old ones dropped, both from the client's own value.
 *
 * ## Layout
 *   users/{uid}/activity/{YYYY-MM-DD}_{deviceId}
 *     { uid, date, deviceId, platform, appVersion, count, updatedAt,
 *       events: ActivityEvent[] }
 *
 * One document per device per day. Sharding by device rather than collecting a
 * day into one document is what makes the write contention-free: two devices
 * flushing at the same moment touch different documents, so neither needs a
 * transaction and neither can lose the other's events. Sharding by DAY keeps
 * any single document bounded and makes the common query — "what did this user
 * do last week" — a range scan on the document id.
 *
 * ## Idempotent on retry
 * Events are appended with `arrayUnion`, which is a set operation: re-uploading
 * a batch whose response was lost adds nothing. That works only because every
 * event carries a client-generated [ActivityEvent.id] that makes it distinct
 * from every other event — including one with the identical name and timestamp,
 * which two rapid taps genuinely produce. Without that id, arrayUnion would
 * silently collapse real duplicate events into one.
 */

/** One recorded action. `props` is free-form and deliberately not validated. */
export interface ActivityEvent {
    /** Client-generated unique id. See the idempotency note above. */
    id: string;
    /** Event name, e.g. `app.opened`, `widget.added`, `board.deleted`. */
    name: string;
    /** DEVICE clock when the event happened, epoch millis. */
    t: number;
    /** Event-specific detail. Small, flat, and never validated server-side. */
    props?: Record<string, unknown>;
}

export interface ActivityBatchInput {
    uid: string;
    deviceId: string;
    platform?: string;
    appVersion?: string;
    events: ActivityEvent[];
}

export class UserActivityService {

    /**
     * The most events one request may carry.
     *
     * A client that has been offline for a week still has to be able to drain
     * its queue, so the LIMIT is per request and clients page rather than
     * truncate. Chosen to sit well inside the 1 MiB document ceiling even at
     * the largest realistic event size.
     */
    static readonly MAX_EVENTS_PER_BATCH = 500;

    /** Longest a single `props` blob may be, serialised. */
    private static readonly MAX_PROPS_BYTES = 2 * 1024;

    /**
     * Anything older than this is dropped on arrival rather than stored.
     *
     * A device whose clock is wrong — or one restored from a very old backup —
     * otherwise writes events into a document dated years ago, where nothing
     * will ever look for them and they simply accumulate. Thirty days is
     * comfortably longer than any legitimate offline stretch.
     */
    private static readonly MAX_EVENT_AGE_MS = 30 * 24 * 60 * 60 * 1000;

    /**
     * Append a device's batch to its day-document.
     *
     * Returns how many events were actually stored, which will be fewer than
     * were sent when some failed validation. The client deletes its local copy
     * on a 200 regardless: an event this rejected is one it would reject again,
     * so holding it would mean retrying forever.
     */
    static async record(input: ActivityBatchInput): Promise<{ accepted: number; rejected: number }> {
        const { uid, deviceId } = input;
        if (!uid) throw new Error('uid is required');
        if (!deviceId) throw new Error('deviceId is required');

        const receivedAt = Date.now();
        const floor = receivedAt - this.MAX_EVENT_AGE_MS;

        const valid = (input.events ?? [])
            .slice(0, this.MAX_EVENTS_PER_BATCH)
            .map(e => this.sanitise(e, receivedAt, floor))
            .filter((e): e is ActivityEvent => e !== null);

        const rejected = Math.min((input.events ?? []).length, this.MAX_EVENTS_PER_BATCH) - valid.length;
        if (valid.length === 0) return { accepted: 0, rejected };

        // Grouped by the day the event HAPPENED, not the day it arrived, so a
        // batch that spans midnight — the common case for a nightly flush —
        // lands in the two documents it belongs to instead of being backdated
        // or postdated wholesale into one.
        const byDate = new Map<string, ActivityEvent[]>();
        for (const event of valid) {
            const date = this.dateKey(event.t);
            const bucket = byDate.get(date);
            if (bucket) bucket.push(event); else byDate.set(date, [event]);
        }

        await Promise.all([...byDate.entries()].map(([date, events]) =>
            db.collection('users').doc(uid)
                .collection('activity').doc(`${date}_${deviceId}`)
                .set({
                    uid,
                    date,
                    deviceId,
                    ...(input.platform ? { platform: input.platform } : {}),
                    ...(input.appVersion ? { appVersion: input.appVersion } : {}),
                    updatedAt: receivedAt,
                    // arrayUnion, not a read-modify-write: no transaction, no
                    // contention, and a replayed batch is absorbed rather than
                    // duplicated. See the idempotency note at the top.
                    //
                    // This only works while an event is a pure function of what
                    // the CLIENT sent — arrayUnion compares whole objects, so a
                    // single server-stamped field makes every retry distinct
                    // and turns the dedup into an append. That is exactly what a
                    // `receivedAt` on the event used to do.
                    //
                    // There is deliberately no `count` field either. It would
                    // have to be `FieldValue.increment`, which cannot know how
                    // many events the union actually added, so it drifted above
                    // the real total on the first retry. `events.length` is the
                    // count and is always right.
                    events: FieldValue.arrayUnion(...events),
                }, { merge: true })
        ));

        return { accepted: valid.length, rejected };
    }

    /**
     * Normalise one event, or reject it.
     *
     * Rejection is silent by design — an event is telemetry, and failing a
     * user's request because one line of their activity log was malformed
     * would trade something that matters for something that does not.
     */
    private static sanitise(raw: ActivityEvent, receivedAt: number, floor: number): ActivityEvent | null {
        if (!raw || typeof raw.id !== 'string' || !raw.id) return null;
        if (typeof raw.name !== 'string' || !raw.name) return null;

        const t = typeof raw.t === 'number' && Number.isFinite(raw.t) ? raw.t : 0;
        if (t < floor) return null;
        // A device whose clock runs fast would otherwise file events in the
        // future, where a "last 7 days" query never reaches them. Clamped
        // rather than dropped: the event is real, only its timestamp is not.
        const stamped = t > receivedAt ? receivedAt : t;

        let props: Record<string, unknown> | undefined;
        if (raw.props && typeof raw.props === 'object' && !Array.isArray(raw.props)) {
            const flat: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(raw.props)) {
                // Flat scalars only. A nested object here is a client bug, and
                // storing it would let one event's shape dictate the cost of
                // every read of the day it landed in.
                if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) flat[k] = v;
            }
            if (Buffer.byteLength(JSON.stringify(flat), 'utf8') <= this.MAX_PROPS_BYTES) {
                props = flat;
            }
        }

        // Every field here comes from the client. Adding a server-derived one
        // would break idempotency — see the write above.
        return {
            id: raw.id,
            name: raw.name,
            t: stamped,
            ...(props && Object.keys(props).length > 0 ? { props } : {}),
        };
    }

    /** `YYYY-MM-DD` in UTC — the document-id grain. */
    private static dateKey(epochMs: number): string {
        return new Date(epochMs).toISOString().slice(0, 10);
    }
}
