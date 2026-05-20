'use client';

import { useState, useEffect, useCallback, useRef } from 'react';

// ─── Types ───────────────────────────────────────────────────────────────

export interface TeamData {
  team: {
    id: string;
    name: string;
    constellation: string;
    status: string;
    goal: string | null;
    preset: string | null;
    budget_usd: number | null;
    spent_usd: number;
    project_id: string;
    main_branch: string;
    parent_chat_key: string | null;
    created_at: number;
    updated_at: number;
    settings_json: string;
  };
  agents: AgentData[];
  tasks: TaskData[];
  cost: {
    total_usd: number;
    by_agent: Array<{ agent_id: string; role: string; role_handle: string; cost_usd: number }>;
    budget_usd: number | null;
    percent: number | null;
  };
  summary: {
    pending: number;
    inProgress: number;
    review: number;
    done: number;
    total: number;
  };
  blocker?: {
    headline: string;
    severity: 'ok' | 'warn' | 'error' | 'idle';
    phase: string | null;
    detail?: string;
  };
}

export interface AgentData {
  id: string;
  team_id: string;
  role: string;
  role_handle: string;
  model: string;
  status: string;
  status_reason: string | null;
  session_id: string | null;
  session_key: string;
  worktree_path: string;
  branch_name: string;
  current_task_id: string | null;
  cost_usd: number;
  tokens_in: number;
  tokens_out: number;
  started_at: number | null;
}

export interface TaskData {
  id: string;
  team_id: string;
  title: string;
  description: string;
  status: string;
  priority: number;
  role_hint: string | null;
  assigned_agent_id: string | null;
  depends_on: string;
  files_touched: string;
  diff_numstat: string | null;
  worktree_path: string | null;
  branch_name: string | null;
  result_summary: string | null;
  error_detail: string | null;
  status_reason: string | null;
  phase: string | null;
  rework_count: number;
  parent_task_id: string | null;
  commit_sha: string | null;
  created_at: number;
  claimed_at: number | null;
  completed_at: number | null;
}

export interface TeamEvent {
  id: number;
  team_id: string;
  agent_id: string | null;
  task_id: string | null;
  kind: string;
  severity: string;
  payload: string;
  chat_report: number;
  created_at: number;
}

export interface TeamListItem {
  id: string;
  name: string;
  constellation: string;
  status: string;
  spent_usd: number;
  budget_usd: number | null;
  preset: string | null;
  updated_at: number;
}

export interface TeamMessage {
  id: string;
  team_id: string;
  from_agent_id: string | null;
  to_agent_id: string | null;
  type: 'direct' | 'broadcast' | 'halt' | 'note' | 'chat_report';
  priority: 'now' | 'next' | 'later';
  body: string;
  metadata_json: string;
  created_at: number;
  delivered_at: number | null;
  read_at: number | null;
}

export interface TeamPhase {
  id: string;
  team_id: string;
  name: string;
  description: string | null;
  ordering: number;
  roles_json: string;
  status: 'pending' | 'active' | 'completed' | 'skipped';
  started_at: number | null;
  completed_at: number | null;
  created_at: number;
}

export interface TeamDecision {
  id: string;
  team_id: string;
  agent_id: string | null;
  decision_type: string;
  summary: string;
  details_json: string;
  created_at: number;
}

export interface TaskReview {
  id: string;
  task_id: string;
  reviewer_agent_id: string | null;
  reviewer_model: string;
  review_kind: string;
  clean: number;
  verdict: string | null;
  summary: string | null;
  cost_usd: number | null;
  duration_ms: number | null;
  raw_output: string | null;
  created_at: number;
}

export interface TaskReviewFinding {
  id: string;
  review_id: string;
  task_id: string;
  review_kind: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  file: string | null;
  line_start: number | null;
  line_end: number | null;
  title: string;
  body: string | null;
  recommendation: string | null;
  confidence: number | null;
  status: 'open' | 'addressed' | 'waived' | 'false_positive';
  created_at: number;
}

// ─── Hooks ───────────────────────────────────────────────────────────────

