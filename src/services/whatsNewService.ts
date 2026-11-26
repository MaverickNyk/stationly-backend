/**
 * The one-time "What's new" screen an Android user sees after updating from
 * the first Android release (versionCode 2) to 2.0.
 *
 * Only a device that ran the v1 database migration ever shows it (the client
 * marks that moment in `V1Upgrade`), so a fresh install and every later update
 * never see it. iOS never marks it.
 *
 * Served so the words can change without a release; the app carries the same
 * copy as its fallback (`WhatsNewCopy` in composeApp). House rules for every
 * string here: no en or em dashes, no "donate", no coffee.
 */
export class WhatsNewService {

    static homeConfigKeys(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
        const show = (env.WHATS_NEW_V2_ENABLED ?? '').trim().toLowerCase() !== 'false';
        return {
            'whats_new.v2.show': String(show),
            'whats_new.v2.title': "What's new in Stationly",
            'whats_new.v2.subtitle': 'Your stations and widgets came across with you. Here is what changed.',
            // A JSON list so the number of rows can change without a release.
            // `icon` is a token the client maps to its own glyphs: boards,
            // filter, widget, sync, alert. An unknown token draws a plain dot.
            'whats_new.v2.items.json': JSON.stringify([
                {
                    icon: 'boards',
                    title: 'Up to four stations',
                    body: 'Keep a board for each station you use. Swipe between them, or see them all in a list.',
                },
                {
                    icon: 'filter',
                    title: 'Only the trains you want',
                    body: 'Filter a board to the destinations or stops you care about, and hide the rest.',
                },
                {
                    icon: 'widget',
                    title: 'A widget for each station',
                    body: 'Every widget on your home screen can show its own station.',
                },
                {
                    icon: 'sync',
                    title: 'The same boards everywhere',
                    body: 'Sign in on your phone and your iPhone or tablet, and your boards follow you.',
                },
            ]),
            'whats_new.v2.support':
                'Stationly is free, with no adverts and nothing locked away. ' +
                'It is kept running by the people who use it. If it makes your journey easier, ' +
                'you can support it here or from your profile, whenever suits you.',
            'whats_new.v2.cta': 'Support Stationly',
            'whats_new.v2.done': 'Got it',
        };
    }
}
