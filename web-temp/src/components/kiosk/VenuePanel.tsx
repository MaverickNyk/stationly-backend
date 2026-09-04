import { useEffect, useRef, useState } from 'react';

/**
 * The café's own space - the left 70% of the bottom band.
 *
 * Two fields: the venue's NAME, which titles the panel, and a message of the
 * day, which is whatever they want it to be.
 *
 * ## Why it is editable in place
 * The URL parameters still work and are still the way a screen is provisioned.
 * But handing a café owner a URL and asking them to percent-encode a sentence
 * every time the soup changes is not a thing that happens twice. So the panel
 * edits itself: hover anywhere on it and an edit control fades up, click it,
 * type, save.
 *
 * The control is hidden until hover ON PURPOSE. This is a wall display in a
 * public room - a button sitting there permanently invites every customer to
 * press it, and it would be the only interactive thing on an otherwise
 * untouchable screen. Hovering requires a mouse, which in a café means the
 * owner's laptop rather than a passer-by.
 *
 * ## Where it is stored, and what that costs
 * `localStorage`, keyed per station, on the machine driving the screen. That is
 * the right shape for a trial - no endpoint, no auth, no account, and the café
 * cannot break anyone else's board. What it is not is portable: clearing site
 * data or moving to a different TV loses it, and the URL parameters are then
 * the fallback. When this graduates out of the backend it should become a real
 * per-venue record; noted in TEMPORARY.md.
 */

interface Venue {
    name: string;
    message: string;
}

const MAX_NAME = 40;
const MAX_MESSAGE = 180;

function storageKey(station: string): string {
    return `stationly.kiosk.venue.${station}`;
}

/** Every read and write is guarded: a browser with site data blocked throws on
 *  access rather than returning null, and a café screen must render anyway. */
function readStored(station: string): Venue | null {
    try {
        const raw = window.localStorage.getItem(storageKey(station));
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        return {
            name: String(parsed.name ?? '').slice(0, MAX_NAME),
            message: String(parsed.message ?? '').slice(0, MAX_MESSAGE),
        };
    } catch {
        return null;
    }
}

function writeStored(station: string, venue: Venue): void {
    try {
        window.localStorage.setItem(storageKey(station), JSON.stringify(venue));
    } catch {
        /* private window, blocked site data - the edit still applies for this
           session, it just will not survive a reload. */
    }
}

export function VenuePanel({
    station,
    defaultName,
    defaultMessage,
    onNameChange,
}: {
    station: string;
    /** From `?venue=` - the provisioned value, and the fallback. */
    defaultName: string;
    /** From `?message=`. */
    defaultMessage: string;
    /** The header shows the venue name too, so it has to hear about edits. */
    onNameChange?: (name: string) => void;
}) {
    const [venue, setVenue] = useState<Venue>({ name: defaultName, message: defaultMessage });
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState<Venue>(venue);
    const nameRef = useRef<HTMLInputElement>(null);

    // Stored values win over the URL: the URL provisioned the screen, the café
    // has since corrected it.
    useEffect(() => {
        const stored = readStored(station);
        const next = stored ?? { name: defaultName, message: defaultMessage };
        setVenue(next);
        onNameChange?.(next.name);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [station, defaultName, defaultMessage]);

    useEffect(() => {
        if (editing) nameRef.current?.focus();
    }, [editing]);

    const open = () => {
        setDraft(venue);
        setEditing(true);
    };

    const save = () => {
        const next = {
            name: draft.name.trim().slice(0, MAX_NAME),
            message: draft.message.trim().slice(0, MAX_MESSAGE),
        };
        setVenue(next);
        writeStored(station, next);
        onNameChange?.(next.name);
        setEditing(false);
    };

    if (editing) {
        return (
            <section className="venue venue--editing">
                <div className="venue__edit-row">
                    <input
                        ref={nameRef}
                        className="venue__input venue__input--name"
                        value={draft.name}
                        maxLength={MAX_NAME}
                        placeholder="Café name"
                        onChange={e => setDraft(d => ({ ...d, name: e.target.value }))}
                        onKeyDown={e => {
                            if (e.key === 'Enter') save();
                            if (e.key === 'Escape') setEditing(false);
                        }}
                    />
                    <div className="venue__actions">
                        <button className="venue__btn venue__btn--save" onClick={save}>Save</button>
                        <button className="venue__btn" onClick={() => setEditing(false)}>Cancel</button>
                    </div>
                </div>

                <div className="venue__edit-row">
                    <input
                        className="venue__input venue__input--message"
                        value={draft.message}
                        maxLength={MAX_MESSAGE}
                        placeholder="Message of the day..."
                        onChange={e => setDraft(d => ({ ...d, message: e.target.value }))}
                        onKeyDown={e => {
                            if (e.key === 'Enter') save();
                            if (e.key === 'Escape') setEditing(false);
                        }}
                    />
                    <span className="venue__count">{draft.message.length}/{MAX_MESSAGE}</span>
                </div>
            </section>
        );
    }

    return (
        <section className="venue">
            {/* Placeholders rather than an empty panel: an unconfigured screen
                should show the café what goes here, not a hole. */}
            <div className={venue.name ? 'venue__name' : 'venue__name venue__name--empty'}>
                {venue.name || 'Café name'}
            </div>
            <div className={venue.message ? 'venue__message' : 'venue__message venue__message--empty'}>
                {venue.message || 'Message of the day'}
            </div>

            <button className="venue__edit" onClick={open} aria-label="Edit café details" title="Edit café details">
                <svg className="venue__edit-icon" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M11.013 1.427a1.75 1.75 0 0 1 2.474 0l1.086 1.086a1.75 1.75 0 0 1 0 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 0 1-.927-.928l.929-3.25a1.75 1.75 0 0 1 .445-.758l8.61-8.61Zm1.414 1.06a.25.25 0 0 0-.354 0L10.811 3.75l1.439 1.44 1.263-1.263a.25.25 0 0 0 0-.354l-1.086-1.086ZM9.75 4.81l-6.97 6.97a.25.25 0 0 0-.064.108l-.558 1.953 1.953-.558a.249.249 0 0 0 .108-.064l6.97-6.97-1.439-1.439Z" />
                </svg>
            </button>
        </section>
    );
}
