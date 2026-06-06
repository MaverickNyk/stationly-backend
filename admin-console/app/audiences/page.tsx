import Nav from '@/components/Nav';
import AudienceLookup from '@/components/AudienceLookup';
import { activeEnv } from '@/lib/env';

export default function AudiencesPage() {
  return (
    <>
      <Nav active="/audiences" />
      <main className="page">
        <div className="page-head">
          <h1>Audience lookup</h1>
          <p>
            Check whether a Firebase UID can receive a push and to how many devices — before you target it.
            Reads are cache-first, so repeat lookups don&apos;t cost Firestore reads.
          </p>
        </div>
        <AudienceLookup env={activeEnv()} />
      </main>
    </>
  );
}
