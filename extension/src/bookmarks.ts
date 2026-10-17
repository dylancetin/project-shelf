import type { BrowserBookmarks } from '../../shared/browser-bookmarks';
import { sameMembers } from '../../shared/ordering';
import { chrome, type ChromeApi } from './browser';
import { chromeFavicons } from './favicons';

export function browserBookmarks(api: ChromeApi = chrome): BrowserBookmarks {
  return {
    favicons: chromeFavicons(api),
    hasAccess: () => api.permissions.contains({ permissions: ['bookmarks'] }),
    requestAccess: () => api.permissions.request({ permissions: ['bookmarks'] }),
    getTree: () => api.bookmarks.getTree(),
    subscribe(listener) {
      // Permission events also refresh the view after access is granted/revoked.
      const events = [api.permissions.onAdded, api.permissions.onRemoved,
        api.bookmarks?.onCreated, api.bookmarks?.onRemoved, api.bookmarks?.onChanged,
        api.bookmarks?.onMoved, api.bookmarks?.onChildrenReordered, api.bookmarks?.onImportEnded].filter(event => event);
      for (const event of events) event.addListener(listener);
      return () => { for (const event of events) event.removeListener(listener); };
    },
    async reorder(parentId, ids, previousIds) {
      if (parentId === '0') throw new Error('Browser root folders cannot be reordered. Open a folder first.');
      const children = await api.bookmarks.getChildren(parentId);
      const current = children.map(node => node.id);
      if (!sameMembers(current, ids) || current.length !== previousIds.length || !current.every((id, index) => id === previousIds[index])) {
        throw new Error('This bookmark folder changed. Close Organize and reopen it to load the latest order.');
      }
      if (children.some(node => node.unmodifiable)) throw new Error('This folder contains managed bookmarks and cannot be reordered.');
      // Chrome moves are not transactional. Check before every move, stop on an
      // external edit/failure, and refresh the actual tree rather than rolling back.
      const expected = [...current];
      for (let index = 0; index < ids.length; index++) {
        if (expected[index] === ids[index]) continue;
        const live = (await api.bookmarks.getChildren(parentId)).map(node => node.id);
        if (live.length !== expected.length || !live.every((id, i) => id === expected[i])) {
          throw new Error('Bookmarks changed during saving. Some moves may have been applied; reopen Organize to review Chrome’s current order.');
        }
        const id = ids[index]!;
        await api.bookmarks.move(id, { parentId, index });
        expected.splice(index, 0, expected.splice(expected.indexOf(id), 1)[0]!);
      }
      const saved = (await api.bookmarks.getChildren(parentId)).map(node => node.id);
      if (saved.length !== ids.length || !saved.every((id, index) => id === ids[index])) {
        throw new Error('Bookmarks changed while saving. Reopen Organize to review Chrome’s current order.');
      }
    },
  };
}
