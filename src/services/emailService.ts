import { Resend } from 'resend';
import { welcomeEmailHtml } from '../templates/welcomeEmailTemplate';
import { forgotPasswordEmailHtml } from '../templates/forgotPasswordTemplate';
import { verifyEmailHtml } from '../templates/verifyEmailTemplate';
import { waitlistEmailHtml } from '../templates/waitlistEmailTemplate';
import { isStaging } from '../utils/formatters';

const resend = new Resend(process.env.RESEND_API_KEY);
const FROM = 'Stationly <info@stationly.co.uk>';
const pfx = () => isStaging() ? '[Staging] ' : '';

export class EmailService {
    static async sendWelcomeEmail(email: string, name: string): Promise<void> {
        try {
            const { error } = await resend.emails.send({
                from: FROM,
                to: email,
                subject: `${pfx()}Hey ${name || 'there'}, Welcome to Stationly 🎉`,
                html: welcomeEmailHtml(name),
            });
            if (error) {
                console.error('[EmailService] Failed to send welcome email:', error);
            }
        } catch (err) {
            // Non-fatal — log and move on so signup never fails because of email
            console.error('[EmailService] Failed to send welcome email (exception):', err);
        }
    }

    static async sendPasswordResetEmail(email: string, name: string, resetLink: string): Promise<void> {
        try {
            const { error } = await resend.emails.send({
                from: FROM,
                to: email,
                subject: `${pfx()}Reset your Stationly password`,
                html: forgotPasswordEmailHtml(name, resetLink),
            });
            if (error) {
                throw new Error(error.message || JSON.stringify(error));
            }
        } catch (err) {
            console.error('[EmailService] Failed to send password reset email:', err);
            throw err;
        }
    }

    static async sendVerifyEmail(email: string, name: string, verifyLink: string): Promise<void> {
        try {
            const { error } = await resend.emails.send({
                from: FROM,
                to: email,
                subject: `${pfx()}Verify your Stationly email`,
                html: verifyEmailHtml(name, verifyLink),
            });
            if (error) {
                throw new Error(error.message || JSON.stringify(error));
            }
        } catch (err) {
            console.error('[EmailService] Failed to send verification email:', err);
            throw err;
        }
    }

    static async sendWaitlistEmail(email: string): Promise<void> {
        try {
            const { error } = await resend.emails.send({
                from: FROM,
                to: email,
                subject: `${pfx()}You're on the list — Stationly is coming`,
                html: waitlistEmailHtml(),
            });
            if (error) {
                console.error('[EmailService] Failed to send waitlist email:', error);
            }
        } catch (err) {
            // Non-fatal — Firestore entry is the source of truth
            console.error('[EmailService] Failed to send waitlist email (exception):', err);
        }
    }
}
