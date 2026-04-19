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
