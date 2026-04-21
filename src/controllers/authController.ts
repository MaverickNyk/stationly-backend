import { Request, Response } from 'express';
import { URL } from 'url';
import { auth } from '../config/firebase';
import { EmailService } from '../services/emailService';

export class AuthController {
    static async sendPasswordReset(req: Request, res: Response): Promise<void> {
        const { email } = req.body;
        if (!email || typeof email !== 'string') {
            res.status(400).json({ error: 'Email is required.' });
            return;
        }

        const normalised = email.trim().toLowerCase();

        try {
            // Generate raw Firebase reset link — we only need the oobCode from it
            const rawLink = await auth.generatePasswordResetLink(normalised, {
                url: 'https://stationly.co.uk', // placeholder continueUrl (overridden below)
            });

            // Extract oobCode from the Firebase-generated link
            const oobCode = new URL(rawLink).searchParams.get('oobCode') ?? '';

            // Build our branded smart-redirect URLs
            const deepLink  = `stationly://reset?oobCode=${encodeURIComponent(oobCode)}`;
            const webLink   = `https://stationly.co.uk/reset-password?oobCode=${encodeURIComponent(oobCode)}`;
            const smartLink = `https://stationly.co.uk/open?deep=${encodeURIComponent(deepLink)}&web=${encodeURIComponent(webLink)}`;

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
