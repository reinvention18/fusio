import { NextResponse } from 'next/server';

const VERCEL_TOKEN = process.env.VERCEL_TOKEN;
const VERCEL_TEAM_ID = process.env.VERCEL_TEAM_ID;

interface VercelDeployment {
  uid: string;
  name: string;
  url: string;
  state: string;
  created: number;
  target: string | null;
  meta?: {
    githubCommitRef?: string;
  };
}

async function fetchVercelDeployments(projectName: string): Promise<any[]> {
  if (!VERCEL_TOKEN) {
    return [];
  }

  try {
    const params = new URLSearchParams({
      projectId: projectName,
      limit: '10',
      ...(VERCEL_TEAM_ID ? { teamId: VERCEL_TEAM_ID } : {})
    });

    const response = await fetch(
      `https://api.vercel.com/v6/deployments?${params}`,
      {
        headers: {
          Authorization: `Bearer ${VERCEL_TOKEN}`,
        },
        next: { revalidate: 30 }
      }
    );

    if (!response.ok) {
      console.error(`Vercel API error for ${projectName}:`, response.status);
      return [];
    }

    const data = await response.json();
    return (data.deployments || []).map((d: VercelDeployment) => ({
      id: d.uid,
      name: d.name,
      url: d.url ? `https://${d.url}` : '',
      state: d.state?.toUpperCase() || 'UNKNOWN',
      createdAt: new Date(d.created).toISOString(),
      target: d.target || 'preview',
      branch: d.meta?.githubCommitRef || 'unknown'
    }));
  } catch (error) {
    console.error(`Error fetching deployments for ${projectName}:`, error);
    return [];
  }
}

export async function GET() {
  try {
    // Fetch real deployments from Vercel
    const [saasDeployments, appDeployments] = await Promise.all([
      fetchVercelDeployments('fieldrepapp'),
      fetchVercelDeployments('dist')
    ]);

    // Separate production and staging deployments
    const saasProd = saasDeployments.filter(d => d.target === 'production');
    const saasStaging = saasDeployments.filter(d => d.target === 'preview' || d.branch === 'staging');
    const appProd = appDeployments.filter(d => d.target === 'production');
    const appStaging = appDeployments.filter(d => d.target === 'preview' || d.branch === 'staging');

    // If no Vercel token, return informative mock data
    if (!VERCEL_TOKEN) {
      return NextResponse.json({
        saas: {
          production: [{
            id: 'mock-prod',
            name: 'fieldrepapp',
            url: 'https://example.com',
            state: 'READY',
            createdAt: new Date().toISOString(),
            target: 'production',
            branch: 'main'
          }],
          staging: [{
            id: 'mock-staging',
            name: 'fieldrepapp',
            url: 'https://staging.example.com',
            state: 'READY',
            createdAt: new Date().toISOString(),
            target: 'preview',
            branch: 'staging'
          }]
        },
        app: {
          production: [{
            id: 'mock-app-prod',
            name: 'dist',
            url: 'https://app.example.com',
            state: 'READY',
            createdAt: new Date().toISOString(),
            target: 'production',
            branch: 'main'
          }],
          staging: [{
            id: 'mock-app-staging',
            name: 'dist',
            url: 'https://staging-app.example.com',
            state: 'READY',
            createdAt: new Date().toISOString(),
            target: 'preview',
            branch: 'staging'
          }]
        },
        eas: [],
        needsToken: true,
        message: 'Add VERCEL_TOKEN to .env.local for real deployment status'
      });
    }

    return NextResponse.json({
      saas: {
        production: saasProd,
        staging: saasStaging
      },
      app: {
        production: appProd,
        staging: appStaging
      },
      eas: [], // TODO: Add EAS API integration
      needsToken: false
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
