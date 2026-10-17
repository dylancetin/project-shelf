import { chrome, element, hasAccess, message, readSettings } from './browser';
import { checkConnection } from './core';

const status = element('connection-status');
const address = element('address');
const links = element('destinations');
const home = element<HTMLAnchorElement>('home');
const manage = element<HTMLAnchorElement>('manage');

element<HTMLButtonElement>('settings').addEventListener('click', async () => {
  try { await chrome.runtime.openOptionsPage(); window.close(); }
  catch (error) { status.textContent = message(error); }
});

async function load() {
  try {
    const settings = await readSettings();
    if (!settings) { status.textContent = 'Set your Shelf address to get started.'; return; }
    address.textContent = settings.url;
    address.hidden = false;
    home.href = chrome.runtime.getURL('newtab.html');
    manage.href = `${home.href}#manage`;
    links.hidden = false;
    if (!await hasAccess(settings)) { status.textContent = 'Save settings to allow connection checks.'; return; }
    status.textContent = 'Checking connection…';
    await checkConnection(settings.url);
    status.textContent = 'Shelf is responding';
    status.classList.add('connected');
  } catch (error) { status.textContent = message(error); }
}
void load();
