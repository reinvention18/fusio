import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

const DATA_FILE = path.join(process.cwd(), 'data', 'reports.json');

export async function GET() {
  try {
    let reports = [];
    
    if (fs.existsSync(DATA_FILE)) {
      reports = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
    
    const today = new Date().toDateString();
    const todayReports = reports.filter((r: any) => 
      new Date(r.timestamp).toDateString() === today
    );
    
    const stats = {
      total: reports.length,
      today: todayReports.length,
      bugs: reports.filter((r: any) => r.type === 'bug').length,
      features: reports.filter((r: any) => r.type === 'feature').length,
      notes: reports.filter((r: any) => r.type === 'note').length,
      byStatus: {
        new: reports.filter((r: any) => r.status === 'new').length,
        reviewed: reports.filter((r: any) => r.status === 'reviewed').length,
        inProgress: reports.filter((r: any) => r.status === 'in-progress').length,
        resolved: reports.filter((r: any) => r.status === 'resolved').length,
        wontFix: reports.filter((r: any) => r.status === 'wont-fix').length
      },
      byPriority: {
        urgent: reports.filter((r: any) => r.priority === 'urgent').length,
        high: reports.filter((r: any) => r.priority === 'high').length,
        medium: reports.filter((r: any) => r.priority === 'medium').length,
        low: reports.filter((r: any) => r.priority === 'low').length
      }
    };
    
    return NextResponse.json(stats);
  } catch (error) {
    console.error('Error getting stats:', error);
    return NextResponse.json({ error: 'Failed to get stats' }, { status: 500 });
  }
}
