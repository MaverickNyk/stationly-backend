import { Request, Response } from 'express';
import { EmailService } from '../services/emailService';
import { AdminDataService } from './adminDataService';

export class AdminEmailController {
    static async sendAndroidLaunch(req: Request, res: Response) {
        try {
            const { target, testEmail } = req.body;

            if (target === 'test') {
                if (!testEmail) {
                    return res.status(400).json({ error: 'testEmail is required when target is "test"' });
                }

                let emails: string[] = [];
                if (Array.isArray(testEmail)) {
                    emails = testEmail.map(e => String(e).trim()).filter(Boolean);
                } else if (typeof testEmail === 'string') {
                    emails = testEmail.split(',').map(e => e.trim()).filter(Boolean);
                } else {
                    return res.status(400).json({ error: 'testEmail must be a string or array of strings' });
                }

                if (emails.length === 0) {
                    return res.status(400).json({ error: 'No valid emails provided in testEmail' });
                }

                console.log(`[AdminEmail] Sending test Android launch email to ${emails.length} recipients individually...`);
                // Send to each test email individually using the To field
                await Promise.all(
                    emails.map(email => EmailService.sendAndroidLaunchNotificationEmail(email))
                );
                return res.json({ success: true, message: `Test email sent to ${emails.length} recipients individually` });
            }

            if (target === 'all') {
                const refresh = req.query.refresh === '1';
                const { rows } = await AdminDataService.getWaitlist({ refresh });
                
                if (!rows || rows.length === 0) {
                    return res.json({ success: true, message: 'Waitlist is empty, no emails sent.' });
                }

                const emails = rows.map(r => r.email).filter(Boolean);
                console.log(`[AdminEmail] Starting one-by-one broadcast to ${emails.length} waitlisted users...`);

                // Run in background to prevent HTTP connection timeouts
                AdminEmailController.broadcastEmails(emails).catch(err => {
                    console.error('[AdminEmail] Background broadcast failed:', err);
                });

                return res.json({
                    success: true,
                    message: `Started background broadcast of Android launch email to ${emails.length} users. Check logs for details.`
                });
            }

            return res.status(400).json({ error: 'Invalid target. Must be "test" or "all"' });
        } catch (error: any) {
            console.error('[AdminEmail] sendAndroidLaunch failed:', error);
            return res.status(500).json({ error: error.message || 'Internal server error' });
        }
    }

    private static async broadcastEmails(emails: string[]) {
        const batchSize = 10;
        const delayMs = 1000; // 1s cooldown between batches of 10 to protect API rate limits

        for (let i = 0; i < emails.length; i += batchSize) {
            const batch = emails.slice(i, i + batchSize);
            console.log(`[AdminEmail] Sending batch ${Math.floor(i / batchSize) + 1} (${batch.length} emails, progress: ${i}/${emails.length})...`);
            
            await Promise.all(
                batch.map(async (email) => {
                    try {
                        await EmailService.sendAndroidLaunchNotificationEmail(email);
                        console.log(`[AdminEmail] Successfully sent email to ${email}`);
                    } catch (err) {
                        console.error(`[AdminEmail] Failed to send email to ${email}:`, err);
                    }
                })
            );

            if (i + batchSize < emails.length) {
                await new Promise(resolve => setTimeout(resolve, delayMs));
            }
        }
        console.log(`[AdminEmail] Broadcast complete. Processed ${emails.length} emails.`);
    }
}
