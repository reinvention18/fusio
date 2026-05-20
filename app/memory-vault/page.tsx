'use client';

import { useEffect, useState } from 'react';
import { MemoryVaultPanel } from '../../components/MemoryVaultPanel';

/**
 * /memory-vault — standalone configuration + inspection page for the
 * claude-mem + obsidian-skills integration. Pulls the active chat id from
 * URL (?chat=...) or the most recent chat in localStorage.
 */
export default function MemoryVaultPage() {
  const [chatId, setChatId] = useState<string | undefined>(undefined);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const fromUrl = params.get('chat') ?? undefined;
    const fromStorage = fromUrl ?? (
      window.localStorage.getItem('mc.activeChatId')
      ?? window.localStorage.getItem('sessionKey')
      ?? undefined
    );
    setChatId(fromStorage ?? undefined);
  }, []);

  return (
    <main className="min-h-screen bg-black text-gray-100">
      <header className="border-b border-gray-800 px-6 py-4">
        <h1 className="text-xl font-semibold">Memory &amp; Vault</h1>
        <p className="text-sm text-gray-400 mt-1">
          Inspect durable memory observations and configure the Obsidian vault.
          Agents access the same data through <code className="text-xs">mem_*</code> and <code className="text-xs">vault_*</code> MCP tools.
        </p>
      </header>
      <div className="max-w-3xl mx-auto mt-6 border border-gray-800 rounded">
        <MemoryVaultPanel chatId={chatId} />
      </div>
    </main>
  );
}