export function useTeamList() {
  const [teams, setTeams] = useState<TeamListItem[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/teams');
      const data = await res.json();
      setTeams((data.teams || []) as TeamListItem[]);
    } catch (err) {
      console.error('[useTeamList] fetch error:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // Auto-refresh every 5s
  useEffect(() => {
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, [refresh]);

  return { teams, loading, refresh };
}

export function useTeamData(teamId: string | null) {
  const [data, setData] = useState<TeamData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!teamId) { setData(null); return; }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/teams/${teamId}`);
      if (!res.ok) throw new Error(await res.text());
      const d = await res.json();
      setData(d as TeamData);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [teamId]);

  useEffect(() => { refresh(); }, [refresh]);

  // Auto-refresh every 2s when a team is selected
  useEffect(() => {
    if (!teamId) return;
    const interval = setInterval(refresh, 2000);
    return () => clearInterval(interval);
  }, [teamId, refresh]);

  return { data, loading, error, refresh };
}

export function useTeamMessages(teamId: string | null, intervalMs = 3000) {
  const [messages, setMessages] = useState<TeamMessage[]>([]);
  useEffect(() => {
    if (!teamId) { setMessages([]); return; }
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`/api/teams/${teamId}/messages`);
        if (!res.ok) return;
        const d = await res.json();
        if (!cancelled) setMessages((d.messages || []) as TeamMessage[]);
      } catch { /* ignore */ }
    };
    load();
    const interval = setInterval(load, intervalMs);
    return () => { cancelled = true; clearInterval(interval); };
  }, [teamId, intervalMs]);
  return messages;
}

export function useTeamPhases(teamId: string | null, intervalMs = 3000) {
  const [phases, setPhases] = useState<TeamPhase[]>([]);
  useEffect(() => {
    if (!teamId) { setPhases([]); return; }
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`/api/teams/${teamId}/phases`);
        if (!res.ok) return;
        const d = await res.json();
        if (!cancelled) setPhases((d.phases || []) as TeamPhase[]);
      } catch { /* ignore */ }
    };
    load();
    const interval = setInterval(load, intervalMs);
    return () => { cancelled = true; clearInterval(interval); };
  }, [teamId, intervalMs]);
  return phases;
}

export function useTeamDecisions(teamId: string | null, intervalMs = 5000) {
  const [decisions, setDecisions] = useState<TeamDecision[]>([]);
  useEffect(() => {
    if (!teamId) { setDecisions([]); return; }
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`/api/teams/${teamId}/decisions`);
        if (!res.ok) return;
        const d = await res.json();
        if (!cancelled) setDecisions((d.decisions || []) as TeamDecision[]);
      } catch { /* ignore */ }
    };
    load();
    const interval = setInterval(load, intervalMs);
    return () => { cancelled = true; clearInterval(interval); };
  }, [teamId, intervalMs]);
  return decisions;
}

export function useCommanderThread(teamId: string | null, intervalMs = 2500) {
  const [messages, setMessages] = useState<TeamMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    if (!teamId) { setMessages([]); return; }
    setLoading(true);
    try {
      const res = await fetch(`/api/teams/${teamId}/thread`);
      if (!res.ok) return;
      const d = await res.json();
      setMessages((d.thread || []) as TeamMessage[]);
    } catch { /* ignore */ } finally { setLoading(false); }
  }, [teamId]);
  useEffect(() => {
    if (!teamId) { setMessages([]); return; }
    let cancelled = false;
    const loop = async () => { if (!cancelled) await load(); };
    loop();
    const interval = setInterval(loop, intervalMs);
    return () => { cancelled = true; clearInterval(interval); };
  }, [teamId, intervalMs, load]);
  return { messages, loading, refresh: load };
}

export async function askArchitect(
  teamId: string,
  body: string,
  opts: { resume?: boolean; kind?: 'message' | 'revision' } = {},
): Promise<{ resumed: boolean }> {
  const res = await fetch(`/api/teams/${teamId}/ask-architect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body, resume: opts.resume ?? false, kind: opts.kind ?? 'message' }),
  });
  const d = await res.json();
  if (!res.ok) throw new Error(d.error || 'Failed to send message');
  return { resumed: Boolean(d.resumed) };
}

export async function resumeTeamApi(teamId: string): Promise<void> {
  const res = await fetch(`/api/teams/${teamId}/resume`, { method: 'POST' });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new Error(d.error || 'Failed to resume team');
  }
}

export interface DeliverableData {
  status: string;
  is_complete: boolean;
  goal: string | null;
  preset: string | null;
  scratchpad_section: string | null;
  scratchpad_full: string;
  scribe_report: {
    task_id: string;
    title: string;
    summary: string | null;
    completed_at: number | null;
  } | null;
  tasks_summary: Array<{
    id: string;
    title: string;
    role_hint: string | null;
    phase: string | null;
    summary: string | null;
    diff_numstat: string | null;
    completed_at: number | null;
  }>;
  files_changed: string[];
  totals: { total: number; done: number; pending: number; in_progress: number };
}

export interface FinalAudit {
  team_id: string;
  created_at: number;
  decision_id: string;
  verdict: 'addressed' | 'partial' | 'missed';
  coverage: Array<{ requirement: string; status: 'addressed' | 'partial' | 'missed'; evidence?: string }>;
  missing_work: string[];
  unrelated_work: string[];
  quality_score: number;
  summary: string;
  raw: string;
  duration_ms: number;
}

