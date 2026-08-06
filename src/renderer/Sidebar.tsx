import { type ReactNode } from 'react';

import {
  BrandIcon,
  DocumentIcon,
  LockIcon,
  GearIcon,
  ModelIcon,
  MoonIcon,
  SunIcon,
} from './icons';
import { type AppTheme } from './theme';

export type AppPage = 'transcripts' | 'local-ai' | 'settings';

export const Sidebar = ({
  currentPage,
  onNavigate,
  onToggleTheme,
  theme,
  updateBadge,
  updateNotice,
}: {
  currentPage: AppPage;
  onNavigate: (page: AppPage) => void;
  onToggleTheme: () => void;
  theme: AppTheme;
  updateBadge?: ReactNode;
  updateNotice?: ReactNode;
}) => (
  <aside className="sidebar" aria-label="Sotto navigation">
    <div className="brand">
      <BrandIcon className="brand__mark" />
      <span>Sotto</span>
      {updateBadge}
    </div>
    <nav className="navigation" aria-label="Primary">
      <button
        className={`navigation__item${currentPage === 'transcripts' ? ' navigation__item--active' : ''}`}
        onClick={() => onNavigate('transcripts')}
        type="button"
      >
        <DocumentIcon /><span>Transcripts</span>
      </button>
      <button
        className={`navigation__item${currentPage === 'local-ai' ? ' navigation__item--active' : ''}`}
        onClick={() => onNavigate('local-ai')}
        type="button"
      >
        <ModelIcon /><span>Local AI</span>
      </button>
      <button
        className={`navigation__item${currentPage === 'settings' ? ' navigation__item--active' : ''}`}
        onClick={() => onNavigate('settings')}
        type="button"
      >
        <GearIcon /><span>Settings</span>
      </button>
    </nav>
    {updateNotice}
    <div className="sidebar__footer">
      <div className="theme-picker" aria-label="Appearance">
        <span className="theme-picker__label">Appearance</span>
        <div className="theme-picker__options" role="group" aria-label="Choose appearance">
          <button
            aria-pressed={theme === 'light'}
            className={`theme-picker__option${theme === 'light' ? ' theme-picker__option--active' : ''}`}
            onClick={() => {
              if (theme !== 'light') onToggleTheme();
            }}
            title="Use light mode"
            type="button"
          >
            <SunIcon />
            <span>Light</span>
          </button>
          <button
            aria-pressed={theme === 'dark'}
            className={`theme-picker__option${theme === 'dark' ? ' theme-picker__option--active' : ''}`}
            onClick={() => {
              if (theme !== 'dark') onToggleTheme();
            }}
            title="Use dark mode"
            type="button"
          >
            <MoonIcon />
            <span>Dark</span>
          </button>
        </div>
      </div>
      <div className="privacy-note"><LockIcon /><span>Media and transcripts stay on this device.</span></div>
    </div>
  </aside>
);
