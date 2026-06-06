import Nav from '@/components/Nav';
import UsersTable from '@/components/UsersTable';
import { activeEnv } from '@/lib/env';

export default function UsersPage() {
  return (
    <>
      <Nav active="/users" />
      <main className="page">
        <div className="page-head">
          <h1>Users</h1>
          <p>
            Registered Stationly users — served from the local cache (0 Firestore reads). Hit Refresh for one live
            read when you need the latest.
          </p>
        </div>
        <UsersTable env={activeEnv()} />
      </main>
    </>
  );
}
