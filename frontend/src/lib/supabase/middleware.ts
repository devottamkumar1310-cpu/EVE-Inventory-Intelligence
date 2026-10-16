import { logger } from "@/lib/logger";
import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({
    request,
  })

  const pathname = request.nextUrl.pathname
  logger.log(`[MIDDLEWARE] [START] Pathname: ${pathname}`)

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  // Keep public routes renderable when the preview process starts before its
  // project variables are injected. Auth middleware can resume on the next
  // request once the variables are available.
  if (!supabaseUrl || !supabaseAnonKey) {
    logger.warn('[MIDDLEWARE] Supabase environment variables are unavailable; skipping session refresh')
    return supabaseResponse
  }

  const supabase = createServerClient(
    supabaseUrl,
    supabaseAnonKey,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          logger.log(`[MIDDLEWARE] [COOKIES] Setting cookies:`, cookiesToSet.map(c => c.name))
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
          supabaseResponse = NextResponse.next({
            request,
          })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  const {
    data: { user },
    error: userError
  } = await supabase.auth.getUser()

  if (userError) {
    logger.error(`[MIDDLEWARE] [AUTH ERROR] getUser failed:`, userError.message)
  }

  logger.log(`[MIDDLEWARE] [AUTH] Path: ${pathname}, User email: ${user?.email || "anonymous (null)"}, Verified: ${!!user?.email_confirmed_at}`)

  const isAuthRoute = pathname.startsWith('/login') || pathname.startsWith('/signup') || pathname.startsWith('/forgot-password')
  const isVerifyRoute = pathname.startsWith('/verify-email')

  if (user) {
    const isConfirmed = !!user.email_confirmed_at;
    
    // Redirect unverified users trying to access dashboard or onboarding
    if (!isConfirmed && !isVerifyRoute && (pathname.startsWith('/dashboard') || pathname.startsWith('/onboarding'))) {
      const url = request.nextUrl.clone()
      url.pathname = '/verify-email'
      url.searchParams.set('email', user.email || '')
      logger.log(`[MIDDLEWARE] [REDIRECT] Unconfirmed user redirected to: ${url.pathname}`)
      return NextResponse.redirect(url)
    }

    // Redirect verified users away from verify-email
    if (isConfirmed && isVerifyRoute) {
      const url = request.nextUrl.clone()
      url.pathname = '/dashboard/inventory'
      logger.log(`[MIDDLEWARE] [REDIRECT] Verified user redirected away from verify-email to: ${url.pathname}`)
      return NextResponse.redirect(url)
    }

    // Redirect authenticated users away from auth routes
    if (isConfirmed && isAuthRoute) {
      const url = request.nextUrl.clone()
      url.pathname = '/dashboard/inventory'
      logger.log(`[MIDDLEWARE] [REDIRECT] Authenticated user redirected away from auth page to: ${url.pathname}`)
      return NextResponse.redirect(url)
    }

    // Redirect authenticated users from root page '/' ONLY to dashboard/inventory
    if (isConfirmed && pathname === '/') {
      const url = request.nextUrl.clone()
      url.pathname = '/dashboard/inventory'
      logger.log(`[MIDDLEWARE] [REDIRECT] Authenticated user on root '/' redirected to: ${url.pathname}`)
      return NextResponse.redirect(url)
    }
  } else {
    // Protect /dashboard, /onboarding, and /owner for unauthenticated users
    if (pathname.startsWith('/dashboard') || pathname.startsWith('/onboarding') || pathname.startsWith('/owner')) {
      const url = request.nextUrl.clone()
      url.pathname = '/login'
      logger.log(`[MIDDLEWARE] [REDIRECT] Unauthenticated user redirected to login: ${url.pathname}`)
      return NextResponse.redirect(url)
    }
  }

  logger.log(`[MIDDLEWARE] [PASS] Proceeding to route: ${pathname}`)
  return supabaseResponse
}
