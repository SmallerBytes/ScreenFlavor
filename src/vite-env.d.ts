type CursorPos = { x: number; y: number };

type LastRunPayload = {
  seconds: number;
  gameId: string | null;
};

export type SnailLaunchSettings = {
  sizePercent: number;
  speedPercent: number;
};

type ScreenFlavorApi = {
  startGame: (gameId: string, snailSettings?: SnailLaunchSettings) => Promise<boolean>;
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
