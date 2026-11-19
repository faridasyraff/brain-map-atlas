import { create } from 'zustand';

export type PanelTab = 'inspector' | 'hierarchy' | 'saved';

interface UiState {
  panelOpen: boolean;
  tab: PanelTab;
  /** null = sign-in dialog closed. */
  signInMode: 'signin' | 'signup' | null;
  togglePanel: () => void;
  setTab: (tab: PanelTab) => void;
  openSignIn: (mode: 'signin' | 'signup') => void;
  closeSignIn: () => void;
}

/** UI-only state that several components need (panel, tab, dialogs). */
export const useUi = create<UiState>()((set) => ({
  panelOpen: true,
  tab: 'inspector',
  signInMode: null,
  togglePanel: () => set((s) => ({ panelOpen: !s.panelOpen })),
  setTab: (tab) => set({ tab, panelOpen: true }),
  openSignIn: (mode) => set({ signInMode: mode }),
  closeSignIn: () => set({ signInMode: null }),
}));
