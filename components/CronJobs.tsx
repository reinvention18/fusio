'use client';
import { generateId } from '../lib/generateId';

import { useEffect, useState } from 'react';
import { Clock, Play, Pause, RefreshCw, Plus, Trash2 } from 'lucide-react';
import { CronJob } from '@/lib/openclaw';

// Mock cron jobs - in production, this would come from OpenClaw
const MOCK_JOBS: CronJob[] = [
  {
    id: '1',
    name: 'Daily System Audit',
    schedule: '0 6 * * *',
    lastRun: new Date(Date.now() - 86400000),
    nextRun: new Date(Date.now() + 43200000),
    enabled: true,
    payload: 'Audit Mission Control for bugs and improvements',
  },
  {
    id: '2', 
    name: 'Heartbeat Check',
    schedule: '*/5 * * * *',
    lastRun: new Date(Date.now() - 300000),
    nextRun: new Date(Date.now() + 300000),
    enabled: true,
    payload: 'Check system health and report status',
  },
];

export default function CronJobs() {
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [showAddModal, setShowAddModal] = useState(false);
  const [expandedJob, setExpandedJob] = useState<string | null>(null);
  const [newJob, setNewJob] = useState({ name: '', schedule: '', payload: '' });

  useEffect(() => {
    const saved = localStorage.getItem('missionControlCronJobs');
    if (saved) {
      const parsed = JSON.parse(saved);
      setJobs(parsed.map((j: any) => ({
        ...j,
        lastRun: j.lastRun ? new Date(j.lastRun) : null,
        nextRun: j.nextRun ? new Date(j.nextRun) : null,
      })));
    } else {
      setJobs(MOCK_JOBS);
      localStorage.setItem('missionControlCronJobs', JSON.stringify(MOCK_JOBS));
    }
  }, []);

  const saveJobs = (updatedJobs: CronJob[]) => {
    setJobs(updatedJobs);
    localStorage.setItem('missionControlCronJobs', JSON.stringify(updatedJobs));
  };

  const toggleJob = (id: string) => {
    const updated = jobs.map(j => 
      j.id === id ? { ...j, enabled: !j.enabled } : j
    );
    saveJobs(updated);
  };

  const runJob = (id: string) => {
    const updated = jobs.map(j =>
      j.id === id ? { ...j, lastRun: new Date() } : j
    );
    saveJobs(updated);
    alert(`Job "${jobs.find(j => j.id === id)?.name}" triggered!`);
  };

  const deleteJob = (id: string) => {
    if (confirm('Delete this cron job?')) {
      saveJobs(jobs.filter(j => j.id !== id));
    }
  };

  const addJob = () => {
    if (!newJob.name || !newJob.schedule) return;
    
    const job: CronJob = {
      id: generateId(),
      name: newJob.name,
      schedule: newJob.schedule,
      payload: newJob.payload,
      enabled: true,
      lastRun: null,
      nextRun: null,
    };
    
    saveJobs([...jobs, job]);
    setNewJob({ name: '', schedule: '', payload: '' });
    setShowAddModal(false);
  };

  const formatSchedule = (cron: string) => {
    if (cron === '*/5 * * * *') return '5m';
    if (cron === '0 * * * *') return '1h';
    if (cron === '0 6 * * *') return '6am';
    if (cron === '0 0 * * *') return '12am';
    if (cron === '0 0 * * 0') return 'Sun';
    return cron;
  };

  const formatTime = (date: Date | null) => {
    if (!date) return '--';
    const now = new Date();
    const diff = date.getTime() - now.getTime();
    
    if (diff < 0) {
      const mins = Math.floor(-diff / 60000);
      if (mins < 60) return `${mins}m`;
      const hours = Math.floor(mins / 60);
      if (hours < 24) return `${hours}h`;
      return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    } else {
      const mins = Math.floor(diff / 60000);
      if (mins < 60) return `${mins}m`;
      const hours = Math.floor(mins / 60);
      if (hours < 24) return `${hours}h`;
      return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }
  };

  return (
    <div className="fusio-panel p-3">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2.5">
          <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22, borderRadius: 5, background: 'rgba(232, 162, 59, 0.12)', border: '1px solid rgba(232, 162, 59, 0.35)' }}>
            <Clock style={{ width: 11, height: 11, color: 'var(--amber, #E8A23B)' }} />
          </span>
          <div>
            <div style={{ fontFamily: 'var(--font-mono, ui-monospace)', fontSize: 9.5, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--mist, rgba(255,255,255,0.5))' }}>
              Tools · Schedule
            </div>
            <div style={{ fontFamily: 'var(--font-display, "Space Grotesk")', fontSize: 13, fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--white, #fff)', marginTop: 1 }}>
              Cron
            </div>
          </div>
        </div>
        <button
          onClick={() => setShowAddModal(true)}
          className="p-1 text-terminal-green hover:bg-terminal-green/20 rounded transition"
          title="Add cron job"
        >
          <Plus className="w-4 h-4" />
        </button>
      </div>

      {/* Jobs List - Compact */}
      <div className="space-y-1.5">
        {jobs.map((job) => (
          <div 
            key={job.id}
            className={`bg-terminal-bg rounded p-2 border transition cursor-pointer ${
              job.enabled ? 'border-terminal-border' : 'border-terminal-border/50 opacity-60'
            } ${expandedJob === job.id ? 'border-terminal-green/50' : ''}`}
            onClick={() => setExpandedJob(expandedJob === job.id ? null : job.id)}
          >
            {/* Compact View */}
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0 flex-1">
                <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                  job.enabled ? 'bg-terminal-green' : 'bg-terminal-dim'
                }`} />
                <span className="text-terminal-text text-xs font-medium truncate">
                  {job.name}
                </span>
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                <span className="text-terminal-cyan text-xs">{formatSchedule(job.schedule)}</span>
                <button
                  onClick={(e) => { e.stopPropagation(); runJob(job.id); }}
                  className="p-1 text-terminal-dim hover:text-terminal-cyan hover:bg-terminal-cyan/20 rounded transition"
                  title="Run now"
                >
                  <Play className="w-3 h-3" />
                </button>
              </div>
            </div>

            {/* Expanded View */}
            {expandedJob === job.id && (
              <div className="mt-2 pt-2 border-t border-terminal-border/50">
                <div className="grid grid-cols-2 gap-2 text-xs mb-2">
                  <div>
                    <span className="text-terminal-dim">Last: </span>
                    <span className="text-terminal-text">{formatTime(job.lastRun)}</span>
                  </div>
                  <div>
                    <span className="text-terminal-dim">Next: </span>
                    <span className="text-terminal-green">{formatTime(job.nextRun)}</span>
                  </div>
                </div>
                {job.payload && (
                  <div className="text-terminal-dim text-xs mb-2 break-words">
                    → {job.payload}
                  </div>
                )}
                <div className="flex items-center gap-1">
                  <button
                    onClick={(e) => { e.stopPropagation(); toggleJob(job.id); }}
                    className={`px-2 py-0.5 text-xs rounded transition ${
                      job.enabled 
                        ? 'text-terminal-amber bg-terminal-amber/10 hover:bg-terminal-amber/20' 
                        : 'text-terminal-green bg-terminal-green/10 hover:bg-terminal-green/20'
                    }`}
                  >
                    {job.enabled ? 'Disable' : 'Enable'}
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); deleteJob(job.id); }}
                    className="px-2 py-0.5 text-xs text-terminal-red bg-terminal-red/10 hover:bg-terminal-red/20 rounded transition"
                  >
                    Delete
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}

        {jobs.length === 0 && (
          <div className="text-terminal-dim text-center py-4 text-xs italic">
            No cron jobs
          </div>
        )}
      </div>

      {/* Add Job Modal */}
      {showAddModal && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
          <div className="fusio-panel p-6 w-full max-w-md">
            <h3 className="text-terminal-green font-bold mb-4">NEW CRON JOB</h3>
            
            <div className="space-y-4">
              <div>
                <label className="text-terminal-dim text-xs block mb-1">NAME</label>
                <input
                  type="text"
                  value={newJob.name}
                  onChange={(e) => setNewJob({ ...newJob, name: e.target.value })}
                  className="w-full bg-terminal-bg border border-terminal-border rounded px-3 py-2 
                             text-terminal-text focus:border-terminal-green outline-none"
                  placeholder="Job name..."
                />
              </div>
              
              <div>
                <label className="text-terminal-dim text-xs block mb-1">SCHEDULE (CRON)</label>
                <input
                  type="text"
                  value={newJob.schedule}
                  onChange={(e) => setNewJob({ ...newJob, schedule: e.target.value })}
                  className="w-full bg-terminal-bg border border-terminal-border rounded px-3 py-2 
                             text-terminal-text focus:border-terminal-green outline-none font-mono"
                  placeholder="*/5 * * * *"
                />
                <div className="text-terminal-dim text-xs mt-1">
                  */5 * * * * (5min) · 0 * * * * (hourly) · 0 6 * * * (6am)
                </div>
              </div>
              
              <div>
                <label className="text-terminal-dim text-xs block mb-1">PAYLOAD</label>
                <textarea
                  value={newJob.payload}
                  onChange={(e) => setNewJob({ ...newJob, payload: e.target.value })}
                  className="w-full bg-terminal-bg border border-terminal-border rounded px-3 py-2 
                             text-terminal-text focus:border-terminal-green outline-none h-20 resize-none"
                  placeholder="What should the agent do..."
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 mt-6">
              <button
                onClick={() => setShowAddModal(false)}
                className="px-4 py-2 text-terminal-dim hover:text-terminal-text transition"
              >
                Cancel
              </button>
              <button
                onClick={addJob}
                className="px-4 py-2 bg-terminal-green/20 text-terminal-green border 
                           border-terminal-green/50 rounded hover:bg-terminal-green/30 transition"
              >
                Add Job
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


