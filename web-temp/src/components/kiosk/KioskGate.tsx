import { useState, useEffect, type FormEvent, type ReactNode } from 'react';
import './KioskGate.css';
import { BRAND_MARK_URL } from '../../config/assets';

const STORAGE_KEY = 'stationly_kiosk_email';

/**
 * Who may open a kiosk board, and the code that lets them in without typing.
 *
 * The code is what goes in the URL we send a tester. It is deliberately NOT the
 * email: a board URL gets bookmarked, photographed and read off a wall, and
 * none of those should publish somebody's address. Revoking access is deleting
 * a line here.
 */
const ACCESS_CODES: Record<string, string> = {
    'nk-dev': 'nikhilkumar11896@gmail.com',
    'cm-dev': 'cara.mcavinchey@gmail.com',
    'fb-hackneywick': 'federicobenatti@icloud.com',
};

const ALLOWED_EMAILS = new Set(Object.values(ACCESS_CODES));

/** The query parameter carrying an access code. Stripped from the address bar
 *  the moment it is accepted. */
const CODE_PARAM = 'k';

type GateState = 'loading' | 'ask' | 'denied' | 'granted';

/**
 * Wraps the kiosk page and asks who is opening it - once.
 *
 * ## Why the link carries the answer
 * The screen this runs on is driven by a TV remote. Typing
 * `federicobenatti@icloud.com` on a D-pad keyboard, one character at a time, is
 * a miserable first thirty seconds on a board somebody waited two months for -
 * and a TV browser clears its site data often enough that it would not have
 * been the last time.
 *
 * So the URL we send does the work: `/kiosk/910GHACKNYW?k=fb-hackneywick`
 * authorises on open, remembers, and **removes the code from the address bar**
 * so it is not sitting on screen in a photograph of the café wall. Because the
 * code lives in the bookmarked link rather than only in storage, a browser that
 * clears its data re-authorises silently on the next load. Nobody types
 * anything, ever.
 *
 * The typed form is still there for a person who lands on a bare URL - a laptop,
 * a phone, a link forwarded without its parameter.
 *
 * ## What this is and is not
 * A doorbell, not a lock. It is bypassable by anyone who opens devtools, and it
 * is meant to be: it keeps a trial board from being idly shared, and it tells us
 * which tester opened what. Anything that actually needs defending belongs
 * behind the API, which is a different question and already answered.
 */
export function KioskGate({ children }: { children: ReactNode }) {
    const [state, setState] = useState<GateState>('loading');
    const [email, setEmail] = useState('');
    const [error, setError] = useState('');

    useEffect(() => {
        // 1. A code in the link wins, and is spent immediately.
        const code = new URLSearchParams(window.location.search).get(CODE_PARAM);
        const fromCode = code ? ACCESS_CODES[code.trim().toLowerCase()] : undefined;
        if (fromCode) {
            writeSaved(fromCode);
            stripCodeFromUrl();
            setState('granted');
            return;
        }

        // 2. Otherwise, whoever was let in on this device before.
        const saved = readSaved();
        setState(saved && ALLOWED_EMAILS.has(saved) ? 'granted' : 'ask');
    }, []);

    function handleSubmit(e: FormEvent) {
        e.preventDefault();
        const trimmed = email.trim().toLowerCase();

        if (!trimmed || !trimmed.includes('@')) {
            setError('Please enter a valid email address.');
            return;
        }

        if (ALLOWED_EMAILS.has(trimmed)) {
            writeSaved(trimmed);
            setState('granted');
        } else {
            setState('denied');
        }
    }

    if (state === 'loading') return null;
    if (state === 'granted') return <>{children}</>;

    if (state === 'denied') {
        return (
            <div className="gate">
                <div className="gate-card">
                    <img className="gate-logo" src={BRAND_MARK_URL} alt="Stationly" />
                    <h1 className="gate-title">Not on the list yet</h1>
                    <p className="gate-body">
                        Stationly Kiosk is in a closed trial with a handful of venues while we
                        get it right.
                    </p>
                    <p className="gate-body gate-body-dim">
                        If you think this is a mistake, or you would like your venue on the
                        list, email{' '}
                        <a className="gate-link" href="mailto:support@stationly.co.uk">
                            support@stationly.co.uk
                        </a>
                        .
                    </p>
                    <button
                        className="gate-btn gate-btn-secondary"
                        onClick={() => {
                            setEmail('');
                            setError('');
                            setState('ask');
                        }}
                    >
                        Try a different email
                    </button>
                </div>
            </div>
        );
    }

    return (
        <div className="gate">
            <div className="gate-card">
                <img className="gate-logo" src={BRAND_MARK_URL} alt="Stationly" />
                <h1 className="gate-title">Stationly Kiosk</h1>
                <p className="gate-body">
                    A live departure board for venues near a station. Enter the email your
                    invitation was sent to.
                </p>

                <form className="gate-form" onSubmit={handleSubmit}>
                    <input
                        className="gate-input"
                        type="email"
                        inputMode="email"
                        autoComplete="email"
                        autoFocus
                        placeholder="you@example.com"
                        value={email}
                        onChange={e => {
                            setEmail(e.target.value);
                            if (error) setError('');
                        }}
                    />
                    {error && <p className="gate-error">{error}</p>}
                    <button className="gate-btn" type="submit">
                        Open the board
                    </button>
                </form>

                <p className="gate-body gate-body-dim">
                    Opening the link from your invitation email skips this step.
                </p>
            </div>
        </div>
    );
}

/**
 * Both accessors are guarded. A browser with site data blocked THROWS on
 * `localStorage` rather than returning null, and an uncaught throw here unmounts
 * the tree - so the failure mode was a café screen showing nothing at all, on
 * the one code path that runs before anything is rendered.
 *
 * Failing to persist is survivable in a way it was not before: the access code
 * lives in the bookmarked URL, so a device that cannot remember anything still
 * authorises itself on every load.
 */
function readSaved(): string | null {
    try {
        return window.localStorage.getItem(STORAGE_KEY)?.trim().toLowerCase() ?? null;
    } catch {
        return null;
    }
}

function writeSaved(email: string): void {
    try {
        window.localStorage.setItem(STORAGE_KEY, email);
    } catch {
        /* Private window, blocked site data. See above - the link still works. */
    }
}

/**
 * Take the spent code out of the address bar.
 *
 * A board URL ends up bookmarked, screenshotted and read off a wall, and a code
 * sitting in it invites exactly the idle sharing the gate exists to discourage.
 * `replaceState` rather than a navigation: the router must not see this, and the
 * back button must not be able to undo it.
 *
 * Every other query parameter is preserved - `?venue=`, `?rows=` and the rest
 * are the screen's configuration and are none of this function's business.
 */
function stripCodeFromUrl(): void {
    try {
        const url = new URL(window.location.href);
        if (!url.searchParams.has(CODE_PARAM)) return;
        url.searchParams.delete(CODE_PARAM);
        const search = url.searchParams.toString();
        window.history.replaceState(null, '', `${url.pathname}${search ? `?${search}` : ''}${url.hash}`);
    } catch {
        /* Cosmetic only - a URL we cannot rewrite is still a working board. */
    }
}
