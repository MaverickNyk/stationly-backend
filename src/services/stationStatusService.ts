import { LocalDbService } from './localDbService';

/**
 * Which stations are closed, as the Syncer tells us: it asks TfL, decides and
 * pushes to phones; we keep its latest answer and serve it
 * (`GET /stations/status`). The same shape as line status. See
 * docs/STATION_STATUS.md.
 *
 * The Syncer posts EVERYTHING every poll, so a restart is put right within one.
 * The post reaches one worker; the answer is kept in the SQLite file they share.
 * Without one for [staleMs] we know nothing, and say nothing.
 */

/** What a board shows. The Syncer's `StationNotice.java`; served as it came. */
export interface StationNotice {
    id: string;
    kind: string;
    from: number;
    to: number;
    expiresAt: number;
    at: number;
    [field: string]: unknown;
}

/** What TfL said, for the log: "unclear" ones too. */
interface Said { id: string; name: string; mode: string; kind: string; text: string; why?: string }

export interface StationStatusPost {
    group: Group;
    /** When the Syncer asked TfL, epoch ms. */
    at: number;
    /** Whether a stop not named is open, rather than not known. */
    known: boolean;
    notices: StationNotice[];
    statuses: Said[];
}

type Group = 'rail' | 'bus';
/** Several of the Syncer's polls. */
const STALE_MS: Record<Group, number> = { rail: 10 * 60_000, bus: 25 * 60_000 };
const GROUPS = Object.keys(STALE_MS) as Group[];
const KEEP_LOG_MS = 30 * 24 * 3600_000;
/** How old our copy may be before we look whether another worker has a newer one. */
const LOOK_AGAIN_MS = 10_000;

interface State { at: number; known: boolean; notices: Map<string, StationNotice>; said: Map<string, Said> }
const empty = (): State => ({ at: 0, known: false, notices: new Map(), said: new Map() });
/** By the rail ids, as the Syncer does: TfL's bus stops outside London are 210, 240, 400... */
const groupOf = (id: string): Group => id.startsWith('940G') || id.startsWith('910G') ? 'rail' : 'bus';
const isList = (v: unknown): v is any[] => Array.isArray(v);
const named = (v: any) => !!v && typeof v.id === 'string' && !!v.id && typeof v.kind === 'string';

export class StationStatusService {
    private static states: Record<Group, State> = { rail: empty(), bus: empty() };
    private static lookedAt: Record<Group, number> = { rail: 0, bus: 0 };
    private static purgedAt = 0;

    /** The Syncer's latest. False when it is not a post, or not newer than what we have. */
    static async ingest(body: unknown, now: number = Date.now()): Promise<boolean> {
        const p = body as StationStatusPost;
        if (!p || !GROUPS.includes(p.group) || typeof p.at !== 'number' || !Number.isFinite(p.at)
            || typeof p.known !== 'boolean' || !isList(p.notices) || !isList(p.statuses)) throw new Error('not a station status post');
        const at = Math.min(p.at, now);
        await this.look(p.group, now, true);
        const before = this.states[p.group];
        if (at <= before.at) return false;
        this.states[p.group] = this.read({ ...p, at });
        await this.keep(p.group, { ...p, at });
        await this.log(at, before, this.states[p.group]);
        await this.purge(now);
        return true;
    }

    private static read(p: StationStatusPost): State {
        return {
            at: p.at, known: p.known,
            notices: new Map(p.notices.filter(named).map(n => [n.id, n] as const)),
            said: new Map(p.statuses.filter(named).map(s => [s.id, s] as const)),
        };
    }

    private static async keep(group: Group, p: StationStatusPost): Promise<void> {
        if (!LocalDbService.isOpen()) return;
        try {
            await LocalDbService.run('INSERT OR REPLACE INTO station_status_state (grp, at, data) VALUES (?, ?, ?)',
                [group, p.at, JSON.stringify(p)]);
        } catch (e: any) { console.warn(`STATION_STATUS: ${group} not kept`, e?.message); }
    }

    /** Take up a newer answer another worker got. */
    private static async look(group: Group, now: number, always = false): Promise<void> {
        if (!always && (now - this.states[group].at < LOOK_AGAIN_MS || now - this.lookedAt[group] < LOOK_AGAIN_MS)) return;
        this.lookedAt[group] = now;
        if (!LocalDbService.isOpen()) return; // Starting: a query would never answer.
        try {
            const row = await LocalDbService.get<{ data: string }>(
                'SELECT data FROM station_status_state WHERE grp = ? AND at > ?', [group, this.states[group].at]);
            if (row) this.states[group] = this.read(JSON.parse(row.data));
        } catch { /* no database yet, or not readable: what we have */ }
    }

