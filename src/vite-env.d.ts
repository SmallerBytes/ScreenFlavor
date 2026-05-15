type CursorPos = { x: number; y: number };

type LastRunPayload = {
  seconds: number;
  gameId: string | null;
  dropped?: number;
};

export type SnailLaunchSettings = {
  sizePercent: number;
  speedPercent: number;
};

export type GoblinDropResult = {
  ok: boolean;
  path?: string;
  name?: string;
  message?: string;
};

export type OverlayBounds = { x: number; y: number; width: number; height: number };

type ScreenFlavorApi = {
  startGame: (gameId: string, snailSettings?: SnailLaunchSettings) => Promise<boolean>;
  dropGoblinTxtFile: () => Promise<GoblinDropResult>;
  getOverlayBounds: () => Promise<OverlayBounds | null>;
  getSnailLaunchSettings: () => Promise<SnailLaunchSettings>;
  quitApp: () => Promise<void>;
  getAppVersion: () => Promise<string>;
  onCursor: (handler: (pos: CursorPos) => void) => () => void;
  onLastRun: (handler: (payload: LastRunPayload) => void) => () => void;
  notifyGameOver: (seconds: number) => Promise<boolean>;
};

declare global {
  interface Window {
    screenFlavor: ScreenFlavorApi;
  }
}

export {};
