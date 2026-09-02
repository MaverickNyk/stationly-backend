import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { KioskRoute } from './routes/kiosk/KioskRoute';
import { KioskGate } from './components/kiosk/KioskGate';
import { DEFAULT_STATION } from './config/kiosk';

/**
 * The full web app's routing table, with one route built.
 *
 * `/`, `/board/:id` and `/login` are the shape the real web version grows into.
 * They are deliberately absent rather than stubbed, so nothing here can be
 * mistaken for something half-working; what each is meant to become is written
 * down in CAFE_KIOSK_DISPLAY.md §4.4.
 */
export function App() {
    // Carried through the redirect below. `<Navigate to="/910G…">` drops the
    // query string, which silently ate the `?k=` access code out of any link
    // written against the short URL - the board then asked a television for an
    // email. Every other parameter (`?venue=`, `?overscan=`) was lost the same
    // way.
    const { search } = useLocation();

    return (
        <Routes>
            {/* The station is part of the address so a screen can be repointed
                by editing the URL on the TV, and so the URL says which board it
                is. Bare /kiosk lands on the trial station. */}
            {/* The gate asks once, and the invitation link answers for it -
                nobody types an email on a TV remote. See KioskGate. */}
            <Route path="/:stationId" element={<KioskGate><KioskRoute /></KioskGate>} />
            <Route path="/" element={<Navigate to={`/${DEFAULT_STATION}${search}`} replace />} />
            <Route path="*" element={<Navigate to={`/${DEFAULT_STATION}${search}`} replace />} />
        </Routes>
    );
}
