import { NextResponse } from 'next/server';

export async function GET() {
  try {
    // Get Supabase credentials from environment
    const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseKey) {
      // Return mock data if no credentials
      return NextResponse.json({
        tables: [
          { name: 'customers', rowCount: 136, schema: 'public' },
          { name: 'invoices', rowCount: 89, schema: 'public' },
          { name: 'work_orders', rowCount: 45, schema: 'public' },
          { name: 'contracts', rowCount: 23, schema: 'public' },
          { name: 'photo_uploads', rowCount: 1200000, schema: 'public' },
          { name: 'profiles', rowCount: 12, schema: 'public' },
          { name: 'companies', rowCount: 9, schema: 'public' },
          { name: 'team_chat', rowCount: 567, schema: 'public' },
        ]
      });
    }

    // Query to get all tables with row counts
    const response = await fetch(`${supabaseUrl}/rest/v1/rpc/get_table_info`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`
      }
    });

    if (!response.ok) {
      // If the RPC doesn't exist, fall back to basic table list
      const tablesResponse = await fetch(
        `${supabaseUrl}/rest/v1/?apikey=${supabaseKey}`,
        {
          headers: {
            'apikey': supabaseKey,
            'Authorization': `Bearer ${supabaseKey}`
          }
        }
      );

      if (tablesResponse.ok) {
        const text = await tablesResponse.text();
        // Parse OpenAPI spec to get table names
        try {
          const spec = JSON.parse(text);
          const tables = Object.keys(spec.definitions || {})
            .filter(name => !name.startsWith('_'))
            .map(name => ({ name, rowCount: 0, schema: 'public' }));
          return NextResponse.json({ tables });
        } catch {
          // Return empty if can't parse
          return NextResponse.json({ tables: [] });
        }
      }
    }

    const data = await response.json();
    return NextResponse.json({ tables: data });
  } catch (error: any) {
    return NextResponse.json({ error: error.message, tables: [] }, { status: 500 });
  }
}
