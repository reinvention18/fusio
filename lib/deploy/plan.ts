/**
 * Deploy plan detector.
 *
 * Given a project root + the list of files a team changed, figures out which
 * deploy pipelines apply and whether each should run. Smart about:
 *   - Multiple Vercel projects (repo root + nested dist/)
 *   - Expo native vs OTA split (native files OR app.json/eas.json/package.json
 *     → full build; JS-only → OTA update)
 *   - Supabase migrations + edge functions
 *
 * The plan is *advisory* — the UI shows it to the human who toggles each
 * target before actually running.
 */

import 'server-only';
import fs from 'node:fs';
import path from 'node:path';

export type DeployTargetKind =
  | 'next'
  | 'rn-web'
  | 'eas-build'
  | 'eas-update'
  | 'supabase-db'
  | 'supabase-functions';

export interface DeployTarget {
  kind: DeployTargetKind;
  label: string;
  command: string[];
  cwd: string;
  // Whether we recommend running this target given the changed files. The UI
  // can override (default-check or default-uncheck).
  shouldRun: boolean;
  reason: string;
  metadata?: Record<string, any>;
}

export interface DeployPlan {
  projectRoot: string;
  filesChanged: string[];
  detected: {
    next: { projectName: string; vercelOrg: string } | null;
    rnWeb: { projectName: string; vercelOrg: string } | null;
    eas: { hasEasJson: boolean; hasAppJson: boolean } | null;
    supabase: { projectRef: string | null; hasMigrations: boolean; functionsDir: string | null } | null;
  };
  targets: DeployTarget[];
}

function safeReadJson<T = any>(p: string): T | null {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
}

function filesInPrefix(files: string[], prefix: string): string[] {
  return files.filter(f => f.startsWith(prefix));
}

function filesMatching(files: string[], re: RegExp): string[] {
  return files.filter(f => re.test(f));
}

/**
 * Detect what kind of project lives at `projectRoot` — caches nothing; cheap
 * filesystem reads.
 */
export function detectProject(projectRoot: string): DeployPlan['detected'] {
  const detected: DeployPlan['detected'] = {
    next: null,
    rnWeb: null,
    eas: null,
    supabase: null,
  };

  // Next.js + Vercel
  const hasNextConfig =
    fs.existsSync(path.join(projectRoot, 'next.config.js')) ||
    fs.existsSync(path.join(projectRoot, 'next.config.ts')) ||
    fs.existsSync(path.join(projectRoot, 'next.config.mjs'));
  const rootVercel = safeReadJson(path.join(projectRoot, '.vercel/project.json'));
  if (hasNextConfig && rootVercel?.projectName) {
    detected.next = { projectName: rootVercel.projectName, vercelOrg: rootVercel.orgId };
  }

  // React Native Web export under dist/
  const distVercel = safeReadJson(path.join(projectRoot, 'dist/.vercel/project.json'));
  if (distVercel?.projectName) {
    detected.rnWeb = { projectName: distVercel.projectName, vercelOrg: distVercel.orgId };
  }

  // EAS / Expo
  const hasEasJson = fs.existsSync(path.join(projectRoot, 'eas.json'));
  const hasAppJson = fs.existsSync(path.join(projectRoot, 'app.json'));
  if (hasEasJson || hasAppJson) {
    detected.eas = { hasEasJson, hasAppJson };
  }

  // Supabase
  const supaConfigPath = path.join(projectRoot, 'supabase/config.toml');
  const projectRefPath = path.join(projectRoot, 'supabase/.temp/project-ref');
  const migrationsDir = path.join(projectRoot, 'supabase/migrations');
  const functionsDir = path.join(projectRoot, 'supabase/functions');
  if (fs.existsSync(supaConfigPath) || fs.existsSync(migrationsDir) || fs.existsSync(functionsDir)) {
    let projectRef: string | null = null;
    try {
      if (fs.existsSync(projectRefPath)) {
        projectRef = fs.readFileSync(projectRefPath, 'utf-8').trim() || null;
      }
    } catch { /* ignore */ }
    detected.supabase = {
      projectRef,
      hasMigrations: fs.existsSync(migrationsDir),
      functionsDir: fs.existsSync(functionsDir) ? 'supabase/functions' : null,
    };
  }

  return detected;
}

/**
 * File-path heuristics for what each target cares about. Tuned for
 * MyMobileApp but works for any project with similar layout.
 */
