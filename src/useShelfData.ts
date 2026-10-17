import { useCallback, useEffect, useRef, useState, type SetStateAction } from 'react';
import type { Project, Settings } from '../shared/types';
import { api, errorMessage } from './api';
import { readSnapshot, saveSnapshot, unknownRuntime } from './offline';

export function useShelfData() {
  const [saved] = useState(readSnapshot);
  const [projects, setProjects] = useState<Project[]>(() => unknownRuntime(saved?.projects ?? []));
  const [settings, setSettings] = useState<Settings | null>(saved?.settings ?? null);
  const [loading, setLoading] = useState(!saved);
  const [unavailable, setUnavailable] = useState(true);
  const [checking, setChecking] = useState(() => navigator.onLine !== false);
  const [savedAt, setSavedAt] = useState(saved?.savedAt ?? null);
  const [loadError, setLoadError] = useState('');
  const pending = useRef<Promise<void> | null>(null);
  const controller = useRef<AbortController | null>(null);
  const projectRevision = useRef(0);
  const applyProjects = useCallback((value: SetStateAction<Project[]>) => {
    ++projectRevision.current;
    setProjects(value);
  }, []);

  const refresh = useCallback(() => {
    if (pending.current) return pending.current;
    const abort = new AbortController();
    const revision = projectRevision.current;
    controller.current = abort;
    const task = (async () => {
      try {
        const [projectData, settingsData] = await Promise.all([api.projects(abort.signal), api.settings(abort.signal)]);
        if (abort.signal.aborted) return;
        // A poll started before a successful edit/reorder must not undo it.
        if (revision === projectRevision.current) setProjects(projectData.projects);
        setSettings(settingsData.settings);
        setUnavailable(false); setLoadError('');
      } catch (error) {
        if (abort.signal.aborted || revision !== projectRevision.current) return;
        setUnavailable(true); setProjects(current => unknownRuntime(current));
        setLoadError(errorMessage(error));
        throw error;
      } finally {
        if (!abort.signal.aborted) { setLoading(false); setChecking(false); }
      }
    })();
    pending.current = task;
    void task.finally(() => { if (pending.current === task) pending.current = null; }).catch(() => {});
    return task;
  }, []);

  useEffect(() => {
    // Defer the first request so StrictMode's setup/cleanup probe cannot leave
    // an aborted request shared with the real mount.
    let active = true;
    void Promise.resolve().then(() => { if (active) void refresh().catch(() => {}); });
    const retry = () => { if (!document.hidden) void refresh().catch(() => {}); };
    const offline = () => { setChecking(false); setUnavailable(true); setProjects(current => unknownRuntime(current)); };
    const interval = window.setInterval(retry, 3000);
    window.addEventListener('online', retry);
    window.addEventListener('offline', offline);
    document.addEventListener('visibilitychange', retry);
    return () => {
      active = false; controller.current?.abort(); pending.current = null;
      window.clearInterval(interval);
      window.removeEventListener('online', retry);
      window.removeEventListener('offline', offline);
      document.removeEventListener('visibilitychange', retry);
    };
  }, [refresh]);

  useEffect(() => {
    if (!unavailable) setSavedAt(saveSnapshot(projects, settings));
  }, [projects, settings, unavailable]);

  return { projects, setProjects: applyProjects, settings, setSettings, loading, unavailable, checking, savedAt, loadError, refresh };
}
