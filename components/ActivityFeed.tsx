'use client';

import { useEffect, useState, useCallback } from 'react';
import { Activity, Trash2, RefreshCw } from 'lucide-react';
import { ActivityItem, getActivity, clearActivity } from '@/lib/tasks';

export default function ActivityFeed() {
  const [activities, setActivities] = useState<ActivityItem[]>([]);
  const [loading, setLoading] = useState(true);

  const loadActivities = useCallback(async () => {
    const items = await getActivity(30);
    setActivities(items);
    setLoading(false);
  }, []);

  useEffect(() => {
    loadActivities();
    
    // Refresh periodically
    const interval = setInterval(() => {
      loadActivities();
    }, 5000);
    
    return () => clearInterval(interval);
  }, [loadActivities]);

  const formatTime = (date: Date) => {
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const mins = Math.floor(diff / 60000);
    
    if (mins < 1) return 'Just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return date.toLocaleDateString();
  };

  const handleClear = async () => {
    if (confirm('Clear all activity?')) {
      await clearActivity();
      setActivities([]);
    }
  };

  const handleRefresh = async () => {
    setLoading(true);
    await loadActivities();
  };

  return (
    <div className="fusio-panel p-4">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2.5">
          <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 24, height: 24, borderRadius: 6, background: 'rgba(94, 196, 217, 0.12)', border: '1px solid rgba(94, 196, 217, 0.35)' }}>
            <Activity style={{ width: 12, height: 12, color: 'var(--cyan, #5EC4D9)' }} />
          </span>
          <div>
            <div style={{ fontFamily: 'var(--font-mono, ui-monospace)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--mist, rgba(255,255,255,0.5))' }}>
              Monitor · Live
            </div>
            <div style={{ fontFamily: 'var(--font-display, "Space Grotesk")', fontSize: 16, fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--white, #fff)', marginTop: 1 }}>
              Activity feed
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={handleRefresh}
            className="p-1.5 text-terminal-dim hover:text-terminal-green rounded transition"
            title="Refresh"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
          {activities.length > 0 && (
            <button
              onClick={handleClear}
              className="p-1.5 text-terminal-dim hover:text-terminal-red rounded transition"
              title="Clear activity"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {/* Activity List */}
      <div className="space-y-2 max-h-96 overflow-y-auto">
        {activities.slice().reverse().map((item) => (
          <div 
            key={item.id}
            className="bg-terminal-bg rounded p-3 border border-terminal-border"
          >
            <div className="flex items-start gap-2">
              <span className="text-lg">{item.agentEmoji}</span>
              <div className="flex-1 min-w-0">
                <div className="text-sm">
                  <span className="text-terminal-cyan">{item.agent}</span>
                  <span className="text-terminal-dim"> {item.action} </span>
                  <span className="text-terminal-text font-medium">"{item.taskTitle}"</span>
                </div>
                {item.note && (
                  <div className="text-terminal-dim text-xs mt-1 italic">
                    "{item.note}"
                  </div>
                )}
                <div className="text-terminal-dim text-xs mt-1">
                  {formatTime(item.timestamp)}
                </div>
              </div>
            </div>
          </div>
        ))}

        {activities.length === 0 && !loading && (
          <div className="text-terminal-dim text-center py-8 italic">
            No activity yet. Start working on tasks!
          </div>
        )}

        {loading && activities.length === 0 && (
          <div className="text-terminal-dim text-center py-8 animate-pulse">
            Loading activity...
          </div>
        )}
      </div>
    </div>
  );
}
