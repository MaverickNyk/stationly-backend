/**
 * One-time enabler for the National Rail mode.
 *
 * National Rail is NOT auto-populated from TfL (it's `isTflService: false` and
 * sits in EXEMPT_MODES), so the mode is added deliberately here. This does two
 * things:
 *
 *   1. Generates the mode icon at `public/icons/national-rail.png` (a
 *      placeholder National Rail "double arrow" — swap in the official asset
 *      when you have it; the filename is what matters).
 *   2. Upserts the `modes/national-rail` Firestore doc. The running backend's
 *      `modes` onSnapshot listener (DataCacheService) picks it up live into
 *      SQLite + the in-memory cache — no restart — so `GET /modes` starts
 *      returning National Rail with its icon (getIconUrl) and tint (#1D3E89).
 *
 * This is display-only: the mode appears in the picker. Making it selectable to
 * a live board still needs the station sync (add `national-rail` to the syncer's
 * tfl.transport.modes) and the Darwin predictions.
 *
 * Target project comes from FIREBASE_KEY_PATH (the service-account key), so run
 * it with your STAGING credentials to hit staging Firestore.
 *
 * Usage (from stationly-backend/):
 *   npx ts-node src/scripts/seedNationalRailMode.ts            # DRY RUN (also writes the icon)
 *   npx ts-node src/scripts/seedNationalRailMode.ts --write    # write the Firestore doc
 *   FIREBASE_KEY_PATH=./staging-key.json npx ts-node src/scripts/seedNationalRailMode.ts --write
 */
import * as path from 'path';
import * as fs from 'fs';
import sharp from 'sharp';
import { db } from '../config/firebase';

const WRITE = process.argv.includes('--write');

const MODE_NAME = 'national-rail';
const DISPLAY_NAME = 'National Rail';
const TINT = '#1D3E89';

const ICON_PATH = path.join(__dirname, '..', '..', 'public', 'icons', 'national-rail.png');

// The official National Rail "double arrow" (the BR Double Arrow, a registered
// trade mark of the Secretary of State for Transport) — two red stroked paths
// (zig-zag arrows + two parallel rails), reproduced from the Wikimedia SVG, on a
// white rounded badge at 256×256 (4× the client's display size for crispness).
const NR_RED = '#ED1C24';
const ICON_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
  <rect width="256" height="256" rx="56" fill="#FFFFFF"/>
  <clipPath id="nr"><rect x="0" y="0" width="62" height="39"/></clipPath>
  <g transform="translate(38,71.4) scale(2.903)">
    <g clip-path="url(#nr)" fill="none" stroke="${NR_RED}" stroke-width="8.9" stroke-miterlimit="10">
      <path d="M1,-8.9 46,12.4 16,26.6 61,47.9"/>
      <path d="M0,12.4H62m0,14.2H0"/>
    </g>
  </g>
</svg>`;

async function generateIcon(): Promise<void> {
    fs.mkdirSync(path.dirname(ICON_PATH), { recursive: true });
    // High density then downscale keeps the stroked artwork crisp at 256².
    await sharp(Buffer.from(ICON_SVG), { density: 300 }).png().resize(256, 256).toFile(ICON_PATH);
    console.log(`🎨 Wrote National Rail icon → ${path.relative(process.cwd(), ICON_PATH)}`);
}

async function seedMode(): Promise<void> {
    const doc = {
        modeName: MODE_NAME,
        displayName: DISPLAY_NAME,
        // Epoch millis watermark — matches every other replicated collection so
        // the running backend's delta sync + listener pick this doc up.
        lastUpdatedTime: Date.now(),
    };

    if (!WRITE) {
        console.log('🔎 DRY RUN — would upsert modes/national-rail:');
        console.log(JSON.stringify(doc, null, 2));
        console.log('   Re-run with --write to commit the Firestore doc.');
        return;
    }

    await db.collection('modes').doc(MODE_NAME).set(doc, { merge: true });
    console.log(`✅ Upserted modes/${MODE_NAME} (displayName="${DISPLAY_NAME}", tint=${TINT}).`);
}

async function main(): Promise<void> {
    console.log(`🚆 Enabling National Rail mode ${WRITE ? '(WRITE)' : '(DRY RUN)'}…`);
    await generateIcon();
    await seedMode();
    console.log('🏁 Done. Once deployed, GET /modes returns National Rail with its icon + tint.');
    process.exit(0);
}

main().catch(err => {
    console.error('💥 Failed to enable National Rail mode:', err);
    process.exit(1);
});
