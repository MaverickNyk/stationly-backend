import { Resend } from 'resend';
import { welcomeEmailHtml } from '../templates/welcomeEmailTemplate';
import { forgotPasswordEmailHtml } from '../templates/forgotPasswordTemplate';
import { waitlistEmailHtml } from '../templates/waitlistEmailTemplate';

const resend = new Resend(process.env.RESEND_API_KEY);
const FROM = 'Stationly <info@stationly.co.uk>';

export class EmailService {
    static async sendWelcomeEmail(email: string, name: string): Promise<void> {
        try {
            await resend.emails.send({
                from: FROM,
                to: email,
                subject: `Hey ${name || 'there'}, Welcome to Stationly 🎉`,
                html: welcomeEmailHtml(name),
            });
        } catch (err) {
            // Non-fatal — log and move on so signup never fails because of email
            console.error('[EmailService] Failed to send welcome email:', err);
        }
    }

    static async sendPasswordResetEmail(email: string, name: string, resetLink: string): Promise<void> {
        try {
            await resend.emails.send({
                from: FROM,
                to: email,
                subject: 'Reset your Stationly password',
                html: forgotPasswordEmailHtml(name, resetLink),
            });
        } catch (err) {
            console.error('[EmailService] Failed to send password reset email:', err);
            throw err;
        }
    }

    static async sendWaitlistEmail(email: string): Promise<void> {
        try {
            await resend.emails.send({
                from: FROM,
                to: email,
                subject: "You're on the list — Stationly is coming",
                html: waitlistEmailHtml(),
            });
        } catch (err) {
            // Non-fatal — Firestore entry is the source of truth
            console.error('[EmailService] Failed to send waitlist email:', err);
        }
    }
}
