import { Resend } from 'resend';
import { welcomeEmailHtml } from '../templates/welcomeEmailTemplate';
import { forgotPasswordEmailHtml } from '../templates/forgotPasswordTemplate';
import { verifyEmailHtml } from '../templates/verifyEmailTemplate';
import { waitlistEmailHtml } from '../templates/waitlistEmailTemplate';
import { androidLaunchNotificationHtml } from '../templates/androidLaunchNotificationTemplate';
import { isStaging } from '../utils/formatters';
import { db } from '../config/firebase';
import * as admin from 'firebase-admin';

const resend = new Resend(process.env.RESEND_API_KEY);
const FROM = 'Stationly <info@stationly.co.uk>';
const pfx = () => isStaging() ? '[Staging] ' : '';

export class EmailService {
    /**
     * Asynchronously logs email dispatch status to Firestore.
     * Does not await the database write so email flow is unaffected.
     */
    private static logEmailToFirestore(emailType: string, recipient: string, subject: string, status: 'success' | 'error', errorMsg?: string, bcc?: string[]) {
        db.collection('emailLogs').add({
            emailType,
            recipient,
            bcc: bcc || null,
            subject,
            status,
            errorMsg: errorMsg || null,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        }).catch(err => {
            console.error('[EmailService] Failed to log email to Firestore asynchronously:', err);
        });
    }

    static async sendWelcomeEmail(email: string, name: string): Promise<void> {
        const subject = `${pfx()}Hey ${name || 'there'}, Welcome to Stationly 🎉`;
        try {
            const { error } = await resend.emails.send({
                from: FROM,
                to: email,
                subject,
                html: welcomeEmailHtml(name),
            });
            if (error) {
                console.error('[EmailService] Failed to send welcome email:', error);
                this.logEmailToFirestore('welcome', email, subject, 'error', error.message || JSON.stringify(error));
            } else {
                this.logEmailToFirestore('welcome', email, subject, 'success');
            }
        } catch (err: any) {
            console.error('[EmailService] Failed to send welcome email (exception):', err);
            this.logEmailToFirestore('welcome', email, subject, 'error', err.message || String(err));
        }
    }

    static async sendPasswordResetEmail(email: string, name: string, resetLink: string): Promise<void> {
        const subject = `${pfx()}Reset your Stationly password`;
        try {
            const { error } = await resend.emails.send({
                from: FROM,
                to: email,
                subject,
                html: forgotPasswordEmailHtml(name, resetLink),
            });
            if (error) {
                this.logEmailToFirestore('password_reset', email, subject, 'error', error.message || JSON.stringify(error));
                throw new Error(error.message || JSON.stringify(error));
            }
            this.logEmailToFirestore('password_reset', email, subject, 'success');
        } catch (err: any) {
            console.error('[EmailService] Failed to send password reset email:', err);
            this.logEmailToFirestore('password_reset', email, subject, 'error', err.message || String(err));
            throw err;
        }
    }

    static async sendVerifyEmail(email: string, name: string, verifyLink: string): Promise<void> {
        const subject = `${pfx()}Verify your Stationly email`;
        try {
            const { error } = await resend.emails.send({
                from: FROM,
                to: email,
                subject,
                html: verifyEmailHtml(name, verifyLink),
            });
            if (error) {
                this.logEmailToFirestore('verify_email', email, subject, 'error', error.message || JSON.stringify(error));
                throw new Error(error.message || JSON.stringify(error));
            }
            this.logEmailToFirestore('verify_email', email, subject, 'success');
        } catch (err: any) {
            console.error('[EmailService] Failed to send verification email:', err);
            this.logEmailToFirestore('verify_email', email, subject, 'error', err.message || String(err));
            throw err;
        }
    }

    static async sendWaitlistEmail(email: string): Promise<void> {
        const subject = `${pfx()}You're on the list — Stationly for iOS`;
        try {
            const { error } = await resend.emails.send({
                from: FROM,
                to: email,
                subject,
                html: waitlistEmailHtml(),
            });
            if (error) {
                console.error('[EmailService] Failed to send waitlist email:', error);
                this.logEmailToFirestore('waitlist', email, subject, 'error', error.message || JSON.stringify(error));
            } else {
                this.logEmailToFirestore('waitlist', email, subject, 'success');
            }
        } catch (err: any) {
            console.error('[EmailService] Failed to send waitlist email (exception):', err);
            this.logEmailToFirestore('waitlist', email, subject, 'error', err.message || String(err));
        }
    }

    static async sendAndroidLaunchNotificationEmail(email: string, bcc?: string[]): Promise<void> {
        const subject = `${pfx()}The wait is over: Stationly is live on Android!`;
        try {
            const { error } = await resend.emails.send({
                from: FROM,
                to: email,
                bcc: bcc,
                subject,
                html: androidLaunchNotificationHtml(),
            });
            if (error) {
                console.error(`[EmailService] Failed to send Android launch notification email to ${email}:`, error);
                this.logEmailToFirestore('android_launch', email, subject, 'error', error.message || JSON.stringify(error), bcc);
            } else {
                this.logEmailToFirestore('android_launch', email, subject, 'success', undefined, bcc);
            }
        } catch (err: any) {
            console.error(`[EmailService] Failed to send Android launch notification email (exception) to ${email}:`, err);
            this.logEmailToFirestore('android_launch', email, subject, 'error', err.message || String(err), bcc);
        }
    }
}
