import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { readEmbedParams } from '../../shared/embed';
import '../styles.css';
import './embed.css';
import { EmbedApp } from './EmbedApp';
import { announceHidden, framerTrusted } from './host';

const root = document.getElementById('root');
if (!root) throw new Error('embed.html is missing #root');
const { surface, pageUrl } = readEmbedParams(window.location.search);
document.documentElement.dataset.surface = surface;
if (framerTrusted(surface, pageUrl)) {
  createRoot(root).render(<StrictMode><EmbedApp surface={surface} pageUrl={pageUrl} /></StrictMode>);
} else {
  announceHidden();
}
