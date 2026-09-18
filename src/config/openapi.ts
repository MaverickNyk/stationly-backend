/**
 * OpenAPI spec construction and the public-documentation filter.
 *
 * Lives in its own module, apart from `server.ts`, for one reason: importing
 * `server.ts` starts a listener, opens WebSocket hubs and initialises Firebase,
 * so the published API surface could not be asserted in a test. Everything here
 * is a pure config object plus a pure function over it — importing this module
 * has no side effects, so `src/tests/run.ts` can build the real spec and check
 * exactly what would be served.
 *
 * That matters more than tidiness. The published surface is a security boundary
 * (see the leak recorded in `buildPublicSpec` below), and an untested boundary
 * is one that drifts silently.
 *
 * See docs/API_DOCUMENTATION.md for the full rationale.
 */
import path from 'path';
import swaggerJsdoc from 'swagger-jsdoc';
import { getBaseUrl } from '../utils/formatters';

// Mirrors `server.ts`. Used only to render the local-dev entry in the spec's
// `servers` list — this module never binds a port.
const port = process.env.PORT || 3000;

// OpenAPI Configuration
export const swaggerOptions = {
    definition: {
        openapi: '3.1.0',
        info: {
            title: 'Stationly API documentation',
            version: 'v1.0.0',
            description: `
Welcome to the Stationly API Documentation. 

Stationly provides a high-performance middleware for transport data, specializing in TfL (Transport for London) integration. Our API offers real-time arrival predictions, station metadata, and live line status updates.

### Key Features
*   **Real-time Predictions**: Accurate arrival times for Tube, Overground, DLR, and more.
*   **Station Metadata**: Detailed information about stations including coordinates and available modes.
*   **Line Status**: Live updates on delays, closures, and service changes.
*   **SDUI Integration**: Server-Driven UI layouts for dynamic app screens.
            `,
            contact: {
                name: 'Stationly Limited',
                email: 'support@stationly.co.uk'
            },
            license: {
                name: 'Apache 2.0',
                url: 'http://www.apache.org/licenses/LICENSE-2.0.html'
            }
        },
        servers: [
            {
                url: `${getBaseUrl()}/api/v1`,
                description: 'Current Server'
            },
            {
                url: `http://localhost:${port}/api/v1`,
                description: 'Local Development Server'
            }
        ],
        components: {
            securitySchemes: {
                StationlyKey: {
                    type: 'apiKey',
                    in: 'header',
                    name: 'X-Stationly-Key',
                    description: 'Your Stationly Developer API Key'
                },
                FirebaseToken: {
                    type: 'http',
                    scheme: 'bearer',
                    bearerFormat: 'JWT',
                    description: 'Firebase ID Token for user-specific data access'
                }
            },
            schemas: {
                TransportMode: {
                    type: 'object',
                    properties: {
                        modeName: { type: 'string', example: 'tube' },
                        displayName: { type: 'string', example: 'Underground' },
                        id: { type: 'string', example: 'tube' },
                        label: { type: 'string', example: 'Underground' },
                        iconUrl: { type: 'string', example: `${getBaseUrl()}/icons/tube.png` }
                    }
                },
                LineInfo: {
                    type: 'object',
                    properties: {
                        id: { type: 'string', example: 'victoria' },
                        name: { type: 'string', example: 'Victoria' },
                        modeName: { type: 'string', example: 'tube' },
                        label: { type: 'string', example: 'Victoria' }
                    }
                },
                LineStatus: {
                    type: 'object',
                    properties: {
                        id: { type: 'string', example: 'central' },
                        name: { type: 'string', example: 'Central' },
                        statusSeverityDescription: { type: 'string', example: 'Good Service' },
                        reason: { type: 'string', example: 'Service is operating normally.' },
                        mode: { type: 'string', example: 'tube' },
                        lastUpdatedTime: { type: 'string', format: 'date-time' }
                    }
                },
                Station: {
                    type: 'object',
                    properties: {
                        naptanId: { type: 'string', example: '940GZZLUEUS' },
                        commonName: { type: 'string', example: 'Euston Underground Station' },
                        lat: { type: 'number', example: 51.5281 },
                        lon: { type: 'number', example: -0.1331 },
                        stopType: { type: 'string', example: 'NaptanMetroStation' },
                        id: { type: 'string', example: '940GZZLUEUS' },
                        label: { type: 'string', example: 'Euston' }
                    }
                },
                SubscribedStation: {
                    type: 'object',
                    properties: {
                        naptanId: { type: 'string', example: '940GZZLUEUS' },
                        commonName: { type: 'string', example: 'Euston' },
                        lineId: { type: 'string', example: 'victoria' },
                        lineName: { type: 'string', example: 'Victoria' },
                        modeName: { type: 'string', example: 'tube' }
                    }
                },
                BoardFilter: {
                    type: 'object',
                    description:
                        'How one queue is narrowed. Both the user INTENT (`viaIds`) and its ' +
                        'RESOLUTION (`destinationIds`) are kept: the resolution goes stale when a ' +
                        'branch closes, so the intent has to survive to be re-resolved.',
                    properties: {
                        mode: { type: 'string', enum: ['ALL', 'DESTINATIONS', 'VIA'], example: 'ALL' },
                        destinationIds: {
                            type: 'array', items: { type: 'string' },
                            description: 'Naptan allow-list. Filters never match on display name.'
                        },
                        destinationNames: { type: 'array', items: { type: 'string' } },
                        viaIds: { type: 'array', items: { type: 'string' } },
                        viaNames: { type: 'array', items: { type: 'string' } },
                        resolvedAt: { type: 'number', description: 'Epoch millis' }
                    }
                },
                BoardSelection: {
                    type: 'object',
                    description:
                        'One departure queue on a board — one line, one direction, one stop. Flat ' +
                        'under the board: a line level would hold nothing but the line id.',
                    required: ['naptanId', 'line'],
                    properties: {
                        naptanId: {
                            type: 'string', example: '490008805N',
                            description:
                                'The RESOLVED stop for this exact (line, direction). On rail it equals ' +
                                'the station naptan; on bus it is the specific pole, and the two ' +
                                'directions of one route sit on opposite sides of the road.'
                        },
                        line: { type: 'string', example: '39' },
                        mode: { type: 'string', example: 'bus', description: 'On the selection — a hub can serve several modes' },
                        direction: { type: 'string', example: 'inbound' },
                        filter: { $ref: '#/components/schemas/BoardFilter' }
                    }
                },
                SavedBoard: {
                    type: 'object',
                    description:
                        'One saved board — ONE PER STATION. `id` is the hub the user picked (the ' +
                        'client\'s groupingId), matching the one card the home screen draws and the ' +
                        'one station a widget is configured with. Selections hang flat under it, ' +
                        'each carrying its own fetch naptan, because on a bus hub each ' +
                        '(line, direction) departs from its own pole — e.g. Smithwood Close hub ' +
                        '490012211N, route 39 inbound from 490008805N and outbound from ' +
                        '490012211N. Written by iOS; Android still uses the separate `stations` list. ' +
                        'Carries what the user TRACKS only — appearance (expanded, rows, pin, ' +
                        'order) is device-local and never sent.',
                    required: ['id', 'selections'],
                    properties: {
                        id: { type: 'string', example: '490012211N', description: 'The hub / grouping id — the board\'s identity' },
                        name: { type: 'string', example: 'Smithwood Close' },
                        selections: { type: 'array', items: { $ref: '#/components/schemas/BoardSelection' } },
                        addedAt: { type: 'number', description: 'Epoch millis — drives restore order' }
                    }
                },
                UserProfile: {
                    type: 'object',
                    properties: {
                        uid: { type: 'string', example: 'user123' },
                        email: { type: 'string', example: 'user@example.com' },
                        displayName: { type: 'string', example: 'John Doe' },
                        stations: {
                            type: 'array',
                            description: 'LEGACY board list — Android only.',
                            items: { $ref: '#/components/schemas/SubscribedStation' }
                        },
                        boards: {
                            type: 'array',
                            description:
                                'v2 board list. Always present on read: derived from `stations` for an ' +
                                'account that has only ever used Android, so a first iOS login restores ' +
                                'their board without writing back over Android\'s list.',
                            items: { $ref: '#/components/schemas/SavedBoard' }
                        },
                        boardsUpdatedAt: { type: 'number', description: 'LWW guard for `boards`, epoch millis' },
                        supportMoney: {
                            type: 'object',
                            description:
                                'Voluntary-contribution status. Present ONLY when the account has ' +
                                'contributed at least once. Status only, never a history — see ' +
                                '`UserService.normaliseSupportMoneyForClient`. Written server-side off a ' +
                                'signature-verified payment webhook; the client cannot set it.',
                            properties: {
                                status: { type: 'string', enum: ['active', 'none'], description: 'Recomputed from `until` on every read' },
                                tier:   { type: 'string', enum: ['tip', 'supporter'] },
                                since:  { type: 'number', description: 'Epoch millis of the most recent contribution' },
                                until:  { type: 'number', description: 'Epoch millis the Supporter badge stops showing' },
                                count:  { type: 'number', description: 'Lifetime contribution count — powers copy, never shown as a list' }
                            }
                        }
                        // No `preferences`. Client settings — expanded, rows, pin,
                        // order, layout — are DEVICE-LOCAL, kept per account on the
                        // device and restored when the same person signs back in
                        // there. They change on every touch and this document is the
                        // one every login reads, so syncing them spent the write
                        // quota on the lowest-value state in the app. Advertising the
                        // field here is what would invite a client to start again.
                    }
                },
                UserSyncRequest: {
                    type: 'object',
                    required: ['uid', 'email'],
                    properties: {
                        uid: { type: 'string' },
                        email: { type: 'string' },
                        displayName: { type: 'string' },
                        photoURL: { type: 'string' },
                        signInProvider: { type: 'string' }
                    }
                },
                StationSyncRequest: {
                    type: 'object',
                    required: ['uid', 'stations'],
                    properties: {
                        uid: { type: 'string' },
                        stations: {
                            type: 'array',
                            items: { $ref: '#/components/schemas/SubscribedStation' }
                        }
                    }
                },
                Layout: {
                    type: 'object',
                    properties: {
                        template: { type: 'string', example: 'selection_flow' },
                        data: { type: 'object' }
                    }
                },
                PredictionItem: {
                    type: 'object',
                    properties: {
                        destId: { type: 'string', example: '940GZZLUEDM' },
                        platform: { type: 'string', example: 'Platform 1' },
                        eta: { type: 'string', format: 'date-time' },
                        displayName: { type: 'string', example: 'Upminster' }
                    }
                },
                LinePredictions: {
                    type: 'object',
                    properties: {
                        id: { type: 'string', example: 'district' },
                        name: { type: 'string', example: 'District' },
                        dirs: {
                            type: 'object',
                            additionalProperties: {
                                type: 'object',
                                properties: {
                                    preds: {
                                        type: 'array',
                                        items: { $ref: '#/components/schemas/PredictionItem' }
                                    }
                                }
                            }
                        }
                    }
                },
                StationPredictionResponse: {
                    type: 'object',
                    properties: {
                        id: { type: 'string', example: '940GZZLUBKG' },
                        name: { type: 'string', example: 'Barking Underground Station' },
                        lut: { type: 'string', format: 'date-time' },
                        lines: {
                            type: 'object',
                            additionalProperties: { $ref: '#/components/schemas/LinePredictions' }
                        }
                    }
                }
            }
        },
        tags: [
            { name: 'Stations', description: 'Access to station metadata, location searching, and line association.' },
            { name: 'Modes', description: 'Transport meta-data for supported London transport modes.' },
            { name: 'Lines', description: 'Live line status, routes, and operational information.' },
            { name: 'Users', description: 'Synchronization of user profiles and personalized station subscriptions.' },
            { name: 'SDUI', description: 'Server-Driven UI layout definitions for dynamic mobile application screens.' },
            { name: 'Auth', description: 'Layout endpoints for authentication flows (Login, Register, Password Reset).' }
        ],
        security: [
            { StationlyKey: [] }
        ]
    },
    apis: [
        path.join(__dirname, '../controllers/*.ts'),
        path.join(__dirname, '../controllers/*.js')
    ]
};

