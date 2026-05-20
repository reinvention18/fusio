import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

const DATA_FILE = path.join(process.cwd(), 'data', 'reports.json');

interface Report {
  id: string;
  type: 'bug' | 'feature' | 'note';
  priority: 'low' | 'medium' | 'high' | 'urgent';
  message: string;
  status: 'new' | 'reviewed' | 'in-progress' | 'resolved' | 'wont-fix';
  element: {
    selector: string;
    tagName: string;
    id: string | null;
    className: string | null;
    textContent: string | null;
    position: {
      top: number;
      left: number;
      width: number;
      height: number;
    };
  };
  page: {
    url: string;
    title: string;
    viewport: {
      width: number;
      height: number;
    };
  };
  screenshot?: any;
  timestamp: string;
  userAgent: string;
  resolvedAt?: string;
  notes?: string[];
}

function loadReports(): Report[] {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch (error) {
    console.error('Error loading reports:', error);
  }
  return [];
}

function saveReports(reports: Report[]): void {
  try {
    const dir = path.dirname(DATA_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(DATA_FILE, JSON.stringify(reports, null, 2));
  } catch (error) {
    console.error('Error saving reports:', error);
    throw error;
  }
}

// GET - List all reports or fetch single by ID/number
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');
    const num = searchParams.get('num'); // Short numeric ID (e.g., #3)
    const type = searchParams.get('type');
    const status = searchParams.get('status');
    const priority = searchParams.get('priority');
    
    let reports = loadReports();
    
    // Sort by timestamp descending (newest first) - needed for short ID calculation
    reports.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    
    // Fetch single report by full ID
    if (id) {
      const report = reports.find(r => r.id === id);
      if (!report) {
        return NextResponse.json({ error: 'Report not found' }, { status: 404 });
      }
      const shortId = reports.length - reports.findIndex(r => r.id === id);
      return NextResponse.json({ report, shortId });
    }
    
    // Fetch single report by short numeric ID (e.g., #3)
    if (num) {
      const shortId = parseInt(num, 10);
      const index = reports.length - shortId;
      if (index < 0 || index >= reports.length) {
        return NextResponse.json({ error: 'Report not found' }, { status: 404 });
      }
      const report = reports[index];
      return NextResponse.json({ report, shortId });
    }
    
    // Filter by type
    if (type) {
      reports = reports.filter(r => r.type === type);
    }
    
    // Filter by status
    if (status) {
      reports = reports.filter(r => r.status === status);
    }
    
    // Filter by priority
    if (priority) {
      reports = reports.filter(r => r.priority === priority);
    }
    
    return NextResponse.json({ reports, count: reports.length });
  } catch (error) {
    console.error('Error fetching reports:', error);
    return NextResponse.json({ error: 'Failed to fetch reports' }, { status: 500 });
  }
}

// POST - Create new report
export async function POST(request: NextRequest) {
  try {
    const data = await request.json();
    
    const report: Report = {
      id: `report-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      type: data.type || 'bug',
      priority: data.priority || 'medium',
      message: data.message || '',
      status: 'new',
      element: data.element || {},
      page: data.page || {},
      screenshot: data.screenshot,
      timestamp: data.timestamp || new Date().toISOString(),
      userAgent: data.userAgent || '',
      notes: []
    };
    
    const reports = loadReports();
    reports.unshift(report);
    saveReports(reports);
    
    console.log(`[Rev Reporter] New ${report.type} report from ${report.page.url}`);
    
    return NextResponse.json({ 
      success: true, 
      id: report.id,
      message: 'Report received' 
    });
  } catch (error) {
    console.error('Error creating report:', error);
    return NextResponse.json({ error: 'Failed to create report' }, { status: 500 });
  }
}

// PATCH - Update report
export async function PATCH(request: NextRequest) {
  try {
    const data = await request.json();
    const { id, ...updates } = data;
    
    if (!id) {
      return NextResponse.json({ error: 'Report ID required' }, { status: 400 });
    }
    
    const reports = loadReports();
    const index = reports.findIndex(r => r.id === id);
    
    if (index === -1) {
      return NextResponse.json({ error: 'Report not found' }, { status: 404 });
    }
    
    // Apply updates
    reports[index] = { ...reports[index], ...updates };
    
    // If status changed to resolved, add timestamp
    if (updates.status === 'resolved' && !reports[index].resolvedAt) {
      reports[index].resolvedAt = new Date().toISOString();
    }
    
    saveReports(reports);
    
    return NextResponse.json({ success: true, report: reports[index] });
  } catch (error) {
    console.error('Error updating report:', error);
    return NextResponse.json({ error: 'Failed to update report' }, { status: 500 });
  }
}

// DELETE - Delete report
export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');
    
    if (!id) {
      return NextResponse.json({ error: 'Report ID required' }, { status: 400 });
    }
    
    const reports = loadReports();
    const filtered = reports.filter(r => r.id !== id);
    
    if (filtered.length === reports.length) {
      return NextResponse.json({ error: 'Report not found' }, { status: 404 });
    }
    
    saveReports(filtered);
    
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error deleting report:', error);
    return NextResponse.json({ error: 'Failed to delete report' }, { status: 500 });
  }
}
