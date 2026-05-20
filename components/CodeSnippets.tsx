'use client';

import { useState } from 'react';
import { Code, Copy, Check, ChevronDown, ChevronRight, Search } from 'lucide-react';

interface Snippet {
  id: string;
  name: string;
  category: string;
  description: string;
  code: string;
  language: string;
}

const SNIPPETS: Snippet[] = [
  // Multi-tenant Patterns
  {
    id: 'mt-query',
    name: 'Multi-tenant Query',
    category: 'Multi-tenancy',
    description: 'Standard Supabase query with company_id filter',
    language: 'javascript',
    code: `const { data, error } = await supabase
  .from('customers')
  .select('*')
  .eq('company_id', user.company_id)
  .order('created_at', { ascending: false });

if (error) throw error;
return { success: true, data };`
  },
  {
    id: 'mt-insert',
    name: 'Multi-tenant Insert',
    category: 'Multi-tenancy',
    description: 'Insert with company_id included',
    language: 'javascript',
    code: `const { data, error } = await supabase
  .from('customers')
  .insert({
    company_id: user.company_id,
    name: customerName,
    email: customerEmail,
    phone: customerPhone,
    created_by: user.id
  })
  .select()
  .single();

if (error) throw error;
return { success: true, data };`
  },
  // Service Patterns
  {
    id: 'service-method',
    name: 'Service Method Template',
    category: 'Services',
    description: 'Standard async service method with error handling',
    language: 'javascript',
    code: `export const fetchCustomers = async (companyId) => {
  try {
    const { data, error } = await supabase
      .from('customers')
      .select('*')
      .eq('company_id', companyId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return { success: true, data, error: null };
  } catch (error) {
    console.error('fetchCustomers error:', error);
    return { success: false, data: null, error: error.message };
  }
};`
  },
  // API Routes
  {
    id: 'api-route',
    name: 'API Route Template',
    category: 'API',
    description: 'Next.js API route with auth and error handling',
    language: 'javascript',
    code: `import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { userId, companyId } = req.body;

    if (!userId || !companyId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const { data, error } = await supabase
      .from('customers')
      .select('*')
      .eq('company_id', companyId);

    if (error) throw error;

    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error('API Error:', error);
    return res.status(500).json({ error: error.message });
  }
}`
  },
  // React Native Screen
  {
    id: 'rn-screen',
    name: 'React Native Screen',
    category: 'Mobile',
    description: 'Basic screen with navigation and styles',
    language: 'javascript',
    code: `import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { COLORS } from '../constants/colors';
import { useAuth } from '../context/AuthContext';

export default function MyScreen() {
  const navigation = useNavigation();
  const { user } = useAuth();
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      // Fetch data here
    } catch (error) {
      console.error('Error loading data:', error);
    }
    setLoading(false);
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>My Screen</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
    padding: 16,
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    color: COLORS.text.primary,
  },
});`
  },
  // RLS Policy
  {
    id: 'rls-policy',
    name: 'RLS Policy Template',
    category: 'Database',
    description: 'Row Level Security policy for multi-tenant table',
    language: 'sql',
    code: `-- Enable RLS
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;

-- SELECT policy: Users can only see their company's data
CREATE POLICY "Users can view own company customers"
  ON customers FOR SELECT
  USING (
    company_id = (SELECT company_id FROM profiles WHERE id = auth.uid())
  );

-- INSERT policy: Users can only insert for their company
CREATE POLICY "Users can insert own company customers"
  ON customers FOR INSERT
  WITH CHECK (
    company_id = (SELECT company_id FROM profiles WHERE id = auth.uid())
  );

-- UPDATE policy: Users can only update their company's data
CREATE POLICY "Users can update own company customers"
  ON customers FOR UPDATE
  USING (
    company_id = (SELECT company_id FROM profiles WHERE id = auth.uid())
  );

-- DELETE policy: Users can only delete their company's data
CREATE POLICY "Users can delete own company customers"
  ON customers FOR DELETE
  USING (
    company_id = (SELECT company_id FROM profiles WHERE id = auth.uid())
  );`
  },
  // Hook Pattern
  {
    id: 'custom-hook',
    name: 'Custom Hook Template',
    category: 'Hooks',
    description: 'Custom React hook with state and effects',
    language: 'javascript',
    code: `import { useState, useEffect, useCallback } from 'react';
import { customerService } from '../services/customerService';
import { useAuth } from '../context/AuthContext';

export function useCustomers() {
  const { user } = useAuth();
  const [customers, setCustomers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchCustomers = useCallback(async () => {
    if (!user?.company_id) return;
    
    setLoading(true);
    setError(null);
    
    try {
      const result = await customerService.fetchCustomers(user.company_id);
      if (result.success) {
        setCustomers(result.data);
      } else {
        setError(result.error);
      }
    } catch (e) {
      setError(e.message);
    }
    
    setLoading(false);
  }, [user?.company_id]);

  useEffect(() => {
    fetchCustomers();
  }, [fetchCustomers]);

  return { customers, loading, error, refetch: fetchCustomers };
}`
  },
  // Stripe Webhook
  {
    id: 'stripe-webhook',
    name: 'Stripe Webhook Handler',
    category: 'Payments',
    description: 'Handle Stripe webhook events',
    language: 'javascript',
    code: `import Stripe from 'stripe';
import { buffer } from 'micro';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export const config = {
  api: { bodyParser: false }
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).end();
  }

  const buf = await buffer(req);
  const sig = req.headers['stripe-signature'];

  let event;

  try {
    event = stripe.webhooks.constructEvent(
      buf,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    return res.status(400).send(\`Webhook Error: \${err.message}\`);
  }

  switch (event.type) {
    case 'checkout.session.completed':
      const session = event.data.object;
      // Handle successful payment
      break;
    case 'customer.subscription.updated':
      const subscription = event.data.object;
      // Handle subscription update
      break;
    default:
      console.log(\`Unhandled event type: \${event.type}\`);
  }

  res.json({ received: true });
}`
  },
];

