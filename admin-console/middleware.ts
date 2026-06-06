import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { isValidSessionValue, SESSION_COOKIE } from '@/lib/session';

/**
 * Redirects unauthenticated visitors to /login. Runs on every page request
 * except the login page, the auth/proxy API routes (which check the session
 * themselves), and static assets.
 */
export async function middleware(req: NextRequest) {
  const session = req.cookies.get(SESSION_COOKIE)?.value;
  const authed = await isValidSessionValue(session);

  if (!authed) {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    url.searchParams.set('from', req.nextUrl.pathname);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  // Protect everything except: login page, all API routes, Next internals.
  matcher: ['/((?!login|api|_next/static|_next/image|favicon.ico).*)'],
};
