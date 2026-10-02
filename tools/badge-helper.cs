// dsh-sound-alert badge helper
//
// Draws a red count badge on the DSH taskbar button (Windows overlay icon) and
// clears it when the count returns to zero.
//
// Why a separate process: the DSH Host runs as a Node-mode child of the Electron
// shell, so plugins cannot reach Electron's window APIs. The shell accepts only a
// fixed IPC vocabulary (no badge/overlay message), therefore the taskbar overlay is
// applied here through the documented Win32 interface ITaskbarList3::SetOverlayIcon.
//
// Usage:
//   badge-helper.exe --state <path to badge-state.json> [--process <exe name>]
//
// State file (written by the plugin's host half, UTF-8 JSON):
//   { "count": 3, "pending": 1, "completed": 2, "beat": 1790000000000, "text": "..." }
//
// Behaviour:
//   * polls the state file every 250 ms; redraws only when the count changes;
//   * finds the app window again if it is recreated;
//   * clears the overlay and exits when the count is 0 for a moment, or when the
//     heartbeat is older than STALE_MS (Host gone / plugin unloaded);
//   * never throws: any failure exits quietly after clearing.
//
// Build (in-box .NET Framework compiler, no SDK required):
//   csc.exe /nologo /target:exe /out:badge-helper.exe badge-helper.cs /r:System.Drawing.dll

using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

[ComImport, Guid("56FDF344-FD6D-11d0-958A-006097C9A090")]
internal class CTaskbarList { }

