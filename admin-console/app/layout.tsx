import type { Metadata } from 'next';
import './globals.css';
import EnvBanner from '@/components/EnvBanner';

export const metadata: Metadata = {
  title: 'Stationly Admin',
  description: 'Internal admin console',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <EnvBanner />
        <div className="topbar" />
        {children}
      </body>
    </html>
  );
}
