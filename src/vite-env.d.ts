type CursorPos = { x: number; y: number };

type LastRunPayload = {
  seconds: number;
  gameId: string | null;
};

export type SnailLaunchSettings = {
  sizePercent: number;
  speedPercent: number;
};

export type DesktopShuffleResult = {
  ok: boolean;
  skipped?: boolean;
  message?: string;
};

type GoblinHitRegion = { x: number; y: number; w: number; h: number };

type ScreenFlavorApi = {
  startGame: (gameId: string, snailSettings?: SnailLaunchSettings) => Promise<boolean>;
  shuffleDesktopIcon: () => Promise<DesktopShuffleResult>;
  setGoblinHitRegion: (rect: GoblinHitRegion | null) => void;
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
