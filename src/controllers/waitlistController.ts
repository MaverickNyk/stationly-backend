import { Request, Response } from 'express';
import { db } from '../config/firebase';
import { EmailService } from '../services/emailService';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class WaitlistController {
    /**
     * @openapi
     * /waitlist/join:
     *   post:
     *     summary: Join the Stationly launch waitlist
     *     tags: [Waitlist]
     *     security: []
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             required: [email]
     *             properties:
     *               email:
     *                 type: string
     *                 format: email
     *     responses:
     *       200:
     *         description: Successfully joined (or already on list)
     *       400:
     *         description: Invalid email
     *       500:
     *         description: Server error
     */
    static async join(req: Request, res: Response): Promise<void> {
        const { email } = req.body;

        if (!email || typeof email !== 'string' || !EMAIL_RE.test(email.trim())) {
            res.status(400).json({ error: 'A valid email address is required.' });
            return;
        }

        const normalised = email.trim().toLowerCase();
        const docId = normalised.replace(/[^a-z0-9]/g, '_');

        try {
            const ref = db.collection('waitlist').doc(docId);
            const snap = await ref.get();
            const alreadyExists = snap.exists;

            await ref.set({
                email: normalised,
                joinedAt: snap.exists ? snap.data()?.joinedAt : new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            }, { merge: true });

            // Only send email on first sign-up
            if (!alreadyExists) {
                await EmailService.sendWaitlistEmail(normalised);
            }

            res.status(200).json({ success: true, alreadyRegistered: alreadyExists });
        } catch (err: any) {
            console.error('[WaitlistController] join error:', err);
            res.status(500).json({ error: 'Something went wrong. Please try again.' });
        }
    }
}
