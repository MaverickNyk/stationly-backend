import Nav from '@/components/Nav';
import WaitlistTable from '@/components/WaitlistTable';
import { activeEnv } from '@/lib/env';

export default function WaitlistPage() {
  return (
    <>
      <Nav active="/waitlist" />
      <main className="page">
        <div className="page-head">
          <h1>Waitlist</h1>
          <p>Launch-waitlist signups from the marketing site. Served from local cache; export to CSV any time.</p>
        </div>
        <WaitlistTable env={activeEnv()} />
      </main>
    </>
  );
}
