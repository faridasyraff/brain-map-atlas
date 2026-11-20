import { create } from 'zustand';

export type PanelTab = 'inspector' | 'hierarchy' | 'saved';
/** Desktop views: the 3D stage over a strip of three sections, or four equal views. */
export type ViewLayout = 'stage' | 'quad';

const LAYOUT_KEY = 'brain-atlas.layout';
function storedLayout(): ViewLayout {
  try {
    return localStorage.getItem(LAYOUT_KEY) === 'quad' ? 'quad' : 'stage';
  } catch {
    return 'stage';
  }
}

interface UiState {
  panelOpen: boolean;
  /** Desktop: the brain index on the left (open by default; collapses to a rail). */
  indexOpen: boolean;
  tab: PanelTab;
  layout: ViewLayout;
  /** null = sign-in dialog closed. */
  signInMode: 'signin' | 'signup' | null;
  togglePanel: () => void;
  toggleIndex: () => void;
  setTab: (tab: PanelTab) => void;
  setLayout: (layout: ViewLayout) => void;
  openSignIn: (mode: 'signin' | 'signup') => void;
  closeSignIn: () => void;
}

/** UI-only state that several components need (panel, tab, dialogs). */
export const useUi = create<UiState>()((set) => ({
  panelOpen: true,
  indexOpen: true,
  tab: 'inspector',
  layout: storedLayout(),
  signInMode: null,
  togglePanel: () => set((s) => ({ panelOpen: !s.panelOpen })),
  toggleIndex: () => set((s) => ({ indexOpen: !s.indexOpen })),
  setTab: (tab) => set({ tab, panelOpen: true }),
  setLayout: (layout) => {
    try {
      localStorage.setItem(LAYOUT_KEY, layout);
    } catch {
      // private window or blocked storage: the choice lasts until reload
    }
    set({ layout });
  },
  openSignIn: (mode) => set({ signInMode: mode }),
  closeSignIn: () => set({ signInMode: null }),
}));
