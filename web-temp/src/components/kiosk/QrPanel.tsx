/**
 * The reason the screen is on the café wall: the board earns the attention,
 * this converts it.
 *
 * Deliberately NOT a card. It sat in a bordered, filled box that read as a
 * separate advert bolted onto the corner of the screen - the thing people's eyes
 * skip. It is now part of the same surface as the café's own panel: no border,
 * a much lighter ground, and our name and mark at the top where the explanatory
 * caption used to be.
 *
 * There is no "scan me" and no "quick scan". A QR code on a wall is not a thing
 * anybody needs instructions for, and telling them how to use a camera reads as
 * a leaflet. The question above it is the whole invitation.
 */

import { APP_QR_URL, BRAND_MARK_URL } from '../../config/assets';

export function QrPanel({ caption }: { caption: string }) {
    const askText = caption || 'Get Stationly on your phone for live London departures';

    return (
        <aside className="qr">
            {/* Left: Stationly logo & name on top, text underneath */}
            <div className="qr__info">
                <div className="qr__brand">
                    <img className="qr__mark" src={BRAND_MARK_URL} alt="" aria-hidden="true" />
                    <span className="qr__name">Stationly</span>
                </div>
                {/* TEXT, never HTML. `askText` comes straight from `?qr=` in
                    the address bar, so `dangerouslySetInnerHTML` here made the
                    URL handed to a café a script-injection vector into a screen
                    on their wall - for a feature whose entire job is to print
                    one sentence. */}
                <div className="qr__caption">{askText}</div>
            </div>

            {/* Right: The QR code */}
            <div className="qr__frame">
                <span className="qr__corner qr__corner--tl" />
                <span className="qr__corner qr__corner--tr" />
                <span className="qr__corner qr__corner--bl" />
                <span className="qr__corner qr__corner--br" />
                <img className="qr__img" src={APP_QR_URL} alt="Scan to get Stationly on your phone" />
            </div>
        </aside>
    );
}
