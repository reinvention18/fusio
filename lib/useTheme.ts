'use client';

import { useState, useEffect } from 'react';

export type ThemeId = 'terminal' | 'aurora' | 'ember' | 'frost';
export type DensityId = 'cozy' | 'compact' | 'minimal';

export interface Theme {
  id: ThemeId;
  name: string;
  description: string;
  preview: string; // CSS class for preview card
}

export const themes: Theme[] = [
  {
    id: 'terminal',
    name: 'Terminal Classic',
    description: 'Classic hacker terminal with green phosphor glow',
    preview: 'theme-preview-terminal',
  },
  {
    id: 'aurora',
    name: 'Midnight Aurora',
    description: 'Deep space blues with purple and cyan aurora accents',
    preview: 'theme-preview-aurora',
  },
  {
    id: 'ember',
    name: 'Ember Command',
    description: 'Warm command center with amber and orange fire tones',
    preview: 'theme-preview-ember',
  },
  {
    id: 'frost',
    name: 'Frost Glass',
    description: 'Light glassmorphism with cool blues and soft whites',
    preview: 'theme-preview-frost',
  },
];

export function useTheme() {
  const [theme, setThemeState] = useState<ThemeId>('terminal');
  const [density, setDensityState] = useState<DensityId>('cozy');
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    const saved = localStorage.getItem('mission-control-theme') as ThemeId;
    if (saved && themes.find(t => t.id === saved)) {
      setThemeState(saved);
      document.documentElement.setAttribute('data-theme', saved);
    }
    const savedDensity = localStorage.getItem('mission-control-density') as DensityId;
    if (savedDensity && ['cozy', 'compact', 'minimal'].includes(savedDensity)) {
      setDensityState(savedDensity);
      document.documentElement.setAttribute('data-density', savedDensity);
    } else {
      document.documentElement.setAttribute('data-density', 'cozy');
    }
  }, []);

  const setTheme = (newTheme: ThemeId) => {
    setThemeState(newTheme);
    localStorage.setItem('mission-control-theme', newTheme);
    document.documentElement.setAttribute('data-theme', newTheme);
  };

  const setDensity = (newDensity: DensityId) => {
    setDensityState(newDensity);
    localStorage.setItem('mission-control-density', newDensity);
    document.documentElement.setAttribute('data-density', newDensity);
  };

  return {
    theme,
    setTheme,
    themes,
    density,
    setDensity,
    mounted,
  };
}
