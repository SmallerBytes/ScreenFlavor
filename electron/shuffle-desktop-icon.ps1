# Moves one random desktop icon to a new random position in the desktop ListView (Windows).
# Writes "OK" or "FAIL" to stdout. Requires classic desktop icon layer (not tablet-only shell).

$ErrorActionPreference = "Stop"

Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class ScreenFlavorDesk {
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern IntPtr FindWindowEx(IntPtr hwndParent, IntPtr hwndChildAfter, string lpszClass, string lpszWindow);

  [DllImport("user32.dll")]
  public static extern IntPtr GetWindow(IntPtr hWnd, uint uCmd);

  [DllImport("user32.dll")]
  public static extern bool GetClientRect(IntPtr hWnd, out RECT lpRect);

  [DllImport("user32.dll", CharSet = CharSet.Auto)]
  public static extern IntPtr SendMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

  [DllImport("user32.dll", CharSet = CharSet.Auto)]
  public static extern IntPtr SendMessagePt(IntPtr hWnd, uint Msg, IntPtr wParam, ref POINT lParam);

  public const uint GW_CHILD = 5;
  public const uint GW_HWNDNEXT = 2;
  public const uint LVM_GETITEMCOUNT = 0x1000 + 4;
  public const uint LVM_GETITEMPOSITION = 0x1000 + 16;
  public const uint LVM_SETITEMPOSITION = 0x1000 + 15;

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct POINT {
    public int X;
    public int Y;
  }

  static IntPtr FindListUnder(IntPtr root) {
    if (root == IntPtr.Zero) return IntPtr.Zero;
    IntPtr shellDll = FindWindowEx(root, IntPtr.Zero, "SHELLDLL_DefView", null);
    if (shellDll == IntPtr.Zero) return IntPtr.Zero;
    return FindWindowEx(shellDll, IntPtr.Zero, "SysListView32", null);
  }

  static IntPtr FindDesktopListView() {
    IntPtr prog = FindWindow("Progman", null);
    IntPtr lv = FindListUnder(prog);
    if (lv != IntPtr.Zero) return lv;

    if (prog == IntPtr.Zero) return IntPtr.Zero;
    for (IntPtr w = GetWindow(prog, GW_CHILD); w != IntPtr.Zero; w = GetWindow(w, GW_HWNDNEXT)) {
      lv = FindListUnder(w);
      if (lv != IntPtr.Zero) return lv;
    }
    return IntPtr.Zero;
  }

  public static bool ShuffleOne() {
    IntPtr lv = FindDesktopListView();
    if (lv == IntPtr.Zero) return false;

    int count = (int)(long)SendMessage(lv, LVM_GETITEMCOUNT, IntPtr.Zero, IntPtr.Zero);
    if (count <= 0) return false;

    var rnd = new Random();
    int idx = rnd.Next(count);

    POINT pt = new POINT();
    SendMessagePt(lv, LVM_GETITEMPOSITION, (IntPtr)idx, ref pt);

    if (!GetClientRect(lv, out RECT cr)) return false;
    int margin = 28;
    int minX = cr.Left + margin;
    int minY = cr.Top + margin;
    int maxX = cr.Right - margin - 72;
    int maxY = cr.Bottom - margin - 72;
    if (maxX <= minX) maxX = minX + 8;
    if (maxY <= minY) maxY = minY + 8;

    int nx = rnd.Next(minX, maxX + 1);
    int ny = rnd.Next(minY, maxY + 1);

    IntPtr packed = (IntPtr)((long)((ushort)(ny & 0xffff)) << 16 | (ushort)(nx & 0xffff));
    SendMessage(lv, LVM_SETITEMPOSITION, (IntPtr)idx, packed);
    return true;
  }
}
"@

try {
  if ([ScreenFlavorDesk]::ShuffleOne()) {
    Write-Output "OK"
    exit 0
  }
  Write-Output "FAIL"
  exit 1
} catch {
  Write-Output "FAIL"
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
