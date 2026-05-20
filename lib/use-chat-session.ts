/**
 * useChatSession — derives per-active-session state from the bag of
 * `Record<sessionId, value>` maps that ChatPanel currently holds at the top
 * level. Consolidates ~10 scattered lookups into one hook and one object.
 *
 * The hook does not own the state — that still lives in ChatPanel because
 * many mutations need cross-session access (e.g. "switch to session X while
 * streaming continues on session Y"). This hook is a thin reader that
 * downstream children can consume without parent-prop drilling.
 */

'use client';
import { useMemo } from 'react';

export interface TokenUsage {
  used: number;
  max: number;
  outputTokens?: number;
}
export interface LiveActivity {
  status: string;
  elapsedSec: number;
  silentSec?: number;
  toolsUsed?: number;
  subagentsRunning?: number;
  subagentsDone?: number;
  lastTool?: string;
  lastUpdate: number;
}

export interface ChatSessionMaps {
  inputMap: Record<string, string>;
  attachmentMap: Record<string, any[]>;
  loadingMap: Record<string, boolean>;
  streamingMap: Record<string, string>;
  modelMap: Record<string, string>;
  modeMap: Record<string, 'quick' | 'work' | 'constellation'>;
  tokenUsageMap: Record<string, TokenUsage | null>;
  permissionModeMap: Record<string, string>;
  activityMap: Record<string, LiveActivity | null>;
}

export interface UseChatSessionResult {
  input: string;
  attachments: any[];
  isLoading: boolean;
  streamingContent: string;
  model: string;
  mode: 'quick' | 'work' | 'constellation';
  tokenUsage: TokenUsage | null;
  permissionMode: string;
  activity: LiveActivity | null;
}

export function useChatSession(
  activeSessionId: string | null,
  maps: ChatSessionMaps,
): UseChatSessionResult {
  const id = activeSessionId || '';
  return useMemo<UseChatSessionResult>(() => ({
    input: maps.inputMap[id] || '',
    attachments: maps.attachmentMap[id] || [],
    isLoading: maps.loadingMap[id] || false,
    streamingContent: maps.streamingMap[id] || '',
    model: maps.modelMap[id] || 'default',
    mode: (maps.modeMap[id] || 'work') as 'quick' | 'work' | 'constellation',
    tokenUsage: maps.tokenUsageMap[id] || null,
    permissionMode: maps.permissionModeMap[id] || 'default',
    activity: maps.activityMap[id] || null,
  }), [
    id,
    maps.inputMap[id],
    maps.attachmentMap[id],
    maps.loadingMap[id],
    maps.streamingMap[id],
    maps.modelMap[id],
    maps.modeMap[id],
    maps.tokenUsageMap[id],
    maps.permissionModeMap[id],
    maps.activityMap[id],
  ]);
}
