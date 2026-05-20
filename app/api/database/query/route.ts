import { NextRequest, NextResponse } from 'next/server';

export async function POST(req: NextRequest) {
  try {
    const { query } = await req.json();

    if (!query) {
      return NextResponse.json({ error: 'Query is required' }, { status: 400 });
    }

    // Basic SQL injection prevention - only allow SELECT queries
    const normalizedQuery = query.trim().toUpperCase();
    if (!normalizedQuery.startsWith('SELECT')) {
      return NextResponse.json({ 
        error: 'Only SELECT queries are allowed for safety',
        data: null,
        rowCount: 0,
        duration: 0
      }, { status: 400 });
    }

    const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseKey) {
      return NextResponse.json({ 
        error: 'Database not configured',
        data: null,
        rowCount: 0,
        duration: 0
      }, { status: 500 });
    }

    const startTime = Date.now();

    // Use Supabase's SQL endpoint
    const response = await fetch(`${supabaseUrl}/rest/v1/rpc/execute_sql`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`
      },
      body: JSON.stringify({ query })
    });

    const duration = Date.now() - startTime;

    if (!response.ok) {
      // Try alternative: parse the query and use REST API
      const tableName = extractTableName(query);
      if (tableName) {
        const limit = extractLimit(query) || 100;
        
        const restResponse = await fetch(
          `${supabaseUrl}/rest/v1/${tableName}?limit=${limit}`,
          {
            headers: {
              'apikey': supabaseKey,
              'Authorization': `Bearer ${supabaseKey}`
            }
          }
        );

        if (restResponse.ok) {
          const data = await restResponse.json();
          return NextResponse.json({
            data,
            rowCount: data.length,
            duration: Date.now() - startTime,
            error: null
          });
        }
      }

      const errorText = await response.text();
      return NextResponse.json({ 
        error: errorText || 'Query failed',
        data: null,
        rowCount: 0,
        duration
      });
    }

    const data = await response.json();
    
    return NextResponse.json({
      data: Array.isArray(data) ? data : [data],
      rowCount: Array.isArray(data) ? data.length : 1,
      duration,
      error: null
    });
  } catch (error: any) {
    return NextResponse.json({ 
      error: error.message,
      data: null,
      rowCount: 0,
      duration: 0
    }, { status: 500 });
  }
}

function extractTableName(query: string): string | null {
  const match = query.match(/FROM\s+([a-zA-Z_][a-zA-Z0-9_]*)/i);
  return match ? match[1] : null;
}

function extractLimit(query: string): number | null {
  const match = query.match(/LIMIT\s+(\d+)/i);
  return match ? parseInt(match[1]) : null;
}
