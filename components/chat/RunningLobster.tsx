'use client';

/**
 * RunningLobster — decorative pixel-lobster that crab-walks around the
 * thinking bubble while the agent is generating a response.
 *
 * The keyframes live in app/globals.css (`.lobster-runner` /
 * `@keyframes lobster-run`) so this file is just the <img> + position.
 * Avoids `<style jsx>` because it has caused PostCSS issues in this repo.
 */
export function RunningLobster() {
  return (
    <img
      src="/lobster.svg?v=2"
      alt=""
      className="lobster-runner absolute pointer-events-none z-10"
      style={{ width: '24px', height: '16px', imageRendering: 'pixelated' }}
    />
  );
}