export function useFinalAudit(teamId: string | null, intervalMs = 8000) {
  const [audit, setAudit] = useState<FinalAudit | null>(null);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    if (!teamId) { setAudit(null); return; }
    try {
      const res = await fetch(`/api/teams/${teamId}/final-audit`);
      if (!res.ok) return;
      const d = await res.json();
      setAudit(d.audit || null);
    } catch { /* ignore */ }
  }, [teamId]);
  useEffect(() => {
    if (!teamId) { setAudit(null); return; }
    load();
    const i = setInterval(load, intervalMs);
    return () => clearInterval(i);
  }, [teamId, intervalMs, load]);
  const runNow = useCallback(async () => {
    if (!teamId) return null;
    setLoading(true);
    try {
      const res = await fetch(`/api/teams/${teamId}/final-audit`, { method: 'POST' });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.error || 'Audit failed');
      setAudit(d.audit);
      return d.audit as FinalAudit;
    } finally { setLoading(false); }
  }, [teamId]);
  return { audit, loading, refresh: load, runNow };
}

export function useDeliverable(teamId: string | null, intervalMs = 4000) {
  const [data, setData] = useState<DeliverableData | null>(null);
  useEffect(() => {
    if (!teamId) { setData(null); return; }
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`/api/teams/${teamId}/deliverable`);
        if (!res.ok) return;
        const d = await res.json();
        if (!cancelled) setData(d as DeliverableData);
      } catch { /* ignore */ }
    };
    load();
    const interval = setInterval(load, intervalMs);
    return () => { cancelled = true; clearInterval(interval); };
  }, [teamId, intervalMs]);
  return data;
}

export function useTeamReviews(teamId: string | null, intervalMs = 5000) {
  const [reviews, setReviews] = useState<TaskReview[]>([]);
  const [findings, setFindings] = useState<TaskReviewFinding[]>([]);
  useEffect(() => {
    if (!teamId) { setReviews([]); setFindings([]); return; }
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`/api/teams/${teamId}/reviews`);
        if (!res.ok) return;
        const d = await res.json();
        if (!cancelled) {
          setReviews((d.reviews || []) as TaskReview[]);
          setFindings((d.findings || []) as TaskReviewFinding[]);
        }
      } catch { /* ignore */ }
    };
    load();
    const interval = setInterval(load, intervalMs);
    return () => { cancelled = true; clearInterval(interval); };
  }, [teamId, intervalMs]);
  return { reviews, findings };
}

export function useTeamEvents(teamId: string | null) {
  const [events, setEvents] = useState<TeamEvent[]>([]);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!teamId) { setEvents([]); return; }

    const es = new EventSource(`/api/teams/${teamId}/stream`);
    esRef.current = es;

    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === 'team_event') {
          setEvents(prev => {
            const exists = prev.some(ev => ev.id === data.id);
            if (exists) return prev;
            return [data, ...prev].slice(0, 500);
          });
        }
      } catch { /* ignore parse errors */ }
    };

    es.onerror = () => {
      es.close();
      // Reconnect after 3s
      setTimeout(() => {
        if (esRef.current === es) {
          esRef.current = null;
        }
      }, 3000);
    };

    return () => { es.close(); };
  }, [teamId]);

  return events;
}

// ─── Actions ─────────────────────────────────────────────────────────────

export interface ChatContextInput {
  workspace: string;
  contextSnapshot?: string;
  keyFacts?: Array<{ category: string; label: string; value: string }>;
  environment?: { name: string; saasUrl: string; appUrl: string; branch: string; supabaseRef: string };
  githubRepo?: { name: string; fullName: string; url: string; defaultBranch: string };
  recentMessages?: Array<{ role: string; content: string }>;
}

export async function createTeam(body: Record<string, unknown>): Promise<{ team: TeamData['team']; error?: string }> {
  const res = await fetch('/api/teams', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to create team');
  return data;
}

export async function startTeam(teamId: string): Promise<void> {
  const res = await fetch(`/api/teams/${teamId}/start`, { method: 'POST' });
  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.error || 'Failed to start team');
  }
}

export async function haltTeam(teamId: string, reason?: string): Promise<void> {
  const res = await fetch(`/api/teams/${teamId}/halt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason }),
  });
  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.error || 'Failed to halt team');
  }
}

export async function mergeApproved(teamId: string, squash = false): Promise<any> {
  const res = await fetch(`/api/teams/${teamId}/merge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ squash }),
  });
  return res.json();
}

export async function addTask(teamId: string, task: { title: string; description: string; role_hint?: string; priority?: number }): Promise<any> {
  const res = await fetch(`/api/teams/${teamId}/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(task),
  });
  return res.json();
}

export async function sendAgentMessage(teamId: string, agentId: string, body: string): Promise<void> {
  await fetch(`/api/teams/${teamId}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to_agent_id: agentId, body }),
  });
}