function categorize(files: string[]) {
  const nextFiles = filesMatching(files, /^(pages\/|app\/|next\.config|lib\/(?!teams|mem|deploy)|components\/(?!constellation|teams|mem|notifications)|public\/)/);
  const rnWebFiles = filesMatching(files, /^(App\.js|App\.tsx|src\/(screens|services|components|utils|hooks|navigation)\/|babel\.config|metro\.config)/);
  const nativeFiles = filesMatching(files, /^(ios\/|android\/|.*\/Podfile|.*\/build\.gradle)/);
  const appConfigFiles = filesMatching(files, /^(app\.json|app\.config\.js|eas\.json|package\.json|package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/);
  const migrationFiles = filesMatching(files, /^supabase\/migrations\//);
  const functionFiles = filesMatching(files, /^supabase\/functions\//);

  return { nextFiles, rnWebFiles, nativeFiles, appConfigFiles, migrationFiles, functionFiles };
}

/**
 * Plan the deploy. Always returns all detected targets (so the UI can show
 * them greyed out with a reason) — `shouldRun` tells the UI which to check.
 */
export function planDeploy(projectRoot: string, filesChanged: string[]): DeployPlan {
  const detected = detectProject(projectRoot);
  const cat = categorize(filesChanged);
  const targets: DeployTarget[] = [];

  // Next.js
  if (detected.next) {
    const relevant = cat.nextFiles.length > 0;
    targets.push({
      kind: 'next',
      label: `Next.js → Vercel (${detected.next.projectName})`,
      command: ['vercel', '--prod'],
      cwd: projectRoot,
      shouldRun: relevant,
      reason: relevant
        ? `${cat.nextFiles.length} Next.js-related file${cat.nextFiles.length === 1 ? '' : 's'} changed`
        : 'No Next.js-related files changed',
      metadata: { projectName: detected.next.projectName, sampleFiles: cat.nextFiles.slice(0, 8) },
    });
  }

  // RN Web (second Vercel project under dist/)
  if (detected.rnWeb) {
    const relevant = cat.rnWebFiles.length > 0 || cat.appConfigFiles.length > 0;
    targets.push({
      kind: 'rn-web',
      label: `RN Web → Vercel (${detected.rnWeb.projectName})`,
      command: ['npm', 'run', 'deploy:app'],
      cwd: projectRoot,
      shouldRun: relevant,
      reason: relevant
        ? `${cat.rnWebFiles.length + cat.appConfigFiles.length} React-Native/web file${(cat.rnWebFiles.length + cat.appConfigFiles.length) === 1 ? '' : 's'} changed`
        : 'No React Native web files changed',
      metadata: { projectName: detected.rnWeb.projectName, sampleFiles: cat.rnWebFiles.slice(0, 8) },
    });
  }

  // EAS — full build OR OTA
  if (detected.eas) {
    const needFullBuild = cat.nativeFiles.length > 0 || cat.appConfigFiles.length > 0;
    const jsChanged = cat.rnWebFiles.length > 0;

    if (needFullBuild) {
      targets.push({
        kind: 'eas-build',
        label: 'EAS Build (iOS + Android, production)',
        command: ['eas', 'build', '--platform', 'all', '--profile', 'production', '--non-interactive'],
        cwd: projectRoot,
        shouldRun: true,
        reason: cat.nativeFiles.length > 0
          ? 'Native (ios/ android/) files changed — full build required'
          : 'app.json / eas.json / package.json changed — full build required (version bump triggers)',
        metadata: { nativeFiles: cat.nativeFiles.slice(0, 8), configFiles: cat.appConfigFiles },
      });
    } else if (jsChanged) {
      targets.push({
        kind: 'eas-update',
        label: 'EAS OTA Update (production branch)',
        command: ['eas', 'update', '--branch', 'production', '--non-interactive'],
        cwd: projectRoot,
        shouldRun: true,
        reason: `${cat.rnWebFiles.length} JS/React file${cat.rnWebFiles.length === 1 ? '' : 's'} changed — OTA is safe (no native changes)`,
        metadata: { sampleFiles: cat.rnWebFiles.slice(0, 8) },
      });
    } else {
      // Show EAS in plan but don't recommend
      targets.push({
        kind: 'eas-update',
        label: 'EAS OTA Update (production branch)',
        command: ['eas', 'update', '--branch', 'production', '--non-interactive'],
        cwd: projectRoot,
        shouldRun: false,
        reason: 'No app/native changes detected',
      });
    }
  }

  // Supabase — migrations
  if (detected.supabase?.hasMigrations) {
    const relevant = cat.migrationFiles.length > 0;
    const projectRef = detected.supabase.projectRef;
    targets.push({
      kind: 'supabase-db',
      label: `Supabase DB push${projectRef ? ` (${projectRef})` : ''}`,
      command: projectRef
        ? ['supabase', 'db', 'push', '--linked']
        : ['supabase', 'db', 'push'],
      cwd: projectRoot,
      shouldRun: relevant,
      reason: relevant
        ? `${cat.migrationFiles.length} new migration file${cat.migrationFiles.length === 1 ? '' : 's'}`
        : 'No migration files changed',
      metadata: { migrationFiles: cat.migrationFiles, projectRef },
    });
  }

  // Supabase — edge functions (one target per changed function)
  if (detected.supabase?.functionsDir) {
    const funcNames = new Set<string>();
    for (const f of cat.functionFiles) {
      const m = f.match(/^supabase\/functions\/([^/]+)\//);
      if (m) funcNames.add(m[1]);
    }
    for (const name of funcNames) {
      const projectRef = detected.supabase.projectRef;
      targets.push({
        kind: 'supabase-functions',
        label: `Supabase function: ${name}`,
        command: projectRef
          ? ['supabase', 'functions', 'deploy', name, '--project-ref', projectRef]
          : ['supabase', 'functions', 'deploy', name],
        cwd: projectRoot,
        shouldRun: true,
        reason: `${name}/ changed`,
        metadata: { functionName: name, projectRef },
      });
    }
  }

  return { projectRoot, filesChanged, detected, targets };
}
