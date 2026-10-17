import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { DownloadSimple, Check, ArrowClockwise, WifiSlash } from '@phosphor-icons/react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { readSnapshot } from './offline';
import { shelfPlatform } from './platform';

interface InstallPrompt extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

function usePwaState() {
  const [registration, setRegistration] = useState<ServiceWorkerRegistration>();
  const [registrationError, setRegistrationError] = useState(false);
  const [prompt, setPrompt] = useState<InstallPrompt | null>(null);
  const [installed, setInstalled] = useState(() => window.matchMedia('(display-mode: standalone)').matches || Boolean((navigator as Navigator & { standalone?: boolean }).standalone));
  const [installing, setInstalling] = useState(false);
  const { offlineReady: [ready, setReady], needRefresh: [updateAvailable], updateServiceWorker } = useRegisterSW({
    immediate: true,
    onRegisteredSW(_url, result) { setRegistration(result); setRegistrationError(false); },
    onRegisterError() { setRegistrationError(true); },
  });

  useEffect(() => {
    const beforeInstall = (event: Event) => { event.preventDefault(); setPrompt(event as InstallPrompt); };
    const installed = () => { setInstalled(true); setPrompt(null); };
    window.addEventListener('beforeinstallprompt', beforeInstall);
    window.addEventListener('appinstalled', installed);
    return () => { window.removeEventListener('beforeinstallprompt', beforeInstall); window.removeEventListener('appinstalled', installed); };
  }, []);

  useEffect(() => {
    if (!registration) return;
    if (registration.active) setReady(true);
    const check = () => { if (!document.hidden && navigator.onLine) void registration.update().catch(() => {}); };
    const interval = window.setInterval(check, 60 * 60 * 1000);
    window.addEventListener('online', check);
    document.addEventListener('visibilitychange', check);
    return () => { window.clearInterval(interval); window.removeEventListener('online', check); document.removeEventListener('visibilitychange', check); };
  }, [registration, setReady]);

  async function install() {
    if (!prompt || installing) return;
    setInstalling(true);
    try { await prompt.prompt(); await prompt.userChoice; }
    finally { setPrompt(null); setInstalling(false); }
  }

  return { ready, registrationError, updateAvailable, updateServiceWorker, install, canInstall: Boolean(prompt), installed, installing };
}

const PwaContext = createContext<ReturnType<typeof usePwaState> | null>(null);
export function PwaProvider({ children }: { children: ReactNode }) {
  const state = usePwaState();
  return <PwaContext.Provider value={state}>{children}</PwaContext.Provider>;
}
function usePwa() {
  const state = useContext(PwaContext);
  if (!state) throw new Error('PWA provider is missing');
  return state;
}

export function UpdateNotice() {
  const { updateAvailable, updateServiceWorker } = usePwa();
  const [error, setError] = useState(false);
  if (!updateAvailable) return null;
  return <div className="connection-notice update-notice" role="status">
    <span>{error ? 'The update could not load. Reconnect and try again.' : 'A new version is ready. Save any edits before reloading.'}</span>
    <button className="text-button" onClick={() => { void updateServiceWorker(true).catch(() => setError(true)); }}>Reload to update</button>
  </div>;
}

export function PwaPanel() {
  const { ready, registrationError, canInstall, installed, installing, install, updateAvailable, updateServiceWorker } = usePwa();
  const [error, setError] = useState('');
  const snapshot = readSnapshot();
  const supported = window.isSecureContext && 'serviceWorker' in navigator;
  if (shelfPlatform().openExtensionSettings) return <section className="settings-section pwa-panel">
    <div className="section-heading"><h3>Saved in your extension</h3><WifiSlash size={19} /></div>
    <p className="section-description">The frontend, search shortcuts, and bundled icons are installed locally. New tabs render saved destinations first, then refresh from your server without redirecting or focusing the page search.</p>
    <dl className="offline-details"><div><dt>Saved destinations</dt><dd>{snapshot ? `${snapshot.projects.length} entries` : 'Not saved yet'}</dd></div><div><dt>Last saved</dt><dd>{snapshot ? new Date(snapshot.savedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'Connect to the server first'}</dd></div></dl>
    <p className="section-description">Process status is unknown until the server responds. Starting projects, editing, and live logs require a connection. Commands are never cached, queued, or replayed.</p>
    <button className="button" onClick={() => { void shelfPlatform().openExtensionSettings?.().catch(() => setError('Open the extension’s options from your browser’s Extensions page.')); }}>Extension connection settings</button>
    {error && <p role="alert">{error}</p>}
    <p className="field-hint">Each server has a separate local snapshot. Clearing extension data removes saved destinations. Updating the frontend requires installing the updated extension folder.</p>
  </section>;
  return <section className="settings-section pwa-panel">
    <div className="section-heading"><h3>Your shelf, even offline</h3><WifiSlash size={19} /></div>
    <p className="section-description">Keep this start page on your device. Search saved destinations when the server or your connection is unavailable.</p>
    <div className="offline-status" role="status"><span className={`status-dot${ready ? ' offline-ready' : ''}`} /><div><strong>{!supported ? 'HTTPS is needed' : registrationError ? 'Offline setup failed' : ready ? 'App saved for offline use' : import.meta.env.DEV ? 'Offline caching is off in development' : 'Preparing offline access…'}</strong><p>{!supported ? 'Open over HTTPS or localhost to enable installation and offline reloads.' : registrationError ? 'Reconnect, then reload to try saving the app again.' : ready ? 'The app and bundled icons can load without a connection.' : 'Visit once online to download the app.'}</p></div></div>
    <dl className="offline-details"><div><dt>Saved destinations</dt><dd>{snapshot ? `${snapshot.projects.length} entries` : 'Not saved yet'}</dd></div><div><dt>Last saved</dt><dd>{snapshot ? new Date(snapshot.savedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'Connect to the server first'}</dd></div></dl>
    <p className="section-description">Saved links and search work offline. Linked sites still need their own connection. Starting projects, editing, scanning, and live logs need the server; commands are never queued for later.</p>
    <div className="pwa-install">
      <h3>{installed ? 'Installed on this device' : 'Give your shelf a home'}</h3>
      {installed ? <p><Check size={16} />Project Shelf is running as an app.</p> : canInstall ? <button className="button button-primary" disabled={installing} onClick={() => { void install().catch(() => setError('Installation was unavailable. Try your browser’s install menu.')); }}><DownloadSimple size={16} />{installing ? 'Installing…' : 'Install Project Shelf'}</button> : <p>On iPhone or iPad, open in Safari, then Share → Add to Home Screen. On desktop or Android, use your browser’s Install app or Add to Home Screen menu when available.</p>}
      {updateAvailable && <button className="button" onClick={() => { void updateServiceWorker(true).catch(() => setError('Reconnect before applying the update.')); }}><ArrowClockwise size={16} />Reload to update</button>}
      {error && <p role="alert">{error}</p>}
    </div>
    <p className="field-hint">Saved data stays in this browser on this origin. Clearing site data removes offline access. Updates wait for you to reload, so unsaved edits are not interrupted.</p>
  </section>;
}
