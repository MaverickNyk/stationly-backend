import Nav from '@/components/Nav';
import HistoryTable from '@/components/HistoryTable';
import { activeEnv } from '@/lib/env';

export default function HistoryPage() {
  return (
    <>
      <Nav active="/history" />
      <main className="page">
        <div className="page-head">
          <h1>Send history</h1>
          <p>
            Recent admin sends, newest first. Served from this environment&apos;s local audit log — no Firestore
            reads. Raw device tokens are never stored.
          </p>
        </div>
        <HistoryTable env={activeEnv()} />
      </main>
    </>
  );
}
