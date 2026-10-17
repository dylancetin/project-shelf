import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import App from '../../src/App';
import { PwaProvider } from '../../src/Pwa';
import { configurePlatform } from '../../src/platform';
import { chrome, message, readSettings } from './browser';
import { extensionSnapshotKey } from './core';
import { ExtensionConnection } from './connection';
import { browserBookmarks } from './bookmarks';
import '../../src/styles.css';
import './newtab.css';

function Setup({ error }: { error?: string }) {
  const [failed, setFailed] = useState(error ?? '');
  return <main className="extension-setup"><img src="icon.png" alt="" width="36" height="36" /><h1>Connect your shelf.</h1><p>The app runs here, without redirecting. Saved destinations load locally while the server refreshes in the background.</p>{failed && <p role="alert">{failed}</p>}<button className="button button-primary" onClick={() => { void chrome.runtime.openOptionsPage().catch(error => setFailed(message(error))); }}>Set up Project Shelf</button></main>;
}

async function start() {
  const root = createRoot(document.getElementById('root')!);
  try {
    const settings = await readSettings();
    if (!settings) { root.render(<Setup />); return; }
    const connection = new ExtensionConnection(settings);
    configurePlatform({ request: connection.request, apiAsset: connection.asset,
      snapshotKey: extensionSnapshotKey(settings.url), openExtensionSettings: () => chrome.runtime.openOptionsPage(), bookmarks: browserBookmarks() });
    // No location navigation or autofocus. The browser owns the new-tab omnibox
    // focus; rendering and background refresh must never steal it.
    root.render(<React.StrictMode><PwaProvider><App /></PwaProvider></React.StrictMode>);
  } catch (error) { root.render(<Setup error={message(error)} />); }
}
void start();
