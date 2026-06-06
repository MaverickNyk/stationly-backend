import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { isValidSessionValue, SESSION_COOKIE } from '@/lib/session';
import { getUserTokens } from '@/lib/backend';
import { activeEnv } from '@/lib/env';

export const runtime = 'nodejs';

/**
 * Proxy: GET a uid's registered-device count from the backend (count only,
 * never raw tokens). Session-gated; target env + `fresh` come via query.
 */
export async function GET(req: Request, { params }: { params: { uid: string } }) {
  const session = cookies().get(SESSION_COOKIE)?.value;
  if (!(await isValidSessionValue(session))) {
    return NextResponse.json({ message: 'Not authenticated.' }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const fresh = searchParams.get('fresh') === '1';

  const uid = (params.uid || '').trim();
  if (!uid) {
    return NextResponse.json({ message: 'uid is required.' }, { status: 400 });
  }

  try {
    const result = await getUserTokens(activeEnv(), uid, fresh);
    return NextResponse.json(result.data, { status: result.status });
  } catch (e: any) {
    return NextResponse.json(
      { message: e?.message ?? 'Proxy failed to reach backend.' },
      { status: 502 },
    );
  }
}