    private static fresh(group: Group, now: number): boolean {
        return now - this.states[group].at <= STALE_MS[group];
    }

    private static current(group: Group, now: number): StationNotice[] {
        if (!this.fresh(group, now)) return [];
        return [...this.states[group].notices.values()].filter(n => n.to > now && n.expiresAt > now);
    }

    /**
     * The notices for [ids]. `known` are the ids we can answer for, each with when
     * that was learned (not asked for: a push the Syncer sent since must not look
     * older than this answer). One there with no notice is open; one not there is to
     * be left alone.
     */
    static async notices(ids: string[], now: number = Date.now()): Promise<{ known: Record<string, number>; notices: StationNotice[] }> {
        const known: Record<string, number> = {};
        const notices: StationNotice[] = [];
        for (const g of GROUPS) {
            const mine = new Set(ids.filter(id => groupOf(id) === g));
            if (!mine.size) continue;
            await this.look(g, now);
            if (!this.states[g].known || !this.fresh(g, now)) continue;
            for (const id of mine) known[id] = this.states[g].at;
            notices.push(...this.current(g, now).filter(n => mine.has(n.id)));
        }
        return { known, notices };
    }

    /** The stops closed now: for labelling a list. */
    static async closedIds(now: number = Date.now()): Promise<Set<string>> {
        for (const g of GROUPS) await this.look(g, now);
        return new Set(GROUPS.flatMap(g => this.current(g, now))
            .filter(n => n.from <= now && (n.kind === 'closed' || n.kind === 'closing')).map(n => n.id));
    }

    /** For the admin. */
    static async describe(now: number = Date.now()) {
        for (const g of GROUPS) await this.look(g, now);
        return Object.fromEntries(GROUPS.map(g => [g, {
            at: this.states[g].at || null, stale: !this.fresh(g, now), known: this.states[g].known,
            notices: [...this.states[g].notices.values()], said: [...this.states[g].said.values()],
        }]));
    }

    // ── The log: what we hold TfL to have said, for judging it ───────────────

    private static async log(at: number, before: State, after: State): Promise<void> {
        if (!LocalDbService.isOpen()) return;
        const write = async (s: Said, event: string) => {
            console.log(`STATION_STATUS: ${event} ${s.kind} ${s.id} ${s.name}${s.why ? ` (${s.why})` : ''}`);
            await LocalDbService.run(
                `INSERT INTO station_status_log (at, station, name, mode, event, kind, why, text) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [at, s.id, s.name ?? s.id, s.mode ?? '', event, s.kind, s.why ?? null, String(s.text ?? '').slice(0, 1000)]);
        };
        try {
            for (const s of after.said.values()) {
                const was = before.said.get(s.id);
                if (was?.kind !== s.kind) await write(s, was ? 'changed' : 'started');
            }
            for (const s of before.said.values()) if (!after.said.has(s.id)) await write(s, 'cleared');
        } catch (e: any) { console.warn('STATION_STATUS: not logged', e?.message); }
    }

    private static async purge(now: number): Promise<void> {
        if (!LocalDbService.isOpen() || now - this.purgedAt < 24 * 3600_000) return;
        this.purgedAt = now;
        await LocalDbService.run('DELETE FROM station_status_log WHERE at < ?', [now - KEEP_LOG_MS]).catch(() => undefined);
    }

    /** What the log has learned. */
    static async report(days: number, now: number = Date.now()) {
        if (!LocalDbService.isOpen()) throw new Error('starting, try again');
        const since = now - days * 24 * 3600_000;
        const [states, unclear, recent] = await Promise.all([
            LocalDbService.all(`SELECT mode, kind, COUNT(DISTINCT station) AS stations FROM station_status_log
                WHERE at >= ? AND event IN ('started', 'changed') GROUP BY mode, kind ORDER BY mode, kind`, [since]),
            LocalDbService.all(`SELECT why, text, COUNT(DISTINCT station) AS stations FROM station_status_log
                WHERE at >= ? AND kind = 'unclear' AND event IN ('started', 'changed') GROUP BY why, text ORDER BY stations DESC LIMIT 100`, [since]),
            LocalDbService.all(`SELECT at, event, kind, station, name, mode, text FROM station_status_log
                WHERE at >= ? AND mode != 'bus' ORDER BY at DESC LIMIT 100`, [since]),
        ]);
        return { days, states, unclear, recentRail: recent };
    }

    static resetForTest(): void {
        this.states = { rail: empty(), bus: empty() };
        this.lookedAt = { rail: 0, bus: 0 };
        this.purgedAt = 0;
    }
}
