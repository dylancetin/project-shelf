// Extension resources are installed files, not a remotely hosted PWA. Keep the
// shared provider API without registering a website service worker here.
export function useRegisterSW() {
  return { offlineReady: [true, (_value: boolean) => {}] as const,
    needRefresh: [false, (_value: boolean) => {}] as const,
    updateServiceWorker: async (_reload?: boolean) => {} };
}
