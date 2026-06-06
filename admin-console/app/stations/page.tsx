import Nav from '@/components/Nav';
import StationsTable from '@/components/StationsTable';
import { activeEnv } from '@/lib/env';

export default function StationsPage() {
  return (
    <>
      <Nav active="/stations" />
      <main className="page">
        <div className="page-head">
          <h1>Subscribed stations</h1>
          <p>
            Stations users are actively watching, by subscriber count — joined with station metadata from memory. Zero
            Firestore reads.
          </p>
        </div>
        <StationsTable env={activeEnv()} />
      </main>
    </>
  );
}
