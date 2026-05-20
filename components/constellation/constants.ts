export const ROLE_GLYPHS: Record<string, string> = {
  commander: '✦', architect: '◆', builder: '●', inspector: '◎',
  sentinel: '▲', scout: '◇', scribe: '✎', navigator: '◈',
  security: '🛡', dba: '🗄', tester: '🧪', perfanalyst: '📊',
  uxreviewer: '👁', deployer: '🚀', apidesigner: '🔌', refactorer: '🔧',
};

export const STATUS_COLORS: Record<string, string> = {
  spawning: 'text-terminal-dim',
  idle: 'text-terminal-cyan',
  working: 'text-terminal-green',
  waiting: 'text-terminal-dim',
  needs_input: 'text-terminal-amber',
  blocked: 'text-terminal-red',
  error: 'text-terminal-red',
  paused: 'text-terminal-dim',
  crashed: 'text-terminal-red',
  done: 'text-terminal-cyan',
  completed: 'text-terminal-cyan',
  planning: 'text-terminal-amber',
  running: 'text-terminal-green',
  review: 'text-terminal-purple',
  merging: 'text-terminal-amber',
  cancelled: 'text-terminal-dim',
  needs_rework: 'text-terminal-amber',
  rework_in_progress: 'text-terminal-amber',
  re_testing: 'text-terminal-purple',
};

export const STATUS_DOTS: Record<string, string> = {
  spawning: 'bg-terminal-dim',
  idle: 'bg-terminal-cyan',
  working: 'bg-terminal-green animate-pulse',
  waiting: 'bg-terminal-dim',
  needs_input: 'bg-terminal-amber animate-pulse',
  blocked: 'bg-terminal-red',
  error: 'bg-terminal-red',
  paused: 'bg-terminal-dim',
  crashed: 'bg-terminal-red',
  done: 'bg-terminal-cyan',
  completed: 'bg-terminal-cyan',
  planning: 'bg-terminal-amber animate-pulse',
  needs_rework: 'bg-terminal-amber animate-pulse',
  rework_in_progress: 'bg-terminal-amber animate-pulse',
  re_testing: 'bg-terminal-purple animate-pulse',
};

export const PHASE_ICONS: Record<string, string> = {
  pending: '○',
  active: '●',
  completed: '✓',
  skipped: '✗',
};

export const TASK_FLOW_COLUMNS = [
  { key: 'pending', label: 'Pending', statuses: ['pending'], color: 'border-terminal-dim' },
  { key: 'working', label: 'Working', statuses: ['claimed', 'in_progress', 'rework_in_progress'], color: 'border-terminal-amber' },
  { key: 'review', label: 'Review', statuses: ['ready_for_review', 'review', 're_testing'], color: 'border-terminal-purple' },
  { key: 'rework', label: 'Rework', statuses: ['needs_rework'], color: 'border-terminal-amber' },
  { key: 'done', label: 'Done', statuses: ['done', 'approved', 'merging'], color: 'border-terminal-green' },
  { key: 'blocked', label: 'Blocked', statuses: ['blocked', 'failed'], color: 'border-terminal-red' },
] as const;