const CATEGORIES = [...new Set(SNIPPETS.map(s => s.category))];

export default function CodeSnippets() {
  const [search, setSearch] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [expandedSnippet, setExpandedSnippet] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const filteredSnippets = SNIPPETS.filter(snippet => {
    const matchesSearch = search === '' || 
      snippet.name.toLowerCase().includes(search.toLowerCase()) ||
      snippet.description.toLowerCase().includes(search.toLowerCase()) ||
      snippet.code.toLowerCase().includes(search.toLowerCase());
    
    const matchesCategory = selectedCategory === null || snippet.category === selectedCategory;
    
    return matchesSearch && matchesCategory;
  });

  const copyCode = (id: string, code: string) => {
    navigator.clipboard.writeText(code);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  return (
    <div
      style={{
        background: 'var(--ink, #0A0A0E)',
        border: '1px solid var(--line, rgba(255,255,255,0.08))',
        borderRadius: 12,
        padding: 16,
        fontFamily: 'var(--font-sans, system-ui)',
        color: 'var(--white, #fff)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <span
          style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 24, height: 24, borderRadius: 6,
            background: 'rgba(139, 111, 232, 0.12)',
            border: '1px solid rgba(139, 111, 232, 0.35)',
          }}
        >
          <Code style={{ width: 12, height: 12, color: 'var(--violet, #8B6FE8)' }} />
        </span>
        <div>
          <div style={{ fontFamily: 'var(--font-mono, ui-monospace)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--mist, rgba(255,255,255,0.5))' }}>
            Dev · Library
          </div>
          <div style={{ fontFamily: 'var(--font-display, "Space Grotesk")', fontSize: 16, fontWeight: 600, letterSpacing: '-0.01em', marginTop: 1 }}>
            Code snippets
          </div>
        </div>
      </div>

      {/* Search */}
      <div className="relative mb-3">
        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-terminal-dim" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search snippets..."
          className="w-full bg-terminal-bg border border-terminal-border rounded pl-9 pr-3 py-2 
                     text-terminal-text text-sm focus:border-terminal-purple outline-none"
        />
      </div>

      {/* Categories */}
      <div className="flex flex-wrap gap-2 mb-3">
        <button
          onClick={() => setSelectedCategory(null)}
          className={`px-2 py-1 text-xs rounded transition ${
            selectedCategory === null
              ? 'bg-terminal-purple/20 text-terminal-purple border border-terminal-purple/50'
              : 'text-terminal-dim border border-terminal-border hover:border-terminal-dim'
          }`}
        >
          All
        </button>
        {CATEGORIES.map(cat => (
          <button
            key={cat}
            onClick={() => setSelectedCategory(cat)}
            className={`px-2 py-1 text-xs rounded transition ${
              selectedCategory === cat
                ? 'bg-terminal-purple/20 text-terminal-purple border border-terminal-purple/50'
                : 'text-terminal-dim border border-terminal-border hover:border-terminal-dim'
            }`}
          >
            {cat}
          </button>
        ))}
      </div>

      {/* Snippets */}
      <div className="space-y-2 max-h-[500px] overflow-y-auto">
        {filteredSnippets.map((snippet) => (
          <div key={snippet.id} className="bg-terminal-bg rounded overflow-hidden">
            <div 
              className="px-3 py-2 flex items-center justify-between cursor-pointer hover:bg-terminal-surface/50"
              onClick={() => setExpandedSnippet(expandedSnippet === snippet.id ? null : snippet.id)}
            >
              <div className="flex items-center gap-2">
                {expandedSnippet === snippet.id ? (
                  <ChevronDown className="w-4 h-4 text-terminal-dim" />
                ) : (
                  <ChevronRight className="w-4 h-4 text-terminal-dim" />
                )}
                <div>
                  <div className="text-terminal-text text-sm font-medium">{snippet.name}</div>
                  <div className="text-terminal-dim text-xs">{snippet.description}</div>
                </div>
              </div>
              <span className="text-terminal-dim text-xs px-1.5 py-0.5 bg-terminal-surface rounded">
                {snippet.language}
              </span>
            </div>

            {expandedSnippet === snippet.id && (
              <div className="px-3 pb-3 border-t border-terminal-border/30">
                <div className="flex justify-end mb-2 mt-2">
                  <button
                    onClick={() => copyCode(snippet.id, snippet.code)}
                    className="flex items-center gap-1 px-2 py-1 text-xs text-terminal-dim 
                               hover:text-terminal-text transition"
                  >
                    {copiedId === snippet.id ? (
                      <>
                        <Check className="w-3 h-3 text-terminal-green" />
                        Copied!
                      </>
                    ) : (
                      <>
                        <Copy className="w-3 h-3" />
                        Copy
                      </>
                    )}
                  </button>
                </div>
                <pre className="p-3 bg-terminal-surface rounded text-xs text-terminal-text 
                                font-mono overflow-x-auto max-h-80 overflow-y-auto">
                  {snippet.code}
                </pre>
              </div>
            )}
          </div>
        ))}

        {filteredSnippets.length === 0 && (
          <div className="text-center py-8 text-terminal-dim text-sm">
            No snippets found
          </div>
        )}
      </div>
    </div>
  );
}
