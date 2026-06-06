import Composer from '@/components/Composer';
import Nav from '@/components/Nav';
import { activeEnv } from '@/lib/env';

export default function NotificationsPage() {
  return (
    <>
      <Nav active="/notifications" />
      <main className="page">
        <div className="page-head">
          <h1>Send a notification</h1>
          <p>Compose a push, pick who gets it, and preview exactly how it lands on a device before sending.</p>
        </div>
        <Composer env={activeEnv()} />
      </main>
    </>
  );
}
