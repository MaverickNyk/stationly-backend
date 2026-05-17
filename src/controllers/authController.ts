import { Request, Response } from 'express';
import { URL } from 'url';
import { auth } from '../config/firebase';
import { EmailService } from '../services/emailService';
import { getBaseUrl, getWebUrl } from '../utils/formatters';

/**
 * Wrapper around auth.generateEmailVerificationLink with bounded retries on
 * auth/user-not-found. Right after createUserWithEmailAndPassword on the client,
 * the Admin SDK can need up to ~3s to see the new user. Without this the very
 * first signup-time call gets a 500 and the app falls back to Firebase's plain
 * verification email instead of our Resend-branded one.
 */
async function generateVerifyLinkWithRetry(email: string): Promise<string> {
    const delays = [0, 600, 1200, 2000]; // total ~3.8s worst case
    let lastErr: any;
    for (const wait of delays) {
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        try {
            return await auth.generateEmailVerificationLink(email);
        } catch (err: any) {
            const code = err?.errorInfo?.code || err?.code;
            // Only retry on the propagation race. Anything else (config / quota /
            // bad email) is fatal and shouldn't be hidden behind retries.
            if (code !== 'auth/user-not-found') throw err;
            lastErr = err;
        }
    }
    throw lastErr;
}

export class AuthController {
    /**
     * Send the Stationly-branded verification email (mirrors sendPasswordReset).
     * Auth-required: the caller's Firebase ID token identifies the user, so we
     * generate the verify link for THEIR email — no spoofing possible.
     */
    static async sendVerification(req: Request, res: Response): Promise<void> {
        const user = (req as any).user as { uid?: string; email?: string } | undefined;
        if (!user?.uid || !user.email) {
            res.status(401).json({ error: 'Not authenticated.' });
            return;
        }

        try {
            // Generate Firebase's verify link with retry. For brand-new users
            // (called right after createUserWithEmailAndPassword) the Admin SDK
            // can hit a 1–3s eventual-consistency window where it can't see the
            // user yet and throws auth/user-not-found. Three quick retries cover
            // that window — if it still fails, the user genuinely doesn't exist.
            //
            // rawLink is the full Firebase hosted action URL
            // (https://<project>.firebaseapp.com/__/auth/action?...). We DON'T
            // pass actionCodeSettings: that would require whitelisting our
            // domain in Firebase Console → Authentication → Authorized Domains.
            const rawLink = await generateVerifyLinkWithRetry(user.email);
            const parsed = new URL(rawLink);
            const oobCode = parsed.searchParams.get('oobCode') ?? '';
            const apiKey  = parsed.searchParams.get('apiKey')  ?? '';

            // Smart redirect for the email button:
            //   - Mobile with app installed → stationly://verified?oobCode=... — app
            //     calls applyActionCode itself via MainActivity's deep-link handler.
            //   - Mobile/desktop without app → falls back to our /verified branded
            //     page which applies the code via Firebase REST in-browser and shows
            //     a Stationly success state with "Open the App" CTA.
            const deepLink  = `stationly://verified?oobCode=${encodeURIComponent(oobCode)}`;
            const webLink   = `${getBaseUrl()}/verified?oobCode=${encodeURIComponent(oobCode)}&apiKey=${encodeURIComponent(apiKey)}`;
            const smartLink = `${getBaseUrl()}/open?deep=${encodeURIComponent(deepLink)}&web=${encodeURIComponent(webLink)}`;

            // Display name: prefer Firebase Auth's displayName (set during signup),
            // then Firestore (also populated at signup), then email prefix as a
            // last resort. Previously we ALWAYS hit the email-prefix path because
            // req.user only had {uid, email} — never `name`.
            let displayName = '';
            try {
                const fbUser = await auth.getUser(user.uid);
                displayName = fbUser.displayName ?? '';
            } catch (_) {
                // ignore — fall through to email prefix
            }
            if (!displayName) displayName = user.email.split('@')[0];

            await EmailService.sendVerifyEmail(user.email, displayName, smartLink);

            res.status(200).json({ success: true });
        } catch (err: any) {
            console.error('[AuthController] sendVerification error:', err);
            res.status(500).json({ error: 'Failed to send verification email. Please try again.' });
        }
    }

    static async sendPasswordReset(req: Request, res: Response): Promise<void> {
        const { email } = req.body;
        if (!email || typeof email !== 'string') {
            res.status(400).json({ error: 'Email is required.' });
            return;
        }

        const normalised = email.trim().toLowerCase();

        try {
            // Generate raw Firebase reset link — we only need the oobCode from it.
            // No continueUrl passed: we build our own smartLink below and Firebase's
            // continueUrl is never followed. Passing one requires the domain to be
            // whitelisted in Firebase Console, which adds operational fragility.
            const rawLink = await auth.generatePasswordResetLink(normalised);
            const parsed = new URL(rawLink);
            const oobCode = parsed.searchParams.get('oobCode') ?? '';
            const apiKey  = parsed.searchParams.get('apiKey')  ?? '';

            // Build our branded smart-redirect URLs. Web fallback is OUR branded
            // /reset-password page on the API host (same pattern as /verified)
            // rather than getWebUrl() — we don't depend on a separate web-app
            // deployment, the page is served by the Node.js backend.
            const deepLink  = `stationly://reset?oobCode=${encodeURIComponent(oobCode)}`;
            const webLink   = `${getBaseUrl()}/reset-password?oobCode=${encodeURIComponent(oobCode)}&apiKey=${encodeURIComponent(apiKey)}`;
            const smartLink = `${getBaseUrl()}/open?deep=${encodeURIComponent(deepLink)}&web=${encodeURIComponent(webLink)}`;

            // Look up display name — fall back to email prefix
            let name = normalised.includes('@') ? normalised.split('@')[0] : 'there';
            try {
                const fbUser = await auth.getUserByEmail(normalised);
                if (fbUser.displayName) name = fbUser.displayName;
            } catch (err: any) {
                if (err?.code !== 'auth/user-not-found') {
                    console.warn('[AuthController] Unexpected error fetching user:', err?.message);
                }
            }

            await EmailService.sendPasswordResetEmail(email, name, smartLink);

            // Always 200 — never reveal whether the email exists
            res.status(200).json({ success: true });
        } catch (err: any) {
            if (err?.code === 'auth/user-not-found' || err?.errorInfo?.code === 'auth/user-not-found') {
                res.status(200).json({ success: true });
                return;
            }
            console.error('[AuthController] sendPasswordReset error:', err);
            res.status(500).json({ error: 'Failed to send reset email. Please try again.' });
        }
    }
}
