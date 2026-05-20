'use client';

import { useEffect, useState, useCallback } from 'react';
import { Plus, GripVertical, Trash2, Clock, Gauge, User, Flag, ChevronDown, RefreshCw } from 'lucide-react';
import { Task, TaskStatus, TaskPriority, TASK_STATUSES, TASK_PRIORITIES, getTasks, addTask, updateTask, moveTask, deleteTask, assignTask, calculateMomentum, getPriorityWeight } from '@/lib/tasks';
import { Board, getBoards, addBoard, getActiveBoard, setActiveBoard, BOARD_ICONS } from '@/lib/boards';
import { Agent } from '@/lib/openclaw';
import { getAgents } from '@/lib/agents';

export default function Workshop() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [boards, setBoards] = useState<Board[]>([]);
  const [activeBoard, setActiveBoardState] = useState<string>('default');
  const [agents, setAgents] = useState<Agent[]>([]);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showBoardModal, setShowBoardModal] = useState(false);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [loading, setLoading] = useState(true);
  const [newTask, setNewTask] = useState({ 
    title: '', 
    description: '', 
    details: '',
    priority: 'none' as TaskPriority,
    assignedTo: null as string | null,
  });
  const [newBoard, setNewBoard] = useState({ name: '', icon: '🚀' });

  const loadTasks = useCallback(async (boardId: string) => {
    const loadedTasks = await getTasks(boardId);
    setTasks(loadedTasks);
  }, []);

  const loadBoards = useCallback(async () => {
    const loadedBoards = await getBoards();
    setBoards(loadedBoards);
  }, []);

  useEffect(() => {
    const init = async () => {
      setLoading(true);
      try {
        const boardId = await getActiveBoard();
        setActiveBoardState(boardId);
        await loadBoards();
        setAgents(getAgents());
        await loadTasks(boardId);
      } finally {
        setLoading(false);
      }
    };
    init();
  }, [loadTasks, loadBoards]);

  const handleBoardChange = async (boardId: string) => {
    await setActiveBoard(boardId);
    setActiveBoardState(boardId);
    await loadTasks(boardId);
  };

  const handleAddBoard = async () => {
    if (!newBoard.name.trim()) return;
    
    const board = await addBoard(newBoard.name, newBoard.icon);
    if (board) {
      await loadBoards();
      setNewBoard({ name: '', icon: '🚀' });
      setShowBoardModal(false);
      await handleBoardChange(board.id);
    }
  };

  const handleAddTask = async () => {
    if (!newTask.title.trim()) return;
    
    const completedTasks = tasks.filter(t => t.status === 'done');
    const task = await addTask({
      title: newTask.title,
      description: newTask.description,
      details: newTask.details,
      status: 'inbox',
      priority: newTask.priority,
      boardId: activeBoard,
      assignedTo: newTask.assignedTo,
      momentum: 50,
    });
    
    if (task) {
      // Calculate momentum and update
      const momentum = calculateMomentum(task, completedTasks);
      if (momentum !== 50) {
        await updateTask(task.id, { momentum });
      }
      
      await loadTasks(activeBoard);
    }
    
    setNewTask({ title: '', description: '', details: '', priority: 'none', assignedTo: null });
    setShowAddModal(false);
  };

  const handleMoveTask = async (taskId: string, newStatus: TaskStatus) => {
    await moveTask(taskId, newStatus);
    await loadTasks(activeBoard);
    setSelectedTask(null);
  };

  const handleDeleteTask = async (taskId: string) => {
    if (confirm('Delete this task?')) {
      await deleteTask(taskId);
      await loadTasks(activeBoard);
      setSelectedTask(null);
    }
  };

  const handleAssignTask = async (taskId: string, agentId: string | null) => {
    const agent = agents.find(a => a.id === agentId);
    await assignTask(taskId, agentId, agent?.name);
    await loadTasks(activeBoard);
  };

  const handleUpdatePriority = async (taskId: string, priority: TaskPriority) => {
    await updateTask(taskId, { priority });
    await loadTasks(activeBoard);
    if (selectedTask && selectedTask.id === taskId) {
      setSelectedTask({ ...selectedTask, priority });
    }
  };

  const handleRefresh = async () => {
    setLoading(true);
    try {
      await loadBoards();
      await loadTasks(activeBoard);
    } finally {
      setLoading(false);
    }
  };

  const getTasksByStatus = (status: TaskStatus) => {
    return tasks
      .filter(t => t.status === status)
      .sort((a, b) => {
        // Sort by priority first, then momentum
        const priorityDiff = getPriorityWeight(b.priority) - getPriorityWeight(a.priority);
        if (priorityDiff !== 0) return priorityDiff;
        return b.momentum - a.momentum;
      });
  };

  const getPriorityColor = (priority: TaskPriority) => {
    const p = TASK_PRIORITIES.find(tp => tp.id === priority);
    return p?.color || 'terminal-dim';
  };

  const currentBoard = boards.find(b => b.id === activeBoard);

  if (loading) {
    return (
      <div className="fusio-panel p-4 h-full flex items-center justify-center">
        <div className="text-terminal-dim animate-pulse">Loading tasks...</div>
      </div>
    );
  }

  return (
    <div
      style={{
        background: 'var(--ink, #0A0A0E)',
        border: '1px solid var(--line, rgba(255,255,255,0.08))',
        borderRadius: 12,
        padding: 16,
        height: '100%',
        display: 'flex', flexDirection: 'column',
        fontFamily: 'var(--font-sans, system-ui)',
        color: 'var(--white, #fff)',
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {/* Board Selector — pill button */}
          <button
            type="button"
            onClick={() => setShowBoardModal(true)}
            data-fusio
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 8,
              padding: '5px 12px',
              background: 'var(--ink-2, #131319)',
              border: '1px solid var(--line, rgba(255,255,255,0.08))',
              borderRadius: 6,
              cursor: 'pointer',
              transition: 'border-color 120ms ease-out',
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = 'rgba(204, 12, 32, 0.4)'; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--line, rgba(255,255,255,0.08))'; }}
          >
            <span style={{ fontSize: 16 }}>{currentBoard?.icon || '🚀'}</span>
            <span style={{ fontSize: 12.5, color: 'var(--white, #fff)' }}>{currentBoard?.name || 'Main Board'}</span>
            <ChevronDown style={{ width: 13, height: 13, color: 'var(--mist, rgba(255,255,255,0.5))' }} />
          </button>

          <div>
            <div style={{ fontFamily: 'var(--font-mono, ui-monospace)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--mist, rgba(255,255,255,0.5))' }}>
              Build · Tasks
            </div>
            <div style={{ fontFamily: 'var(--font-display, "Space Grotesk")', fontSize: 16, fontWeight: 600, letterSpacing: '-0.01em', marginTop: 1 }}>
              Workshop
            </div>
          </div>

          <button
            type="button"
            onClick={handleRefresh}
            data-fusio
            title="Refresh"
            style={{
              padding: 6, borderRadius: 5, background: 'transparent', border: 'none', cursor: 'pointer',
              color: 'var(--mist, rgba(255,255,255,0.5))',
              transition: 'all 120ms ease-out',
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--ink-2, #131319)'; (e.currentTarget as HTMLElement).style.color = 'var(--white, #fff)'; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; (e.currentTarget as HTMLElement).style.color = 'var(--mist, rgba(255,255,255,0.5))'; }}
          >
            <RefreshCw style={{ width: 13, height: 13 }} />
          </button>
        </div>
        <button
          type="button"
          onClick={() => setShowAddModal(true)}
          className="card-btn primary"
          data-fusio
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '5px 14px', fontSize: 11.5,
            background: 'var(--red, #CC0C20)', borderColor: 'var(--red, #CC0C20)',
            color: '#fff',
            boxShadow: '0 0 14px rgba(204,12,32,0.35)',
          }}
        >
          <Plus style={{ width: 13, height: 13 }} /> Add task
        </button>
      </div>

      {/* 5-Column Kanban */}
      <div className="flex-1 grid grid-cols-5 gap-3 min-h-0 overflow-x-auto">
        {TASK_STATUSES.map((col) => (
          <div key={col.id} className="flex flex-col min-w-[180px]">
            <div className={`text-${col.color} text-xs font-bold mb-2 flex items-center gap-2`}>
              <span className="w-2 h-2 rounded-full bg-current" />
              {col.label}
              <span className="text-terminal-dim">
                ({getTasksByStatus(col.id).length})
              </span>
            </div>
            
            <div className="flex-1 bg-terminal-bg rounded p-2 space-y-2 overflow-y-auto">
              {getTasksByStatus(col.id).map((task) => (
                <div
                  key={task.id}
                  onClick={() => setSelectedTask(task)}
                  className="bg-terminal-surface border border-terminal-border rounded p-2 
                             cursor-pointer hover:border-terminal-green/50 transition group"
                >
                  <div className="flex items-start gap-1">
                    <GripVertical className="w-3 h-3 text-terminal-dim mt-0.5 opacity-0 group-hover:opacity-100 flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="text-terminal-text text-sm font-medium truncate">
                        {task.title}
                      </div>
                      {task.description && (
                        <div className="text-terminal-dim text-xs mt-1 truncate">
                          {task.description}
                        </div>
                      )}
                      <div className="flex items-center gap-2 mt-2 text-xs flex-wrap">
                        {task.priority !== 'none' && (
                          <div className={`flex items-center gap-1 text-${getPriorityColor(task.priority)}`}>
                            <Flag className="w-3 h-3" />
                            {task.priority}
                          </div>
                        )}
                        {task.assignedTo && (
                          <div className="flex items-center gap-1 text-terminal-cyan">
                            <User className="w-3 h-3" />
                            {agents.find(a => a.id === task.assignedTo)?.name || 'Agent'}
                          </div>
                        )}
                        <div className="flex items-center gap-1 text-terminal-amber">
                          <Gauge className="w-3 h-3" />
                          {task.momentum}%
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
              
              {getTasksByStatus(col.id).length === 0 && (
                <div className="text-terminal-dim text-xs text-center py-4 italic">
                  Empty
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Board Selector Modal */}
      {showBoardModal && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
          <div className="fusio-panel p-6 w-full max-w-md">
            <h3 className="text-terminal-green font-bold mb-4">BOARDS</h3>
            
            {/* Existing Boards */}
            <div className="space-y-2 mb-4 max-h-48 overflow-y-auto">
              {boards.map((board) => (
                <button
                  key={board.id}
                  onClick={() => { handleBoardChange(board.id); setShowBoardModal(false); }}
                  className={`w-full flex items-center gap-3 p-3 rounded border transition ${
                    board.id === activeBoard 
                      ? 'bg-terminal-green/20 border-terminal-green text-terminal-green'
                      : 'bg-terminal-bg border-terminal-border hover:border-terminal-green/50'
                  }`}
                >
                  <span className="text-xl">{board.icon}</span>
                  <span className="flex-1 text-left">{board.name}</span>
                  <span className="text-terminal-dim text-xs">{board.taskCount} tasks</span>
                </button>
              ))}
            </div>

            {/* New Board */}
            <div className="border-t border-terminal-border pt-4">
              <div className="text-terminal-dim text-xs mb-2">CREATE NEW BOARD</div>
              <div className="flex gap-2">
                <select
                  value={newBoard.icon}
                  onChange={(e) => setNewBoard({ ...newBoard, icon: e.target.value })}
                  className="bg-terminal-bg border border-terminal-border rounded px-2 py-2 
                             text-lg focus:border-terminal-green outline-none"
                >
                  {BOARD_ICONS.map((icon) => (
                    <option key={icon} value={icon}>{icon}</option>
                  ))}
                </select>
                <input
                  type="text"
                  value={newBoard.name}
                  onChange={(e) => setNewBoard({ ...newBoard, name: e.target.value })}
                  placeholder="Board name..."
                  className="flex-1 bg-terminal-bg border border-terminal-border rounded px-3 py-2 
                             text-terminal-text focus:border-terminal-green outline-none"
                />
                <button
                  onClick={handleAddBoard}
                  className="px-4 py-2 bg-terminal-green/20 text-terminal-green border 
                             border-terminal-green/50 rounded hover:bg-terminal-green/30 transition"
                >
                  Create
                </button>
              </div>
            </div>

            <div className="flex justify-end mt-4">
              <button
                onClick={() => setShowBoardModal(false)}
                className="px-4 py-2 text-terminal-dim hover:text-terminal-text transition"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add Task Modal */}
      {showAddModal && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
          <div className="fusio-panel p-6 w-full max-w-md">
            <h3 className="text-terminal-green font-bold mb-4">NEW TASK</h3>
            
            <div className="space-y-4">
              <div>
                <label className="text-terminal-dim text-xs block mb-1">TITLE</label>
                <input
                  type="text"
                  value={newTask.title}
                  onChange={(e) => setNewTask({ ...newTask, title: e.target.value })}
                  className="w-full bg-terminal-bg border border-terminal-border rounded px-3 py-2 
                             text-terminal-text focus:border-terminal-green outline-none"
                  placeholder="Task title..."
                />
              </div>
              
              <div>
                <label className="text-terminal-dim text-xs block mb-1">DESCRIPTION</label>
                <input
                  type="text"
                  value={newTask.description}
                  onChange={(e) => setNewTask({ ...newTask, description: e.target.value })}
                  className="w-full bg-terminal-bg border border-terminal-border rounded px-3 py-2 
                             text-terminal-text focus:border-terminal-green outline-none"
                  placeholder="Short description..."
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-terminal-dim text-xs block mb-1">PRIORITY</label>
                  <select
                    value={newTask.priority}
                    onChange={(e) => setNewTask({ ...newTask, priority: e.target.value as TaskPriority })}
                    className="w-full bg-terminal-bg border border-terminal-border rounded px-3 py-2 
                               text-terminal-text focus:border-terminal-green outline-none"
                  >
                    {TASK_PRIORITIES.map((p) => (
                      <option key={p.id} value={p.id}>{p.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-terminal-dim text-xs block mb-1">ASSIGN TO</label>
                  <select
                    value={newTask.assignedTo || ''}
                    onChange={(e) => setNewTask({ ...newTask, assignedTo: e.target.value || null })}
                    className="w-full bg-terminal-bg border border-terminal-border rounded px-3 py-2 
                               text-terminal-text focus:border-terminal-green outline-none"
                  >
                    <option value="">Unassigned</option>
                    {agents.map((a) => (
                      <option key={a.id} value={a.id}>{a.name}</option>
                    ))}
                  </select>
                </div>
              </div>
              
              <div>
                <label className="text-terminal-dim text-xs block mb-1">DETAILS</label>
                <textarea
                  value={newTask.details}
                  onChange={(e) => setNewTask({ ...newTask, details: e.target.value })}
                  className="w-full bg-terminal-bg border border-terminal-border rounded px-3 py-2 
                             text-terminal-text focus:border-terminal-green outline-none h-24 resize-none"
                  placeholder="Detailed instructions for the agent..."
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
                onClick={handleAddTask}
                className="px-4 py-2 bg-terminal-green/20 text-terminal-green border 
                           border-terminal-green/50 rounded hover:bg-terminal-green/30 transition"
              >
                Add Task
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Task Detail Modal */}
      {selectedTask && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
          <div className="fusio-panel p-6 w-full max-w-lg">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-terminal-green font-bold">TASK DETAILS</h3>
              <button
                onClick={() => handleDeleteTask(selectedTask.id)}
                className="text-terminal-red hover:bg-terminal-red/20 p-1 rounded transition"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
            
            <div className="space-y-4">
              <div>
                <div className="text-terminal-dim text-xs mb-1">TITLE</div>
                <div className="text-terminal-text">{selectedTask.title}</div>
              </div>
              
              {selectedTask.description && (
                <div>
                  <div className="text-terminal-dim text-xs mb-1">DESCRIPTION</div>
                  <div className="text-terminal-text">{selectedTask.description}</div>
                </div>
              )}
              
              {selectedTask.details && (
                <div>
                  <div className="text-terminal-dim text-xs mb-1">DETAILS</div>
                  <div className="text-terminal-text text-sm bg-terminal-bg rounded p-3">
                    {selectedTask.details}
                  </div>
                </div>
              )}
              
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <div className="text-terminal-dim text-xs mb-1">PRIORITY</div>
                  <select
                    value={selectedTask.priority}
                    onChange={(e) => {
                      const newPriority = e.target.value as TaskPriority;
                      setSelectedTask({ ...selectedTask, priority: newPriority });
                      handleUpdatePriority(selectedTask.id, newPriority);
                    }}
                    className={`bg-terminal-bg border border-terminal-border rounded px-2 py-1 
                               text-${getPriorityColor(selectedTask.priority)} focus:border-terminal-green outline-none`}
                  >
                    {TASK_PRIORITIES.map((p) => (
                      <option key={p.id} value={p.id}>{p.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <div className="text-terminal-dim text-xs mb-1">ASSIGNED TO</div>
                  <select
                    value={selectedTask.assignedTo || ''}
                    onChange={(e) => {
                      handleAssignTask(selectedTask.id, e.target.value || null);
                      setSelectedTask({ ...selectedTask, assignedTo: e.target.value || null });
                    }}
                    className="bg-terminal-bg border border-terminal-border rounded px-2 py-1 
                               text-terminal-text focus:border-terminal-green outline-none"
                  >
                    <option value="">Unassigned</option>
                    {agents.map((a) => (
                      <option key={a.id} value={a.id}>{a.name}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="flex items-center gap-4 text-sm">
                <div>
                  <div className="text-terminal-dim text-xs mb-1">MOMENTUM</div>
                  <div className="text-terminal-amber font-bold">{selectedTask.momentum}%</div>
                </div>
                <div>
                  <div className="text-terminal-dim text-xs mb-1">STATUS</div>
                  <div className="text-terminal-cyan">{selectedTask.status.toUpperCase().replace('_', ' ')}</div>
                </div>
              </div>
            </div>

            <div className="flex items-center justify-between mt-6 pt-4 border-t border-terminal-border">
              <div className="flex gap-1 flex-wrap">
                {TASK_STATUSES.filter(s => s.id !== selectedTask.status).map((status) => (
                  <button
                    key={status.id}
                    onClick={() => handleMoveTask(selectedTask.id, status.id)}
                    className={`px-2 py-1 text-xs text-${status.color} border border-${status.color}/50 
                               rounded hover:bg-${status.color}/20 transition`}
                  >
                    → {status.label}
                  </button>
                ))}
              </div>
              
              <button
                onClick={() => setSelectedTask(null)}
                className="px-4 py-2 text-terminal-dim hover:text-terminal-text transition"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
