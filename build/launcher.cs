using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Windows.Forms;

static class Program
{
    [STAThread]
    static void Main()
    {
        string exe = Assembly.GetExecutingAssembly().Location;
        string dir = Path.GetDirectoryName(exe);
        string node = Path.Combine(dir, @"runtime\node.exe");
        string app = Path.Combine(dir, @"app\agpanel.js");

        string desktop = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "Antigravity Panel.lnk");
        string startup = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Startup), "Antigravity Panel.lnk");

        bool startupOk = EnsureShortcut(startup, exe, dir);
        bool desktopOk = EnsureShortcut(desktop, exe, dir);
        bool firstRun = !startupOk || !desktopOk;

        if (File.Exists(node) && File.Exists(app))
        {
            ProcessStartInfo psi = new ProcessStartInfo(node, "\"" + app + "\"");
            psi.WorkingDirectory = dir;
            psi.CreateNoWindow = true;
            psi.UseShellExecute = false;
            psi.WindowStyle = ProcessWindowStyle.Hidden;
            try { Process.Start(psi); } catch { }
        }

        if (firstRun)
        {
            MessageBox.Show(
                "Панель аккаунтов запущена.\n\n" +
                "Открой Antigravity — панель появится внизу слева, рядом с кнопкой Settings.\n\n" +
                "Чтобы добавить аккаунт: войди в него в Antigravity и нажми «+» в панели.\n\n" +
                "Ярлык добавлен на рабочий стол и в автозагрузку.",
                "Antigravity Switcher",
                MessageBoxButtons.OK,
                MessageBoxIcon.Information);
        }
    }

    /// <summary>Creates the shortcut or fixes it when the app folder was moved. True if it already pointed here.</summary>
    static bool EnsureShortcut(string path, string target, string workDir)
    {
        bool existed = File.Exists(path);
        bool matches = false;
        if (existed)
        {
            try
            {
                Type shellType = Type.GetTypeFromProgID("WScript.Shell");
                object shell = Activator.CreateInstance(shellType);
                object lnk = shellType.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { path });
                object current = lnk.GetType().InvokeMember("TargetPath", BindingFlags.GetProperty, null, lnk, null);
                matches = string.Equals(Convert.ToString(current), target, StringComparison.OrdinalIgnoreCase);
            }
            catch
            {
                matches = false;
            }
        }
        if (!matches)
        {
            WriteShortcut(path, target, workDir);
        }
        return matches;
    }

    static void WriteShortcut(string path, string target, string workDir)
    {
        try
        {
            Type shellType = Type.GetTypeFromProgID("WScript.Shell");
            object shell = Activator.CreateInstance(shellType);
            object lnk = shellType.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { path });
            Type lnkType = lnk.GetType();
            lnkType.InvokeMember("TargetPath", BindingFlags.SetProperty, null, lnk, new object[] { target });
            lnkType.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, lnk, new object[] { workDir });
            lnkType.InvokeMember("IconLocation", BindingFlags.SetProperty, null, lnk, new object[] { target + ",0" });
            lnkType.InvokeMember("Description", BindingFlags.SetProperty, null, lnk, new object[] { "Antigravity account switcher panel" });
            lnkType.InvokeMember("Save", BindingFlags.InvokeMethod, null, lnk, null);
        }
        catch
        {
        }
    }
}
