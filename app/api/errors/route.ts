import { NextResponse } from 'next/server';

// In-memory error store (would be replaced with real error tracking service)
let errorStore: any[] = [];

export async function GET() {
  try {
    // In production, this would fetch from:
    // - Vercel Logs API
    // - Supabase Edge Function logs
    // - Client-side error reporting service (Sentry, etc.)

    // For now, return mock data + any stored errors
    const mockErrors: any[] = [
      // Uncomment to see sample errors
      // {
      //   id: 'err_1',
      //   type: 'vercel',
      //   message: 'TypeError: Cannot read property "id" of undefined',
      //   source: '/api/customers/[id]',
      //   timestamp: new Date(Date.now() - 300000).toISOString(),
      //   count: 3,
      //   stack: `TypeError: Cannot read property 'id' of undefined
      //   at handler (/api/customers/[id].js:15:23)
      //   at processRequest (next-server.js:1234:5)`,
      //   resolved: false
      // },
    ];

    return NextResponse.json({
      errors: [...errorStore, ...mockErrors].sort((a, b) => 
        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
      )
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message, errors: [] }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const error = await req.json();
    
    // Add error to store
    errorStore.push({
      id: `err_${Date.now()}`,
      ...error,
      timestamp: new Date().toISOString(),
      count: 1,
      resolved: false
    });

    // Keep only last 100 errors
    if (errorStore.length > 100) {
      errorStore = errorStore.slice(-100);
    }

    return NextResponse.json({ success: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
