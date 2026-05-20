'use client';

import { useState, useEffect } from 'react';
import { Calendar, ChevronLeft, ChevronRight } from 'lucide-react';

interface ScheduledJob {
  id: string;
  name: string;
  time: string;
  date: Date;
}

export default function CronCalendar() {
  const [currentDate, setCurrentDate] = useState(new Date());
  const [jobs, setJobs] = useState<ScheduledJob[]>([]);

  useEffect(() => {
    // Generate mock scheduled jobs for the week
    const mockJobs: ScheduledJob[] = [];
    const today = new Date();
    
    // Daily 6am audit
    for (let i = 0; i < 7; i++) {
      const date = new Date(today);
      date.setDate(date.getDate() + i);
      date.setHours(6, 0, 0, 0);
      mockJobs.push({
        id: `audit-${i}`,
        name: 'Daily Audit',
        time: '6:00 AM',
        date,
      });
    }

    // 5-min heartbeats (just show a few per day)
    for (let i = 0; i < 3; i++) {
      const date = new Date(today);
      date.setHours(9 + i * 4, 0, 0, 0);
      mockJobs.push({
        id: `heartbeat-${i}`,
        name: 'Heartbeat',
        time: date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
        date,
      });
    }

    setJobs(mockJobs);
  }, []);

  const getDaysInMonth = (date: Date) => {
    const year = date.getFullYear();
    const month = date.getMonth();
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    return { firstDay, daysInMonth };
  };

  const { firstDay, daysInMonth } = getDaysInMonth(currentDate);
  const today = new Date();

  const getJobsForDay = (day: number) => {
    const date = new Date(currentDate.getFullYear(), currentDate.getMonth(), day);
    return jobs.filter(j => 
      j.date.getDate() === day && 
      j.date.getMonth() === currentDate.getMonth() &&
      j.date.getFullYear() === currentDate.getFullYear()
    );
  };

  const prevMonth = () => {
    setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() - 1));
  };

  const nextMonth = () => {
    setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() + 1));
  };

  const isToday = (day: number) => {
    return day === today.getDate() && 
           currentDate.getMonth() === today.getMonth() && 
           currentDate.getFullYear() === today.getFullYear();
  };

  return (
    <div className="fusio-panel p-3">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2.5">
          <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22, borderRadius: 5, background: 'rgba(94, 196, 217, 0.12)', border: '1px solid rgba(94, 196, 217, 0.35)' }}>
            <Calendar style={{ width: 11, height: 11, color: 'var(--cyan, #5EC4D9)' }} />
          </span>
          <div>
            <div style={{ fontFamily: 'var(--font-mono, ui-monospace)', fontSize: 9.5, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--mist, rgba(255,255,255,0.5))' }}>
              Tools · Cron
            </div>
            <div style={{ fontFamily: 'var(--font-display, "Space Grotesk")', fontSize: 13, fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--white, #fff)', marginTop: 1 }}>
              Schedule
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={prevMonth} className="p-1 text-terminal-dim hover:text-terminal-green">
            <ChevronLeft className="w-3 h-3" />
          </button>
          <span className="text-terminal-text text-xs w-24 text-center">
            {currentDate.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}
          </span>
          <button onClick={nextMonth} className="p-1 text-terminal-dim hover:text-terminal-green">
            <ChevronRight className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* Calendar Grid */}
      <div className="bg-terminal-bg rounded p-2">
        {/* Day headers */}
        <div className="grid grid-cols-7 gap-1 mb-1">
          {['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map((d) => (
            <div key={d} className="text-terminal-dim text-xs text-center">{d}</div>
          ))}
        </div>

        {/* Days */}
        <div className="grid grid-cols-7 gap-1">
          {/* Empty cells for days before first of month */}
          {Array.from({ length: firstDay }).map((_, i) => (
            <div key={`empty-${i}`} className="h-8" />
          ))}

          {/* Day cells */}
          {Array.from({ length: daysInMonth }).map((_, i) => {
            const day = i + 1;
            const dayJobs = getJobsForDay(day);
            
            return (
              <div
                key={day}
                className={`h-8 rounded text-center relative ${
                  isToday(day) 
                    ? 'bg-terminal-green/20 border border-terminal-green' 
                    : 'hover:bg-terminal-border'
                }`}
              >
                <span className={`text-xs ${isToday(day) ? 'text-terminal-green font-bold' : 'text-terminal-text'}`}>
                  {day}
                </span>
                {dayJobs.length > 0 && (
                  <div className="absolute bottom-0.5 left-1/2 -translate-x-1/2 flex gap-0.5">
                    {dayJobs.slice(0, 3).map((_, i) => (
                      <div key={i} className="w-1 h-1 rounded-full bg-terminal-cyan" />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Today's Jobs */}
      <div className="mt-2">
        <div className="text-terminal-dim text-xs mb-1">Today</div>
        <div className="space-y-1">
          {getJobsForDay(today.getDate()).slice(0, 3).map((job) => (
            <div key={job.id} className="flex items-center gap-2 text-xs">
              <span className="text-terminal-cyan">{job.time}</span>
              <span className="text-terminal-text">{job.name}</span>
            </div>
          ))}
          {getJobsForDay(today.getDate()).length === 0 && (
            <div className="text-terminal-dim text-xs italic">No jobs today</div>
          )}
        </div>
      </div>
    </div>
  );
}