[ComImport, Guid("ea1afb91-9e28-4b86-90e9-9e9f8a5eefaf"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface ITaskbarList3
{
    // ITaskbarList
    void HrInit();
    void AddTab(IntPtr hwnd);
    void DeleteTab(IntPtr hwnd);
    void ActivateTab(IntPtr hwnd);
    void SetActiveAlt(IntPtr hwnd);
    // ITaskbarList2
    void MarkFullscreenWindow(IntPtr hwnd, [MarshalAs(UnmanagedType.Bool)] bool fFullscreen);
    // ITaskbarList3
    void SetProgressValue(IntPtr hwnd, ulong ullCompleted, ulong ullTotal);
    void SetProgressState(IntPtr hwnd, int tbpFlags);
    void RegisterTab(IntPtr hwndTab, IntPtr hwndMDI);
    void UnregisterTab(IntPtr hwndTab);
    void SetTabOrder(IntPtr hwndTab, IntPtr hwndInsertBefore);
    void SetTabActive(IntPtr hwndTab, IntPtr hwndInsertBefore, uint dwReserved);
    void ThumbBarAddButtons(IntPtr hwnd, uint cButtons, IntPtr pButtons);
    void ThumbBarUpdateButtons(IntPtr hwnd, uint cButtons, IntPtr pButtons);
    void ThumbBarSetImageList(IntPtr hwnd, IntPtr himl);
    void SetOverlayIcon(IntPtr hwnd, IntPtr hIcon, [MarshalAs(UnmanagedType.LPWStr)] string pszDescription);
    void SetThumbnailTooltip(IntPtr hwnd, [MarshalAs(UnmanagedType.LPWStr)] string pszTip);
    void SetThumbnailClip(IntPtr hwnd, IntPtr prcClip);
}

internal static class Program
{
    private const int PollMs = 250;
    private const int StaleMs = 120000;   // no heartbeat for 2 minutes -> Host is gone
    private const int ZeroGraceMs = 1500; // keep a zero badge this long before clearing
    private const int NoWindowTimeoutMs = 30000; // give up when no DSH window exists (e.g. dsh web)

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool DestroyIcon(IntPtr hIcon);

    private static IntPtr currentIcon = IntPtr.Zero;
    private static int currentCount = -1;

    private static int Main(string[] args)
    {
        string statePath = null;
        string processName = "DeepSeek Harness";
        for (int i = 0; i < args.Length; i++)
        {
            if (args[i] == "--state" && i + 1 < args.Length) statePath = args[++i];
            else if (args[i] == "--process" && i + 1 < args.Length) processName = args[++i];
            else if (args[i] == "--log" && i + 1 < args.Length) logPath = args[++i];
        }
        if (statePath == null) return 2;

        ITaskbarList3 taskbar;
        try
        {
            taskbar = (ITaskbarList3)new CTaskbarList();
            taskbar.HrInit();
        }
        catch
        {
            Log("exit: taskbar COM unavailable");
            return 3;
        }
        Log("start state=" + statePath);

        IntPtr window = IntPtr.Zero;
        long lastLookup = 0;
        long zeroSince = 0;
        long startedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

        while (true)
        {
            try
            {
                State state = ReadState(statePath);
                long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

                if (state == null || now - state.Beat > StaleMs)
                {
                    Log(state == null ? "exit: state unreadable" : "exit: heartbeat stale (" + (now - state.Beat) + "ms)");
                    Clear(taskbar, ref window);
                    return 0;
                }

                if (window == IntPtr.Zero || !IsWindow(window))
                {
                    if (window != IntPtr.Zero) Log("window lost, re-looking");
                    window = IntPtr.Zero;
                    if (now - lastLookup > 1000)
                    {
                        lastLookup = now;
                        window = FindWindow(processName);
                        if (window != IntPtr.Zero) Log("window found hwnd=0x" + window.ToInt64().ToString("X", CultureInfo.InvariantCulture));
                    }
                    if (window == IntPtr.Zero)
                    {
                        // 30 秒还找不到窗口（例如这是 dsh web，没有桌面窗口）就放弃，
                        // 让宿主把徽标通道标记为不可用，浏览器半区走 navigator.setAppBadge 兜底。
                        if (now - startedAt > NoWindowTimeoutMs)
                        {
                            Log("exit: no window");
                            return 6;
                        }
                        Thread.Sleep(PollMs);
                        continue;
                    }
                }

                if (state.Count <= 0)
                {
                    if (zeroSince == 0) zeroSince = now;
                    else if (now - zeroSince >= ZeroGraceMs)
                    {
                        Log("exit: count back to 0");
                        Clear(taskbar, ref window);
                        return 0;
                    }
                }
                else
                {
                    zeroSince = 0;
                    if (state.Count != currentCount)
                    {
                        IntPtr icon = RenderIcon(state.Count);
                        string description = string.IsNullOrEmpty(state.Text) ? state.Count + " conversations" : state.Text;
                        try
                        {
                            taskbar.SetOverlayIcon(window, icon, description);
                        }
                        catch (Exception error)
                        {
                            Log("exit: SetOverlayIcon failed: " + error.Message);
                            if (icon != IntPtr.Zero) DestroyIcon(icon);
                            return 4;
                        }
                        if (currentIcon != IntPtr.Zero) DestroyIcon(currentIcon);
                        currentIcon = icon;
                        currentCount = state.Count;
                        Log("badge set count=" + state.Count);
                    }
                }

                Thread.Sleep(PollMs);
            }
            catch (Exception error)
            {
                Log("exit: " + error.GetType().Name + ": " + error.Message);
                return 5;
            }
        }
    }

    private static void Clear(ITaskbarList3 taskbar, ref IntPtr window)
    {
        try
        {
            if (window != IntPtr.Zero && IsWindow(window)) taskbar.SetOverlayIcon(window, IntPtr.Zero, null);
        }
        catch { /* clearing is best effort */ }
        if (currentIcon != IntPtr.Zero)
        {
            DestroyIcon(currentIcon);
            currentIcon = IntPtr.Zero;
        }
        currentCount = -1;
        window = IntPtr.Zero;
    }

    [DllImport("user32.dll")]
    private static extern bool IsWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int max);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassNameW(IntPtr hWnd, StringBuilder text, int max);

    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    private static string windowTitle = "DeepSeek Harness";
    private static string windowClass = "Chrome_WidgetWin_1";

    /// <summary>
    /// Top-level visible window of the Electron shell. Process.MainWindowHandle is 0 for every
    /// DSH process (the renderer owns the window), so match the window itself: class
    /// Chrome_WidgetWin_1 plus the app name in the title ("&lt;session&gt; — DeepSeek Harness").
    /// </summary>
    private static IntPtr FindWindow(string processName)
    {
        IntPtr found = IntPtr.Zero;
        try
        {
            EnumWindows((handle, _) =>
            {
                if (!IsWindowVisible(handle)) return true;
                StringBuilder title = new StringBuilder(512);
                GetWindowTextW(handle, title, title.Capacity);
                if (title.Length == 0) return true;
                StringBuilder cls = new StringBuilder(256);
                GetClassNameW(handle, cls, cls.Capacity);
                string titleText = title.ToString();
                bool classMatches = string.Equals(cls.ToString(), windowClass, StringComparison.OrdinalIgnoreCase);
                if (classMatches && titleText.IndexOf(windowTitle, StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    found = handle;
                    return false;
                }
                return true;
            }, IntPtr.Zero);
        }
        catch { /* fall through to the process-name attempt */ }

        if (found != IntPtr.Zero) return found;

        try
        {
            foreach (Process process in Process.GetProcessesByName(processName))
            {
                if (process.MainWindowHandle != IntPtr.Zero) return process.MainWindowHandle;
            }
        }
        catch { /* nothing else to try */ }
        return IntPtr.Zero;
    }

    private static string logPath;

    private static void Log(string message)
    {
        if (logPath == null) return;
        try
        {
            File.AppendAllText(logPath, DateTime.Now.ToString("HH:mm:ss.fff", CultureInfo.InvariantCulture) + " " + message + Environment.NewLine, new UTF8Encoding(false));
        }
        catch { /* logging is best effort */ }
    }

    private sealed class State
    {
        public int Count;
        public long Beat;
        public string Text;
    }

    private static readonly Regex CountRe = new Regex("\"count\"\\s*:\\s*(-?\\d+)", RegexOptions.Compiled);
    private static readonly Regex BeatRe = new Regex("\"beat\"\\s*:\\s*(\\d+)", RegexOptions.Compiled);
    private static readonly Regex TextRe = new Regex("\"text\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"", RegexOptions.Compiled);

    private static State ReadState(string path)
    {
        string json;
        try
        {
            using (FileStream stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
            using (StreamReader reader = new StreamReader(stream, new UTF8Encoding(false)))
            {
                json = reader.ReadToEnd();
            }
        }
        catch
        {
            return null;
        }

        Match count = CountRe.Match(json);
        Match beat = BeatRe.Match(json);
        if (!count.Success || !beat.Success) return null;

        State state = new State();
        state.Count = int.Parse(count.Groups[1].Value, CultureInfo.InvariantCulture);
        state.Beat = long.Parse(beat.Groups[1].Value, CultureInfo.InvariantCulture);
        Match text = TextRe.Match(json);
        if (text.Success) state.Text = Regex.Unescape(text.Groups[1].Value);
        return state;
    }

    /// <summary>Red circle + white count, 32x32 so Windows can scale it on high DPI.</summary>
    private static IntPtr RenderIcon(int count)
    {
        const int size = 32;
        string label = count > 99 ? "99+" : count.ToString(CultureInfo.InvariantCulture);
        using (Bitmap bitmap = new Bitmap(size, size))
        {
            using (Graphics graphics = Graphics.FromImage(bitmap))
            {
                graphics.SmoothingMode = SmoothingMode.AntiAlias;
                graphics.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
                graphics.Clear(Color.Transparent);
                using (SolidBrush fill = new SolidBrush(Color.FromArgb(255, 232, 17, 35)))
                using (Pen ring = new Pen(Color.White, 2.5f))
                {
                    graphics.FillEllipse(fill, 1.5f, 1.5f, size - 3f, size - 3f);
                    graphics.DrawEllipse(ring, 1.5f, 1.5f, size - 3f, size - 3f);
                }
                float pixels = label.Length >= 3 ? 9.5f : label.Length == 2 ? 13.5f : 17f;
                using (Font font = new Font("Segoe UI", pixels, FontStyle.Bold, GraphicsUnit.Pixel))
                using (SolidBrush ink = new SolidBrush(Color.White))
                using (StringFormat format = new StringFormat
                {
                    Alignment = StringAlignment.Center,
                    LineAlignment = StringAlignment.Center,
                    FormatFlags = StringFormatFlags.NoWrap,
                })
                {
                    graphics.DrawString(label, font, ink, new RectangleF(0, 0, size, size), format);
                }
            }
            return bitmap.GetHicon();
        }
    }
}
