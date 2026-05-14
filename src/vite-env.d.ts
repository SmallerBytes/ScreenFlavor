export {};

type CursorPos = { x: number; y: number };

type LastRunPayload = {
  seconds: number;
  gameId: string | null;
};

type ScreenFlavorApi = {
  startGame: (gameId: string) => Promise<boolean>;
  quitApp: () => Promise<void>;
  onCursor: (handler: (pos: CursorPos) => void) => () => void;
  onLastRun: (handler: (payload: LastRunPayload) => void) => () => void;
  notifyGameOver: (seconds: number) => Promise<boolean>;
};

declare global {
  interface Window {
    screenFlavor: ScreenFlavorApi;
  }
}
