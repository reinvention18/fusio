'use client';

import { ConstellationPanel } from './constellation';

/**
 * Mission Operations Center — thin wrapper around the composed ConstellationPanel.
 * All the constellation UI lives under components/constellation/.
 */
export default function TeamsPanel() {
  return <ConstellationPanel />;
}