// --- PUBLIC DOC FILTER ---------------------------------------------------
// Strips internal / app-only operations out of the spec we *publish*.
// This is a documentation-only transform: it operates on a deep copy of the
// generated spec and is used solely for `/openapi.json` + `/docs`. The live
// API (routes, controllers, middleware, auth) is completely untouched — those
// endpoints still exist and work, they're just not advertised to third-party
// developers browsing the public reference.
//
// Published surface = the transport-data product only (Modes, Lines, Stations).
// Enforced by the PUBLIC_TAGS allow-list below.
// See docs/API_DOCUMENTATION.md for the full rationale.
const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace'] as const;
export function buildPublicSpec(fullSpec: any): any {
    const spec = JSON.parse(JSON.stringify(fullSpec));
    // The public reference is the transport-data product only. This is an
    // ALLOW-LIST, and that direction is the whole point: an operation is
    // published only if it carries one of these tags, so anything new defaults
    // to HIDDEN and a leak requires someone to deliberately tag an endpoint as
    // transport data.
    //
    // It used to be a deny-list (INTERNAL_TAGS = Users/SDUI/Auth/Theme/Waitlist),
    // which fails open: it can only hide the categories it was told about at the
    // time it was written. The widget-push work then added two NEW tags — `Widget
    // Push` and `Admin` — that the deny-list had never heard of, and four
    // operations published themselves onto `/docs`: `/device/register`,
    // `/device/unregister`, and the two admin `/admin/device-push/*` routes.
    // Nobody had to make a mistake for that to happen; the default did it.
    //
    // A third-party developer holds an `X-Stationly-Key` and nothing else. Every
    // hidden category is unusable to them by construction — `/user/*` and
    // `/device/*` need a Firebase bearer tied to Stationly's own auth, `/admin/*`
    // needs `X-Stationly-Admin-Key`, and SDUI/Theme return layouts shaped for the
    // app's own renderer — so documenting any of it leaks internal mechanics
    // while giving the reader nothing they can call.
    const PUBLIC_TAGS = new Set(['Stations', 'Modes', 'Lines']);
    // Overrides the allow-list: an operation carrying one of these is hidden
    // even if it ALSO carries a public tag. Without this, `[Stations, Users]`
    // would publish on the strength of `Stations` alone — and that combination
    // is not hypothetical here. `/stations/subscribed-ids` is a user-scoped,
    // dev-tier endpoint tagged `Stations`, kept out today by a hand-written
    // path entry below; tag it honestly as `[Stations, Users]` and this line is
    // what keeps it hidden. An allow-list on its own only asks "is this
    // transport data?", never "is this ALSO someone's private data?".
    const INTERNAL_TAGS = new Set(['Users', 'User', 'SDUI', 'Auth', 'Theme', 'Waitlist', 'Widget Push', 'Admin']);
    // Hidden by route, for operations whose tags alone wouldn't catch them.
    // `/stations/subscribed-ids` is the live case (tagged `Stations`, dev-tier).
    // `/user/` + `/auth/` are redundant under the two tag rules above and are
    // kept deliberately as a third, independent guard.
    const INTERNAL_PREFIXES = ['/user/', '/auth/', '/stations/subscribed-ids'];

    // 1. Publish an operation only if it is tagged as public, is NOT tagged
    //    internal, and sits outside every internal prefix. Drop the path
    //    entirely if nothing's left. An operation with no tags at all fails the
    //    first test and is dropped — fail closed.
    for (const [route, item] of Object.entries<any>(spec.paths ?? {})) {
        const isInternalPath = INTERNAL_PREFIXES.some((p) => route.startsWith(p));
        for (const method of HTTP_METHODS) {
            const op = item[method];
            if (!op) continue;
            const tags: string[] = op.tags ?? [];
            const isPublicTagged = tags.some((t) => PUBLIC_TAGS.has(t));
            const hasInternalTag = tags.some((t) => INTERNAL_TAGS.has(t));
            if (isInternalPath || hasInternalTag || !isPublicTagged) delete item[method];
        }
        if (!HTTP_METHODS.some((m) => item[m])) delete spec.paths[route];
    }

    // 2. Prune component schemas nothing in the public spec still references
    //    (follows $refs transitively so shared schemas survive).
    const allSchemas: Record<string, any> = spec.components?.schemas ?? {};
    const reachable = new Set<string>();
    const collectRefs = (node: any): void => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) { node.forEach(collectRefs); return; }
        for (const [key, value] of Object.entries<any>(node)) {
            const match = key === '$ref' && typeof value === 'string'
                ? value.match(/^#\/components\/schemas\/(.+)$/)
                : null;
            if (match && !reachable.has(match[1])) {
                reachable.add(match[1]);
                collectRefs(allSchemas[match[1]]);
            } else {
                collectRefs(value);
            }
        }
    };
    collectRefs(spec.paths);
    if (spec.components?.schemas) {
        spec.components.schemas = Object.fromEntries(
            Object.entries(allSchemas).filter(([name]) => reachable.has(name)),
        );
    }

    // 3. Keep only tags still used by a visible operation (drops empty `Users`).
    const usedTags = new Set<string>();
    for (const item of Object.values<any>(spec.paths ?? {})) {
        for (const method of HTTP_METHODS) {
            (item[method]?.tags ?? []).forEach((t: string) => usedTags.add(t));
        }
    }
    if (Array.isArray(spec.tags)) {
        spec.tags = spec.tags.filter((t: any) => usedTags.has(t.name));
    }

    return spec;
}

/**
 * The two specs, built the way `server.ts` builds them.
 *
 * Exists so the composition itself is testable: a test that called
 * `buildPublicSpec` on a spec it assembled by hand would prove nothing about
 * what the server actually serves. `src/tests/run.ts` calls this.
 *
 * `full` is every annotated operation; `published` is what `/openapi.json` and
 * `/docs` return. Nothing else should consume either — the live API does not
 * read them.
 */
export function buildSpecs(): { full: any; published: any } {
    const full = swaggerJsdoc(swaggerOptions);
    return { full, published: buildPublicSpec(full) };
}
