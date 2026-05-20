import { NextRequest, NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export async function POST(req: NextRequest) {
  try {
    const { target } = await req.json();

    // Get workspace from the config or use default
    const workspace = process.env.FIELDREPAPP_WORKSPACE || 'C:\\DevApps\\MyMobileApp';

    let command = '';
    let cwd = workspace;

    switch (target) {
      case 'saas-prod':
        command = 'vercel --prod --yes';
        break;
      case 'saas-staging':
        command = 'vercel --yes';
        break;
      case 'app-prod':
        command = 'npm run deploy:app';
        break;
      case 'app-ota':
        command = 'npm run update:production';
        break;
      default:
        return NextResponse.json({ error: 'Invalid target' }, { status: 400 });
    }

    // Execute the deploy command
    // Note: This runs asynchronously - the response comes back immediately
    // In production, you'd want to track the deployment status
    exec(command, { cwd, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        console.error(`Deploy error: ${error.message}`);
        return;
      }
      console.log(`Deploy stdout: ${stdout}`);
      if (stderr) console.error(`Deploy stderr: ${stderr}`);
    });

    return NextResponse.json({ 
      success: true, 
      message: `Deployment triggered: ${target}`,
      command 
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
