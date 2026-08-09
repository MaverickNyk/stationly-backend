export const TFL_LINE_COLORS: Record<string, string> = {
    'bakerloo':           '#B36305',
    'central':            '#E32017',
    'circle':             '#FFD300',
    'district':           '#00782A',
    'hammersmith-city':   '#F3A9BB',
    'jubilee':            '#A0A5A9',
    'metropolitan':       '#9B0056',
    'northern':           '#000000',
    'piccadilly':         '#003688',
    'victoria':           '#0098D4',
    'waterloo-city':      '#95CDBA',
    'dlr':                '#00A4A7',
    'elizabeth':          '#6950A1',
    'london-overground':  '#EE7C0E',
    'lioness':            '#E2A12B',
    'mildmay':            '#1A6DB4',
    'windrush':           '#E2231A',
    'weaver':             '#7B2D8B',
    'suffragette':        '#00843D',
    'liberty':            '#6B717E',
    'tram':               '#84B817',
    'cable-car':          '#E21836',
};

/**
 * Short display forms for line names, keyed by canonical line id.
 *
 * ## Why the server owns this
 * The clients need a short label wherever horizontal space is the binding
 * constraint — a platform header naming the lines using it ("Dist. & Circ.
 * Platform 2"), a per-row line prefix, and above all the iOS widget, whose
 * pager header spends its width on two arrows and a page marker before the
 * title gets any. "Hammersmith & City" alone is wider than a phone board row.
 *
 * Both clients carried their own hardcoded copy of this map. That is a
 * duplicate of naming the backend already owns everywhere else (platform
 * labels, status text, mode names all come down from the API), and it drifts:
 * the whole Overground fleet was renamed in 2024 and every client copy had to
 * be found and shipped. Serving it means a rename is a deploy, not a release.
 *
 * ## Conventions, so future additions stay consistent
 *  - **Real TfL abbreviations win.** "H&C" and "W&C" are what the roundels, the
 *    tube map key and station signage already say — inventing "Hamm." would be
 *    a worse label than the one passengers can read off the wall.
 *  - Otherwise: first syllable, trailing period ("Dist.", "Picc."). Long enough
 *    to disambiguate — "Cen." not "C." — because a board is read at a glance.
 *  - Initialisms that are already the line's whole name keep it and take no
 *    period: DLR, Tram.
 *
 * Not exhaustive on purpose: bus routes ("39") are already as short as a label
 * gets and there are hundreds of them, so they are absent and the clients pass
 * an unknown id through unchanged. An absent entry is a normal answer here, not
 * a gap — see `shortNameFor`.
 */
export const TFL_LINE_SHORT_NAMES: Record<string, string> = {
    'bakerloo':           'Bak.',
    'central':            'Cen.',
    'circle':             'Circ.',
    'district':           'Dist.',
    'hammersmith-city':   'H&C',
    'jubilee':            'Jub.',
    'metropolitan':       'Met.',
    'northern':           'Nor.',
    'piccadilly':         'Picc.',
    'victoria':           'Vic.',
    'waterloo-city':      'W&C',
    'dlr':                'DLR',
    'elizabeth':          'Eliz.',
    'elizabeth-line':     'Eliz.',
    'london-overground':  'Ovr.',
    'lioness':            'Lion.',
    'mildmay':            'Mild.',
    'windrush':           'Wind.',
    'weaver':             'Weav.',
    'suffragette':        'Suff.',
    'liberty':            'Lib.',
    'tram':               'Tram',
    'cable-car':          'Cable',
};

/**
 * The short form for a line id, or `undefined` when there isn't one.
 *
 * Deliberately NOT falling back to the full name. The field is optional on the
 * wire, and a client that receives it absent uses its own fallback chain — which
 * ends in "show the full name". Echoing the full name here would look like an
 * answer and rob the client of the chance to apply a better one, and it would
 * make "the backend has no short form for this line" indistinguishable from
 * "the short form happens to equal the full name".
 */
export function shortNameFor(lineId: string | undefined | null): string | undefined {
    if (!lineId) return undefined;
    return TFL_LINE_SHORT_NAMES[lineId.trim().toLowerCase()];
}

export const EXEMPT_MODES = new Set([
    "national-rail", "tram", "river-bus", "cable-car", "river-tour", "cycle-hire", "replacement-bus"
]);

export const DISPLAY_NAME_MAP: Record<string, string> = {
    "tube": "Underground",
    "dlr": "DLR",
    "overground": "Overground",
    "elizabeth-line": "Elizabeth Line",
    "bus": "Bus"
};

export const GOOD_SERVICE_MESSAGES = [
    "Please mind the gap between the train and the platform. Mind the gap.",
    "Please stand behind the yellow line and stay back from the platform edge.",
    "See it, say it, sorted. Text the British Transport Police on 61016.",
    "Please hold the handrail on the escalators and always stand on the right.",
    "Please move down inside the carriages and use all available space.",
    "Please offer your seat to those who may need it more than you. Thank you.",
    "Please keep all personal belongings with you at all times. Thank you.",
    "Check before you travel. Plan your journey at tfl.gov.uk or on the TfL Go app.",
    "Please have your tickets or contactless cards ready before the barriers.",
    "Follow the signs for a way out and keep to the left when on the stairs.",
    "For a more comfortable journey, please carry a bottle of water with you.",
    "Please keep the doorways clear to allow other customers to board the train."
];

export const capitalize = (str: string): string => {
    if (!str) return str;
    return str.substring(0, 1).toUpperCase() + str.substring(1).replace("-", " ");
};
