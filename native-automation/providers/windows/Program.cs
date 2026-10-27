using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Windows.Automation;

namespace DTGuiComputer.WindowsProvider;

internal sealed record AppSelector(string Kind, string Value);
internal sealed record NativeAction(
    string Kind,
    string? ElementId,
    string? Value,
    string? Key,
    string? Direction,
    int? Pages,
    double? X,
    double? Y,
    bool AllowCoordinateFallback
);
internal sealed record ExpectedElement(string Role, string Name, bool Secure);
internal sealed record ProviderRequest(
    string Command,
    AppSelector? App,
    NativeAction? Action,
    string? ProviderPath,
    ExpectedElement? ExpectedElement,
    int? MaxDepth,
    int? MaxElements
);

internal sealed class ProviderException(string code, string message, object? details = null) : Exception(message)
{
    public string Code { get; } = code;
    public object Details { get; } = details ?? new { };
}

internal static class Program
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    [STAThread]
    private static int Main(string[] args)
    {
        var responsePath = ArgumentValue(args, "--response");
        try
        {
            var requestPath = ArgumentValue(args, "--request");
            var input = requestPath is null
                ? Console.In.ReadToEnd()
                : File.ReadAllText(requestPath, Encoding.UTF8);
            var request = JsonSerializer.Deserialize<ProviderRequest>(input, JsonOptions)
                ?? throw new ProviderException("INVALID_ARGUMENT", "请求内容为空");
            Emit(responsePath, new { ok = true, data = Dispatch(request) });
            return 0;
        }
        catch (ProviderException error)
        {
            Emit(responsePath, new
            {
                ok = false,
                error = new { code = error.Code, message = error.Message, details = error.Details },
            });
            return 2;
        }
        catch (Exception error)
        {
            Emit(responsePath, new
            {
                ok = false,
                error = new { code = "INTERNAL", message = $"Windows Provider 执行失败：{error.Message}", details = new { } },
            });
            return 3;
        }
    }

    private static object Dispatch(ProviderRequest request) => request.Command switch
    {
        "probe" => new
        {
            providerId = "windows-ui-automation",
            available = true,
            permission = "granted",
            integrity = "as-invoker",
            capabilities = new[] { "launch", "observe", "click", "set-value", "type-text", "key", "scroll" },
            limitations = new[] { "elevated-targets-require-matching-integrity", "secure-fields-require-human-handoff" },
        },
        "listApps" => ListApps(),
        "launch" => Launch(request),
        "observe" => Observe(request),
        "perform" => Perform(request),
        _ => throw new ProviderException("INVALID_ARGUMENT", $"未知 provider command：{request.Command}"),
    };

    private static object[] ListApps() => Process.GetProcesses()
        .Select(TryAppInfo)
        .Where(info => info is not null)
        .OrderBy(info => ((AppInfo)info!).DisplayName, StringComparer.OrdinalIgnoreCase)
        .Cast<object>()
        .ToArray();

    private static object Launch(ProviderRequest request)
    {
        var selector = request.App ?? throw new ProviderException("INVALID_ARGUMENT", "launch 缺少 app");
        if (selector.Kind == "process-id")
        {
            throw new ProviderException("INVALID_ARGUMENT", "不能使用 process-id 启动应用");
        }
        var startInfo = new ProcessStartInfo
        {
            FileName = selector.Value,
            UseShellExecute = true,
        };
        var process = Process.Start(startInfo)
            ?? throw new ProviderException("APP_LAUNCH_FAILED", $"应用启动失败：{selector.Value}");
        try
        {
            for (var attempt = 0; attempt < 50; attempt += 1)
            {
                process.Refresh();
                if (!process.HasExited && process.MainWindowHandle != IntPtr.Zero)
                {
                    return ToAppInfo(process);
                }
                Thread.Sleep(100);
            }
            throw new ProviderException("APP_LAUNCH_FAILED", $"应用已启动，但没有可操作窗口：{selector.Value}");
        }
        finally
        {
            process.Dispose();
        }
    }

    private static object Observe(ProviderRequest request)
    {
        var selector = request.App ?? throw new ProviderException("INVALID_ARGUMENT", "observe 缺少 app");
        using var process = ResolveProcess(selector);
        var root = ResolveRoot(process);
        var maxDepth = Math.Clamp(request.MaxDepth ?? 6, 1, 12);
        var maxElements = Math.Clamp(request.MaxElements ?? 400, 1, 2_000);
        var elements = new List<object>(Math.Min(maxElements, 400));
        var text = new List<string>(Math.Min(maxElements, 400));
        CollectElements(root, "0", 0, maxDepth, maxElements, process.Id, elements, text);
        var gaps = new List<string>();
        if (elements.Count >= maxElements)
        {
            gaps.Add("element-limit-reached");
        }
        gaps.Add("windows-provider-no-screenshot");
        return new
        {
            app = ToAppInfo(process),
            text = string.Join(Environment.NewLine, text),
            elements,
            screenshotPath = (string?)null,
            captureGaps = gaps,
        };
    }

    private static object Perform(ProviderRequest request)
    {
        var selector = request.App ?? throw new ProviderException("INVALID_ARGUMENT", "perform 缺少 app");
        var action = request.Action ?? throw new ProviderException("INVALID_ARGUMENT", "perform 缺少 action");
        using var process = ResolveProcess(selector);
        var root = ResolveRoot(process);
        SetForegroundWindow(process.MainWindowHandle);
        var target = request.ProviderPath is null ? null : ElementAtPath(root, request.ProviderPath);
        ValidateExpectedElement(target, request.ExpectedElement);

        switch (action.Kind)
        {
            case "click":
                PerformClick(target, action);
                break;
            case "set-value":
            case "type-text":
                PerformSetValue(target, action);
                break;
            case "key":
                PostKey(action.Key ?? string.Empty);
                break;
            case "scroll":
                PerformScroll(target ?? root, action);
                break;
            default:
                throw new ProviderException("UNSUPPORTED_ACTION", $"Windows Provider 暂不支持动作：{action.Kind}");
        }
        return new { performed = true, kind = action.Kind };
    }

    private static void CollectElements(
        AutomationElement element,
        string path,
        int depth,
        int maxDepth,
        int maxElements,
        int processId,
        List<object> elements,
        List<string> text)
    {
        if (depth > maxDepth || elements.Count >= maxElements)
        {
            return;
        }
        try
        {
            var role = Safe(() => element.Current.ControlType.ProgrammaticName.Replace("ControlType.", ""), "Unknown");
            var name = Safe(() => element.Current.Name, string.Empty);
            var automationId = Safe(() => element.Current.AutomationId, string.Empty);
            var secure = Safe(() => element.Current.IsPassword, false);
            var enabled = Safe(() => element.Current.IsEnabled, true);
            var value = ReadValue(element, secure);
            var actions = SupportedActions(element, secure);
            var elementId = ElementId(processId, path, role, automationId, name);
            elements.Add(new
            {
                elementId,
                providerPath = path,
                role,
                name,
                value,
                secure,
                enabled,
                actions,
            });
            var valueText = value is null ? string.Empty : $" value={value}";
            text.Add($"{new string(' ', depth * 2)}{elementId} {role} {name}{valueText}");
            if (depth == maxDepth)
            {
                return;
            }
            var walker = TreeWalker.ControlViewWalker;
            var child = walker.GetFirstChild(element);
            var index = 0;
            while (child is not null && elements.Count < maxElements)
            {
                CollectElements(child, $"{path}.{index}", depth + 1, maxDepth, maxElements, processId, elements, text);
                child = walker.GetNextSibling(child);
                index += 1;
            }
        }
        catch (ElementNotAvailableException)
        {
            // The next observation gets a fresh tree when the target changes mid-traversal.
        }
    }

    private static string? ReadValue(AutomationElement element, bool secure)
    {
        if (secure)
        {
            return "[REDACTED]";
        }
        if (!element.TryGetCurrentPattern(ValuePattern.Pattern, out var rawPattern))
        {
            return null;
        }
        var value = ((ValuePattern)rawPattern).Current.Value;
        return value[..Math.Min(value.Length, 2_000)];
    }

    private static string[] SupportedActions(AutomationElement element, bool secure)
    {
        var actions = new List<string>();
        if (element.TryGetCurrentPattern(InvokePattern.Pattern, out _)
            || element.TryGetCurrentPattern(SelectionItemPattern.Pattern, out _)
            || element.TryGetCurrentPattern(TogglePattern.Pattern, out _))
        {
            actions.Add("click");
        }
        if (!secure && element.TryGetCurrentPattern(ValuePattern.Pattern, out var pattern)
            && !((ValuePattern)pattern).Current.IsReadOnly)
        {
            actions.Add("set-value");
            actions.Add("type-text");
        }
        if (element.TryGetCurrentPattern(ScrollPattern.Pattern, out _))
        {
            actions.Add("scroll");
        }
        return actions.ToArray();
    }

    private static AutomationElement ResolveRoot(Process process)
    {
        process.Refresh();
        if (process.MainWindowHandle == IntPtr.Zero)
        {
            throw new ProviderException("APP_NOT_FOUND", $"目标应用没有可访问的主窗口：{process.ProcessName}");
        }
        try
        {
            return AutomationElement.FromHandle(process.MainWindowHandle);
        }
        catch (Exception error) when (error is ElementNotAvailableException or UnauthorizedAccessException)
        {
            throw new ProviderException(
                "PERMISSION_DENIED",
                "无法读取目标应用 UI Automation Tree；若目标以管理员身份运行，请以相同完整性级别启动 dt-gui-computer",
                new { processId = process.Id, cause = error.Message });
        }
    }

    private static Process ResolveProcess(AppSelector selector)
    {
        var processes = Process.GetProcesses();
        var process = processes.FirstOrDefault(candidate => Matches(candidate, selector));
        foreach (var candidate in processes)
        {
            if (candidate.Id != process?.Id)
            {
                candidate.Dispose();
            }
        }
        return process ?? throw new ProviderException("APP_NOT_FOUND", $"目标应用未运行或不可见：{selector.Value}");
    }

    private static bool Matches(Process process, AppSelector selector)
    {
        try
        {
            return selector.Kind switch
            {
                "process-id" => process.Id.ToString() == selector.Value,
                "path" => string.Equals(process.MainModule?.FileName, selector.Value, StringComparison.OrdinalIgnoreCase),
                "bundle-id" => string.Equals(process.ProcessName, selector.Value, StringComparison.OrdinalIgnoreCase),
                _ => string.Equals(process.ProcessName, selector.Value, StringComparison.OrdinalIgnoreCase)
                    || string.Equals(process.MainWindowTitle, selector.Value, StringComparison.OrdinalIgnoreCase),
            };
        }
        catch
        {
            return false;
        }
    }

    private static object? TryAppInfo(Process process)
    {
        try
        {
            if (process.MainWindowHandle == IntPtr.Zero || string.IsNullOrWhiteSpace(process.MainWindowTitle))
            {
                process.Dispose();
                return null;
            }
            var info = ToAppInfo(process);
            process.Dispose();
            return info;
        }
        catch
        {
            process.Dispose();
            return null;
        }
    }

    private sealed record AppInfo(string Id, string DisplayName, bool IsRunning, int ProcessId);

    private static AppInfo ToAppInfo(Process process) => new(
        process.ProcessName,
        string.IsNullOrWhiteSpace(process.MainWindowTitle) ? process.ProcessName : process.MainWindowTitle,
        !process.HasExited,
        process.Id
    );

    private static AutomationElement? ElementAtPath(AutomationElement root, string path)
    {
        var indexes = path.Split('.').Select(part => int.TryParse(part, out var index) ? index : -1).ToArray();
        if (indexes.Length == 0 || indexes[0] != 0)
        {
            return null;
        }
        var current = root;
        var walker = TreeWalker.ControlViewWalker;
        foreach (var index in indexes.Skip(1))
        {
            var child = walker.GetFirstChild(current);
            for (var position = 0; position < index && child is not null; position += 1)
            {
                child = walker.GetNextSibling(child);
            }
            if (child is null)
            {
                return null;
            }
            current = child;
        }
        return current;
    }

    private static void ValidateExpectedElement(AutomationElement? target, ExpectedElement? expected)
    {
        if (expected is null)
        {
            return;
        }
        if (target is null)
        {
            throw new ProviderException("ELEMENT_NOT_FOUND", "目标元素路径已失效");
        }
        var role = Safe(() => target.Current.ControlType.ProgrammaticName.Replace("ControlType.", ""), "Unknown");
        var name = Safe(() => target.Current.Name, string.Empty);
        var secure = Safe(() => target.Current.IsPassword, false);
        if (role != expected.Role || name != expected.Name || secure != expected.Secure)
        {
            throw new ProviderException(
                "STALE_SNAPSHOT",
                "目标元素已变化，请重新观察",
                new { expectedRole = expected.Role, currentRole = role, expectedName = expected.Name, currentName = name });
        }
    }

    private static void PerformClick(AutomationElement? target, NativeAction action)
    {
        if (target is not null)
        {
            if (target.TryGetCurrentPattern(InvokePattern.Pattern, out var invoke))
            {
                ((InvokePattern)invoke).Invoke();
                return;
            }
            if (target.TryGetCurrentPattern(SelectionItemPattern.Pattern, out var selection))
            {
                ((SelectionItemPattern)selection).Select();
                return;
            }
            if (target.TryGetCurrentPattern(TogglePattern.Pattern, out var toggle))
            {
                ((TogglePattern)toggle).Toggle();
                return;
            }
            throw new ProviderException("UNSUPPORTED_ACTION", "目标元素不支持 Invoke/Selection/Toggle Pattern");
        }
        if (action.X is null || action.Y is null || !action.AllowCoordinateFallback)
        {
            throw new ProviderException("ELEMENT_NOT_FOUND", "目标元素路径已失效，且未显式允许坐标回退");
        }
        SetCursorPos((int)action.X.Value, (int)action.Y.Value);
        mouse_event(MouseEventLeftDown, 0, 0, 0, UIntPtr.Zero);
        mouse_event(MouseEventLeftUp, 0, 0, 0, UIntPtr.Zero);
    }

    private static void PerformSetValue(AutomationElement? target, NativeAction action)
    {
        if (target is null)
        {
            throw new ProviderException("ELEMENT_NOT_FOUND", "目标元素路径已失效");
        }
        if (Safe(() => target.Current.IsPassword, false))
        {
            throw new ProviderException("HANDOFF_REQUIRED", "安全输入框必须由用户操作");
        }
        if (!target.TryGetCurrentPattern(ValuePattern.Pattern, out var rawPattern))
        {
            throw new ProviderException("UNSUPPORTED_ACTION", "目标元素不支持 Value Pattern");
        }
        var pattern = (ValuePattern)rawPattern;
        if (pattern.Current.IsReadOnly)
        {
            throw new ProviderException("UNSUPPORTED_ACTION", "目标元素为只读");
        }
        var value = action.Kind == "type-text"
            ? pattern.Current.Value + (action.Value ?? string.Empty)
            : action.Value ?? string.Empty;
        pattern.SetValue(value);
    }

    private static void PerformScroll(AutomationElement target, NativeAction action)
    {
        var pages = Math.Clamp(action.Pages ?? 1, 1, 20);
        var amount = action.Direction == "up" ? ScrollAmount.LargeDecrement : ScrollAmount.LargeIncrement;
        if (target.TryGetCurrentPattern(ScrollPattern.Pattern, out var rawPattern))
        {
            var pattern = (ScrollPattern)rawPattern;
            for (var index = 0; index < pages; index += 1)
            {
                pattern.ScrollVertical(amount);
            }
            return;
        }
        var delta = action.Direction == "up" ? 120 * pages : -120 * pages;
        mouse_event(MouseEventWheel, 0, 0, unchecked((uint)delta), UIntPtr.Zero);
    }

    private static void PostKey(string key)
    {
        var parts = key.ToLowerInvariant().Split('+', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        var keyName = parts.LastOrDefault() ?? string.Empty;
        var virtualKeys = new Dictionary<string, byte>(StringComparer.OrdinalIgnoreCase)
        {
            ["return"] = 0x0D, ["enter"] = 0x0D, ["tab"] = 0x09, ["space"] = 0x20,
            ["escape"] = 0x1B, ["left"] = 0x25, ["up"] = 0x26, ["right"] = 0x27, ["down"] = 0x28,
        };
        if (!virtualKeys.TryGetValue(keyName, out var virtualKey))
        {
            throw new ProviderException("UNSUPPORTED_ACTION", "当前仅支持导航键和 Return/Tab/Escape");
        }
        var modifiers = new List<byte>();
        if (parts.Contains("ctrl") || parts.Contains("control")) modifiers.Add(0x11);
        if (parts.Contains("shift")) modifiers.Add(0x10);
        if (parts.Contains("alt")) modifiers.Add(0x12);
        if (parts.Contains("super") || parts.Contains("win")) modifiers.Add(0x5B);
        foreach (var modifier in modifiers) keybd_event(modifier, 0, 0, UIntPtr.Zero);
        keybd_event(virtualKey, 0, 0, UIntPtr.Zero);
        keybd_event(virtualKey, 0, KeyEventKeyUp, UIntPtr.Zero);
        foreach (var modifier in modifiers.AsEnumerable().Reverse()) keybd_event(modifier, 0, KeyEventKeyUp, UIntPtr.Zero);
    }

    private static string ElementId(int processId, string path, string role, string automationId, string name)
    {
        var material = Encoding.UTF8.GetBytes($"{processId}|{path}|{role}|{automationId}|{name}");
        return $"uia-{Convert.ToHexString(SHA256.HashData(material))[..16].ToLowerInvariant()}";
    }

    private static T Safe<T>(Func<T> read, T fallback)
    {
        try { return read(); }
        catch { return fallback; }
    }

    private static string? ArgumentValue(string[] args, string name)
    {
        var index = Array.IndexOf(args, name);
        return index >= 0 && index + 1 < args.Length ? args[index + 1] : null;
    }

    private static void Emit(string? responsePath, object payload)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(payload, JsonOptions);
        if (responsePath is null)
        {
            Console.OpenStandardOutput().Write(bytes);
            return;
        }
        Directory.CreateDirectory(Path.GetDirectoryName(responsePath)!);
        File.WriteAllBytes(responsePath, bytes);
    }

    private const uint MouseEventLeftDown = 0x0002;
    private const uint MouseEventLeftUp = 0x0004;
    private const uint MouseEventWheel = 0x0800;
    private const uint KeyEventKeyUp = 0x0002;

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool SetCursorPos(int x, int y);

    [DllImport("user32.dll")]
    private static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);

    [DllImport("user32.dll")]
    private static extern void keybd_event(byte virtualKey, byte scanCode, uint flags, UIntPtr extraInfo);
}
