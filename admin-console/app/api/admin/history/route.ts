import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { isValidSessionValue, SESSION_COOKIE } from '@/lib/session';
import { getHistory } from '@/lib/backend';
import { activeEnv } from '@/lib/env';

export const runtime = 'nodejs';

/**
 * Proxy: GET recent admin sends from a given env's local audit log.
 * Session-gated; target env + limit come via query.
 */
export async function GET(req: Request) {
  const session = cookies().get(SESSION_COOKIE)?.value;
  if (!(await isValidSessionValue(session))) {
    return NextResponse.json({ message: 'Not authenticated.' }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const limit = Number(searchParams.get('limit') ?? 50);

  try {
    const result = await getHistory(activeEnv(), Number.isFinite(limit) ? limit : 50);
    return NextResponse.json(result.data, { status: result.status });
  } catch (e: any) {
    return NextResponse.json(
      { message: e?.message ?? 'Proxy failed to reach backend.' },
      { status: 502 },
    );
  }
}
